"""Rolling conformal uncertainty audit for the shadow owned projection model.

Projection means are held fixed.  The audit compares position-pooled signed
residual quantiles with a preregistered position + rookie/veteran calibration
cohort.  Every test season uses residuals from earlier seasons only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

os.environ.setdefault("LOKY_MAX_CPU_COUNT", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    MODEL_VERSION,
    TARGETS,
    WR_ROOKIE_SPECIALIST,
    _clip_prediction,
    _empirical_predict,
    _fit_predict,
    _stack_weights,
    _wr_rookie_total_model,
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

QUANTILES = (0.10, 0.25, 0.50, 0.75, 0.90)
CALIBRATION_SEASONS = (2020, 2021, 2022)
TEST_SEASONS = (2023, 2024, 2025)
MIN_COHORT_CALIBRATION = 40
MIN_EVALUATION_COHORT = 20
MAX_WIDTH_RATIO = 1.25


def base_forecasts(
    rows: pd.DataFrame,
    features: list[str],
    position: str,
    seasons: tuple[int, ...],
    seed: int,
) -> dict[int, pd.DataFrame]:
    components: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    actual: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    for target in TARGETS:
        for season in seasons:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            values, _ = _fit_predict(train, test, features, target, position, seed + season)
            components[target][season] = values
            actual[target][season] = test[f"target_{target}"].to_numpy(dtype=float)
    output: dict[int, pd.DataFrame] = {}
    for season in seasons:
        predicted: dict[str, np.ndarray] = {}
        for target in TARGETS:
            prior = [
                value for value in seasons
                if value < season and (season < 2023 or value >= 2021)
            ][-5:]
            if prior:
                stacked = np.vstack([components[target][value] for value in prior])
                truth = np.concatenate([actual[target][value] for value in prior])
                weights = _stack_weights(stacked, truth)
                offset = float(np.median(truth - stacked @ weights))
            else:
                weights = np.array([1.0, 0.0, 0.0])
                offset = 0.0
            predicted[target] = _clip_prediction(
                target, components[target][season] @ weights + offset
            )
        test = rows[rows["season"] == season]
        output[season] = pd.DataFrame(
            {
                "row_index": test.index,
                "season": season,
                "position": position,
                "rookie": test["rookie"].to_numpy(dtype=float) == 1.0,
                "mean": predicted["games"] * predicted["ppr_ppg"],
                "actual": test["target_ppr_total"].to_numpy(dtype=float),
            }
        ).set_index("row_index")
    return output


def apply_wr_rookie_specialist(
    forecasts: dict[int, pd.DataFrame],
    rows: pd.DataFrame,
    features: list[str],
    seasons: tuple[int, ...],
    seed: int,
) -> None:
    rookies = rows[rows["rookie"] == 1.0]
    blend = float(WR_ROOKIE_SPECIALIST["pprBlend"])
    for season in seasons:
        test = rookies[rookies["season"] == season]
        if test.empty:
            continue
        train = rookies[rookies["season"] < season]
        model = _wr_rookie_total_model(seed + season)
        model.fit(train[features], train["target_ppr_total"].to_numpy(dtype=float))
        specialist = np.maximum(0.0, model.predict(test[features]))
        base = forecasts[season].loc[test.index, "mean"].to_numpy(dtype=float)
        forecasts[season].loc[test.index, "mean"] = base * (1.0 - blend) + specialist * blend


def signed_quantiles(residuals: np.ndarray) -> np.ndarray:
    # "higher" is conservative and deterministic for finite calibration sets.
    return np.quantile(np.asarray(residuals, dtype=float), QUANTILES, method="higher")


def interval_metrics(rows: pd.DataFrame, quantiles_by_row: np.ndarray) -> dict[str, Any]:
    if rows.empty:
        return {
            "rows": 0,
            "coverage": {f"p{int(level * 100)}": None for level in QUANTILES},
            "meanAbsoluteCalibrationError": None,
            "meanP90P10Width": None,
            "medianP90P10Width": None,
        }
    actual = rows["actual"].to_numpy(dtype=float)
    mean = rows["mean"].to_numpy(dtype=float)
    thresholds = np.maximum(0.0, mean[:, None] + quantiles_by_row)
    coverages = np.mean(actual[:, None] <= thresholds, axis=0)
    calibration_error = float(np.mean(np.abs(coverages - np.asarray(QUANTILES))))
    widths = thresholds[:, -1] - thresholds[:, 0]
    return {
        "rows": int(len(rows)),
        "coverage": {
            f"p{int(level * 100)}": round(float(value), 4)
            for level, value in zip(QUANTILES, coverages)
        },
        "meanAbsoluteCalibrationError": round(calibration_error, 4),
        "meanP90P10Width": round(float(np.mean(widths)), 4),
        "medianP90P10Width": round(float(np.median(widths)), 4),
    }


def score_fold(calibration: pd.DataFrame, test: pd.DataFrame) -> tuple[dict[str, Any], dict[str, Any], dict[str, int]]:
    pooled = signed_quantiles(calibration["residual"].to_numpy(dtype=float))
    baseline_q = np.repeat(pooled[None, :], len(test), axis=0)
    candidate_q = baseline_q.copy()
    fallback = {"rookie": 0, "veteran": 0}
    for rookie, label in ((True, "rookie"), (False, "veteran")):
        test_mask = test["rookie"].to_numpy(dtype=bool) == rookie
        cohort = calibration[calibration["rookie"] == rookie]
        if len(cohort) >= MIN_COHORT_CALIBRATION:
            candidate_q[test_mask] = signed_quantiles(cohort["residual"].to_numpy(dtype=float))
        else:
            fallback[label] = int(test_mask.sum())
    return (
        interval_metrics(test, baseline_q),
        interval_metrics(test, candidate_q),
        fallback,
    )


def acceptance(aggregate: dict[str, Any], slices: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    base = aggregate["baseline"]
    candidate = aggregate["candidate"]
    if candidate["meanAbsoluteCalibrationError"] >= base["meanAbsoluteCalibrationError"]:
        reasons.append("aggregate calibration error did not strictly improve")
    if candidate["meanP90P10Width"] > base["meanP90P10Width"] * MAX_WIDTH_RATIO:
        reasons.append("aggregate interval width exceeded the 25% cap")
    for result in slices:
        if result["rows"] < MIN_EVALUATION_COHORT:
            continue
        prefix = f"{result['season']} {result['position']} {result['cohort']}"
        if result["candidate"]["meanAbsoluteCalibrationError"] > result["baseline"]["meanAbsoluteCalibrationError"]:
            reasons.append(f"{prefix} calibration error regressed")
        if result["candidate"]["meanP90P10Width"] > result["baseline"]["meanP90P10Width"] * MAX_WIDTH_RATIO:
            reasons.append(f"{prefix} interval width exceeded the 25% cap")
    return not reasons, reasons


def run(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.data_dir)
    stats, _ = load_stats(root)
    players, _ = load_players(Path(args.players))
    draft_picks, _ = load_draft_picks(Path(args.draft_picks))
    players, _ = enrich_players_with_draft_picks(players, draft_picks)
    roles, _ = load_depth_charts(root, args.projection_season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.projection_season - 1)
    dst_stats, dst_players, _ = load_dst_stats(root, root / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, features = build_dataset(stats, players, roles)
    seed = int(args.seed)
    # Two extra component seasons let 2020 itself receive a prior-only stack.
    component_seasons = (2018, 2019, *CALIBRATION_SEASONS, *TEST_SEASONS)
    forecast_frames: list[pd.DataFrame] = []
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"] == position]
        forecasts = base_forecasts(rows, features, position, component_seasons, seed)
        if position == "WR":
            apply_wr_rookie_specialist(forecasts, rows, features, component_seasons, seed)
        if position == "DST":
            for season in component_seasons:
                test = rows[rows["season"] == season]
                empirical = _empirical_predict(test, "games", position) * _empirical_predict(test, "ppr_ppg", position)
                forecasts[season]["mean"] = empirical
        forecast_frames.extend(forecasts[season] for season in (*CALIBRATION_SEASONS, *TEST_SEASONS))
    forecasts = pd.concat(forecast_frames, ignore_index=True)
    forecasts["residual"] = forecasts["actual"] - forecasts["mean"]

    scored_rows: list[pd.DataFrame] = []
    fold_results: list[dict[str, Any]] = []
    slice_results: list[dict[str, Any]] = []
    for season in TEST_SEASONS:
        for position in CORE_POSITIONS:
            calibration = forecasts[
                (forecasts["position"] == position) & (forecasts["season"] < season)
            ]
            test = forecasts[
                (forecasts["position"] == position) & (forecasts["season"] == season)
            ].copy()
            pooled = signed_quantiles(calibration["residual"].to_numpy(dtype=float))
            baseline_q = np.repeat(pooled[None, :], len(test), axis=0)
            candidate_q = baseline_q.copy()
            fallback = {"rookie": 0, "veteran": 0}
            for rookie, label in ((True, "rookie"), (False, "veteran")):
                mask = test["rookie"].to_numpy(dtype=bool) == rookie
                cohort = calibration[calibration["rookie"] == rookie]
                if len(cohort) >= MIN_COHORT_CALIBRATION:
                    candidate_q[mask] = signed_quantiles(cohort["residual"].to_numpy(dtype=float))
                else:
                    fallback[label] = int(mask.sum())
            fold_results.append({
                "season": season,
                "position": position,
                "rows": int(len(test)),
                "baseline": interval_metrics(test, baseline_q),
                "candidate": interval_metrics(test, candidate_q),
                "fallbackRows": fallback,
                "calibrationRows": int(len(calibration)),
            })
            for rookie, label in ((True, "rookie"), (False, "veteran")):
                mask = test["rookie"].to_numpy(dtype=bool) == rookie
                selected = test.loc[mask]
                slice_results.append({
                    "season": season,
                    "position": position,
                    "cohort": label,
                    "rows": int(len(selected)),
                    "baseline": interval_metrics(selected, baseline_q[mask]),
                    "candidate": interval_metrics(selected, candidate_q[mask]),
                })
            for index, row in enumerate(test.to_dict("records")):
                scored_rows.append(pd.DataFrame([{
                    **row,
                    **{f"baseline_q{i}": value for i, value in enumerate(baseline_q[index])},
                    **{f"candidate_q{i}": value for i, value in enumerate(candidate_q[index])},
                }]))
    scored = pd.concat(scored_rows, ignore_index=True)
    baseline_q = scored[[f"baseline_q{i}" for i in range(5)]].to_numpy(dtype=float)
    candidate_q = scored[[f"candidate_q{i}" for i in range(5)]].to_numpy(dtype=float)
    aggregate = {
        "baseline": interval_metrics(scored, baseline_q),
        "candidate": interval_metrics(scored, candidate_q),
    }
    accepted, reasons = acceptance(aggregate, slice_results)
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "modelVersion": MODEL_VERSION,
        "researchStatus": "accepted-for-production-review" if accepted else "rejected",
        "meansChanged": False,
        "method": "Rolling signed-residual conformal audit. Every 2023-2025 test interval is calibrated only on earlier out-of-fold seasons. Baseline pools by position; candidate separates rookie and veteran residuals within position when at least 40 prior residuals exist.",
        "quantiles": list(QUANTILES),
        "smallSampleFallback": {
            "minimumCalibrationRows": MIN_COHORT_CALIBRATION,
            "fallback": "position-pooled residual quantiles",
            "minimumRowsForStrictSliceGate": MIN_EVALUATION_COHORT,
        },
        "aggregate": aggregate,
        "folds": fold_results,
        "cohortSlices": slice_results,
        "acceptanceRule": "Aggregate calibration error must strictly improve; no adequately sized position-season-cohort may regress; and mean p90-p10 width may not exceed baseline by more than 25% aggregate or per adequately sized slice.",
        "accepted": accepted,
        "rejectionReasons": reasons,
        "productionChanged": False,
        "limitations": [
            "Historical player files are participant-only, so zero-stat offensive players can be absent.",
            "Signed residual quantiles calibrate marginal outcome coverage, not player-specific conditional distributions.",
            "Only three untouched test seasons are available.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260715)
    parser.add_argument("--output", default="data/research/owned-model-uncertainty-calibration.json")
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "status": report["researchStatus"],
        "aggregate": report["aggregate"],
        "rejectionReasons": report["rejectionReasons"],
    }, indent=2))


if __name__ == "__main__":
    main()
