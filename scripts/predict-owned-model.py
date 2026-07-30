import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (
    add_kicker_zero_outcomes,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_model,
    load_players,
    load_stats,
    predict_owned_model,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Reproduce an owned-model shadow candidate from a saved estimator."
    )
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--catalog", default="data/generated/sleeper-current-catalog.json")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--model", default="data/private/owned-model/model.joblib")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    stats, _ = load_stats(data_dir)
    players, _ = load_players(Path(args.players))
    draft_picks, _ = load_draft_picks(Path(args.draft_picks))
    players, _ = enrich_players_with_draft_picks(players, draft_picks)
    roles, _ = load_depth_charts(data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dst_stats, dst_players, _ = load_dst_stats(data_dir, data_dir / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)

    model = load_model(Path(args.model))
    projection = predict_owned_model(
        model,
        stats,
        players,
        args.season,
        Path(args.catalog),
        roles,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(projection, separators=(",", ":"), allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "model": str(args.model),
        "projection": str(output),
        "players": len(projection["players"]),
    }, indent=2))


if __name__ == "__main__":
    main()
