"""Fetch prior-season nflverse injury reports for owned-model research."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "injuries/injuries_{season}.csv"
)


def load_fetcher():
    source = Path(__file__).with_name("fetch-owned-model-data.py")
    spec = spec_from_file_location("owned_model_fetcher", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {source}")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.download


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-season", type=int, default=2012)
    parser.add_argument("--end-season", type=int, required=True)
    parser.add_argument("--output", default="data/private/owned-model/raw")
    args = parser.parse_args()
    if args.end_season < args.start_season:
        raise ValueError("Invalid injury season range.")
    output = Path(args.output)
    download = load_fetcher()
    inputs = [
        download(
            URL.format(season=season),
            output / f"injuries_{season}.csv",
        )
        for season in range(args.start_season, args.end_season + 1)
    ]
    payload = {
        "schemaVersion": 1,
        "artifactType": "owned-model-injury-input-manifest",
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "attribution": "nflverse, CC-BY-4.0",
        "inputs": inputs,
    }
    manifest = output / "injury-fetch-manifest.json"
    manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest), "inputs": len(inputs)}, indent=2))


if __name__ == "__main__":
    main()
