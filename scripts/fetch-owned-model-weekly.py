"""Fetch nflverse weekly player/team statistics for owned-model research.

The files are written only to the ignored private cache. A separate manifest
binds every byte and records its CC-BY-4.0 attribution.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from importlib.util import module_from_spec, spec_from_file_location


def load_fetcher():
    source = Path(__file__).with_name("fetch-owned-model-data.py")
    spec = spec_from_file_location("owned_model_fetcher", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {source}")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.download


PLAYER_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "stats_player/stats_player_week_{season}.csv"
)
TEAM_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "stats_team/stats_team_week_{season}.csv"
)
ROSTER_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "weekly_rosters/roster_weekly_{season}.csv"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-season", type=int, default=2012)
    parser.add_argument("--end-season", type=int, required=True)
    parser.add_argument("--output", default="data/private/owned-model/raw")
    args = parser.parse_args()
    if args.end_season < args.start_season:
        raise ValueError("Invalid weekly-stat season range.")
    output = Path(args.output)
    download = load_fetcher()
    inputs = []
    for season in range(args.start_season, args.end_season + 1):
        inputs.append(download(
            PLAYER_URL.format(season=season),
            output / f"stats_player_week_{season}.csv",
        ))
        inputs.append(download(
            TEAM_URL.format(season=season),
            output / f"stats_team_week_{season}.csv",
        ))
        inputs.append(download(
            ROSTER_URL.format(season=season),
            output / f"roster_weekly_{season}.csv",
        ))
    payload = {
        "schemaVersion": 1,
        "artifactType": "owned-model-weekly-input-manifest",
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "attribution": "nflverse, CC-BY-4.0",
        "inputs": inputs,
    }
    manifest = output / "weekly-fetch-manifest.json"
    manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest), "inputs": len(inputs)}, indent=2))


if __name__ == "__main__":
    main()
