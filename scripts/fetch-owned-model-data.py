import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{season}.csv"
PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
DEPTH_URL = "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_{season}.csv{suffix}"
TEAM_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_reg_{season}.csv"
SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"
DRAFT_PICKS_URL = "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv"
SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"


def fetch_bytes(url: str, attempts: int = 4, timeout: int = 60) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "DraftGoblinOwnedModel/1.0"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 or attempt == attempts - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if attempt == attempts - 1:
                raise
        time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"Download attempts exhausted: {url}")


def download(url: str, destination: Path) -> dict:
    data = fetch_bytes(url)
    is_gzip = data[:2] == b"\x1f\x8b"
    if len(data) < 100 or (not is_gzip and b"," not in data[:1000]):
        raise RuntimeError(f"Downloaded input is not a plausible CSV: {url}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return {"file": destination.name, "url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "license": "CC-BY-4.0"}

def download_sleeper_catalog(destination: Path) -> dict:
    data = fetch_bytes(SLEEPER_PLAYERS_URL)
    value = json.loads(data)
    if not isinstance(value, dict) or len(value) < 1000:
        raise RuntimeError("Sleeper player catalog was not a plausible NFL catalog.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return {"file": destination.name, "url": SLEEPER_PLAYERS_URL, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "license": "official-read-only-api", "use": "identity-only"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-season", type=int, default=2012)
    parser.add_argument("--end-season", type=int, required=True)
    parser.add_argument("--depth-end-season", type=int, default=None)
    parser.add_argument("--output", default="data/private/owned-model/raw")
    parser.add_argument("--catalog-output", default=None)
    args = parser.parse_args()
    if args.end_season < args.start_season or args.end_season > datetime.now(timezone.utc).year:
        raise ValueError("Invalid owned-model season range.")
    output = Path(args.output)
    manifest = [download(STATS_URL.format(season=season), output / f"stats_player_reg_{season}.csv") for season in range(args.start_season, args.end_season + 1)]
    manifest.extend(download(TEAM_URL.format(season=season), output / f"stats_team_reg_{season}.csv") for season in range(args.start_season, args.end_season + 1))
    manifest.append(download(PLAYERS_URL, output / "players.csv"))
    manifest.append(download(DRAFT_PICKS_URL, output / "draft_picks.csv"))
    manifest.append(download(SCHEDULE_URL, output / "games.csv"))
    depth_end = args.depth_end_season or args.end_season
    for season in range(args.start_season, depth_end + 1):
        suffix = ".gz" if season >= 2024 else ""
        manifest.append(download(DEPTH_URL.format(season=season, suffix=suffix), output / f"depth_charts_{season}.csv{suffix}"))
    if args.catalog_output:
        manifest.append(download_sleeper_catalog(Path(args.catalog_output)))
    payload = {"schemaVersion": 1, "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "attribution": "nflverse, CC-BY-4.0", "inputs": manifest}
    (output / "fetch-manifest.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "inputs": len(manifest)}, indent=2))


if __name__ == "__main__":
    main()
