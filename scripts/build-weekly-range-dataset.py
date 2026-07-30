"""Join historical pre-week projections to licensed nflverse outcomes and rosters.

The row-level result stays in the ignored private cache.  Only aggregate data
quality evidence is written to data/research.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

POSITIONS = {"QB", "RB", "WR", "TE", "K"}
INACTIVE_STATUSES = {"INA", "RES", "DEV", "CUT", "RET", "EXE"}


def identity(name: str, position: str) -> str:
    value = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return f"{re.sub(r'[^a-z0-9]', '', value.lower())}:{position.upper()}"


def number(value: str | None) -> float | None:
    try:
        result = float(value or "")
        return result if result == result else None
    except ValueError:
        return None


def load_metadata(path: Path) -> dict[str, dict]:
    result: dict[str, dict] = {}
    with path.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            position = str(row.get("position") or "").upper()
            if position not in POSITIONS:
                continue
            key = identity(row.get("display_name") or row.get("football_name") or "", position)
            result[key] = {
                "gsisId": row.get("gsis_id") or None,
                "rookieSeason": int(float(row["rookie_season"])) if row.get("rookie_season") else None,
                "draftYear": int(float(row["draft_year"])) if row.get("draft_year") else None,
                "draftRound": int(float(row["draft_round"])) if row.get("draft_round") else None,
                "draftPick": int(float(row["draft_pick"])) if row.get("draft_pick") else None,
            }
    return result


def load_weekly_csvs(raw: Path, years: range, prefix: str) -> dict[tuple[int, int, str], dict]:
    result: dict[tuple[int, int, str], dict] = {}
    for year in years:
        path = raw / f"{prefix}_{year}.csv"
        with path.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                if str(row.get("season_type") or row.get("game_type") or "REG") != "REG":
                    continue
                position = str(row.get("position") or "").upper()
                if position not in POSITIONS:
                    continue
                name = row.get("player_display_name") or row.get("full_name") or ""
                result[(year, int(row["week"]), identity(name, position))] = row
    return result


def source_rows(root: Path, years: range):
    for year in years:
        year_path = root / str(year)
        if not year_path.exists():
            continue
        for week_path in sorted((entry for entry in year_path.iterdir() if entry.is_dir() and entry.name.isdigit()), key=lambda value: int(value.name)):
            week = int(week_path.name)
            for position in sorted(POSITIONS):
                path = week_path / "projected" / f"{position}_projected.json"
                if not path.exists():
                    continue
                for row in json.loads(path.read_text(encoding="utf-8")):
                    projected = number(row.get("PlayerWeekProjectedPts"))
                    actual = number(row.get("TotalPoints"))
                    if projected is None or projected <= 0 or actual is None:
                        continue
                    yield year, week, position, row, projected, actual


def build(args: argparse.Namespace) -> dict:
    years = range(args.start_season, args.end_season + 1)
    raw, source_root = Path(args.raw), Path(args.source)
    metadata = load_metadata(raw / "players.csv")
    stats = load_weekly_csvs(raw, years, "stats_player_week")
    rosters = load_weekly_csvs(raw, years, "roster_weekly")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    counts, by_year, rookie_counts = Counter(), Counter(), Counter()
    matched_actual_differences: dict[str, list[float]] = {"standard": [], "half-ppr": [], "ppr": []}
    with output.open("w", encoding="utf-8", newline="\n") as destination:
        for year, week, position, source, projected, actual in source_rows(source_root, years):
            key = identity(source.get("PlayerName") or "", position)
            stat, roster, meta = stats.get((year, week, key)), rosters.get((year, week, key)), metadata.get(key, {})
            roster_status = str((roster or {}).get("status") or "")
            if stat is not None or roster_status == "ACT":
                outcome_status = "active-observed"
            elif roster_status in INACTIVE_STATUSES:
                outcome_status = "inactive-or-unavailable"
            else:
                outcome_status = "unknown-activity"
            rookie_year = int(float(roster["rookie_year"])) if roster and roster.get("rookie_year") else meta.get("rookieSeason")
            rookie = rookie_year == year if rookie_year is not None else None
            nflverse_standard = number((stat or {}).get("fantasy_points"))
            nflverse_actual = number((stat or {}).get("fantasy_points_ppr"))
            nflverse_half = (nflverse_standard + nflverse_actual) / 2 if nflverse_standard is not None and nflverse_actual is not None else None
            receptions = number(source.get("ReceivingRec")) or 0
            for scoring, value in (("standard", nflverse_standard), ("half-ppr", nflverse_half), ("ppr", nflverse_actual)):
                if value is not None:
                    matched_actual_differences[scoring].append(abs(value - actual))
            record = {
                "sourceId": "hvpkod-fantasy-nfl",
                "season": year,
                "week": week,
                "playerKey": key,
                "playerId": (stat or {}).get("player_id") or (roster or {}).get("gsis_id") or meta.get("gsisId"),
                "name": source.get("PlayerName"),
                "position": position,
                "projected": projected,
                "projectedStandard": max(0, projected - 0.5 * receptions),
                "projectedHalfPpr": projected,
                "projectedPpr": projected + 0.5 * receptions,
                "sourceActual": actual,
                "nflversePprActual": nflverse_actual,
                "nflverseHalfPprActual": nflverse_half,
                "nflverseStandardActual": nflverse_standard,
                "outcomeStatus": outcome_status,
                "rosterStatus": roster_status or None,
                "rookie": rookie,
                "rookieSeason": rookie_year,
                "yearsExperience": int(float(roster["years_exp"])) if roster and roster.get("years_exp") else None,
                "draftRound": meta.get("draftRound"),
                "draftPick": meta.get("draftPick"),
            }
            destination.write(json.dumps(record, separators=(",", ":")) + "\n")
            counts[outcome_status] += 1
            by_year[(year, outcome_status)] += 1
            rookie_counts[str(rookie).lower() if rookie is not None else "unknown"] += 1
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    total = sum(counts.values())
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rowDataset": {"path": str(output).replace("\\", "/"), "rows": total, "sha256": digest, "redistribution": "private-cache-only"},
        "sources": {"projections": "hvpkod/NFL-Data historical pre-week projections", "outcomesAndRosters": "nflverse CC-BY-4.0"},
        "activitySemantics": {
            "active-observed": "A matching nflverse stat row exists or the weekly roster status is ACT.",
            "inactive-or-unavailable": "The weekly roster status is INA, RES, DEV, CUT, RET, or EXE.",
            "unknown-activity": "Neither source establishes game participation; do not silently treat this as an inactive game.",
        },
        "coverage": {
            "rows": total,
            "outcomeStatus": dict(counts),
            "outcomeStatusRate": {key: round(value / total, 6) for key, value in counts.items()},
            "rookieFlag": dict(rookie_counts),
            "byYear": {str(year): {status: by_year[(year, status)] for status in counts} for year in years},
        },
        "scoringDiagnostic": {
            "matchedNflverseRows": len(matched_actual_differences["ppr"]),
            "medianAbsoluteDifferenceFromSourceActual": {scoring: round(sorted(values)[len(values) // 2], 4) if values else None for scoring, values in matched_actual_differences.items()},
            "meanAbsoluteDifferenceFromSourceActual": {scoring: round(sum(values) / len(values), 4) if values else None for scoring, values in matched_actual_differences.items()},
            "warning": "nflverse PPR outcomes validate activity and identity; sourceActual remains the scoring-compatible target unless scoring equivalence is separately established.",
        },
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-season", type=int, default=2021)
    parser.add_argument("--end-season", type=int, default=2024)
    parser.add_argument("--raw", default="data/private/owned-model/raw")
    parser.add_argument("--source", default="data/vendor/NFL-Data-main/NFL-data-Players")
    parser.add_argument("--output", default="data/private/owned-model/weekly-range-rows.jsonl")
    parser.add_argument("--report", default="data/research/weekly-range-data-audit.json")
    args = parser.parse_args()
    print(json.dumps(build(args), indent=2))


if __name__ == "__main__":
    main()
