"""Leakage-safe research harness for team-level projection reconciliation.

This file is intentionally separate from the owned-model production pipeline.
It recreates the current nested 2023-2025 player forecasts, predicts a
preseason team/position scoring budget from earlier seasons only, and tests
whether gently scaling the players on each preseason roster improves the
untouched next season.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    DRAFTABLE_LIMITS,
    MODEL_VERSION,
    TARGETS,
    _clip_prediction,
    _empirical_predict,
    _fit_predict,
    _metrics,
    _stack_weights,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_players,
    load_stats,
    utc_now,
)

OFFENSE = ("QB", "RB", "WR", "TE")
RIDGE_ALPHAS = (1.0, 10.0, 50.0, 200.0, 1000.0)
BLENDS = (0.0, 0.10, 0.20, 0.35, 0.50, 0.75, 1.0)
RATIO_LIMITS = ((0.70, 1.30), (0.80, 1.20), (0.90, 1.10))
TEAM_FEATURES = (
    "empirical_sum",
    "team_position_ppr_lag1",
    "team_position_ppr_lag2",
    "team_ppr_lag1",
    "team_ppr_lag2",
    "team_attempts_pg",
    "team_carries_pg",
    "team_targets_pg",
    "team_ppr_pg",
    "returning_carry_share",
    "returning_target_share",
    "returning_ppr_share",
    "position_competition",
    "roster_rows",
    "depth_starters",
    "depth_top_three",
    "position_QB",
    "position_RB",
    "position_WR",
    "position_TE",
)


def metric(predicted: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return _metrics(np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float))


def nested_player_forecasts(
    dataset: pd.DataFrame, feature_columns: list[str], seed: int
) -> pd.DataFrame:
    """Recreate current v2026.11 nested forecasts and empirical baselines."""
    seasons = sorted(int(value) for value in dataset["season"].unique())
    base_oof_seasons = seasons[-5:]
    evaluation_seasons = seasons[-3:]
    output: list[pd.DataFrame] = []
    for position in OFFENSE:
        rows = dataset[dataset["position"] == position].copy()
        target_frames: dict[str, pd.DataFrame] = {}
        for target in TARGETS:
            components: list[np.ndarray] = []
            actuals: list[np.ndarray] = []
            labels: list[np.ndarray] = []
            indices: list[np.ndarray] = []
            for season in base_oof_seasons:
                train = rows[rows["season"] < season]
                test = rows[rows["season"] == season]
                if len(train) < 80 or len(test) < 8:
                    continue
                predictions, _ = _fit_predict(
                    train, test, feature_columns, target, position, seed + season
                )
                components.append(predictions)
                actuals.append(test[f"target_{target}"].to_numpy(dtype=float))
                labels.append(np.full(len(test), season))
                indices.append(test.index.to_numpy())
            stacked = np.vstack(components)
            actual = np.concatenate(actuals)
            fold_labels = np.concatenate(labels)
            row_indices = np.concatenate(indices)
            empirical = stacked[:, 0]
            candidate = np.full(len(actual), np.nan)
            for season in evaluation_seasons:
                test_mask = fold_labels == season
                prior_mask = fold_labels < season
                weights = _stack_weights(stacked[prior_mask], actual[prior_mask])
                offset = float(np.median(actual[prior_mask] - stacked[prior_mask] @ weights))
                candidate[test_mask] = _clip_prediction(
                    target, stacked[test_mask] @ weights + offset
                )
            target_frames[target] = pd.DataFrame(
                {
                    "row_index": row_indices,
                    "season": fold_labels,
                    f"empirical_{target}": empirical,
                    f"candidate_{target}": candidate,
                }
            ).set_index("row_index")
        joined = target_frames["games"].join(
            target_frames["ppr_ppg"][
                ["empirical_ppr_ppg", "candidate_ppr_ppg"]
            ]
        )
        truth = rows.loc[joined.index]
        frame = pd.DataFrame(
            {
                "row_index": joined.index,
                "season": joined["season"].astype(int),
                "player_id": truth["player_id"].astype(str),
                "position": position,
                "actual": truth["target_ppr_total"].to_numpy(dtype=float),
                "empirical": (
                    joined["empirical_games"] * joined["empirical_ppr_ppg"]
                ).to_numpy(dtype=float),
                "candidate": (
                    joined["candidate_games"] * joined["candidate_ppr_ppg"]
                ).to_numpy(dtype=float),
            },
            index=joined.index,
        )
        output.append(frame)
    return pd.concat(output).sort_values(["season", "position", "player_id"])


def team_lag_lookup(stats: pd.DataFrame) -> tuple[dict[tuple[int, str, str], float], dict[tuple[int, str], float]]:
    offense = stats[stats["position"].isin(OFFENSE)].copy()
    offense["fantasy_points_ppr"] = pd.to_numeric(
        offense["fantasy_points_ppr"], errors="coerce"
    ).fillna(0.0)
    by_position = (
        offense.groupby(["season", "recent_team", "position"])["fantasy_points_ppr"]
        .sum()
        .to_dict()
    )
    by_team = (
        offense.groupby(["season", "recent_team"])["fantasy_points_ppr"]
        .sum()
        .to_dict()
    )
    return by_position, by_team


def attach_preseason_context(
    forecasts: pd.DataFrame,
    dataset: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    position_lags: dict[tuple[int, str, str], float],
    team_lags: dict[tuple[int, str], float],
) -> pd.DataFrame:
    rows = forecasts.copy()
    rows["team"] = [
        str(roles.get((int(season), str(player_id)), {}).get("team") or "")
        for season, player_id in zip(rows["season"], rows["player_id"])
    ]
    feature_names = [
        "team_attempts_pg",
        "team_carries_pg",
        "team_targets_pg",
        "team_ppr_pg",
        "returning_carry_share",
        "returning_target_share",
        "returning_ppr_share",
        "position_competition",
        "depth_starter",
        "depth_top_three",
    ]
    for name in feature_names:
        rows[name] = dataset.loc[rows.index, name].to_numpy(dtype=float)
    rows["mapped"] = rows["team"].ne("")
    rows["team_position_ppr_lag1"] = [
        position_lags.get((season - 1, team, position), np.nan)
        for season, team, position in zip(rows["season"], rows["team"], rows["position"])
    ]
    rows["team_position_ppr_lag2"] = [
        position_lags.get((season - 2, team, position), np.nan)
        for season, team, position in zip(rows["season"], rows["team"], rows["position"])
    ]
    rows["team_ppr_lag1"] = [
        team_lags.get((season - 1, team), np.nan)
        for season, team in zip(rows["season"], rows["team"])
    ]
    rows["team_ppr_lag2"] = [
        team_lags.get((season - 2, team), np.nan)
        for season, team in zip(rows["season"], rows["team"])
    ]
    return rows


def make_groups(rows: pd.DataFrame) -> pd.DataFrame:
    mapped = rows[rows["mapped"]].copy()
    groups = mapped.groupby(["season", "team", "position"], sort=True)
    result = groups.agg(
        actual=("actual", "sum"),
        empirical_sum=("empirical", "sum"),
        roster_rows=("player_id", "size"),
        depth_starters=("depth_starter", "sum"),
        depth_top_three=("depth_top_three", "sum"),
        team_position_ppr_lag1=("team_position_ppr_lag1", "first"),
        team_position_ppr_lag2=("team_position_ppr_lag2", "first"),
        team_ppr_lag1=("team_ppr_lag1", "first"),
        team_ppr_lag2=("team_ppr_lag2", "first"),
        team_attempts_pg=("team_attempts_pg", "first"),
        team_carries_pg=("team_carries_pg", "first"),
        team_targets_pg=("team_targets_pg", "first"),
        team_ppr_pg=("team_ppr_pg", "first"),
        returning_carry_share=("returning_carry_share", "first"),
        returning_target_share=("returning_target_share", "first"),
        returning_ppr_share=("returning_ppr_share", "first"),
        position_competition=("position_competition", "first"),
    ).reset_index()
    for position in OFFENSE:
        result[f"position_{position}"] = (result["position"] == position).astype(float)
    return result


def budget_model(alpha: float) -> Any:
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        StandardScaler(),
        Ridge(alpha=alpha),
    )


def reconcile(
    players: pd.DataFrame,
    groups: pd.DataFrame,
    train_through: int,
    season: int,
    alpha: float,
    blend: float,
    limits: tuple[float, float],
) -> np.ndarray:
    model = budget_model(alpha)
    train = groups[groups["season"] <= train_through]
    test = groups[groups["season"] == season].copy()
    model.fit(train[list(TEAM_FEATURES)], train["actual"])
    test["budget"] = np.maximum(0.0, model.predict(test[list(TEAM_FEATURES)]))
    budgets = {
        (str(row.team), str(row.position)): float(row.budget)
        for row in test.itertuples()
    }
    baseline_column = "candidate" if season >= 2023 else "empirical"
    season_rows = players[players["season"] == season]
    projected = season_rows[baseline_column].fillna(season_rows["empirical"]).to_numpy(dtype=float)
    output = projected.copy()
    for (_, team, position), indices in season_rows[season_rows["mapped"]].groupby(
        ["season", "team", "position"]
    ).groups.items():
        local = season_rows.index.get_indexer(indices)
        total = float(projected[local].sum())
        if total <= 0:
            continue
        ratio = budgets.get((str(team), str(position)), total) / total
        ratio = float(np.clip(ratio, limits[0], limits[1]))
        output[local] *= 1.0 + blend * (ratio - 1.0)
    return output


def evaluate_configuration(
    players: pd.DataFrame,
    groups: pd.DataFrame,
    season: int,
    alpha: float,
    blend: float,
    limits: tuple[float, float],
) -> dict[str, Any]:
    prediction = reconcile(
        players, groups, season - 1, season, alpha, blend, limits
    )
    season_rows = players[players["season"] == season]
    actual = season_rows["actual"].to_numpy(dtype=float)
    baseline_column = "candidate" if season >= 2023 else "empirical"
    baseline = season_rows[baseline_column].fillna(season_rows["empirical"]).to_numpy(dtype=float)
    return {
        "candidate": metric(prediction, actual),
        "baseline": metric(baseline, actual),
        "prediction": prediction,
    }


def choose_on_validation(
    players: pd.DataFrame, groups: pd.DataFrame, validation_season: int
) -> dict[str, Any]:
    choices: list[dict[str, Any]] = []
    for alpha in RIDGE_ALPHAS:
        for blend in BLENDS:
            for limits in RATIO_LIMITS:
                result = evaluate_configuration(
                    players, groups, validation_season, alpha, blend, limits
                )
                choices.append(
                    {
                        "ridgeAlpha": alpha,
                        "blend": blend,
                        "ratioLimits": list(limits),
                        "mae": result["candidate"]["mae"],
                        "rmse": result["candidate"]["rmse"],
                    }
                )
    return min(choices, key=lambda row: (row["mae"], row["rmse"], row["blend"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument(
        "--out", default="data/research/owned-model-team-reconciliation.json"
    )
    parser.add_argument("--seed", type=int, default=20260715)
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    stats, _ = load_stats(data_dir)
    players, _ = load_players(data_dir / "players.csv")
    draft, _ = load_draft_picks(data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, draft)
    roles, depth_manifest = load_depth_charts(data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dst_stats, dst_players, _ = load_dst_stats(data_dir, data_dir / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, features = build_dataset(stats, players, roles)
    forecasts = nested_player_forecasts(dataset, features, args.seed)
    position_lags, team_lags = team_lag_lookup(stats)
    forecasts = attach_preseason_context(
        forecasts, dataset, roles, position_lags, team_lags
    )
    groups = make_groups(forecasts)

    folds: list[dict[str, Any]] = []
    all_actual: list[np.ndarray] = []
    all_baseline: list[np.ndarray] = []
    all_candidate: list[np.ndarray] = []
    for season in (2023, 2024, 2025):
        selection = choose_on_validation(forecasts, groups, season - 1)
        result = evaluate_configuration(
            forecasts,
            groups,
            season,
            selection["ridgeAlpha"],
            selection["blend"],
            tuple(selection["ratioLimits"]),
        )
        season_rows = forecasts[forecasts["season"] == season]
        actual = season_rows["actual"].to_numpy(dtype=float)
        baseline = season_rows["candidate"].to_numpy(dtype=float)
        candidate = result.pop("prediction")
        all_actual.append(actual)
        all_baseline.append(baseline)
        all_candidate.append(candidate)
        positions: dict[str, Any] = {}
        for position in OFFENSE:
            mask = season_rows["position"].to_numpy() == position
            positions[position] = {
                "reconciled": metric(candidate[mask], actual[mask]),
                "unreconciled": metric(baseline[mask], actual[mask]),
            }
        folds.append(
            {
                "season": season,
                "selectionSeason": season - 1,
                "selected": selection,
                "mappedRows": int(season_rows["mapped"].sum()),
                "totalRows": int(len(season_rows)),
                "reconciled": metric(candidate, actual),
                "unreconciled": metric(baseline, actual),
                "positions": positions,
            }
        )

    actual = np.concatenate(all_actual)
    baseline = np.concatenate(all_baseline)
    candidate = np.concatenate(all_candidate)
    fold_gate = all(
        fold["reconciled"]["mae"] < fold["unreconciled"]["mae"]
        and fold["reconciled"]["rmse"] <= fold["unreconciled"]["rmse"]
        for fold in folds
    )
    aggregate_gate = (
        metric(candidate, actual)["mae"] < metric(baseline, actual)["mae"]
        and metric(candidate, actual)["rmse"] <= metric(baseline, actual)["rmse"]
    )
    report = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "baseModelVersion": MODEL_VERSION,
        "status": "isolated-research-only",
        "method": (
            "For each test season, a ridge model predicts each preseason "
            "team/position PPR budget using only prior-season statistics, the "
            "leakage-safe preseason depth snapshot, and player forecasts made "
            "without that season's outcomes. Hyperparameters are chosen on the "
            "immediately preceding completed season, then refit only on seasons "
            "strictly before the test season. Player forecasts are scaled "
            "proportionally within team/position and bounded."
        ),
        "leakageControls": {
            "teamIdentity": "earliest available week-1 depth snapshot, or the last dated snapshot strictly before the first regular-season game",
            "teamFeatures": list(TEAM_FEATURES),
            "outcomes": "budget target only in seasons strictly before each test fold",
            "selection": "immediately preceding season only",
            "testSeasons": [2023, 2024, 2025],
            "cutoffCaveat": (
                "The nflverse 2022-2024 depth files expose week but no publication "
                "timestamp. Their earliest week-1 rows are the same input accepted "
                "by the current pipeline, but strict pre-kickoff timing cannot be "
                "independently proven. This blocks promotion even if metric gates pass."
            ),
            "depthInputs": [
                {
                    "file": row["file"],
                    "featureCutoff": row["featureCutoff"],
                    "sha256": row["sha256"],
                }
                for row in depth_manifest
                if row["file"].startswith(("depth_charts_2022", "depth_charts_2023", "depth_charts_2024", "depth_charts_2025"))
            ],
        },
        "coverage": {
            "teamGroups": int(len(groups)),
            "playerRows": int(len(forecasts)),
            "mappedPlayerRows": int(forecasts["mapped"].sum()),
        },
        "aggregate": {
            "reconciled": metric(candidate, actual),
            "unreconciled": metric(baseline, actual),
        },
        "folds": folds,
        "acceptance": {
            "aggregateMaeImprovesAndRmseDoesNotRegress": aggregate_gate,
            "everyFoldMaeImprovesAndRmseDoesNotRegress": fold_gate,
            "acceptedForIntegration": bool(aggregate_gate and fold_gate),
            "policy": "Integrate only when aggregate and every 2023-2025 fold lower MAE without RMSE regression.",
            "additionalBlocker": "Historical depth publication timing is unproven for 2022-2024.",
        },
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "aggregate": report["aggregate"],
                "folds": [
                    {
                        "season": fold["season"],
                        "selected": fold["selected"],
                        "reconciled": fold["reconciled"],
                        "unreconciled": fold["unreconciled"],
                    }
                    for fold in folds
                ],
                "acceptance": report["acceptance"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
