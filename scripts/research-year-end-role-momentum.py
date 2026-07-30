"""Research-only audit of prior-season year-end role momentum.

This preregistered experiment adds one fixed five-feature family for RB, WR,
and TE. Target season S uses only completed weekly player/team statistics from
S-1. It never writes a model, projection candidate, or runtime policy.
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
POSITIONS = ("RB", "WR", "TE")
EVALUATION_SEASONS = (2023, 2024, 2025)
ADDED_FEATURES = (
    "year_end_opportunity_share",
    "early_opportunity_share",
    "year_end_role_momentum",
    "year_end_active_game_share",
    "year_end_role_missing",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_role_history(data_dir: Path) -> tuple[
    dict[tuple[str, int], dict[str, float]], list[dict[str, Any]], dict[str, Any]
]:
    history: dict[tuple[str, int], dict[str, float]] = {}
    manifest: list[dict[str, Any]] = []
    coverage = {
        "seasons": [],
        "regularSeasonPlayerRows": 0,
        "regularSeasonTeamRows": 0,
        "playerSeasons": 0,
    }
    player_files = sorted(data_dir.glob("stats_player_week_*.csv"))
    for player_path in player_files:
        season = int(player_path.stem.rsplit("_", 1)[1])
        team_path = data_dir / f"stats_team_week_{season}.csv"
        if not team_path.is_file():
            raise ValueError(f"Missing paired weekly team file: {team_path}")
        players = pd.read_csv(player_path, low_memory=False)
        teams = pd.read_csv(team_path, low_memory=False)
        player_required = {
            "player_id", "position", "season", "week", "season_type", "game_id",
            "team", "carries", "targets",
        }
        team_required = {
            "season", "week", "season_type", "game_id", "team", "carries", "targets",
        }
        if missing := sorted(player_required - set(players.columns)):
            raise ValueError(f"{player_path.name} missing columns: {', '.join(missing)}")
        if missing := sorted(team_required - set(teams.columns)):
            raise ValueError(f"{team_path.name} missing columns: {', '.join(missing)}")
        players = players[
            players["season_type"].astype(str).eq("REG")
            & players["position"].astype(str).isin(POSITIONS)
        ].copy()
        teams = teams[teams["season_type"].astype(str).eq("REG")].copy()
        for frame in (players, teams):
            frame["week"] = pd.to_numeric(frame["week"], errors="coerce")
            frame["carries"] = pd.to_numeric(frame["carries"], errors="coerce").fillna(0)
            frame["targets"] = pd.to_numeric(frame["targets"], errors="coerce").fillna(0)
        coverage["seasons"].append(season)
        coverage["regularSeasonPlayerRows"] += int(len(players))
        coverage["regularSeasonTeamRows"] += int(len(teams))
        team_games: dict[str, dict[str, set[str]]] = {}
        team_denominators: dict[tuple[str, str, str], float] = {}
        for team, rows in teams.groupby("team"):
            ordered = rows.sort_values(["week", "game_id"]).drop_duplicates("game_id")
            game_ids = ordered["game_id"].astype(str).tolist()
            final = set(game_ids[-6:])
            early = set(game_ids[:-6])
            team_games[str(team)] = {"final": final, "early": early}
            for window, selected_ids in (("final", final), ("early", early)):
                selected = ordered[ordered["game_id"].astype(str).isin(selected_ids)]
                team_denominators[(str(team), window, "RB")] = float(
                    (selected["carries"] + selected["targets"]).sum()
                )
                team_denominators[(str(team), window, "REC")] = float(
                    selected["targets"].sum()
                )
        for player_id, rows in players.groupby("player_id"):
            ordered = rows.sort_values(["week", "game_id"])
            latest = ordered.iloc[-1]
            team = str(latest["team"])
            position = str(latest["position"])
            games = team_games.get(team)
            if not games:
                continue
            same_team = ordered[ordered["team"].astype(str).eq(team)]
            shares = {}
            for window in ("final", "early"):
                selected = same_team[
                    same_team["game_id"].astype(str).isin(games[window])
                ]
                numerator = float(
                    (selected["carries"] + selected["targets"]).sum()
                    if position == "RB" else selected["targets"].sum()
                )
                denominator = team_denominators.get(
                    (team, window, "RB" if position == "RB" else "REC"), 0.0
                )
                shares[window] = numerator / denominator if denominator > 0 else math.nan
            history[(str(player_id), season)] = {
                "year_end_opportunity_share": shares["final"],
                "early_opportunity_share": shares["early"],
                "year_end_role_momentum": shares["final"] - shares["early"]
                if math.isfinite(shares["final"]) and math.isfinite(shares["early"])
                else math.nan,
                "year_end_active_game_share": min(
                    1.0,
                    same_team[
                        same_team["game_id"].astype(str).isin(games["final"])
                    ]["game_id"].nunique() / max(1, len(games["final"])),
                ),
                "year_end_role_missing": 0.0,
            }
        for source in (player_path, team_path):
            manifest.append({
                "file": source.name,
                "bytes": source.stat().st_size,
                "sha256": sha256_file(source),
                "source": (
                    "https://github.com/nflverse/nflverse-data/releases/download/"
                    + ("stats_player/" if "player" in source.name else "stats_team/")
                    + source.name
                ),
                "license": "CC-BY-4.0",
                "featureCutoff": (
                    f"Completed {season} regular season; used only for target "
                    f"season {season + 1} or later"
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
        source_season = int(row["season"]) - 1
        values = history.get((str(row["player_id"]), source_season))
        if values is None:
            for column in ADDED_FEATURES[:-1]:
                result.at[index, column] = 0.0
            result.at[index, "year_end_role_missing"] = 1.0
            continue
        for column in ADDED_FEATURES:
            result.at[index, column] = values[column]
    return result


def acceptance(control: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    comparisons: list[dict[str, Any]] = []
    for scoring in ("STD", "PPR"):
        baseline_all = control["lockedDraftableVeterans"][scoring]
        candidate_all = candidate["lockedDraftableVeterans"][scoring]
        baseline = baseline_all["aggregate"]
        test = candidate_all["aggregate"]
        guards = {
            "mae": test["mae"] < baseline["mae"],
            "rmse": test["rmse"] <= baseline["rmse"],
            "bias": abs(test["bias"]) <= abs(baseline["bias"]),
            "spearman": test["spearman"] >= baseline["spearman"] - .005,
        }
        for metric, passed in guards.items():
            comparisons.append({
                "scoring": scoring, "scope": "aggregate", "metric": metric,
                "baseline": baseline[metric], "candidate": test[metric],
                "passed": passed,
            })
            if not passed:
                reasons.append(f"{scoring} aggregate {metric} guard failed")
        for season in EVALUATION_SEASONS:
            before = baseline_all["folds"][str(season)]
            after = candidate_all["folds"][str(season)]
            fold_guards = {
                "mae": after["mae"] <= before["mae"] * 1.02,
                "rmse": after["rmse"] <= before["rmse"] * 1.02,
                "bias": abs(after["bias"]) <= max(abs(before["bias"]) * 1.05, abs(before["bias"]) + .5),
                "spearman": after["spearman"] >= before["spearman"] - .01,
            }
            for metric, passed in fold_guards.items():
                comparisons.append({
                    "scoring": scoring, "scope": str(season), "metric": metric,
                    "baseline": before[metric], "candidate": after[metric],
                    "passed": passed,
                })
                if not passed:
                    reasons.append(f"{scoring} {season} {metric} guard failed")
    return {
        "accepted": not reasons,
        "policy": (
            "Locked draftable veterans require strict aggregate MAE improvement "
            "in STD and PPR, no aggregate RMSE or absolute-bias regression, no "
            "more than 0.005 aggregate rank regression, and fold guards capped "
            "at 2% MAE/RMSE, 5% or 0.5 bias, and 0.01 rank regression."
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
        default=Path("data/research/owned-model-year-end-role-momentum.json"),
    )
    args = parser.parse_args()
    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    history, manifest, coverage = load_role_history(args.data_dir)
    augmented = augment(dataset, history)
    positions: dict[str, Any] = {}
    for position in POSITIONS:
        rows = augmented[augmented["position"].eq(position)].copy()
        baseline_oof = HARNESS.oof_components(rows, production_features, position)
        locked_ids = HARNESS.locked_draftable_ids(baseline_oof, position)
        control = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(baseline_oof), rows, position, locked_ids
        )
        candidate_oof = HARNESS.oof_components(
            rows, production_features + list(ADDED_FEATURES), position
        )
        candidate = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(candidate_oof), rows, position, locked_ids
        )
        positions[position] = {
            "lockedDraftableVeterans": len(locked_ids),
            "featureCoverage": {
                feature: int(rows[feature].notna().sum()) for feature in ADDED_FEATURES
            },
            "control": control,
            "candidate": candidate,
            "acceptance": acceptance(control, candidate),
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
        "experiment": "prior-season-year-end-role-momentum-v1",
        "hypothesis": (
            "A player's share of team opportunity in the prior season's final "
            "six games captures durable role changes hidden by full-season aggregates."
        ),
        "design": (
            "One fixed five-feature family for RB/WR/TE; exact GSIS player IDs; "
            "production-identical learners and nested expanding-season stack. "
            "No provider projections, target-season data, subset search, or tuning."
        ),
        "addedFeatures": list(ADDED_FEATURES),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "temporalBoundary": (
            "Every target-season S row uses only REG weekly player/team rows "
            "from completed season S-1. Missing player weeks contribute zero "
            "opportunity; missing player-season joins are explicitly flagged."
        ),
        "coverage": coverage,
        "inputManifest": manifest,
        "positions": positions,
        "decision": {
            "acceptedPositions": accepted,
            "productionAction": (
                "No production change. Development folds are adaptive evidence; "
                "any accepted position requires unchanged prospective confirmation."
            ),
        },
        "limitations": [
            "Final-six role state can reflect injuries or trades and is predictive, not causal.",
            "Rookies have no prior-season role and are not evaluated by the veteran gate.",
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
