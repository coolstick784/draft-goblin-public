"""Audit licensed Week-1 betting-market and named-QB context.

The fixed feature family uses only target-season Week-1 schedule rows from the
CC-BY nflverse schedules release: game total, signed team spread, implied team
points, home status, and whether the player is the named starting quarterback.
No provider projection is an input.  Every evaluation stack remains nested and
chronological through the shared schedule-audit harness.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (
    CORE_POSITIONS,
    MODEL_VERSION,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_players,
    load_stats,
    utc_now,
)


BASE_PATH = Path(__file__).with_name("research-schedule-team-environment.py")
SPEC = importlib.util.spec_from_file_location("schedule_audit", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {BASE_PATH}")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)

FEATURES = (
    "week1_market_total",
    "week1_team_spread_strength",
    "week1_team_implied_points",
    "week1_home",
    "week1_named_qb",
)


def normalized_name(value: Any) -> str:
    return "".join(character for character in str(value or "").lower() if character.isalnum())


def market_contexts(games: pd.DataFrame) -> dict[tuple[int, str], dict[str, Any]]:
    rows = games[
        games["game_type"].astype(str).eq("REG")
        & pd.to_numeric(games["week"], errors="coerce").eq(1)
    ]
    output: dict[tuple[int, str], dict[str, Any]] = {}
    for row in rows.to_dict("records"):
        season = int(row["season"])
        total = BASE.number(row.get("total_line"))
        home_strength = BASE.number(row.get("spread_line"))
        home = BASE.canonical_team(row.get("home_team"))
        away = BASE.canonical_team(row.get("away_team"))
        for team, strength, is_home, qb_name in (
            (home, home_strength, 1.0, row.get("home_qb_name")),
            (away, -home_strength, 0.0, row.get("away_qb_name")),
        ):
            output[(season, team)] = {
                "week1_market_total": total,
                "week1_team_spread_strength": strength,
                "week1_team_implied_points": (
                    total / 2.0 + strength / 2.0
                    if math.isfinite(total) and math.isfinite(strength)
                    else math.nan
                ),
                "week1_home": is_home,
                "named_qb": normalized_name(qb_name),
            }
    return output


def augment(
    dataset: pd.DataFrame,
    stats: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    contexts: dict[tuple[int, str], dict[str, Any]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    for feature in FEATURES:
        result[feature] = np.nan
    previous_team = {
        (int(row["season"]) + 1, str(row["player_id"])): BASE.canonical_team(
            row.get("recent_team")
        )
        for row in stats.to_dict("records")
    }
    matched = 0
    named_qb_matches = 0
    for index, row in result.iterrows():
        season, player_id = int(row["season"]), str(row["player_id"])
        if player_id.startswith("DST:"):
            team = BASE.canonical_team(player_id.split(":", 1)[1])
        else:
            team = BASE.canonical_team(roles.get((season, player_id), {}).get("team"))
            team = team or previous_team.get((season, player_id), "")
        context = contexts.get((season, team))
        if not context:
            continue
        matched += 1
        for feature in FEATURES[:-1]:
            result.at[index, feature] = BASE.number(context.get(feature))
        named = bool(context.get("named_qb")) and normalized_name(row.get("name")) == context["named_qb"]
        result.at[index, "week1_named_qb"] = 1.0 if named else 0.0
        named_qb_matches += int(named)
    return result, {
        "rows": int(len(result)),
        "rowsWithWeek1Market": matched,
        "rowCoverage": round(matched / max(1, len(result)), 6),
        "namedQbMatches": named_qb_matches,
        "bySeason": {
            str(season): int(
                result[result["season"].eq(season)]["week1_market_total"].notna().sum()
            )
            for season in sorted(int(value) for value in result["season"].unique())
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("data/private/owned-model/raw"))
    parser.add_argument(
        "--out", type=Path, default=Path("data/research/owned-model-week1-market-context.json")
    )
    args = parser.parse_args()
    for variable in (
        "LOKY_MAX_CPU_COUNT",
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ[variable] = "1"

    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dst_stats, dst_players, _ = load_dst_stats(args.data_dir, args.data_dir / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, production_features = build_dataset(stats, players, roles)
    games = pd.read_csv(args.data_dir / "games.csv", low_memory=False)
    contexts = market_contexts(games)
    dataset, coverage = augment(dataset, stats, roles, contexts)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only Week-1 market context audit",
        "baselineModelVersion": MODEL_VERSION,
        "generatedAt": utc_now(),
        "method": (
            "A fixed five-feature family from target-season Week-1 nflverse schedule "
            "lines and named quarterbacks is tested with expanding OOF base fits and "
            "nested earlier-season-only stacks for 2023-2025."
        ),
        "source": "nflverse schedules release",
        "license": "CC-BY-4.0",
        "providerProjectionInputsUsed": False,
        "features": list(FEATURES),
        "coverage": coverage,
        "depthChartCaveat": [
            item["featureCutoff"]
            for item in depth_manifest
            if str(item.get("file", "")).endswith(("2023.csv", "2024.csv.gz", "2025.csv.gz"))
        ],
        "positions": {},
        "decision": {},
    }
    records = {"control": [], "candidate": []}
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"].eq(position)].copy()
        baseline_oof = BASE.build_oof(rows, production_features, position)
        locked_ids = BASE.locked_draftable_ids(baseline_oof, position)
        specialist = BASE.wr_rookie_specialist_oof(rows, production_features) if position == "WR" else None
        baseline_nested, baseline_parameters = BASE.nested_predictions(
            baseline_oof, force_empirical=position == "DST"
        )
        control, control_records = BASE.evaluate_predictions(
            baseline_nested, rows, position, locked_ids, specialist
        )
        candidate_oof = BASE.build_oof(rows, [*production_features, *FEATURES], position)
        candidate_nested, candidate_parameters = BASE.nested_predictions(candidate_oof)
        candidate, candidate_records = BASE.evaluate_predictions(
            candidate_nested, rows, position, locked_ids, specialist
        )
        for label, values in (("control", control_records), ("candidate", candidate_records)):
            for record in values:
                record.update({"position": position, "variant": label})
            records[label].extend(values)
        gate = BASE.acceptance(control, candidate)
        report["positions"][position] = {
            "control": control,
            "candidate": candidate,
            "controlParameters": baseline_parameters,
            "candidateParameters": candidate_parameters,
            "acceptance": gate,
        }
        report["decision"][position] = gate["accepted"]
    pooled_control = BASE.pooled_metrics(records["control"])
    pooled_candidate = BASE.pooled_metrics(records["candidate"])
    pooled_gate = BASE.acceptance(pooled_control, pooled_candidate)
    report["pooled"] = {
        "control": pooled_control,
        "candidate": pooled_candidate,
        "acceptance": pooled_gate,
    }
    report["acceptedAllPositionsAndPooled"] = pooled_gate["accepted"] and all(report["decision"].values())
    report["researchStatus"] = "accepted-for-production-review" if report["acceptedAllPositionsAndPooled"] else "rejected"
    report["productionChanged"] = False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "coverage": coverage, "decision": report["decision"], "pooledAccepted": pooled_gate["accepted"], "status": report["researchStatus"]}, indent=2))


if __name__ == "__main__":
    main()
