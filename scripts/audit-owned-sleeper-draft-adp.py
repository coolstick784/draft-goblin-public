"""Audit whether the anonymized Sleeper draft corpus can be an owned-model input.

This script quantifies coverage and descriptive predictive association, but it
cannot establish preseason provenance that the sanitized corpus did not retain.
It is therefore a governance audit, not a model feature experiment.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


CORE = {"QB", "RB", "WR", "TE"}
SEASONS = (2022, 2023, 2024, 2025)


def metrics(frame: pd.DataFrame) -> dict[str, Any]:
    if frame.empty:
        return {"rows": 0, "spearmanAdpVsPprTotal": None}
    correlation = frame["normalized_adp"].corr(
        frame["fantasy_points_ppr"], method="spearman"
    )
    by_position = {}
    for position, rows in frame.groupby("position"):
        value = rows["normalized_adp"].corr(
            rows["fantasy_points_ppr"], method="spearman"
        )
        by_position[position] = {
            "rows": int(len(rows)),
            "spearmanAdpVsPprTotal": (
                round(float(value), 4) if pd.notna(value) else None
            ),
        }
    return {
        "rows": int(len(frame)),
        "spearmanAdpVsPprTotal": (
            round(float(correlation), 4) if pd.notna(correlation) else None
        ),
        "byPosition": by_position,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    corpus_path = Path(args.corpus)
    raw = json.loads(corpus_path.read_text(encoding="utf-8"))
    records = [row for row in raw["records"] if int(row["season"]) in SEASONS]
    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))

    picks: list[dict[str, Any]] = []
    draft_counts: dict[int, int] = {}
    scoring_counts: dict[str, int] = {}
    for draft_index, draft in enumerate(records):
        season = int(draft["season"])
        teams = int(draft["teams"])
        draft_counts[season] = draft_counts.get(season, 0) + 1
        scoring = str(draft.get("scoringType") or "unknown")
        scoring_counts[scoring] = scoring_counts.get(scoring, 0) + 1
        for pick in draft["picks"]:
            position = str(pick.get("position") or "").upper()
            if position not in CORE:
                continue
            player_id = str(pick["playerId"])
            metadata = catalog.get(player_id, {})
            gsis_id = str(metadata.get("gsis_id") or "")
            picks.append({
                "season": season,
                "draft_index": draft_index,
                "teams": teams,
                "player_id": player_id,
                "position": position,
                "pick_no": int(pick["pickNo"]),
                "normalized_pick": float(pick["pickNo"]) * 12.0 / teams,
                "catalog_match": bool(metadata),
                "gsis_id": gsis_id,
            })
    pick_frame = pd.DataFrame(picks)
    adp = (
        pick_frame.groupby(["season", "player_id", "position"], as_index=False)
        .agg(
            normalized_adp=("normalized_pick", "mean"),
            median_normalized_pick=("normalized_pick", "median"),
            draft_appearances=("draft_index", "nunique"),
            catalog_match=("catalog_match", "max"),
            gsis_id=("gsis_id", "first"),
        )
    )
    stats = pd.concat(
        [
            pd.read_csv(
                Path(args.data_dir) / f"stats_player_reg_{season}.csv",
                usecols=[
                    "season",
                    "player_id",
                    "position",
                    "fantasy_points_ppr",
                ],
                low_memory=False,
            )
            for season in SEASONS
        ],
        ignore_index=True,
    )
    stats["season"] = pd.to_numeric(stats["season"], errors="coerce").astype("Int64")
    stats["player_id"] = stats["player_id"].fillna("").astype(str)
    stats["position"] = stats["position"].fillna("").astype(str).str.upper()
    stats["fantasy_points_ppr"] = pd.to_numeric(
        stats["fantasy_points_ppr"], errors="coerce"
    )
    joined = adp.merge(
        stats,
        left_on=["season", "gsis_id"],
        right_on=["season", "player_id"],
        how="inner",
        suffixes=("_draft", "_stats"),
    )
    joined = joined[joined["position_draft"].eq(joined["position_stats"])].copy()
    joined["position"] = joined["position_draft"]

    coverage: dict[str, Any] = {}
    associations: dict[str, Any] = {}
    for season in SEASONS:
        season_picks = pick_frame[pick_frame["season"].eq(season)]
        season_adp = adp[adp["season"].eq(season)]
        season_joined = joined[joined["season"].eq(season)]
        coverage[str(season)] = {
            "drafts": int(draft_counts.get(season, 0)),
            "offensivePicks": int(len(season_picks)),
            "uniqueDraftedPlayers": int(len(season_adp)),
            "catalogMatchedPlayers": int(season_adp["catalog_match"].sum()),
            "canonicalGsisPlayers": int(season_adp["gsis_id"].ne("").sum()),
            "joinedOutcomePlayers": int(len(season_joined)),
            "joinedOutcomeCoverage": round(
                len(season_joined) / max(1, len(season_adp)), 4
            ),
            "medianDraftAppearancesPerPlayer": round(
                float(season_adp["draft_appearances"].median()), 2
            ),
        }
        associations[str(season)] = metrics(season_joined)

    return {
        "schemaVersion": 1,
        "kind": "research-only Sleeper draft-derived ADP governance audit",
        "corpus": {
            "file": str(corpus_path).replace("\\", "/"),
            "collectedAt": raw.get("collectedAt"),
            "source": raw.get("source"),
            "privacy": raw.get("privacy"),
            "diagnostics": raw.get("diagnostics"),
            "scoringTypes": scoring_counts,
        },
        "coverage": coverage,
        "descriptiveAssociation": {
            "interpretation": "Negative correlation is expected because lower ADP is better. This is descriptive association, not incremental owned-model lift.",
            "bySeason": associations,
            "pooled": metrics(joined),
        },
        "governance": {
            "preseasonTimestampRetained": False,
            "draftStartTimestampRetained": False,
            "retrievedProspectively": False,
            "collectionDateAfterAllEvaluatedSeasons": True,
            "samplingFrame": "Breadth-first network walk from six hard-coded Sleeper user IDs; only accessible completed leagues were considered.",
            "selectionConditions": [
                "league status complete",
                "complete snake draft for the season",
                "champion bracket and champion roster available",
                "at least teams x 5 picks",
                "non-dynasty scoring label",
            ],
            "risks": [
                "The sanitized records omit draft start_time, so a strict pre-kickoff feature cutoff cannot be audited.",
                "The corpus was retrospectively collected in 2026 rather than captured before each target season.",
                "Conditioning on completed, accessible leagues with surviving champion/bracket data creates survivor and network-selection bias.",
                "League and draft identifiers were removed, so independent deduplication and source-record revalidation are impossible from the retained artifact.",
                "The current 2026 Sleeper catalog is a retrospective identity bridge; missing or changed historical mappings produce nonrandom coverage.",
            ],
            "decision": "rejected-as-owned-model-feature",
            "reason": "Predictive association cannot cure missing preseason timestamps, retrospective collection, and survivor-selected sampling.",
            "futureAdmissibleDesign": "Prospectively collect a broad, predefined league sample before the official cutoff; retain hashed draft IDs, draft start_time, scoring/size, immutable raw receipts, and a sampling manifest. Freeze season-player ADP before outcomes and evaluate only on later seasons.",
        },
        "productionChanged": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--corpus", default="data/historical/sleeper-drafts-ranked-expanded.json"
    )
    parser.add_argument(
        "--catalog", default="data/generated/sleeper-current-catalog.json"
    )
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument(
        "--output", default="data/research/owned-model-sleeper-draft-adp-audit.json"
    )
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "output": str(output),
        "decision": report["governance"]["decision"],
        "coverage": report["coverage"],
    }, indent=2))


if __name__ == "__main__":
    main()
