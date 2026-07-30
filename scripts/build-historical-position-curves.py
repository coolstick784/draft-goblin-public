"""Build aggregate PPR position-rank scoring curves from completed seasons."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (
    CORE_POSITIONS,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_players,
    load_stats,
)


DEFAULT_SEASONS = (2021, 2022, 2023, 2024, 2025)


def load_training_data(data_dir: Path) -> pd.DataFrame:
    stats, _ = load_stats(data_dir)
    players, _ = load_players(data_dir / "players.csv")
    picks, _ = load_draft_picks(data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dst_stats, dst_players, _ = load_dst_stats(data_dir, data_dir / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, _ = build_dataset(stats, players, roles)
    return dataset


def build_curves(dataset: pd.DataFrame, seasons: tuple[int, ...] = DEFAULT_SEASONS) -> dict:
    curves = {}
    for position in CORE_POSITIONS:
        ranked = []
        for season in seasons:
            values = dataset[
                (dataset["position"] == position) & (dataset["season"] == season)
            ]["target_ppr_total"].to_numpy(dtype=float)
            ranked.append(np.sort(np.maximum(0.0, values))[::-1])
        length = max(map(len, ranked))
        points = []
        observations = []
        for index in range(length):
            available = [float(values[index]) for values in ranked if index < len(values)]
            points.append(round(float(np.median(available)), 4))
            observations.append(len(available))
        curves[position] = {"pointsByPositionRank": points, "observationsByRank": observations}
    return {
        "schemaVersion": 1,
        "artifactType": "historical-position-rank-ppr-curves",
        "seasons": list(seasons),
        "method": (
            "Median realized PPR season total at each within-position finish rank "
            f"across completed {min(seasons)}-{max(seasons)} seasons. Current provider projections and "
            "current player identities are not inputs."
        ),
        "curves": curves,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw", type=Path)
    parser.add_argument("--start-season", type=int, default=min(DEFAULT_SEASONS))
    parser.add_argument("--end-season", type=int, default=max(DEFAULT_SEASONS))
    parser.add_argument(
        "--out", default="data/research/historical-position-rank-ppr-curves.json", type=Path
    )
    args = parser.parse_args()
    if args.start_season > args.end_season:
        raise ValueError("start season must not exceed end season")
    seasons = tuple(range(args.start_season, args.end_season + 1))
    report = build_curves(load_training_data(args.data_dir), seasons)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "positions": list(report["curves"])}, indent=2))


if __name__ == "__main__":
    main()
