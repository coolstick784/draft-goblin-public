"""Research-only, leakage-safe offensive snap-share experiment.

This harness adds one fixed signal family to the production v2026.12 feature
matrix: lagged regular-season offensive snap share from nflverse/PFR snap
counts. It never writes a model, candidate projection, policy, or runtime file.
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


def _load_existing_harness() -> Any:
    path = ROOT / "scripts" / "research-veteran-feature-ablation.py"
    spec = importlib.util.spec_from_file_location("owned_veteran_ablation", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load evaluation harness: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = _load_existing_harness()
POSITIONS = ("QB", "RB", "WR", "TE")
EVALUATION_SEASONS = (2023, 2024, 2025)
ADDED_FEATURES = (
    "snap_share_lag1",
    "snap_share_lag2",
    "snap_share_lag3",
    "snap_share_ewma",
    "snap_share_trend",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def finite(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else math.nan
    except (TypeError, ValueError):
        return math.nan


def load_snap_history(
    data_dir: Path, players: pd.DataFrame
) -> tuple[dict[str, dict[int, float]], list[dict[str, Any]], dict[str, Any]]:
    """Aggregate game-level counts to player-season weighted snap shares."""
    pfr_to_player = {
        str(row["pfr_id"]).strip(): str(row["player_id"])
        for row in players.to_dict("records")
        if str(row.get("pfr_id") or "").strip()
        and str(row.get("player_id") or "").strip()
    }
    history: dict[str, dict[int, float]] = {}
    manifest: list[dict[str, Any]] = []
    joined_rows = 0
    eligible_rows = 0
    seasons: list[int] = []
    for path in sorted(data_dir.glob("snap_counts_*.csv")):
        frame = pd.read_csv(path, low_memory=False)
        if frame.empty:
            continue
        required = {
            "season", "game_type", "pfr_player_id", "offense_snaps", "offense_pct"
        }
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"{path.name} missing columns: {', '.join(missing)}")
        frame = frame[frame["game_type"].astype(str).eq("REG")].copy()
        frame["player_id"] = (
            frame["pfr_player_id"].fillna("").astype(str).str.strip().map(pfr_to_player)
        )
        frame["offense_snaps"] = pd.to_numeric(
            frame["offense_snaps"], errors="coerce"
        )
        frame["offense_pct"] = pd.to_numeric(frame["offense_pct"], errors="coerce")
        eligible = frame[
            frame["player_id"].notna()
            & frame["offense_snaps"].gt(0)
            & frame["offense_pct"].gt(0)
            & frame["offense_pct"].le(1.01)
        ].copy()
        eligible["estimated_team_snaps"] = (
            eligible["offense_snaps"] / eligible["offense_pct"]
        )
        season = int(pd.to_numeric(frame["season"], errors="raise").iloc[0])
        seasons.append(season)
        eligible_rows += len(frame)
        joined_rows += len(eligible)
        for player_id, rows in eligible.groupby("player_id"):
            denominator = float(rows["estimated_team_snaps"].sum())
            share = (
                float(rows["offense_snaps"].sum()) / denominator
                if denominator > 0 else math.nan
            )
            history.setdefault(str(player_id), {})[season] = share
        manifest.append({
            "file": path.name,
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            "source": (
                "https://github.com/nflverse/nflverse-data/releases/"
                "tag/snap_counts"
            ),
            "upstream": "Pro Football Reference via nflverse",
            "featureCutoff": (
                f"Completed {season} regular season; used only for target "
                f"seasons {season + 1} or later"
            ),
        })
    return history, manifest, {
        "seasons": [min(seasons), max(seasons)] if seasons else [],
        "regularSeasonRows": eligible_rows,
        "validIdentityAndSnapRows": joined_rows,
        "players": len(history),
        "playerSeasons": sum(len(values) for values in history.values()),
    }


def augment(dataset: pd.DataFrame, history: dict[str, dict[int, float]]) -> pd.DataFrame:
    result = dataset.copy()
    for column in ADDED_FEATURES:
        result[column] = np.nan
    for index, row in result.iterrows():
        values = [
            finite(history.get(str(row["player_id"]), {}).get(int(row["season"]) - lag))
            for lag in (1, 2, 3)
        ]
        for lag, value in enumerate(values, start=1):
            result.at[index, f"snap_share_lag{lag}"] = value
        present = [
            (value, weight)
            for value, weight in zip(values, (0.60, 0.27, 0.13))
            if math.isfinite(value)
        ]
        result.at[index, "snap_share_ewma"] = (
            sum(value * weight for value, weight in present)
            / sum(weight for _, weight in present)
            if present else math.nan
        )
        result.at[index, "snap_share_trend"] = (
            values[0] - values[1]
            if math.isfinite(values[0]) and math.isfinite(values[1])
            else 0.0
        )
    return result


def strict_locked_gate(control: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Require strict improvement in every locked cohort fold/format metric."""
    comparisons: list[dict[str, Any]] = []
    reasons: list[str] = []
    for scoring in ("STD", "PPR"):
        for scope in ("aggregate", "2023", "2024", "2025"):
            baseline = (
                control["lockedDraftableVeterans"][scoring]["aggregate"]
                if scope == "aggregate"
                else control["lockedDraftableVeterans"][scoring]["folds"][scope]
            )
            test = (
                candidate["lockedDraftableVeterans"][scoring]["aggregate"]
                if scope == "aggregate"
                else candidate["lockedDraftableVeterans"][scoring]["folds"][scope]
            )
            for metric in ("mae", "rmse", "bias", "spearman"):
                before = baseline[metric]
                after = test[metric]
                if metric == "bias":
                    improved = abs(after) < abs(before)
                elif metric == "spearman":
                    improved = (
                        before is not None and after is not None and after > before
                    )
                else:
                    improved = after < before
                comparisons.append({
                    "scoring": scoring, "scope": scope, "metric": metric,
                    "baseline": before, "candidate": after, "improved": improved,
                })
                if not improved:
                    reasons.append(
                        f"{scoring} {scope} {metric} did not strictly improve"
                    )
    return {
        "accepted": not reasons,
        "policy": (
            "For the preseason-locked draftable-veteran cohort, MAE, RMSE, "
            "absolute bias, and Spearman must each strictly improve in STD and "
            "PPR, both aggregate and separately in every 2023-2025 fold."
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
        default=Path("data/research/owned-model-snap-opportunity.json"),
    )
    args = parser.parse_args()

    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    snap_history, snap_manifest, coverage = load_snap_history(args.data_dir, players)
    augmented = augment(dataset, snap_history)

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
                column: int(rows[column].notna().sum()) for column in ADDED_FEATURES
            },
            "control": control,
            "candidate": candidate,
            "acceptance": strict_locked_gate(control, candidate),
        }

    accepted_positions = [
        position for position, value in positions.items()
        if value["acceptance"]["accepted"]
    ]
    report = {
        "schemaVersion": 1,
        "researchStatus": (
            "eligible-for-independent-review" if accepted_positions else "rejected"
        ),
        "researchOnly": True,
        "productionChanged": False,
        "baselineModelVersion": MODEL_VERSION,
        "experiment": "prior-season-offensive-snap-share-v1",
        "hypothesis": (
            "Weighted offensive snap share and its lagged trend add durable "
            "opportunity/availability information beyond prior fantasy output, "
            "box-score volume, depth rank, and returning team share."
        ),
        "design": (
            "One fixed five-feature family; no hyperparameter, blend, cohort, "
            "season, or threshold search. Production-identical learners and "
            "nested expanding-season stack. Snap features for a target season "
            "use only completed regular seasons ending at target season minus one."
        ),
        "signalAudit": {
            "alreadyInProduction": [
                "targets and receptions",
                "target share, air-yards share, and WOPR",
                "passing, rushing, and receiving EPA",
                "team attempts/carries/targets and returning opportunity shares",
                "preseason depth rank and team-change indicator",
            ],
            "alreadyTestedAndRejectedElsewhere": [
                "CPOE and PACR",
                "yards, touchdowns, first downs, and explosive plays per opportunity",
                "catch rate, RACR, sacks, and fumbles",
                "depth-based opportunity allocation",
            ],
            "boundedCandidateHere": (
                "Exact-PFR-ID regular-season offensive snap share, lagged one "
                "to three completed seasons with fixed EWMA and trend."
            ),
            "remainingResearchOnly": (
                "Play-level on-field/personnel participation can be aggregated "
                "separately, but substantially overlaps snap exposure and was "
                "not opened as a second adaptive family after this result."
            ),
        },
        "addedFeatures": list(ADDED_FEATURES),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "snapCoverage": coverage,
        "inputManifest": snap_manifest,
        "positions": positions,
        "decision": {
            "acceptedPositions": accepted_positions,
            "productionAction": (
                "No production change. Retain v2026.12. "
                + (
                    "Any accepted position still requires independent review."
                    if accepted_positions
                    else "The fixed snap-share family failed the locked stability gate."
                )
            ),
        },
        "limitations": [
            "Snap counts are PFR-derived and joined only by exact PFR player ID.",
            "Rookies have no prior-season snap history and are not evaluated by the veteran gate.",
            "The v2026.12 WR-rookie specialist is orthogonal because this experiment evaluates veterans.",
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "out": str(args.out),
        "acceptedPositions": accepted_positions,
        "failures": {
            position: len(value["acceptance"]["reasons"])
            for position, value in positions.items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
