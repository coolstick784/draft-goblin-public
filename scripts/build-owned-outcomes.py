import argparse
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.outcomes import build_owned_outcomes
from owned_model.pipeline import add_kicker_zero_outcomes, load_depth_charts, load_dst_stats, load_players, load_stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Build private completed-season outcomes for owned prospective evidence scoring.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--catalog", default="data/generated/sleeper-current-catalog.json")
    parser.add_argument("--output", default=None)
    parser.add_argument("--candidate", default=None, help="Exact ignored preseason candidate used by the frozen ledger.")
    parser.add_argument("--complete", action="store_true", help="Assert the regular season is complete; scoring rejects artifacts without this flag.")
    args = parser.parse_args()
    root = Path(args.data_dir)
    stats, _ = load_stats(root)
    players, _ = load_players(Path(args.players))
    roles, _ = load_depth_charts(root, args.season + 1)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season)
    dst_stats, dst_players, _ = load_dst_stats(root, root / "games.csv")
    candidate_path = Path(args.candidate or f"data/private/owned-model/final-refresh-{args.season}/owned-projections-{args.season}.json")
    if not candidate_path.is_file():
        raise FileNotFoundError(f"Frozen preseason candidate is required: {candidate_path}")
    candidate_bytes = candidate_path.read_bytes()
    frozen_candidate = json.loads(candidate_bytes)
    outcomes = build_owned_outcomes(
        pd.concat([stats, dst_stats], ignore_index=True), pd.concat([players, dst_players], ignore_index=True),
        args.season, Path(args.catalog), args.complete,
        frozen_candidate=frozen_candidate,
        frozen_candidate_sha256=hashlib.sha256(candidate_bytes).hexdigest(),
    )
    output = Path(args.output or f"data/private/owned-model/outcomes-{args.season}.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(outcomes, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "season": args.season, "complete": outcomes["complete"], "players": len(outcomes["players"]), "population": outcomes["population"]}, indent=2))


if __name__ == "__main__":
    main()
