"""Fetch a timestamped Fantasy Football Calculator ADP snapshot."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ALLOWED_SCORING = {"standard", "half-ppr", "ppr", "2qb"}
RETRY_DELAYS_SECONDS = (0, 1, 3)
MINIMUM_PLAYER_COUNT = 150


def fetch_json(request: Request) -> dict:
    last_error: Exception | None = None
    for attempt, delay in enumerate(RETRY_DELAYS_SECONDS, start=1):
        if delay:
            time.sleep(delay)
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            retryable = not isinstance(error, HTTPError) or error.code in {408, 425, 429, 500, 502, 503, 504}
            if not retryable or attempt == len(RETRY_DELAYS_SECONDS):
                raise
    raise RuntimeError("FFC request failed") from last_error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scoring", choices=sorted(ALLOWED_SCORING), required=True)
    parser.add_argument("--teams", type=int, default=12)
    parser.add_argument("--year", type=int, default=datetime.now(timezone.utc).year)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.teams not in {8, 10, 12, 14}:
        raise ValueError("teams must be one of 8, 10, 12, or 14")
    url = (
        f"https://fantasyfootballcalculator.com/api/v1/adp/{args.scoring}"
        f"?teams={args.teams}&year={args.year}"
    )
    request = Request(url, headers={"User-Agent": "DraftGoblinOwnedResearch/1.0"})
    payload = fetch_json(request)
    players = payload.get("players") or []
    meta = payload.get("meta") or {}
    identities = {
        (str(player.get("name") or "").strip().casefold(), str(player.get("position") or "").upper())
        for player in players
    }
    valid_positions = {"QB", "RB", "WR", "TE", "PK", "K", "DEF", "DST"}
    invalid_rows = [player for player in players if not player.get("name") or str(player.get("position") or "").upper() not in valid_positions]
    if len(players) < MINIMUM_PLAYER_COUNT or len(identities) != len(players) or invalid_rows or int(meta.get("teams") or 0) != args.teams:
        raise ValueError("FFC returned an empty or mismatched ADP response")
    report = {
        "schemaVersion": 1,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "season": args.year,
        "teams": args.teams,
        "scoring": args.scoring,
        "provider": "Fantasy Football Calculator",
        "license": "Free personal and commercial API use; attribution requested",
        "source": url,
        "meta": meta,
        "players": players,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "players": len(players),
                "type": meta.get("type"),
                "startDate": meta.get("start_date"),
                "endDate": meta.get("end_date"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
