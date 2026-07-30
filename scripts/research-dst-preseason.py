"""Bounded research harness for preseason-only DST features.

This is intentionally separate from the production pipeline.  It prints strict
chronological 2023-2025 results so a feature set can be rejected before any
owned-model behavior changes.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import HuberRegressor, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from owned_model.pipeline import build_dataset, load_dst_stats  # noqa: E402


OLD_DEFENSE = {"CB", "DB", "DE", "DL", "DT", "FS", "ILB", "LB", "MLB", "NT", "OLB", "S", "SS"}
PRODUCTION = (
    "def_sacks", "def_qb_hits", "def_interceptions", "def_fumbles_forced",
    "def_pass_defended", "def_tackles_for_loss", "def_tds", "def_safeties",
)


def _number(value, default=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def depth_units(data_dir: Path) -> dict[tuple[int, str], set[str]]:
    units: dict[tuple[int, str], set[str]] = {}
    for path in sorted([*data_dir.glob("depth_charts_*.csv"), *data_dir.glob("depth_charts_*.csv.gz")]):
        season = int(path.name.split("_")[-1].split(".")[0])
        frame = pd.read_csv(path, low_memory=False)
        if {"week", "club_code", "depth_team", "position"}.issubset(frame.columns):
            weeks = pd.to_numeric(frame["week"], errors="coerce")
            frame = frame[weeks == weeks.min()].copy()
            frame = frame[
                frame["position"].astype(str).str.upper().isin(OLD_DEFENSE)
                & (pd.to_numeric(frame["depth_team"], errors="coerce") == 1)
            ]
            frame["team_key"] = frame["club_code"]
        else:
            frame["dt"] = pd.to_datetime(frame["dt"], errors="coerce", utc=True)
            cutoff = frame["dt"].min() if season < max(2026, pd.Timestamp.now().year) else frame["dt"].max()
            frame = frame[(frame["dt"] == cutoff) & frame["pos_grp"].astype(str).str.contains(" D", regex=False)].copy()
            frame = frame[pd.to_numeric(frame["pos_rank"], errors="coerce") == 1]
            frame["team_key"] = frame["team"]
        frame["gsis_id"] = frame["gsis_id"].fillna("").astype(str).str.strip()
        for team, rows in frame.groupby("team_key"):
            units[(season, str(team))] = set(rows.loc[rows["gsis_id"] != "", "gsis_id"])
    return units


def feature_table(data_dir: Path, games_path: Path) -> pd.DataFrame:
    units = depth_units(data_dir)
    games = pd.read_csv(games_path, low_memory=False)
    games = games[games["game_type"].astype(str).eq("REG")].copy()
    team_files = sorted(data_dir.glob("stats_team_reg_*.csv"))
    player_files = sorted(data_dir.glob("stats_player_reg_*.csv"))
    team_stats = pd.concat([pd.read_csv(path, low_memory=False) for path in team_files], ignore_index=True)
    player_stats = pd.concat([pd.read_csv(path, low_memory=False) for path in player_files], ignore_index=True)
    team_stats["season"] = pd.to_numeric(team_stats["season"], errors="coerce").astype(int)
    player_stats["season"] = pd.to_numeric(player_stats["season"], errors="coerce").astype(int)
    player_key = "player_id" if "player_id" in player_stats else "gsis_id"
    player_stats[player_key] = player_stats[player_key].fillna("").astype(str)

    scores: dict[tuple[int, str], list[float]] = {}
    opponents: dict[tuple[int, str], list[str]] = {}
    home_games: dict[tuple[int, str], int] = {}
    for game in games.to_dict("records"):
        season = int(_number(game.get("season")))
        home, away = str(game.get("home_team") or ""), str(game.get("away_team") or "")
        if not home or not away:
            continue
        opponents.setdefault((season, home), []).append(away)
        opponents.setdefault((season, away), []).append(home)
        home_games[(season, home)] = home_games.get((season, home), 0) + 1
        hs, aws = _number(game.get("home_score"), np.nan), _number(game.get("away_score"), np.nan)
        if math.isfinite(hs) and math.isfinite(aws):
            scores.setdefault((season, home), []).append(hs)
            scores.setdefault((season, away), []).append(aws)

    team_lookup = {(int(row.season), str(row.team)): row for row in team_stats.itertuples(index=False)}
    player_lookup = {
        (int(season), str(player_id)): group
        for (season, player_id), group in player_stats.groupby(["season", player_key])
    }
    rows = []
    seasons = sorted({season for season, _ in units})
    for season in seasons:
        for team in sorted({team for unit_season, team in units if unit_season == season}):
            current = units.get((season, team), set())
            previous = units.get((season - 1, team), set())
            record = {"season": season, "team": team}
            record["dst_starters"] = len(current)
            record["dst_starter_continuity"] = len(current & previous) / max(1, len(current))
            record["dst_unit_prior_experience"] = sum((season - 1, player) in player_lookup for player in current) / max(1, len(current))
            for stat in PRODUCTION:
                total = 0.0
                for player in current:
                    prior = player_lookup.get((season - 1, player))
                    if prior is not None:
                        total += pd.to_numeric(prior[stat], errors="coerce").fillna(0).sum()
                record[f"dst_unit_prior_{stat}"] = total
            prior_team = team_lookup.get((season - 1, team))
            if prior_team is not None:
                for stat in PRODUCTION:
                    denom = max(1.0, _number(getattr(prior_team, stat, 0)))
                    record[f"dst_retained_{stat}_share"] = record[f"dst_unit_prior_{stat}"] / denom
            schedule = opponents.get((season, team), [])
            record["dst_schedule_games"] = len(schedule)
            record["dst_schedule_home_share"] = home_games.get((season, team), 0) / max(1, len(schedule))
            opponent_values: dict[str, list[float]] = {
                "points_pg": [], "sacks_suffered_pg": [], "turnovers_pg": [],
                "passing_epa_pg": [], "rushing_epa_pg": [],
            }
            for opponent in schedule:
                prior = team_lookup.get((season - 1, opponent))
                prior_scores = scores.get((season - 1, opponent), [])
                if prior is None or not prior_scores:
                    continue
                games_played = max(1.0, _number(getattr(prior, "games", 0)))
                opponent_values["points_pg"].append(float(np.mean(prior_scores)))
                opponent_values["sacks_suffered_pg"].append(_number(getattr(prior, "sacks_suffered", 0)) / games_played)
                opponent_values["turnovers_pg"].append((_number(getattr(prior, "passing_interceptions", 0)) + _number(getattr(prior, "fumbles_lost_total", 0))) / games_played)
                opponent_values["passing_epa_pg"].append(_number(getattr(prior, "passing_epa", 0)) / games_played)
                opponent_values["rushing_epa_pg"].append(_number(getattr(prior, "rushing_epa", 0)) / games_played)
            for key, values in opponent_values.items():
                record[f"dst_schedule_prior_{key}"] = float(np.mean(values)) if values else np.nan
            rows.append(record)
    return pd.DataFrame(rows)


def metrics(prediction: np.ndarray, actual: np.ndarray) -> tuple[float, float]:
    errors = prediction - actual
    return float(np.mean(np.abs(errors))), float(np.sqrt(np.mean(errors ** 2)))


def evaluate(dataset: pd.DataFrame, feature_sets: dict[str, list[str]]) -> None:
    dst = dataset[dataset.position.eq("DST")].copy()
    models = {
        "ridge1": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=1.0)),
        "ridge10": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0)),
        "ridge30": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=30.0)),
        "huber": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), HuberRegressor(epsilon=1.5, alpha=2.0, max_iter=500)),
        "hist": make_pipeline(SimpleImputer(strategy="median"), HistGradientBoostingRegressor(loss="absolute_error", learning_rate=.04, max_iter=60, max_leaf_nodes=7, min_samples_leaf=16, l2_regularization=10, random_state=7)),
        "extra": make_pipeline(SimpleImputer(strategy="median"), ExtraTreesRegressor(n_estimators=300, min_samples_leaf=8, max_features=.6, random_state=7)),
        "forest": make_pipeline(SimpleImputer(strategy="median"), RandomForestRegressor(n_estimators=300, min_samples_leaf=8, max_features=.6, random_state=7)),
    }
    actual_all = []
    results = []
    for set_name, features in feature_sets.items():
        for model_name, model in models.items():
            predictions_all = []
            actual_all = []
            folds = []
            for season in (2023, 2024, 2025):
                train = dst[dst.season.lt(season)]
                test = dst[dst.season.eq(season)]
                model.fit(train[features], train.target_std_total)
                prediction = model.predict(test[features])
                actual = test.target_std_total.to_numpy(float)
                folds.append((season, *metrics(prediction, actual)))
                predictions_all.extend(prediction)
                actual_all.extend(actual)
            aggregate = metrics(np.asarray(predictions_all), np.asarray(actual_all))
            results.append((set_name, model_name, *aggregate, folds))
    for row in sorted(results, key=lambda value: value[2]):
        print(row)


def evaluate_shrunk_schedule(dataset: pd.DataFrame, schedule_features: list[str]) -> None:
    dst = dataset[dataset.position.eq("DST")].copy()
    baseline = 102.0
    candidates = []
    subsets = {"all": schedule_features}
    subsets.update({column.removeprefix("dst_schedule_prior_"): [column] for column in schedule_features if "prior_" in column})
    for name, features in subsets.items():
        for alpha in (0.3, 1.0, 3.0, 10.0, 30.0, 100.0):
            raw_folds = []
            for season in (2023, 2024, 2025):
                train = dst[dst.season.lt(season)]
                test = dst[dst.season.eq(season)]
                model = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=alpha))
                model.fit(train[features], train.target_std_total)
                raw_folds.append((season, model.predict(test[features]), test.target_std_total.to_numpy(float)))
            for blend in np.arange(.025, .501, .025):
                folds = []
                all_p, all_y = [], []
                for season, raw, actual in raw_folds:
                    prediction = baseline + blend * (raw - baseline)
                    folds.append((season, *metrics(prediction, actual)))
                    all_p.extend(prediction); all_y.extend(actual)
                aggregate = metrics(np.asarray(all_p), np.asarray(all_y))
                base_folds = {2023: (22.03125, 26.7167), 2024: (22.8125, 28.2467), 2025: (23.3125, 27.6519)}
                accepted = aggregate[0] < 22.7188 and aggregate[1] <= 27.5456 and all(
                    mae <= base_folds[season][0] and rmse <= base_folds[season][1]
                    for season, mae, rmse in folds
                )
                if accepted:
                    candidates.append((name, alpha, round(float(blend), 3), *aggregate, folds))
    print("PASSING SHRUNK SCHEDULE CANDIDATES")
    for candidate in sorted(candidates, key=lambda row: row[3])[:30]:
        print(candidate)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    dst, players, _ = load_dst_stats(data_dir, data_dir / "games.csv")
    dataset, base_features = build_dataset(dst, players, {})
    preseason = feature_table(data_dir, data_dir / "games.csv")
    dataset = dataset.merge(preseason, left_on=["season", "player_id"], right_on=["season", preseason.team.map(lambda team: f"DST:{team}")], how="left") if False else dataset
    preseason["player_id"] = "DST:" + preseason["team"]
    dataset = dataset.merge(preseason.drop(columns="team"), on=["season", "player_id"], how="left")
    new = [column for column in preseason.columns if column not in {"season", "team", "player_id"}]
    lag = [column for column in base_features if any(token in column for token in ("fantasy_points", "def_", "fumble_recovery", "special_teams", "points_allowed"))]
    feature_sets = {
        "preseason": new,
        "lag": lag,
        "lag+preseason": sorted(set(lag + new)),
        "schedule": [column for column in new if "schedule" in column],
        "unit": [column for column in new if "schedule" not in column],
    }
    print({name: len(columns) for name, columns in feature_sets.items()})
    evaluate(dataset, feature_sets)
    evaluate_shrunk_schedule(dataset, feature_sets["schedule"])


if __name__ == "__main__":
    main()
