"""Research-only audit of preseason head-coach offensive context.

The fixed family uses the target season's Week-1 head-coach identity plus only
completed prior-season team results.  It adds continuity, entering tenure, and
shrinkage-weighted prior tendencies for that coach.  It never uses target-
season scores, betting lines, quarterback assignments, or player outcomes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
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
TEAM_ALIASES = {"STL": "LA", "SD": "LAC", "OAK": "LV"}
TENDENCIES = (
    "plays_pg",
    "pass_rate",
    "yards_per_play",
    "offensive_td_pg",
    "points_for_pg",
)
ADDED_FEATURES = (
    "coach_continuity",
    "coach_entering_tenure",
    "coach_prior_seasons",
    "coach_prior_missing",
    *(f"coach_prior_{metric}" for metric in TENDENCIES),
    *(f"coach_delta_team_prior_{metric}" for metric in TENDENCIES),
)
PRIOR_STRENGTH_SEASONS = 2.0
RECENCY = 0.72


def canonical_team(value: Any) -> str:
    team = str(value or "").strip().upper()
    return TEAM_ALIASES.get(team, team)


def number(value: Any, default: float = math.nan) -> float:
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_team_metrics(
    data_dir: Path,
    games: pd.DataFrame,
) -> tuple[dict[tuple[int, str], dict[str, float]], list[dict[str, Any]]]:
    regular = games[games["game_type"].astype(str).eq("REG")].copy()
    scores: dict[tuple[int, str], dict[str, float]] = {}
    for row in regular.to_dict("records"):
        season = int(row["season"])
        home, away = canonical_team(row["home_team"]), canonical_team(row["away_team"])
        home_score, away_score = number(row.get("home_score")), number(row.get("away_score"))
        if not (math.isfinite(home_score) and math.isfinite(away_score)):
            continue
        for team, scored in ((home, home_score), (away, away_score)):
            record = scores.setdefault((season, team), {"games": 0.0, "points": 0.0})
            record["games"] += 1.0
            record["points"] += scored

    metrics: dict[tuple[int, str], dict[str, float]] = {}
    manifest: list[dict[str, Any]] = []
    for path in sorted(data_dir.glob("stats_team_reg_*.csv")):
        frame = pd.read_csv(path, low_memory=False)
        required = {
            "season", "team", "games", "attempts", "carries",
            "passing_yards", "rushing_yards", "passing_tds", "rushing_tds",
        }
        if missing := sorted(required - set(frame.columns)):
            raise ValueError(f"{path.name} missing columns: {', '.join(missing)}")
        for row in frame.to_dict("records"):
            season = int(row["season"])
            team = canonical_team(row["team"])
            games_played = max(1.0, number(row.get("games"), 1.0))
            attempts = number(row.get("attempts"), 0.0)
            carries = number(row.get("carries"), 0.0)
            plays = max(1.0, attempts + carries)
            score = scores.get((season, team), {})
            metrics[(season, team)] = {
                "plays_pg": plays / games_played,
                "pass_rate": attempts / plays,
                "yards_per_play": (
                    number(row.get("passing_yards"), 0.0)
                    + number(row.get("rushing_yards"), 0.0)
                ) / plays,
                "offensive_td_pg": (
                    number(row.get("passing_tds"), 0.0)
                    + number(row.get("rushing_tds"), 0.0)
                ) / games_played,
                "points_for_pg": (
                    number(score.get("points")) / number(score.get("games"))
                    if number(score.get("games"), 0.0) > 0.0 else np.nan
                ),
            }
        manifest.append({
            "file": path.name,
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            "source": (
                "https://github.com/nflverse/nflverse-data/releases/download/"
                f"stats_team/{path.name}"
            ),
            "license": "CC-BY-4.0",
        })
    return metrics, manifest


def week_one_coaches(games: pd.DataFrame) -> dict[tuple[int, str], str]:
    regular = games[games["game_type"].astype(str).eq("REG")].copy()
    regular["gameday"] = pd.to_datetime(
        regular["gameday"], errors="coerce", utc=True
    )
    regular = regular.sort_values(["season", "week", "gameday", "game_id"])
    result: dict[tuple[int, str], str] = {}
    for row in regular.to_dict("records"):
        season = int(row["season"])
        for team_column, coach_column in (
            ("home_team", "home_coach"),
            ("away_team", "away_coach"),
        ):
            key = (season, canonical_team(row[team_column]))
            coach = str(row.get(coach_column) or "").strip()
            if key not in result and coach:
                result[key] = coach
    return result


def build_contexts(
    metrics: dict[tuple[int, str], dict[str, float]],
    coaches: dict[tuple[int, str], str],
) -> tuple[dict[tuple[int, str], dict[str, float]], dict[str, Any]]:
    seasons = sorted({season for season, _ in coaches})
    contexts: dict[tuple[int, str], dict[str, float]] = {}
    missing_prior = 0
    for season in seasons:
        prior_rows = [
            values
            for (source_season, _), values in metrics.items()
            if source_season < season
        ]
        league = {
            metric: float(np.nanmean([
                row[metric] for row in prior_rows
                if math.isfinite(number(row.get(metric)))
            ]))
            for metric in TENDENCIES
        }
        for (coach_season, team), coach in coaches.items():
            if coach_season != season:
                continue
            history: list[tuple[int, dict[str, float]]] = []
            for (source_season, source_team), source_coach in coaches.items():
                if source_season >= season or source_coach != coach:
                    continue
                values = metrics.get((source_season, source_team))
                if values is not None:
                    history.append((source_season, values))
            weights = [
                RECENCY ** max(0, season - 1 - source_season)
                for source_season, _ in history
            ]
            prior_team = metrics.get((season - 1, team), {})
            previous_coach = coaches.get((season - 1, team), "")
            continuity = float(bool(previous_coach) and previous_coach == coach)
            tenure = 0
            cursor = season - 1
            while coaches.get((cursor, team), "") == coach:
                tenure += 1
                cursor -= 1
            values: dict[str, float] = {
                "coach_continuity": continuity,
                "coach_entering_tenure": float(tenure),
                "coach_prior_seasons": float(len(history)),
                "coach_prior_missing": float(not history),
            }
            if not history:
                missing_prior += 1
            for metric in TENDENCIES:
                valid = [
                    (number(row.get(metric)), weight)
                    for (_, row), weight in zip(history, weights)
                    if math.isfinite(number(row.get(metric)))
                ]
                weighted_sum = sum(value * weight for value, weight in valid)
                weight_sum = sum(weight for _, weight in valid)
                prior_mean = (
                    weighted_sum + league[metric] * PRIOR_STRENGTH_SEASONS
                ) / (weight_sum + PRIOR_STRENGTH_SEASONS)
                team_prior = number(prior_team.get(metric))
                values[f"coach_prior_{metric}"] = prior_mean
                values[f"coach_delta_team_prior_{metric}"] = (
                    prior_mean - team_prior
                    if math.isfinite(team_prior) else np.nan
                )
            contexts[(season, team)] = values
    return contexts, {
        "seasons": [min(seasons), max(seasons)] if seasons else [],
        "teamSeasonContexts": len(contexts),
        "contextsWithoutCoachHistory": missing_prior,
        "priorStrengthSeasons": PRIOR_STRENGTH_SEASONS,
        "recency": RECENCY,
    }


def augment(
    dataset: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    contexts: dict[tuple[int, str], dict[str, float]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    for column in ADDED_FEATURES:
        result[column] = np.nan
    mapped = 0
    for index, row in result.iterrows():
        role = roles.get((int(row["season"]), str(row["player_id"])), {})
        key = (int(row["season"]), canonical_team(role.get("team")))
        values = contexts.get(key)
        if values is None:
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
        "mappedEvaluationRows": int(evaluation["coach_continuity"].notna().sum()),
        "evaluationCoverage": float(evaluation["coach_continuity"].notna().mean()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data/private/owned-model/raw"),
    )
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/research/owned-model-offensive-coach-context.json"),
    )
    args = parser.parse_args()

    stats, stats_manifest = load_stats(args.data_dir)
    players, players_manifest = load_players(args.data_dir / "players.csv")
    picks, draft_manifest = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    games_path = args.data_dir / "games.csv"
    games = pd.read_csv(games_path, low_memory=False)
    metrics, team_manifest = load_team_metrics(args.data_dir, games)
    coaches = week_one_coaches(games)
    contexts, context_coverage = build_contexts(metrics, coaches)
    augmented, row_coverage = augment(dataset, roles, contexts)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only preseason offensive head-coach context",
        "baseModelVersion": MODEL_VERSION,
        "productionChanged": False,
        "method": (
            "Use target-season Week-1 head-coach identity, continuity, entering "
            "tenure, and a fixed shrinkage-weighted summary of that coach's "
            "completed prior team seasons. Compare with production-identical "
            "nested expanding-season learners on baseline-locked cohorts."
        ),
        "featureCutoff": (
            "Target-season coach identity is taken from the first scheduled "
            "regular-season matchup; every tendency and team delta uses only "
            "seasons strictly before the target season."
        ),
        "addedFeatures": list(ADDED_FEATURES),
        "contextCoverage": context_coverage,
        "rowCoverage": row_coverage,
        "inputDigests": {
            "stats": [item["sha256"] for item in stats_manifest],
            "players": players_manifest["sha256"],
            "draftPicks": draft_manifest["sha256"],
            "games": sha256_file(games_path),
            "teamStats": [item["sha256"] for item in team_manifest],
            "depthCharts": [item["sha256"] for item in depth_manifest],
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
        "coverage": row_coverage,
        "decision": report["overallDecision"],
    }, indent=2))


if __name__ == "__main__":
    main()
