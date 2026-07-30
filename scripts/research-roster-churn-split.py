"""Research-only audit of incumbent, incoming, and vacated opportunity.

The production model already knows whether an individual changed teams and
the total prior production represented on the target preseason depth chart.
That aggregate combines returning incumbents with offseason arrivals.  This
fixed feature family splits those two mechanisms and records same-position
depth churn.  It uses only completed prior-season stats and the target
preseason depth snapshot.
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
POSITIONS = ("QB", "RB", "WR", "TE")
VOLUME_STATS = ("carries", "targets", "fantasy_points_ppr")
ADDED_FEATURES = (
    "churn_incumbent_carry_share",
    "churn_incumbent_target_share",
    "churn_incumbent_ppr_share",
    "churn_incoming_carry_share",
    "churn_incoming_target_share",
    "churn_incoming_ppr_share",
    "churn_vacated_carry_share",
    "churn_vacated_target_share",
    "churn_vacated_ppr_share",
    "churn_incumbent_top3_count",
    "churn_incoming_top3_count",
    "churn_rookie_top3_count",
    "churn_top3_retention_share",
    "churn_top3_added_count",
    "churn_top3_lost_count",
    "churn_missing",
)


def number(value: Any, default: float = 0.0) -> float:
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_contexts(
    stats: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
) -> tuple[dict[tuple[int, str, str], dict[str, float]], dict[str, Any]]:
    histories: dict[str, dict[int, dict[str, Any]]] = {}
    totals: dict[tuple[int, str], dict[str, float]] = {}
    for row in stats.to_dict("records"):
        player_id = str(row.get("player_id") or "")
        season = int(row["season"])
        histories.setdefault(player_id, {})[season] = row
        if str(row.get("position") or "").upper() not in POSITIONS:
            continue
        team = str(row.get("recent_team") or "")
        if not team:
            continue
        record = totals.setdefault(
            (season, team),
            {"carries": 0.0, "targets": 0.0, "fantasy_points_ppr": 0.0},
        )
        for stat in VOLUME_STATS:
            record[stat] += number(row.get(stat))

    top3: dict[tuple[int, str, str], set[str]] = {}
    for (season, player_id), role in roles.items():
        team = str(role.get("team") or "")
        position = str(role.get("position") or "").upper()
        if (
            team
            and position in POSITIONS
            and number(role.get("rank"), 99.0) <= 3.0
        ):
            top3.setdefault((season, team, position), set()).add(player_id)

    represented: dict[tuple[int, str], dict[str, dict[str, float]]] = {}
    top3_counts: dict[tuple[int, str, str], dict[str, float]] = {}
    for (season, player_id), role in roles.items():
        team = str(role.get("team") or "")
        position = str(role.get("position") or "").upper()
        if not team or position not in POSITIONS:
            continue
        prior = histories.get(player_id, {}).get(season - 1)
        prior_team = str((prior or {}).get("recent_team") or "")
        category = (
            "incumbent"
            if prior is not None and prior_team == team
            else "incoming"
            if prior is not None and prior_team
            else "rookie"
        )
        team_record = represented.setdefault(
            (season, team),
            {
                "incumbent": {stat: 0.0 for stat in VOLUME_STATS},
                "incoming": {stat: 0.0 for stat in VOLUME_STATS},
            },
        )
        if prior is not None and category in ("incumbent", "incoming"):
            for stat in VOLUME_STATS:
                team_record[category][stat] += number(prior.get(stat))
        if number(role.get("rank"), 99.0) <= 3.0:
            counts = top3_counts.setdefault(
                (season, team, position),
                {"incumbent": 0.0, "incoming": 0.0, "rookie": 0.0},
            )
            counts[category] += 1.0

    contexts: dict[tuple[int, str, str], dict[str, float]] = {}
    target_seasons = sorted({season for season, _ in roles})
    target_teams = sorted({(season, str(role.get("team") or "")) for (season, _), role in roles.items()})
    for season, team in target_teams:
        total = totals.get((season - 1, team))
        represented_team = represented.get((season, team))
        if not team or total is None or represented_team is None:
            continue
        for position in POSITIONS:
            values: dict[str, float] = {}
            for short, stat in (
                ("carry", "carries"),
                ("target", "targets"),
                ("ppr", "fantasy_points_ppr"),
            ):
                denominator = max(1.0, total[stat])
                incumbent = represented_team["incumbent"][stat] / denominator
                incoming = represented_team["incoming"][stat] / denominator
                values[f"churn_incumbent_{short}_share"] = incumbent
                values[f"churn_incoming_{short}_share"] = incoming
                values[f"churn_vacated_{short}_share"] = min(
                    1.0, max(0.0, 1.0 - incumbent)
                )
            counts = top3_counts.get(
                (season, team, position),
                {"incumbent": 0.0, "incoming": 0.0, "rookie": 0.0},
            )
            current = top3.get((season, team, position), set())
            previous = top3.get((season - 1, team, position), set())
            values.update({
                "churn_incumbent_top3_count": counts["incumbent"],
                "churn_incoming_top3_count": counts["incoming"],
                "churn_rookie_top3_count": counts["rookie"],
                "churn_top3_retention_share": (
                    len(current & previous) / len(previous)
                    if previous else np.nan
                ),
                "churn_top3_added_count": float(len(current - previous)),
                "churn_top3_lost_count": float(len(previous - current)),
                "churn_missing": 0.0,
            })
            contexts[(season, team, position)] = values

    return contexts, {
        "targetSeasons": [min(target_seasons), max(target_seasons)]
        if target_seasons else [],
        "contexts": len(contexts),
        "featureCount": len(ADDED_FEATURES),
        "definition": (
            "Incumbents have prior-season stats for the same exact team code; "
            "incoming veterans have prior-season stats for a different team; "
            "rookies have no prior-season stat row. Top-three churn compares "
            "preseason depth identities at the same team and position."
        ),
    }


def augment(
    dataset: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    contexts: dict[tuple[int, str, str], dict[str, float]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    for column in ADDED_FEATURES:
        result[column] = np.nan
    mapped = 0
    for index, row in result.iterrows():
        role = roles.get((int(row["season"]), str(row["player_id"])), {})
        key = (
            int(row["season"]),
            str(role.get("team") or ""),
            str(row["position"]),
        )
        values = contexts.get(key)
        if values is None:
            result.at[index, "churn_missing"] = 1.0
            continue
        mapped += 1
        for column, value in values.items():
            result.at[index, column] = value
    evaluation = result[
        result["season"].isin(HARNESS.EVALUATION_SEASONS)
        & result["position"].isin(POSITIONS)
    ]
    return result, {
        "rows": int(len(result)),
        "mappedRows": mapped,
        "evaluationRows": int(len(evaluation)),
        "mappedEvaluationRows": int(evaluation["churn_missing"].eq(0.0).sum()),
        "evaluationCoverage": float(evaluation["churn_missing"].eq(0.0).mean()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data/private/owned-model/raw"),
    )
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/research/owned-model-roster-churn-split.json"),
    )
    args = parser.parse_args()

    stats, stats_manifest = load_stats(args.data_dir)
    players, players_manifest = load_players(args.data_dir / "players.csv")
    picks, draft_manifest = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    contexts, context_coverage = build_contexts(stats, roles)
    augmented, row_coverage = augment(dataset, roles, contexts)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only roster churn and vacated opportunity split",
        "baseModelVersion": MODEL_VERSION,
        "productionChanged": False,
        "method": (
            "Add one fixed team-context family that separates prior production "
            "from same-team incumbents and different-team arrivals, derives "
            "vacated opportunity from incumbents only, and records exact "
            "same-position top-three depth churn. Evaluate with production-"
            "identical learners, baseline-locked draftable cohorts, nested "
            "expanding-season weights, and 2023-2025 folds."
        ),
        "featureCutoff": (
            "Target season S uses only completed S-1 player stats plus the "
            "leakage-safe preseason depth snapshots for S and earlier."
        ),
        "addedFeatures": list(ADDED_FEATURES),
        "contextCoverage": context_coverage,
        "rowCoverage": row_coverage,
        "inputDigests": {
            "stats": [item["sha256"] for item in stats_manifest],
            "players": players_manifest["sha256"],
            "draftPicks": draft_manifest["sha256"],
            "depthCharts": [item["sha256"] for item in depth_manifest],
        },
        "positions": {},
        "decision": {},
    }
    feature_columns = production_features + list(ADDED_FEATURES)
    for position in POSITIONS:
        rows = augmented[augmented["position"].eq(position)].copy()
        baseline_oof = HARNESS.oof_components(rows, production_features, position)
        locked_ids = HARNESS.locked_draftable_ids(baseline_oof, position)
        control = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(baseline_oof),
            rows,
            position,
            locked_ids,
        )
        candidate = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(
                HARNESS.oof_components(rows, feature_columns, position)
            ),
            rows,
            position,
            locked_ids,
        )
        acceptance = HARNESS.acceptance(control, candidate)
        report["positions"][position] = {
            "control": control,
            "candidate": candidate,
            "acceptance": acceptance,
        }
        report["decision"][position] = {
            "accepted": acceptance["accepted"],
            "productionAction": (
                "Eligible for separate reviewed integration."
                if acceptance["accepted"]
                else "Reject the fixed family for this position."
            ),
        }

    accepted = [
        position
        for position, value in report["decision"].items()
        if value["accepted"]
    ]
    report["overallDecision"] = {
        "acceptedPositions": accepted,
        "productionChanged": False,
        "adaptiveDevelopmentCaveat": (
            "The 2023-2025 folds have been adaptively reused. This result can "
            "screen a challenger but cannot establish prospective superiority."
        ),
    }
    report["scriptSha256"] = sha256_file(Path(__file__))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "out": str(args.out),
        "coverage": row_coverage,
        "decision": report["overallDecision"],
    }, indent=2))


if __name__ == "__main__":
    main()
