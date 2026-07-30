"""Research-only audit of prior-season play-participation role.

This fixed family uses nflverse play-participation rows to measure how often a
player was actually on offense relative to his team and same-position group,
including shotgun, under-center, 11-personnel, and non-11-personnel usage.
Target season S receives only completed season S-1 participation features.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from owned_model.pipeline import (  # noqa: E402
    MODEL_VERSION,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
)


def load_harness() -> Any:
    source = ROOT / "scripts" / "research-veteran-feature-ablation.py"
    spec = importlib.util.spec_from_file_location("owned_veteran_ablation", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load evaluation harness: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = load_harness()
POSITIONS = ("QB", "RB", "WR", "TE")
ADDED_FEATURES = (
    "participation_active_play_share",
    "participation_position_slot_share",
    "participation_active_game_share",
    "participation_shotgun_opportunity_share",
    "participation_under_center_opportunity_share",
    "participation_11_personnel_opportunity_share",
    "participation_non11_opportunity_share",
    "participation_missing",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_values(value: Any) -> list[str]:
    if value is None or pd.isna(value):
        return []
    return [part.strip() for part in str(value).split(";") if part.strip()]


def load_participation(
    directory: Path,
    season_positions: dict[tuple[str, int], str],
    fallback_positions: dict[str, str],
) -> tuple[dict[tuple[str, int], dict[str, float]], list[dict[str, Any]], dict[str, Any]]:
    files = sorted(directory.glob("pbp_participation_*.csv"))
    if not files:
        raise FileNotFoundError(f"No participation CSV files found under {directory}.")
    team_game: dict[tuple[int, str, str], Counter[str]] = defaultdict(Counter)
    player_game: dict[tuple[int, str, str, str], Counter[str]] = defaultdict(Counter)
    player_position: dict[tuple[int, str], Counter[str]] = defaultdict(Counter)
    team_games: dict[tuple[int, str], set[str]] = defaultdict(set)
    manifest: list[dict[str, Any]] = []
    coverage = {
        "seasons": [],
        "rawRows": 0,
        "eligibleOffensiveRows": 0,
        "alignedRows": 0,
        "misalignedRows": 0,
    }

    for path in files:
        season = int(path.stem.rsplit("_", 1)[1])
        frame = pd.read_csv(path, low_memory=False)
        required = {
            "nflverse_game_id", "possession_team", "offense_formation",
            "offense_players", "n_offense",
        }
        if missing := sorted(required - set(frame.columns)):
            raise ValueError(f"{path.name} missing columns: {', '.join(missing)}")
        coverage["seasons"].append(season)
        coverage["rawRows"] += int(len(frame))
        for row in frame.to_dict("records"):
            players = split_values(row.get("offense_players"))
            if "offense_positions" in frame.columns:
                positions = [
                    value.upper()
                    for value in split_values(row.get("offense_positions"))
                ]
            else:
                positions = [
                    season_positions.get(
                        (player_id, season),
                        fallback_positions.get(player_id, ""),
                    )
                    for player_id in players
                ]
            n_offense = row.get("n_offense")
            if (
                pd.isna(n_offense)
                or int(float(n_offense)) != 11
                or "QB" not in positions
            ):
                continue
            coverage["eligibleOffensiveRows"] += 1
            if len(players) != len(positions):
                coverage["misalignedRows"] += 1
                continue
            coverage["alignedRows"] += 1
            team = str(row.get("possession_team") or "").strip().upper()
            game = str(row.get("nflverse_game_id") or "").strip()
            if not team or not game:
                continue
            formation = str(row.get("offense_formation") or "").strip().upper()
            skill_counts = Counter(position for position in positions if position in POSITIONS)
            is_eleven = (
                skill_counts["RB"] == 1
                and skill_counts["TE"] == 1
                and skill_counts["WR"] == 3
            )
            team_key = (season, team, game)
            team_games[(season, team)].add(game)
            team_game[team_key]["plays"] += 1
            team_game[team_key]["shotgun"] += int(formation == "SHOTGUN")
            team_game[team_key]["under_center"] += int("UNDER CENTER" in formation)
            team_game[team_key]["eleven"] += int(is_eleven)
            team_game[team_key]["non_eleven"] += int(not is_eleven)
            for position, count in skill_counts.items():
                team_game[team_key][f"slots_{position}"] += count
            for player_id, position in zip(players, positions):
                if position not in POSITIONS or not player_id.startswith("00-"):
                    continue
                key = (season, player_id, team, game)
                player_game[key]["plays"] += 1
                player_game[key]["shotgun"] += int(formation == "SHOTGUN")
                player_game[key]["under_center"] += int("UNDER CENTER" in formation)
                player_game[key]["eleven"] += int(is_eleven)
                player_game[key]["non_eleven"] += int(not is_eleven)
                player_game[key][f"position_{position}"] += 1
                player_position[(season, player_id)][position] += 1
        manifest.append({
            "file": path.name,
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "source": (
                "https://github.com/nflverse/nflverse-data/releases/download/"
                f"pbp_participation/{path.name}"
            ),
            "license": "CC-BY-4.0",
            "featureCutoff": (
                f"Completed {season} participation; used only for target "
                f"season {season + 1} or later"
            ),
            "positionIdentity": (
                "native offense_positions"
                if "offense_positions" in frame.columns
                else "exact nflverse player-season position with static player fallback"
            ),
        })

    player_keys: dict[tuple[int, str], list[tuple[int, str, str, str]]] = defaultdict(list)
    for key in player_game:
        season, player_id, _, _ = key
        player_keys[(season, player_id)].append(key)
    max_team_games = {
        season: max(
            (len(games) for (source_season, _), games in team_games.items()
             if source_season == season),
            default=1,
        )
        for season in coverage["seasons"]
    }
    history: dict[tuple[str, int], dict[str, float]] = {}
    for (season, player_id), keys in player_keys.items():
        position = player_position[(season, player_id)].most_common(1)[0][0]
        numerator = Counter()
        denominator = Counter()
        active_games: set[str] = set()
        for key in keys:
            _, _, team, game = key
            active_games.add(game)
            values = player_game[key]
            team_values = team_game[(season, team, game)]
            numerator.update(values)
            denominator.update(team_values)
        history[(player_id, season)] = {
            "participation_active_play_share": (
                numerator["plays"] / max(1, denominator["plays"])
            ),
            "participation_position_slot_share": (
                numerator[f"position_{position}"]
                / max(1, denominator[f"slots_{position}"])
            ),
            "participation_active_game_share": (
                len(active_games) / max(1, max_team_games[season])
            ),
            "participation_shotgun_opportunity_share": (
                numerator["shotgun"] / max(1, denominator["shotgun"])
            ),
            "participation_under_center_opportunity_share": (
                numerator["under_center"] / max(1, denominator["under_center"])
            ),
            "participation_11_personnel_opportunity_share": (
                numerator["eleven"] / max(1, denominator["eleven"])
            ),
            "participation_non11_opportunity_share": (
                numerator["non_eleven"] / max(1, denominator["non_eleven"])
            ),
            "participation_missing": 0.0,
        }
    coverage["seasons"] = [
        min(coverage["seasons"]), max(coverage["seasons"])
    ]
    coverage["playerSeasons"] = len(history)
    return history, manifest, coverage


def augment(
    dataset: pd.DataFrame,
    history: dict[tuple[str, int], dict[str, float]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    for column in ADDED_FEATURES:
        result[column] = np.nan
    mapped = 0
    for index, row in result.iterrows():
        values = history.get((str(row["player_id"]), int(row["season"]) - 1))
        if values is None:
            result.at[index, "participation_missing"] = 1.0
            continue
        mapped += 1
        for column, value in values.items():
            result.at[index, column] = value
    evaluation = result[
        result["season"].isin(HARNESS.EVALUATION_SEASONS)
        & result["position"].isin(POSITIONS)
    ]
    return result, {
        "rows": int(len(result)),
        "mappedRows": mapped,
        "evaluationRows": int(len(evaluation)),
        "mappedEvaluationRows": int(evaluation["participation_missing"].eq(0.0).sum()),
        "evaluationCoverage": float(
            evaluation["participation_missing"].eq(0.0).mean()
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data/private/owned-model/raw"),
    )
    parser.add_argument(
        "--participation-dir",
        type=Path,
        default=Path("data/private/owned-model/research-participation"),
    )
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/research/owned-model-pbp-participation-role.json"),
    )
    args = parser.parse_args()

    stats, stats_manifest = load_stats(args.data_dir)
    players, players_manifest = load_players(args.data_dir / "players.csv")
    picks, draft_manifest = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    season_positions = {
        (str(row["player_id"]), int(row["season"])): str(
            row.get("position") or ""
        ).upper()
        for row in stats.to_dict("records")
    }
    fallback_positions = {
        str(row["player_id"]): str(row.get("position") or "").upper()
        for row in players.to_dict("records")
        if str(row.get("player_id") or "")
    }
    history, participation_manifest, participation_coverage = load_participation(
        args.participation_dir,
        season_positions,
        fallback_positions,
    )
    augmented, row_coverage = augment(dataset, history)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only prior-season play-participation role",
        "baseModelVersion": MODEL_VERSION,
        "productionChanged": False,
        "method": (
            "Measure prior-season offensive-play share, same-position slot "
            "share, availability, and formation-specific opportunity from "
            "aligned 11-player scrimmage participation rows containing a QB. "
            "Evaluate one fixed family with production-identical nested "
            "expanding-season learners and baseline-locked cohorts."
        ),
        "featureCutoff": (
            "Every target season S uses completed play participation from S-1 only."
        ),
        "addedFeatures": list(ADDED_FEATURES),
        "participationCoverage": participation_coverage,
        "rowCoverage": row_coverage,
        "inputDigests": {
            "stats": [item["sha256"] for item in stats_manifest],
            "players": players_manifest["sha256"],
            "draftPicks": draft_manifest["sha256"],
            "depthCharts": [item["sha256"] for item in depth_manifest],
            "participation": [
                item["sha256"] for item in participation_manifest
            ],
        },
        "positions": {},
        "decision": {},
    }
    feature_columns = production_features + list(ADDED_FEATURES)
    for position in POSITIONS:
        rows = augmented[augmented["position"].eq(position)].copy()
        baseline_oof = HARNESS.oof_components(rows, production_features, position)
        locked_ids = HARNESS.locked_draftable_ids(baseline_oof, position)
        control = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(baseline_oof),
            rows,
            position,
            locked_ids,
        )
        candidate = HARNESS.cohort_metrics(
            HARNESS.nested_predictions(
                HARNESS.oof_components(rows, feature_columns, position)
            ),
            rows,
            position,
            locked_ids,
        )
        acceptance = HARNESS.acceptance(control, candidate)
        report["positions"][position] = {
            "control": control,
            "candidate": candidate,
            "acceptance": acceptance,
        }
        report["decision"][position] = {
            "accepted": acceptance["accepted"],
            "productionAction": (
                "Eligible for separate reviewed integration."
                if acceptance["accepted"]
                else "Reject the fixed family for this position."
            ),
        }
    accepted = [
        position
        for position, value in report["decision"].items()
        if value["accepted"]
    ]
    report["overallDecision"] = {
        "acceptedPositions": accepted,
        "productionChanged": False,
        "adaptiveDevelopmentCaveat": (
            "The 2023-2025 folds have been adaptively reused. This screen is "
            "not prospective superiority evidence."
        ),
    }
    report["scriptSha256"] = sha256_file(Path(__file__))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "out": str(args.out),
        "participationCoverage": participation_coverage,
        "rowCoverage": row_coverage,
        "decision": report["overallDecision"],
    }, indent=2))


if __name__ == "__main__":
    main()
