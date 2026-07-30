"""Bounded audit of rookie survivorship in the owned-model training cohort.

The NFL draft is a preseason-known population, so exact-GSIS drafted
QB/RB/WR/TE players can be followed into the completed player-stat release
without selecting on whether they produced statistics.  This audit measures
that bounded population.  It deliberately does not manufacture a games-played
label: absence from the player-stat release proves no *recorded offensive
fantasy production*, not that the player was inactive for every game.

The result is descriptive research only.  It neither changes the owned model
nor the live consensus.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import MODEL_VERSION, load_depth_charts, utc_now  # noqa: E402

POSITIONS = ("QB", "RB", "WR", "TE")
FIRST_AUDIT_SEASON = 2014
LAST_AUDIT_SEASON = 2025
SELECTION_SEASON = 2022
DEVELOPMENT_SEASONS = (2023, 2024, 2025)
GSIS_PATTERN = re.compile(r"00-\d{7}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def finite_number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def metric_summary(values: pd.Series) -> dict[str, float]:
    numeric = pd.to_numeric(values, errors="coerce").fillna(0.0)
    return {
        "mean": float(numeric.mean()) if len(numeric) else 0.0,
        "median": float(numeric.median()) if len(numeric) else 0.0,
    }


def cohort_summary(rows: pd.DataFrame) -> dict[str, Any]:
    exact = rows[rows["exactGsis"]].copy()
    participant = exact[exact["productionStatsRow"]]
    expanded = exact.copy()
    expanded["expandedStd"] = expanded["stdPoints"].where(
        expanded["anyStatsRow"], 0.0
    )
    expanded["expandedPpr"] = expanded["pprPoints"].where(
        expanded["anyStatsRow"], 0.0
    )
    participant_std = metric_summary(participant["stdPoints"])
    participant_ppr = metric_summary(participant["pprPoints"])
    expanded_std = metric_summary(expanded["expandedStd"])
    expanded_ppr = metric_summary(expanded["expandedPpr"])

    def optimism(participant_metric: dict[str, float], expanded_metric: dict[str, float]) -> dict[str, float | None]:
        difference = participant_metric["mean"] - expanded_metric["mean"]
        return {
            "meanPointDifference": float(difference),
            "participantMeanPercentAboveExpanded": (
                float(difference / expanded_metric["mean"] * 100.0)
                if expanded_metric["mean"] != 0.0
                else None
            ),
        }

    return {
        "draftedRows": int(len(rows)),
        "exactGsisRows": int(len(exact)),
        "unresolvedIdentityRows": int((~rows["exactGsis"]).sum()),
        "metadataMatchedRows": int(exact["metadataMatched"].sum()),
        "productionParticipantRows": int(exact["productionStatsRow"].sum()),
        "statsRowsReclassifiedOutsideDraftPosition": int(
            (exact["anyStatsRow"] & ~exact["productionStatsRow"]).sum()
        ),
        "zeroRecordedProductionRows": int((~exact["anyStatsRow"]).sum()),
        "zeroRecordedProductionRate": (
            float((~exact["anyStatsRow"]).mean()) if len(exact) else 0.0
        ),
        "lowParticipationAmongStatsRows": {
            "gamesAtMostOne": int(
                (exact["anyStatsRow"] & (exact["games"] <= 1.0)).sum()
            ),
            "gamesAtMostThree": int(
                (exact["anyStatsRow"] & (exact["games"] <= 3.0)).sum()
            ),
        },
        "participantOnlyTotals": {
            "STD": participant_std,
            "PPR": participant_ppr,
        },
        "expandedDraftedTotals": {
            "STD": expanded_std,
            "PPR": expanded_ppr,
        },
        "participantOnlyOptimism": {
            "STD": optimism(participant_std, expanded_std),
            "PPR": optimism(participant_ppr, expanded_ppr),
        },
    }


def build_rows(
    draft_picks: pd.DataFrame,
    players: pd.DataFrame,
    all_stats: pd.DataFrame,
) -> pd.DataFrame:
    picks = draft_picks.copy()
    picks["season"] = pd.to_numeric(picks["season"], errors="coerce")
    picks["position"] = picks["position"].fillna("").astype(str).str.upper()
    picks["gsis_id"] = picks["gsis_id"].fillna("").astype(str).str.strip()
    picks = picks[
        picks["season"].between(FIRST_AUDIT_SEASON, LAST_AUDIT_SEASON)
        & picks["position"].isin(POSITIONS)
    ].copy()
    picks["season"] = picks["season"].astype(int)
    if picks.duplicated(["season", "pick"], keep=False).any():
        raise ValueError("Draft population contains duplicate season/pick rows.")

    players = players.copy()
    players["gsis_id"] = players["gsis_id"].fillna("").astype(str).str.strip()
    player_ids = set(players["gsis_id"])

    stats = all_stats.copy()
    stats["season"] = pd.to_numeric(stats["season"], errors="raise").astype(int)
    stats["player_id"] = stats["player_id"].fillna("").astype(str).str.strip()
    stats["position"] = stats["position"].fillna("").astype(str).str.upper()
    stats = stats.sort_values(["season", "player_id"]).drop_duplicates(
        ["season", "player_id"], keep="last"
    )
    stats_index = {
        (int(row["season"]), str(row["player_id"])): row
        for row in stats.to_dict("records")
    }

    output: list[dict[str, Any]] = []
    for pick in picks.to_dict("records"):
        season = int(pick["season"])
        player_id = str(pick["gsis_id"])
        position = str(pick["position"])
        exact = bool(GSIS_PATTERN.fullmatch(player_id))
        stat = stats_index.get((season, player_id)) if exact else None
        stat_position = str((stat or {}).get("position") or "").upper()
        output.append(
            {
                "season": season,
                "position": position,
                "playerId": player_id,
                "exactGsis": exact,
                "metadataMatched": exact and player_id in player_ids,
                "anyStatsRow": stat is not None,
                "productionStatsRow": (
                    stat is not None and stat_position in POSITIONS
                ),
                "statsPosition": stat_position or None,
                "games": finite_number((stat or {}).get("games")),
                "stdPoints": finite_number((stat or {}).get("fantasy_points")),
                "pprPoints": finite_number(
                    (stat or {}).get("fantasy_points_ppr")
                ),
            }
        )
    return pd.DataFrame(output)


def run(args: argparse.Namespace) -> dict[str, Any]:
    raw = Path(args.data_dir)
    draft_path = Path(args.draft_picks)
    players_path = Path(args.players)
    stat_paths = sorted(raw.glob("stats_player_reg_*.csv"))
    if not stat_paths:
        raise FileNotFoundError(f"No player-stat files found under {raw}")
    draft_picks = pd.read_csv(draft_path, low_memory=False)
    players = pd.read_csv(players_path, low_memory=False)
    all_stats = pd.concat(
        [pd.read_csv(path, low_memory=False) for path in stat_paths],
        ignore_index=True,
    )
    rows = build_rows(draft_picks, players, all_stats)

    # Historical depth rows are useful for measuring overlap, but their current
    # downloadable bytes do not prove a pre-kickoff capture for 2014-2024.
    roles, depth_manifest = load_depth_charts(raw, LAST_AUDIT_SEASON + 1)
    role_keys = set(roles)
    rows["depthRolePresent"] = [
        (int(row.season), str(row.playerId)) in role_keys
        for row in rows.itertuples(index=False)
    ]
    exact_zero = rows[rows["exactGsis"] & ~rows["anyStatsRow"]]

    by_season = {
        str(season): cohort_summary(group)
        for season, group in rows.groupby("season", sort=True)
    }
    by_position = {
        position: cohort_summary(group)
        for position, group in rows.groupby("position", sort=True)
    }
    windows = {
        "selection2022": cohort_summary(rows[rows["season"] == SELECTION_SEASON]),
        "development2023To2025": cohort_summary(
            rows[rows["season"].isin(DEVELOPMENT_SEASONS)]
        ),
        "wrSelection2022": cohort_summary(
            rows[
                (rows["season"] == SELECTION_SEASON)
                & (rows["position"] == "WR")
            ]
        ),
        "wrDevelopment2023To2025": cohort_summary(
            rows[
                rows["season"].isin(DEVELOPMENT_SEASONS)
                & (rows["position"] == "WR")
            ]
        ),
    }
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "kind": "research-only drafted-rookie survivorship audit",
        "baseModelVersion": MODEL_VERSION,
        "researchStatus": "bounded-data-gap-with-descriptive-impact",
        "productionChanged": False,
        "liveConsensusChanged": False,
        "method": (
            "Enumerate every drafted QB/RB/WR/TE from 2014-2025 before looking "
            "at outcomes. Retain only exact GSIS identities for outcome linkage; "
            "then compare that population with the completed player-stat release."
        ),
        "populationBoundary": {
            "included": (
                "Drafted QB/RB/WR/TE players. Draft slot, declared position, "
                "and name were publicly known after the NFL draft and before "
                "the rookie regular season."
            ),
            "excluded": (
                "Undrafted free agents and unresolved draft identities. The "
                "audit therefore measures a lower bound on participant-only "
                "survivorship, not the complete rookie population."
            ),
            "identityRule": (
                "Exact canonical GSIS only. Present-day GSIS linkage is used "
                "solely to join a preseason-defined draft row to its outcome; "
                "it is not a model feature."
            ),
        },
        "labelFindings": {
            "zeroRecordedFantasyProduction": {
                "status": "defensible-for-bounded-drafted-cohort",
                "meaning": (
                    "No row in the completed nflverse player-stat release, so "
                    "zero recorded offensive STD/PPR production in that release."
                ),
                "limitation": (
                    "This is not proof of zero points under every provider's "
                    "edge-case scoring rules."
                ),
            },
            "zeroGamesPlayed": {
                "status": "not-defensible",
                "reason": (
                    "The player-stat release is production-based. A player may "
                    "appear on an NFL roster, special teams, or offense without "
                    "recording a stat row; draft results and static player "
                    "metadata contain no game-participation outcome."
                ),
            },
        },
        "historicalRosterBoundary": {
            "status": "not-admissible-as-leakage-safe-proof",
            "reason": (
                "The locally available historical roster/injury population is "
                "not frozen before Week 1. Depth-chart rows overlap the cohort, "
                "but current 2014-2024 asset bytes lack independently verifiable "
                "pre-kickoff capture timestamps."
            ),
            "zeroRecordedRowsWithDepthRole": int(
                exact_zero["depthRolePresent"].sum()
            ),
            "zeroRecordedRowsWithoutDepthRole": int(
                (~exact_zero["depthRolePresent"]).sum()
            ),
            "depthArtifacts": depth_manifest,
            "relatedProof": (
                "data/research/owned-model-preseason-availability-data-gap.json"
            ),
        },
        "sourceEvidence": {
            "draftPicks": {
                "file": draft_path.name,
                "sha256": sha256_file(draft_path),
            },
            "players": {
                "file": players_path.name,
                "sha256": sha256_file(players_path),
            },
            "playerStats": [
                {"file": path.name, "sha256": sha256_file(path)}
                for path in stat_paths
                if FIRST_AUDIT_SEASON
                <= int(path.stem.replace(".csv", "").split("_")[-1])
                <= LAST_AUDIT_SEASON
            ],
        },
        "overall": cohort_summary(rows),
        "bySeason": by_season,
        "byPosition": by_position,
        "policyRelevantWindows": windows,
        "decision": {
            "status": "do-not-integrate",
            "reason": (
                "The audit proves material participant-only optimism for the "
                "bounded drafted cohort, but cannot safely create target_games "
                "and omits undrafted rookies. Treat current WR-rookie backtests "
                "as development-only and rely on the immutable prospective 2026 "
                "population for promotion evidence."
            ),
            "productionAction": (
                "Do not alter v12, the live consensus, or the promotion gate."
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument(
        "--players", default="data/private/owned-model/raw/players.csv"
    )
    parser.add_argument(
        "--draft-picks", default="data/private/owned-model/raw/draft_picks.csv"
    )
    parser.add_argument(
        "--output",
        default="data/research/owned-model-rookie-zero-outcome-audit.json",
    )
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "status": report["researchStatus"],
                "overall": report["overall"],
                "policyRelevantWindows": report["policyRelevantWindows"],
                "decision": report["decision"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
