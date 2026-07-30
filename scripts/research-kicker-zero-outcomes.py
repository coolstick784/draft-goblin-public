"""Audit kicker survivorship bias without changing the production pipeline.

The regular-season stats release omits players who recorded no statistics.
This harness adds a zero outcome only when that player appeared on the
preseason/week-one depth snapshot as a K/PK and had no stats row that season,
then reruns the exact owned-model walk-forward evaluation.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    LAG_STATS,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_players,
    load_stats,
    train_owned_model,
)


def add_kicker_zero_outcomes(stats: pd.DataFrame, roles: dict, last_completed_season: int) -> tuple[pd.DataFrame, list[dict]]:
    existing = set(zip(pd.to_numeric(stats["season"], errors="coerce").astype(int), stats["player_id"].astype(str)))
    first_target = int(pd.to_numeric(stats["season"], errors="coerce").min()) + 2
    additions = []
    audit = []
    for (season, player_id), role in sorted(roles.items()):
        position = str(role.get("position") or "").upper()
        if season < first_target or season > last_completed_season or position not in {"K", "PK"}:
            continue
        if (season, str(player_id)) in existing:
            continue
        row = {
            "player_id": str(player_id), "player_display_name": str(player_id),
            "position": "K", "season": int(season), "games": 0,
            "fantasy_points": 0.0, "fantasy_points_ppr": 0.0,
            "recent_team": str(role.get("team") or ""),
        }
        row.update({column: 0.0 for column in LAG_STATS if column not in row})
        additions.append(row)
        audit.append({
            "season": int(season), "playerId": str(player_id),
            "team": str(role.get("team") or ""), "depthRank": role.get("rank"),
        })
    if not additions:
        return stats.copy(), audit
    return pd.concat([stats, pd.DataFrame(additions)], ignore_index=True), audit


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--output", default="data/research/kicker-zero-outcome-audit.json")
    args = parser.parse_args()
    root = Path(args.data_dir)
    stats, stats_manifest = load_stats(root)
    players, players_manifest = load_players(Path(args.players))
    picks, picks_manifest = load_draft_picks(Path(args.draft_picks))
    players, enrichment = enrich_players_with_draft_picks(players, picks)
    dst, dst_players, dst_manifest = load_dst_stats(root, root / "games.csv")
    roles, depth_manifest = load_depth_charts(root, args.season)
    completed = args.season - 1
    augmented, audit = add_kicker_zero_outcomes(stats, roles, completed)
    combined_stats = pd.concat([augmented, dst], ignore_index=True)
    combined_players = pd.concat([players, dst_players], ignore_index=True)
    dataset, features = build_dataset(combined_stats, combined_players, roles)
    _, report = train_owned_model(
        dataset, features,
        [*stats_manifest, players_manifest, picks_manifest, {"draftPickEnrichment": enrichment}, *dst_manifest, *depth_manifest],
    )
    result = {
        "schemaVersion": 1, "researchOnly": True, "productionChanged": False,
        "method": "Zero outcome iff a completed-season K/PK depth snapshot row has no regular-season stats row.",
        "addedExamples": audit,
        "kickerEvaluation": report["positions"]["K"],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output), "addedExamples": len(audit),
        "seasons": sorted({row["season"] for row in audit}),
        "PPR": result["kickerEvaluation"]["seasonTotals"]["PPR"],
        "folds": result["kickerEvaluation"]["seasonTotalFolds"],
    }, indent=2))


if __name__ == "__main__":
    main()
