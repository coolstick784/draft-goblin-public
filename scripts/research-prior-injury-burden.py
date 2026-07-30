"""Research-only audit of prior-season injury burden for games played.

One fixed seven-feature family is added only to the games-played target for
QB/RB/WR/TE. Target season S uses official injury/practice reports from S-1.
Per-game fantasy models remain byte-for-byte equivalent to the control design.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from owned_model.pipeline import (  # noqa: E402
    MODEL_VERSION,
    _metrics,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
)


def load_harness() -> Any:
    source = ROOT / "scripts" / "research-veteran-feature-ablation.py"
    spec = importlib.util.spec_from_file_location("owned_veteran_ablation", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load evaluation harness: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = load_harness()
POSITIONS = ("QB", "RB", "WR", "TE")
EVALUATION_SEASONS = (2023, 2024, 2025)
ADDED_FEATURES = (
    "prior_injury_report_week_share",
    "prior_dnp_week_share",
    "prior_limited_week_share",
    "prior_out_doubtful_week_share",
    "prior_late_injury_week_share",
    "prior_repeated_injury_week_share",
    "prior_injury_missing",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return "".join(character for character in str(value).lower() if character.isalnum())


def load_injury_history(data_dir: Path) -> tuple[
    dict[tuple[str, int], dict[str, float]], list[dict[str, Any]], dict[str, Any]
]:
    history: dict[tuple[str, int], dict[str, float]] = {}
    manifest: list[dict[str, Any]] = []
    coverage = {"seasons": [], "regularSeasonRows": 0, "playerSeasons": 0}
    for source in sorted(data_dir.glob("injuries_*.csv")):
        season = int(source.stem.rsplit("_", 1)[1])
        frame = pd.read_csv(source, low_memory=False)
        required = {
            "season", "game_type", "week", "gsis_id", "position",
            "report_primary_injury", "report_status", "practice_status",
        }
        if missing := sorted(required - set(frame.columns)):
            raise ValueError(f"{source.name} missing columns: {', '.join(missing)}")
        frame = frame[
            frame["game_type"].astype(str).eq("REG")
            & frame["position"].astype(str).isin(POSITIONS)
            & frame["gsis_id"].fillna("").astype(str).str.startswith("00-")
        ].copy()
        frame["week"] = pd.to_numeric(frame["week"], errors="coerce")
        frame = frame[frame["week"].notna()]
        max_week = max(1, int(frame["week"].max()))
        late_start = max_week - 5
        coverage["seasons"].append(season)
        coverage["regularSeasonRows"] += int(len(frame))
        for player_id, rows in frame.groupby("gsis_id"):
            report_weeks = set(int(value) for value in rows["week"])
            practice = rows["practice_status"].map(normalized)
            report = rows["report_status"].map(normalized)
            injuries = rows["report_primary_injury"].map(normalized)
            repeated = (
                rows.assign(_injury=injuries)
                .loc[injuries.ne(""), ["week", "_injury"]]
                .drop_duplicates()
                .groupby("_injury")["week"]
                .nunique()
            )
            history[(str(player_id), season)] = {
                "prior_injury_report_week_share": len(report_weeks) / max_week,
                "prior_dnp_week_share": rows.loc[
                    practice.eq("didnotparticipateinpractice"), "week"
                ].nunique() / max_week,
                "prior_limited_week_share": rows.loc[
                    practice.eq("limitedparticipationinpractice"), "week"
                ].nunique() / max_week,
                "prior_out_doubtful_week_share": rows.loc[
                    report.isin(("out", "doubtful")), "week"
                ].nunique() / max_week,
                "prior_late_injury_week_share": len(
                    {week for week in report_weeks if week >= late_start}
                ) / 6.0,
                "prior_repeated_injury_week_share": (
                    float(repeated.max()) / max_week if len(repeated) else 0.0
                ),
                "prior_injury_missing": 0.0,
            }
        manifest.append({
            "file": source.name,
            "bytes": source.stat().st_size,
            "sha256": sha256_file(source),
            "source": (
                "https://github.com/nflverse/nflverse-data/releases/download/"
                f"injuries/{source.name}"
            ),
            "license": "CC-BY-4.0",
            "featureCutoff": (
                f"Completed {season} injury/practice reports; used only for "
                f"target season {season + 1} or later"
            ),
        })
    coverage["seasons"] = (
        [min(coverage["seasons"]), max(coverage["seasons"])]
        if coverage["seasons"] else []
    )
    coverage["playerSeasons"] = len(history)
    return history, manifest, coverage


def augment(
    dataset: pd.DataFrame,
    history: dict[tuple[str, int], dict[str, float]],
) -> pd.DataFrame:
    result = dataset.copy()
    for column in ADDED_FEATURES:
        result[column] = np.nan
    for index, row in result.iterrows():
        values = history.get((str(row["player_id"]), int(row["season"]) - 1))
        if values is None:
            for column in ADDED_FEATURES[:-1]:
                result.at[index, column] = 0.0
            result.at[index, "prior_injury_missing"] = 1.0
            continue
        for column in ADDED_FEATURES:
            result.at[index, column] = values[column]
    return result


def games_metrics(
    predictions: dict[str, pd.DataFrame],
    truth: pd.DataFrame,
    locked_ids: set[int],
) -> dict[str, Any]:
    games = predictions["games"]
    indices = games.index.intersection(list(locked_ids))
    indices = indices[
        pd.to_numeric(truth.loc[indices, "experience"], errors="coerce").ge(1)
    ]
    result = {"aggregate": {}, "folds": {}}
    result["aggregate"] = _metrics(
        games.loc[indices, "candidate"].to_numpy(float),
        games.loc[indices, "actual"].to_numpy(float),
    )
    for season in EVALUATION_SEASONS:
        selected = indices[games.loc[indices, "season"].eq(season)]
        result["folds"][str(season)] = _metrics(
            games.loc[selected, "candidate"].to_numpy(float),
            games.loc[selected, "actual"].to_numpy(float),
        )
    return result


def metric_guards(
    before: dict[str, Any],
    after: dict[str, Any],
    aggregate: bool,
) -> dict[str, bool]:
    return {
        "mae": after["mae"] < before["mae"] if aggregate
        else after["mae"] <= before["mae"] * 1.02,
        "rmse": after["rmse"] <= before["rmse"] if aggregate
        else after["rmse"] <= before["rmse"] * 1.02,
        "bias": abs(after["bias"]) <= abs(before["bias"]) if aggregate
        else abs(after["bias"]) <= max(abs(before["bias"]) * 1.05, abs(before["bias"]) + .25),
        "spearman": after["spearman"] >= before["spearman"] - (.005 if aggregate else .01),
    }


def acceptance(
    control_games: dict[str, Any],
    candidate_games: dict[str, Any],
    control_totals: dict[str, Any],
    candidate_totals: dict[str, Any],
) -> dict[str, Any]:
    comparisons: list[dict[str, Any]] = []
    reasons: list[str] = []
    scopes = [("games", control_games, candidate_games)]
    for scoring in ("STD", "PPR"):
        scopes.append((
            scoring,
            control_totals["lockedDraftableVeterans"][scoring],
            candidate_totals["lockedDraftableVeterans"][scoring],
        ))
    for scoring, control, candidate in scopes:
        for scope in ("aggregate", *map(str, EVALUATION_SEASONS)):
            before = control["aggregate"] if scope == "aggregate" else control["folds"][scope]
            after = candidate["aggregate"] if scope == "aggregate" else candidate["folds"][scope]
            for metric, passed in metric_guards(
                before, after, scope == "aggregate"
            ).items():
                comparisons.append({
                    "scoring": scoring, "scope": scope, "metric": metric,
                    "baseline": before[metric], "candidate": after[metric],
                    "passed": passed,
                })
                if not passed:
                    reasons.append(f"{scoring} {scope} {metric} guard failed")
    return {
        "accepted": not reasons,
        "policy": (
            "Games, STD totals, and PPR totals on the identical locked draftable-"
            "veteran cohort require strict aggregate MAE improvement, no aggregate "
            "RMSE/absolute-bias regression, <=0.005 rank regression, and fold "
            "guards capped at 2% MAE/RMSE, 5% or 0.25 bias, and 0.01 rank."
        ),
        "comparisons": comparisons,
        "reasons": reasons,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data/private/owned-model/raw")
    )
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument(
        "--out", type=Path,
        default=Path("data/research/owned-model-prior-injury-burden.json"),
    )
    args = parser.parse_args()
    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    history, manifest, coverage = load_injury_history(args.data_dir)
    augmented = augment(dataset, history)
    positions: dict[str, Any] = {}
    for position in POSITIONS:
        rows = augmented[augmented["position"].eq(position)].copy()
        baseline_components = HARNESS.oof_components(
            rows, production_features, position
        )
        locked_ids = HARNESS.locked_draftable_ids(baseline_components, position)
        control_predictions = HARNESS.nested_predictions(baseline_components)
        candidate_games = HARNESS.oof_components(
            rows, production_features + list(ADDED_FEATURES), position
        )["games"]
        candidate_components = {
            **baseline_components,
            "games": candidate_games,
        }
        candidate_predictions = HARNESS.nested_predictions(candidate_components)
        control_totals = HARNESS.cohort_metrics(
            control_predictions, rows, position, locked_ids
        )
        candidate_totals = HARNESS.cohort_metrics(
            candidate_predictions, rows, position, locked_ids
        )
        control_games = games_metrics(control_predictions, rows, locked_ids)
        test_games = games_metrics(candidate_predictions, rows, locked_ids)
        positions[position] = {
            "lockedDraftableVeterans": len(locked_ids),
            "featureCoverage": {
                feature: int(rows[feature].notna().sum()) for feature in ADDED_FEATURES
            },
            "control": {"games": control_games, "seasonTotals": control_totals},
            "candidate": {"games": test_games, "seasonTotals": candidate_totals},
            "acceptance": acceptance(
                control_games, test_games, control_totals, candidate_totals
            ),
        }
    accepted = [
        position for position, value in positions.items()
        if value["acceptance"]["accepted"]
    ]
    report = {
        "schemaVersion": 1,
        "artifactType": "owned-model-research-report",
        "researchStatus": "eligible-for-independent-review" if accepted else "rejected",
        "researchOnly": True,
        "productionChanged": False,
        "baselineModelVersion": MODEL_VERSION,
        "experiment": "prior-season-injury-burden-games-only-v1",
        "hypothesis": (
            "Official prior-season injury and practice-report burden improves "
            "games-played forecasts beyond lagged games and age."
        ),
        "design": (
            "One fixed seven-feature family for QB/RB/WR/TE games only. "
            "Per-game STD/PPR component predictions are identical to control. "
            "Exact GSIS joins; no provider projections, target-season reports, "
            "subset search, or hyperparameter tuning."
        ),
        "addedFeatures": list(ADDED_FEATURES),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "temporalBoundary": (
            "Every target-season S feature uses only completed injury/practice "
            "rows from S-1. Missing exact-ID joins are retained and flagged."
        ),
        "coverage": coverage,
        "inputManifest": manifest,
        "positions": positions,
        "decision": {
            "acceptedPositions": accepted,
            "productionAction": (
                "No production change. Development results cannot authorize "
                "runtime; accepted positions would require unchanged prospective proof."
            ),
        },
        "limitations": [
            "Injury-report burden is a predictive availability marker, not a medical diagnosis.",
            "Official reporting practices vary by team and season.",
            "2023-2025 are development folds and cannot authorize replacement.",
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "out": str(args.out),
        "acceptedPositions": accepted,
        "failures": {
            position: len(value["acceptance"]["reasons"])
            for position, value in positions.items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
