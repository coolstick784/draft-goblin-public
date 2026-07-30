"""Research-only audit of historical franchise-alias normalization.

nflverse season stats normalize relocated franchises to their current
abbreviations, while historical depth-chart files retain the abbreviation used
at the time.  The production join therefore misses STL/LA, SD/LAC, and OAK/LV
team context and can label a player who stayed with the same franchise as
having changed teams.  This fixed audit changes only those three aliases and
uses the existing nested chronological evaluation harness.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

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
ALIASES = {"STL": "LA", "SD": "LAC", "OAK": "LV"}
POSITIONS = ("QB", "RB", "WR", "TE")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_roles(
    roles: dict[tuple[int, str], dict[str, Any]],
) -> tuple[dict[tuple[int, str], dict[str, Any]], dict[str, Any]]:
    corrected: dict[tuple[int, str], dict[str, Any]] = {}
    mapped: dict[str, int] = {source: 0 for source in ALIASES}
    seasons: dict[str, int] = {}
    for key, role in roles.items():
        value = dict(role)
        source = str(value.get("team") or "").strip().upper()
        if source in ALIASES:
            value["team"] = ALIASES[source]
            mapped[source] += 1
            seasons[str(key[0])] = seasons.get(str(key[0]), 0) + 1
        corrected[key] = value
    return corrected, {
        "aliasMap": ALIASES,
        "mappedRoleRows": sum(mapped.values()),
        "mappedByAlias": mapped,
        "mappedBySeason": seasons,
    }


def feature_difference(
    baseline: pd.DataFrame,
    corrected: pd.DataFrame,
) -> dict[str, Any]:
    keys = [
        "team_changed",
        "team_attempts_pg",
        "team_carries_pg",
        "team_targets_pg",
        "team_ppr_pg",
        "returning_carry_share",
        "returning_target_share",
        "returning_ppr_share",
        "position_competition",
    ]
    result: dict[str, Any] = {"rows": int(len(baseline)), "features": {}}
    for column in keys:
        left = pd.to_numeric(baseline[column], errors="coerce")
        right = pd.to_numeric(corrected[column], errors="coerce")
        changed = ~(left.eq(right) | (left.isna() & right.isna()))
        result["features"][column] = {
            "changedRows": int(changed.sum()),
            "changed2023To2025": int(
                (changed & baseline["season"].isin(HARNESS.EVALUATION_SEASONS)).sum()
            ),
        }
    return result


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
        default=Path("data/research/owned-model-team-alias-correction.json"),
    )
    args = parser.parse_args()

    stats, stats_manifest = load_stats(args.data_dir)
    players, players_manifest = load_players(args.data_dir / "players.csv")
    picks, draft_manifest = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    corrected_roles, correction = normalized_roles(roles)
    baseline, features = build_dataset(stats, players, roles)
    corrected, corrected_features = build_dataset(stats, players, corrected_roles)
    if features != corrected_features:
        raise RuntimeError("Alias correction unexpectedly changed the feature schema.")
    if not baseline[["player_id", "season", "position"]].equals(
        corrected[["player_id", "season", "position"]]
    ):
        raise RuntimeError("Alias correction unexpectedly changed the evaluation cohort.")

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only historical team-alias join correction",
        "baseModelVersion": MODEL_VERSION,
        "productionChanged": False,
        "method": (
            "Compare the production dataset with an otherwise byte-equivalent "
            "dataset whose historical depth-chart club codes map only STL to LA, "
            "SD to LAC, and OAK to LV before team-context and team-change joins. "
            "Both candidates use identical nested expanding-season learners, "
            "baseline-locked draftable cohorts, and 2023-2025 folds."
        ),
        "featureCutoff": (
            "Only the preseason depth role and completed prior-season statistics "
            "are used; franchise aliases are static identity corrections."
        ),
        "correction": correction,
        "featureDifference": feature_difference(baseline, corrected),
        "inputDigests": {
            "stats": [item["sha256"] for item in stats_manifest],
            "players": players_manifest["sha256"],
            "draftPicks": draft_manifest["sha256"],
            "depthCharts": [item["sha256"] for item in depth_manifest],
        },
        "positions": {},
        "decision": {},
    }

    for position in POSITIONS:
        baseline_rows = baseline[baseline["position"].eq(position)].copy()
        corrected_rows = corrected[corrected["position"].eq(position)].copy()
        baseline_oof = HARNESS.oof_components(baseline_rows, features, position)
        locked_ids = HARNESS.locked_draftable_ids(baseline_oof, position)
        control = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(baseline_oof),
            baseline_rows,
            position,
            locked_ids,
        )
        candidate = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(
                HARNESS.oof_components(corrected_rows, features, position)
            ),
            corrected_rows,
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
                "Eligible for reviewed correction only if the complete-model "
                "audit also passes."
                if acceptance["accepted"]
                else "Retain the current join for this position."
            ),
        }

    report["overallDecision"] = {
        "acceptedPositions": [
            position
            for position, value in report["decision"].items()
            if value["accepted"]
        ],
        "productionChanged": False,
        "adaptiveDevelopmentCaveat": (
            "The correction is evaluated on adaptively reused development folds. "
            "Even a passing result is not prospective superiority evidence."
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
        "correction": correction,
        "decision": report["overallDecision"],
    }, indent=2))


if __name__ == "__main__":
    main()
