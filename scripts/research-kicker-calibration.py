"""Leakage-safe research harness for kicker availability and total calibration.

This script does not alter the owned model or live runtime. It reconstructs the
v2026.11 nested OOF kicker forecasts, then evaluates fixed, predeclared
calibrations whose fold parameters are learned exclusively from earlier OOF
seasons.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    TARGETS,
    _clip_prediction,
    _fit_predict,
    _metrics,
    _stack_weights,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
)


def load_kicker_dataset(root: Path, season: int) -> tuple[pd.DataFrame, list[str]]:
    stats, _ = load_stats(root)
    players, _ = load_players(root / "players.csv")
    picks, _ = load_draft_picks(root / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(root, season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, season - 1)
    dataset, features = build_dataset(stats, players, roles)
    return dataset[dataset["position"] == "K"].copy(), features


def reconstruct_v11(rows: pd.DataFrame, features: list[str], seed: int) -> pd.DataFrame:
    seasons = sorted(int(value) for value in rows["season"].unique())
    evaluation_seasons = seasons[-3:]
    base_oof_seasons = seasons[-5:]
    target_data: dict[str, dict[str, np.ndarray]] = {}
    for target in TARGETS:
        component, actual, labels, indices = [], [], [], []
        for fold_season in base_oof_seasons:
            train = rows[rows["season"] < fold_season]
            test = rows[rows["season"] == fold_season]
            if len(train) < 80 or len(test) < 8:
                continue
            prediction, _ = _fit_predict(train, test, features, target, "K", seed + fold_season)
            component.append(prediction)
            actual.append(test[f"target_{target}"].to_numpy(dtype=float))
            labels.append(np.full(len(test), fold_season))
            indices.append(test.index.to_numpy())
        components = np.vstack(component)
        truth = np.concatenate(actual)
        fold_labels = np.concatenate(labels)
        row_indices = np.concatenate(indices)
        target_data[target] = {
            "components": components,
            "actual": truth,
            "season": fold_labels,
            "index": row_indices,
        }
    fold_frames = []
    for fold_season in evaluation_seasons:
        fold_predictions: dict[str, np.ndarray] = {}
        prior_predictions: dict[str, np.ndarray] = {}
        test_indices = None
        prior_indices = None
        for target in TARGETS:
            data = target_data[target]
            test_mask = data["season"] == fold_season
            prior_mask = data["season"] < fold_season
            weights = _stack_weights(data["components"][prior_mask], data["actual"][prior_mask])
            offset = float(np.median(
                data["actual"][prior_mask] - data["components"][prior_mask] @ weights
            ))
            fold_predictions[target] = _clip_prediction(
                target, data["components"][test_mask] @ weights + offset
            )
            prior_predictions[target] = _clip_prediction(
                target, data["components"][prior_mask] @ weights + offset
            )
            test_indices = data["index"][test_mask]
            prior_indices = data["index"][prior_mask]
        test_truth = rows.loc[test_indices]
        prior_truth = rows.loc[prior_indices]
        current = fold_predictions["games"] * fold_predictions["std_ppg"]
        prior_current = prior_predictions["games"] * prior_predictions["std_ppg"]
        prior_actual = prior_truth["target_std_total"].to_numpy(dtype=float)
        residual = prior_actual - prior_current
        frame = pd.DataFrame({
            "row_index": test_indices,
            "season": fold_season,
            "pred_games": fold_predictions["games"],
            "pred_std_ppg": fold_predictions["std_ppg"],
            "actual": test_truth["target_std_total"].to_numpy(dtype=float),
            "current": current,
            "empirical": (
                target_data["games"]["components"][
                    target_data["games"]["season"] == fold_season, 0
                ]
                * target_data["std_ppg"]["components"][
                    target_data["std_ppg"]["season"] == fold_season, 0
                ]
            ),
            "actual_games": test_truth["target_games"].to_numpy(dtype=float),
            "depth_starter": test_truth["depth_starter"].to_numpy(dtype=float),
            "depth_rank": test_truth["depth_rank"].to_numpy(dtype=float),
            "games_lag1": test_truth["games_lag1"].to_numpy(dtype=float),
            "prior_residual_mean": float(np.mean(residual)),
            "prior_residual_median": float(np.median(residual)),
        }).set_index("row_index")
        for ridge in (1.0, 10.0, 100.0, 1000.0):
            design = np.column_stack([np.ones(len(prior_current)), prior_current])
            penalty = np.diag([ridge * 0.01, ridge])
            identity = np.array([0.0, 1.0])
            beta = np.linalg.solve(
                design.T @ design + penalty,
                design.T @ prior_actual + penalty @ identity,
            )
            frame[f"affine_{ridge:g}_intercept"] = float(beta[0])
            frame[f"affine_{ridge:g}_slope"] = float(beta[1])
        fold_frames.append(frame)
    return pd.concat(fold_frames).sort_values(["season", "row_index"])


def prior_residual_offset(frame: pd.DataFrame, statistic: str, shrink: float) -> np.ndarray:
    result = np.zeros(len(frame), dtype=float)
    seasons = frame["season"].to_numpy(dtype=int)
    prediction = frame["current"].to_numpy(dtype=float)
    actual = frame["actual"].to_numpy(dtype=float)
    for season in sorted(set(seasons)):
        prior = seasons < season
        mask = seasons == season
        center = frame.loc[mask, f"prior_residual_{statistic}"].to_numpy(dtype=float)
        result[mask] = prediction[mask] + shrink * center
    return np.clip(result, -34.0, 595.0)


def prior_affine(frame: pd.DataFrame, ridge: float, shrink: float) -> np.ndarray:
    result = np.zeros(len(frame), dtype=float)
    seasons = frame["season"].to_numpy(dtype=int)
    prediction = frame["current"].to_numpy(dtype=float)
    actual = frame["actual"].to_numpy(dtype=float)
    for season in sorted(set(seasons)):
        target_prior = np.array([0.0, 1.0])
        mask = seasons == season
        beta = np.array([
            frame.loc[mask, f"affine_{ridge:g}_intercept"].iloc[0],
            frame.loc[mask, f"affine_{ridge:g}_slope"].iloc[0],
        ])
        beta = target_prior + shrink * (beta - target_prior)
        test_design = np.column_stack(
            [np.ones(np.sum(mask)), prediction[mask]]
        )
        result[mask] = test_design @ beta
    return np.clip(result, -34.0, 595.0)


def evaluate(frame: pd.DataFrame, prediction: np.ndarray) -> dict:
    actual = frame["actual"].to_numpy(dtype=float)
    current = frame["current"].to_numpy(dtype=float)
    by_fold = {}
    accepted = True
    for season in sorted(int(value) for value in frame["season"].unique()):
        mask = frame["season"].to_numpy(dtype=int) == season
        candidate_metrics = _metrics(prediction[mask], actual[mask])
        current_metrics = _metrics(current[mask], actual[mask])
        mae_ok = candidate_metrics["mae"] <= current_metrics["mae"]
        rmse_ok = candidate_metrics["rmse"] <= current_metrics["rmse"]
        accepted &= mae_ok and rmse_ok
        by_fold[str(season)] = {
            "candidate": candidate_metrics,
            "v2026.11": current_metrics,
            "maeNonRegression": mae_ok,
            "rmseNonRegression": rmse_ok,
        }
    aggregate_candidate = _metrics(prediction, actual)
    aggregate_current = _metrics(current, actual)
    aggregate_ok = (
        aggregate_candidate["mae"] < aggregate_current["mae"]
        and aggregate_candidate["rmse"] <= aggregate_current["rmse"]
    )
    return {
        "aggregate": {"candidate": aggregate_candidate, "v2026.11": aggregate_current},
        "folds": by_fold,
        "accepted": bool(aggregate_ok and accepted),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--output", default="data/research/kicker-calibration-audit.json")
    parser.add_argument("--seed", type=int, default=20260715)
    args = parser.parse_args()
    rows, features = load_kicker_dataset(Path(args.data_dir), args.season)
    frame = reconstruct_v11(rows, features, args.seed)
    candidates: dict[str, np.ndarray] = {"identity": frame["current"].to_numpy(dtype=float)}
    for empirical_weight in (0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50):
        candidates[f"empirical-total-blend-{empirical_weight:g}"] = (
            (1.0 - empirical_weight) * frame["current"].to_numpy(dtype=float)
            + empirical_weight * frame["empirical"].to_numpy(dtype=float)
        )
        current = frame["current"].to_numpy(dtype=float)
        empirical = frame["empirical"].to_numpy(dtype=float)
        candidates[f"empirical-downside-only-{empirical_weight:g}"] = np.where(
            current > empirical,
            (1.0 - empirical_weight) * current + empirical_weight * empirical,
            current,
        )
    for cap in (110.0, 120.0, 130.0, 140.0, 150.0, 160.0):
        candidates[f"fixed-total-cap-{cap:g}"] = np.minimum(
            frame["current"].to_numpy(dtype=float), cap
        )
    ranked_backup = (
        np.isfinite(frame["depth_rank"].to_numpy(dtype=float))
        & (frame["depth_rank"].to_numpy(dtype=float) > 1.0)
    )
    for factor in (0.25, 0.5, 0.75):
        values = frame["current"].to_numpy(dtype=float).copy()
        values[ranked_backup] *= factor
        candidates[f"depth-backup-availability-{factor:g}"] = values
    for statistic in ("mean", "median"):
        for shrink in (0.25, 0.5, 0.75, 1.0):
            candidates[f"prior-{statistic}-offset-{shrink:g}"] = prior_residual_offset(
                frame, statistic, shrink
            )
    for ridge in (1.0, 10.0, 100.0, 1000.0):
        for shrink in (0.25, 0.5, 0.75, 1.0):
            candidates[f"prior-affine-ridge-{ridge:g}-shrink-{shrink:g}"] = prior_affine(
                frame, ridge, shrink
            )
    evaluations = {name: evaluate(frame, values) for name, values in candidates.items()}
    accepted = [
        name for name, result in evaluations.items()
        if name != "identity" and result["accepted"]
    ]
    result = {
        "schemaVersion": 1,
        "researchOnly": True,
        "productionChanged": False,
        "method": (
            "Reconstruct v2026.11 nested OOF kicker totals. Each candidate's fold "
            "calibration is fit only on earlier OOF seasons. Acceptance requires "
            "strict aggregate MAE improvement plus aggregate RMSE and every "
            "2023-2025 fold MAE/RMSE non-regression versus v2026.11."
        ),
        "rows": int(len(frame)),
        "zeroOutcomes": int((frame["actual_games"] == 0).sum()),
        "acceptedCandidates": accepted,
        "diagnostics": {
            "depthRankKnownRows": int(np.isfinite(frame["depth_rank"]).sum()),
            "depthBackupRows": int(ranked_backup.sum()),
            "zeroOutcomeMetrics": _metrics(
                frame.loc[frame["actual_games"] == 0, "current"].to_numpy(dtype=float),
                frame.loc[frame["actual_games"] == 0, "actual"].to_numpy(dtype=float),
            ),
            "positiveOutcomeMetrics": _metrics(
                frame.loc[frame["actual_games"] > 0, "current"].to_numpy(dtype=float),
                frame.loc[frame["actual_games"] > 0, "actual"].to_numpy(dtype=float),
            ),
        },
        "evaluations": evaluations,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "rows": result["rows"],
        "zeroOutcomes": result["zeroOutcomes"],
        "acceptedCandidates": accepted,
        "acceptedMetrics": {name: evaluations[name] for name in accepted},
    }, indent=2))


if __name__ == "__main__":
    main()
