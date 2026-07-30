import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


USER_AGENT = "DraftGoblinProspectiveEvidence/1.0"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_bytes(url: str, attempts: int = 4, timeout: int = 60) -> tuple[bytes, dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                headers = {
                    "etag": response.headers.get("ETag"),
                    "lastModified": response.headers.get("Last-Modified"),
                    "contentType": response.headers.get("Content-Type"),
                }
                return response.read(), {key: value for key, value in headers.items() if value}
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 or attempt == attempts - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if attempt == attempts - 1:
                raise
        time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"Download attempts exhausted: {url}")


def plausible_csv(data: bytes) -> bool:
    is_gzip = data[:2] == b"\x1f\x8b"
    return len(data) >= 100 and (is_gzip or b"," in data[:1000])


def write_atomic(destination: Path, data: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(destination)


def capture_signal(signal: dict, season: int, output: Path) -> dict:
    url = signal["urlTemplate"].format(season=season)
    capture = signal.get("capture", {})
    try:
        data, headers = fetch_bytes(url)
    except urllib.error.HTTPError as error:
        if error.code == 404 and capture.get("allowNotPublished") is True:
            return {
                "id": signal["id"],
                "available": False,
                "reason": "not-published",
                "httpStatus": 404,
                "url": url,
                "license": signal["license"],
                "rightsNote": signal.get("rightsNote"),
            }
        raise
    if not plausible_csv(data):
        raise RuntimeError(f"Downloaded input is not a plausible CSV: {url}")
    extension = ".csv.gz" if data[:2] == b"\x1f\x8b" else ".csv"
    destination = output / f"{signal['id']}{extension}"
    write_atomic(destination, data)
    return {
        "id": signal["id"],
        "available": True,
        "file": destination.name,
        "url": url,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "license": signal["license"],
        "rightsNote": signal.get("rightsNote"),
        "use": signal["use"],
        "headers": headers,
    }


def capture_policy_signals(policy: dict, season: int, output: Path, captured_at: str | None = None) -> dict:
    signals = [signal for signal in policy.get("signals", []) if signal.get("status") == "prospective-shadow"]
    if not signals:
        raise ValueError("Model signal policy did not define any prospective-shadow signals.")
    rows = [capture_signal(signal, season, output) for signal in signals]
    for signal, row in zip(signals, rows):
        if signal.get("capture", {}).get("required") is True and not row.get("available"):
            raise RuntimeError(f"Required prospective signal was unavailable: {signal['id']}")
    manifest = {
        "schemaVersion": 1,
        "artifactType": "draft-goblin-prospective-model-signals",
        "season": season,
        "capturedAt": captured_at or utc_now(),
        "researchOnly": True,
        "eligibleToAffectProduction": False,
        "attribution": [
            "nflverse-data repository, CC-BY-4.0",
            "Underlying NFL data can remain subject to the respective owners' terms."
        ],
        "signals": rows,
    }
    write_atomic(output / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture immutable, pre-event model signals for private shadow evaluation.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--policy", default="data/model-signal-policy.json")
    parser.add_argument("--output", default="data/private/prospective-model-signals/latest")
    args = parser.parse_args()
    current_year = datetime.now(timezone.utc).year
    if args.season < 2000 or args.season > current_year + 1:
        raise ValueError("Prospective signal season is outside the supported range.")
    policy = json.loads(Path(args.policy).read_text(encoding="utf-8"))
    manifest = capture_policy_signals(policy, args.season, Path(args.output))
    print(json.dumps({
        "output": str(Path(args.output)),
        "season": args.season,
        "available": sum(1 for row in manifest["signals"] if row["available"]),
        "unavailable": sum(1 for row in manifest["signals"] if not row["available"]),
    }, indent=2))


if __name__ == "__main__":
    main()
