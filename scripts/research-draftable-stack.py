"""Audit stack fitting on a preseason-locked draftable cohort.

This is deliberately research-only.  It reconstructs the owned model's OOF
component forecasts, then compares the production all-player stack objective
with one preregistered alternative:

    75% mean absolute error on the locked draftable cohort
  + 25% mean absolute error on every available player

The cohort is selected independently in each season by the empirical model's
PPR total forecast (games * PPR/game), never by outcomes.  Every 2023-2025
test fold fits weights and calibration only on earlier OOF seasons.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (
    CORE_POSITIONS,
    DRAFTABLE_LIMITS,
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
    load_dst_stats,
    load_players,
    load_stats,
)


SEED = 20260715
EVALUATION_SEASONS = (2023, 2024, 2025)
FULL_REGRESSION_TOLERANCE = 0.005
MODELS = ("control", "draftableWeighted75", "jointSeasonTotal75")


def weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    ordered_values = values[order]
    ordered_weights = weights[order]
    cutoff = ordered_weights.sum() / 2.0
    return float(ordered_values[np.searchsorted(np.cumsum(ordered_weights), cutoff)])


def draft_weighted_stack(
    predictions: np.ndarray, actual: np.ndarray, draftable: np.ndarray
) -> tuple[np.ndarray, float]:
    """Fit a fixed 75% draftable / 25% full-cohort absolute-error objective."""
    if not draftable.any():
        weights = _stack_weights(predictions, actual)
        return weights, float(np.median(actual - predictions @ weights))
    full_weights = np.full(len(actual), 0.25 / len(actual), dtype=float)
    sample_weights = full_weights.copy()
    sample_weights[draftable] += 0.75 / int(draftable.sum())
    best = np.array([1.0, 0.0, 0.0])
    best_loss = math.inf
    for a in range(21):
        for b in range(21 - a):
            candidate = np.array([a, b, 20 - a - b], dtype=float) / 20.0
            loss = float(np.sum(sample_weights * np.abs(predictions @ candidate - actual)))
            regularized = loss + 0.015 * float(np.sum((candidate - 1 / 3) ** 2))
            if regularized < best_loss:
                best_loss, best = regularized, candidate
    offset = weighted_median(actual - predictions @ best, sample_weights)
    return best, offset


def objective_sample_weights(draftable: np.ndarray) -> np.ndarray:
    weights = np.full(len(draftable), 0.25 / len(draftable), dtype=float)
    if draftable.any():
        weights[draftable] += 0.75 / int(draftable.sum())
    return weights


def joint_season_total_stack(
    games_component: np.ndarray,
    ppg_component: np.ndarray,
    actual_games: np.ndarray,
    actual_ppg: np.ndarray,
    actual_total: np.ndarray,
    draftable: np.ndarray,
    games_target: str = "games",
    ppg_target: str = "ppr_ppg",
) -> dict[str, Any]:
    """Jointly select architecture-compatible games and PPG stacks.

    A coarser 0.10 simplex grid keeps this nested audit tractable.  Each
    component candidate receives its own weighted-median component offset;
    the pair is then selected only by reconstructed season-total loss.
    """
    sample_weights = objective_sample_weights(draftable)
    grid = np.asarray(
        [
            [a, b, 10 - a - b]
            for a in range(11)
            for b in range(11 - a)
        ],
        dtype=float,
    ) / 10.0
    games_values = []
    games_offsets = []
    ppg_values = []
    ppg_offsets = []
    for weight in grid:
        games_offset = weighted_median(
            actual_games - games_component @ weight, sample_weights
        )
        ppg_offset = weighted_median(actual_ppg - ppg_component @ weight, sample_weights)
        games_offsets.append(games_offset)
        ppg_offsets.append(ppg_offset)
        games_values.append(
            _clip_prediction(games_target, games_component @ weight + games_offset)
        )
        ppg_values.append(
            _clip_prediction(ppg_target, ppg_component @ weight + ppg_offset)
        )
    games_matrix = np.column_stack(games_values)
    ppg_matrix = np.column_stack(ppg_values)
    best_loss = math.inf
    best_pair = (0, 0)
    for games_index, games_weight in enumerate(grid):
        products = games_matrix[:, [games_index]] * ppg_matrix
        losses = np.sum(
            sample_weights[:, None] * np.abs(products - actual_total[:, None]), axis=0
        )
        penalties = 0.015 * (
            np.sum((games_weight - 1 / 3) ** 2)
            + np.sum((grid - 1 / 3) ** 2, axis=1)
        )
        ppg_index = int(np.argmin(losses + penalties))
        if float(losses[ppg_index] + penalties[ppg_index]) < best_loss:
            best_loss = float(losses[ppg_index] + penalties[ppg_index])
            best_pair = (games_index, ppg_index)
    games_index, ppg_index = best_pair
    return {
        "gamesWeight": grid[games_index],
        "gamesOffset": games_offsets[games_index],
        "ppgWeight": grid[ppg_index],
        "ppgOffset": ppg_offsets[ppg_index],
    }


def build_oof(dataset: pd.DataFrame, features: list[str]) -> dict[str, dict[str, pd.DataFrame]]:
    seasons = sorted(int(value) for value in dataset["season"].unique())
    base_seasons = seasons[-5:]
    result: dict[str, dict[str, pd.DataFrame]] = {}
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"] == position]
        result[position] = {}
        for target in TARGETS:
            frames = []
            for season in base_seasons:
                train = rows[rows["season"] < season]
                test = rows[rows["season"] == season]
                if len(train) < 80 or len(test) < 8:
                    continue
                component, _ = _fit_predict(
                    train, test, features, target, position, SEED + season
                )
                frames.append(
                    pd.DataFrame(
                        {
                            "row_index": test.index.to_numpy(),
                            "season": season,
                            "actual": test[f"target_{target}"].to_numpy(dtype=float),
                            "empirical": component[:, 0],
                            "ridge": component[:, 1],
                            "boosted": component[:, 2],
                        }
                    )
                )
            result[position][target] = pd.concat(frames, ignore_index=True).set_index(
                "row_index"
            )
    return result


def locked_cohort(position: str, target_frames: dict[str, pd.DataFrame]) -> pd.Series:
    games = target_frames["games"]
    ppr = target_frames["ppr_ppg"]
    common = games.index.intersection(ppr.index)
    table = pd.DataFrame(
        {
            "season": games.loc[common, "season"],
            "empirical_ppr_total": (
                games.loc[common, "empirical"].to_numpy()
                * ppr.loc[common, "empirical"].to_numpy()
            ),
        },
        index=common,
    )
    selected = pd.Series(False, index=common)
    for _, fold in table.groupby("season"):
        count = min(DRAFTABLE_LIMITS[position], len(fold))
        selected.loc[fold.nlargest(count, "empirical_ppr_total").index] = True
    return selected


def score_position(
    position: str,
    frames: dict[str, pd.DataFrame],
    truth: pd.DataFrame,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cohort = locked_cohort(position, frames)
    common = frames["games"].index
    for target in TARGETS[1:]:
        common = common.intersection(frames[target].index)
    common = common.intersection(cohort.index)
    seasons = frames["games"].loc[common, "season"].to_numpy(dtype=int)
    cohort_mask = cohort.loc[common].to_numpy(dtype=bool)
    predictions: dict[str, dict[str, np.ndarray]] = {
        "control": {},
        "draftableWeighted75": {},
    }
    parameters: dict[str, dict[str, Any]] = {
        "control": {},
        "draftableWeighted75": {},
        "jointSeasonTotal75": {},
    }
    for target in TARGETS:
        frame = frames[target].loc[common]
        components = frame[["empirical", "ridge", "boosted"]].to_numpy(dtype=float)
        actual = frame["actual"].to_numpy(dtype=float)
        predictions["control"][target] = np.full(len(common), np.nan)
        predictions["draftableWeighted75"][target] = np.full(len(common), np.nan)
        parameters["control"][target] = {}
        parameters["draftableWeighted75"][target] = {}
        for season in EVALUATION_SEASONS:
            test = seasons == season
            prior = seasons < season
            prior_draftable = prior & cohort_mask
            control_weight = _stack_weights(components[prior], actual[prior])
            control_offset = float(
                np.median(actual[prior] - components[prior] @ control_weight)
            )
            candidate_weight, candidate_offset = draft_weighted_stack(
                components[prior], actual[prior], prior_draftable[prior]
            )
            # Production's DST safety selector currently falls back to empirical.
            if position == "DST":
                control_weight = candidate_weight = np.array([1.0, 0.0, 0.0])
                control_offset = candidate_offset = 0.0
            predictions["control"][target][test] = _clip_prediction(
                target, components[test] @ control_weight + control_offset
            )
            predictions["draftableWeighted75"][target][test] = _clip_prediction(
                target, components[test] @ candidate_weight + candidate_offset
            )
            parameters["control"][target][str(season)] = {
                "weights": control_weight.tolist(),
                "offset": round(control_offset, 4),
                "priorRows": int(prior.sum()),
                "priorDraftableRows": int(prior_draftable.sum()),
            }
            parameters["draftableWeighted75"][target][str(season)] = {
                "weights": candidate_weight.tolist(),
                "offset": round(candidate_offset, 4),
                "priorRows": int(prior.sum()),
                "priorDraftableRows": int(prior_draftable.sum()),
            }
    joint_totals: dict[str, np.ndarray] = {}
    for scoring, total_column, ppg_target in (
        ("STD", "target_std_total", "std_ppg"),
        ("PPR", "target_ppr_total", "ppr_ppg"),
    ):
        joint_totals[scoring] = np.full(len(common), np.nan)
        parameters["jointSeasonTotal75"][scoring] = {}
        games_frame = frames["games"].loc[common]
        ppg_frame = frames[ppg_target].loc[common]
        games_components = games_frame[
            ["empirical", "ridge", "boosted"]
        ].to_numpy(dtype=float)
        ppg_components = ppg_frame[
            ["empirical", "ridge", "boosted"]
        ].to_numpy(dtype=float)
        actual_games = games_frame["actual"].to_numpy(dtype=float)
        actual_ppg = ppg_frame["actual"].to_numpy(dtype=float)
        actual_total = truth.loc[common, total_column].to_numpy(dtype=float)
        for season in EVALUATION_SEASONS:
            test = seasons == season
            prior = seasons < season
            prior_draftable = cohort_mask[prior]
            if position == "DST":
                selected = {
                    "gamesWeight": np.array([1.0, 0.0, 0.0]),
                    "gamesOffset": 0.0,
                    "ppgWeight": np.array([1.0, 0.0, 0.0]),
                    "ppgOffset": 0.0,
                }
            else:
                selected = joint_season_total_stack(
                    games_components[prior],
                    ppg_components[prior],
                    actual_games[prior],
                    actual_ppg[prior],
                    actual_total[prior],
                    prior_draftable,
                    ppg_target=ppg_target,
                )
            predicted_games = _clip_prediction(
                "games",
                games_components[test] @ selected["gamesWeight"]
                + selected["gamesOffset"],
            )
            predicted_ppg = _clip_prediction(
                ppg_target,
                ppg_components[test] @ selected["ppgWeight"] + selected["ppgOffset"],
            )
            joint_totals[scoring][test] = predicted_games * predicted_ppg
            parameters["jointSeasonTotal75"][scoring][str(season)] = {
                "gamesWeights": selected["gamesWeight"].tolist(),
                "gamesOffset": round(float(selected["gamesOffset"]), 4),
                "ppgWeights": selected["ppgWeight"].tolist(),
                "ppgOffset": round(float(selected["ppgOffset"]), 4),
                "priorRows": int(prior.sum()),
                "priorDraftableRows": int(prior_draftable.sum()),
            }
    target_truth = truth.loc[common]
    records: list[dict[str, Any]] = []
    for scoring, total_column, ppg_target in (
        ("STD", "target_std_total", "std_ppg"),
        ("PPR", "target_ppr_total", "ppr_ppg"),
    ):
        actual_total = target_truth[total_column].to_numpy(dtype=float)
        for season in EVALUATION_SEASONS:
            fold = seasons == season
            for scope, scope_mask in (
                ("full", fold),
                ("draftable", fold & cohort_mask),
            ):
                for model in MODELS:
                    projected = (
                        joint_totals[scoring]
                        if model == "jointSeasonTotal75"
                        else predictions[model]["games"]
                        * predictions[model][ppg_target]
                    )
                    records.append(
                        {
                            "position": position,
                            "scoring": scoring,
                            "season": season,
                            "scope": scope,
                            "model": model,
                            "projected": projected[scope_mask],
                            "actual": actual_total[scope_mask],
                        }
                    )
    return records, {
        "availableRows": int(len(common)),
        "draftableRows": int(cohort_mask.sum()),
        "draftableLimitPerSeason": DRAFTABLE_LIMITS[position],
        "parameters": parameters,
    }


def metric_pair(records: list[dict[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for model in MODELS:
        selected = [record for record in records if record["model"] == model]
        projected = np.concatenate([record["projected"] for record in selected])
        actual = np.concatenate([record["actual"] for record in selected])
        output[model] = _metrics(projected, actual)
    control = output["control"]
    output["deltaCandidateMinusControl"] = {}
    for model in MODELS[1:]:
        candidate = output[model]
        output["deltaCandidateMinusControl"][model] = {
            key: (
                None
                if control[key] is None or candidate[key] is None
                else round(float(candidate[key] - control[key]), 4)
            )
            for key in ("mae", "rmse", "bias", "spearman")
        }
    return output


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    positions: dict[str, Any] = {}
    for position in CORE_POSITIONS:
        positions[position] = {}
        for scoring in ("STD", "PPR"):
            positions[position][scoring] = {}
            for scope in ("full", "draftable"):
                positions[position][scoring][scope] = {
                    str(season): metric_pair(
                        [
                            record
                            for record in records
                            if record["position"] == position
                            and record["scoring"] == scoring
                            and record["scope"] == scope
                            and record["season"] == season
                        ]
                    )
                    for season in EVALUATION_SEASONS
                }
                positions[position][scoring][scope]["aggregate"] = metric_pair(
                    [
                        record
                        for record in records
                        if record["position"] == position
                        and record["scoring"] == scoring
                        and record["scope"] == scope
                    ]
                )
    overall: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        overall[scoring] = {}
        for scope in ("full", "draftable"):
            overall[scoring][scope] = {
                str(season): metric_pair(
                    [
                        record
                        for record in records
                        if record["scoring"] == scoring
                        and record["scope"] == scope
                        and record["season"] == season
                    ]
                )
                for season in EVALUATION_SEASONS
            }
            overall[scoring][scope]["aggregate"] = metric_pair(
                [
                    record
                    for record in records
                    if record["scoring"] == scoring and record["scope"] == scope
                ]
            )
    return {"overall": overall, "positions": positions}


def acceptance(summary: dict[str, Any]) -> dict[str, Any]:
    candidates: dict[str, Any] = {}
    for model in MODELS[1:]:
        target_cells = []
        full_cells = []
        for scoring in ("STD", "PPR"):
            for key in (*map(str, EVALUATION_SEASONS), "aggregate"):
                target_cells.append(summary["overall"][scoring]["draftable"][key])
                full_cells.append(summary["overall"][scoring]["full"][key])
        target_wins = all(
            cell[model]["mae"] < cell["control"]["mae"]
            and cell[model]["rmse"] <= cell["control"]["rmse"]
            for cell in target_cells
        )
        full_safe = all(
            cell[model]["mae"]
            <= cell["control"]["mae"] * (1 + FULL_REGRESSION_TOLERANCE)
            and cell[model]["rmse"]
            <= cell["control"]["rmse"] * (1 + FULL_REGRESSION_TOLERANCE)
            for cell in full_cells
        )
        position_material_regressions = []
        for position in CORE_POSITIONS:
            for scoring in ("STD", "PPR"):
                for key in (*map(str, EVALUATION_SEASONS), "aggregate"):
                    cell = summary["positions"][position][scoring]["full"][key]
                    if (
                        cell[model]["mae"]
                        > cell["control"]["mae"] * (1 + FULL_REGRESSION_TOLERANCE)
                        or cell[model]["rmse"]
                        > cell["control"]["rmse"] * (1 + FULL_REGRESSION_TOLERANCE)
                    ):
                        position_material_regressions.append(
                            {"position": position, "scoring": scoring, "fold": key}
                        )
        candidates[model] = {
            "draftableAggregateAndEveryFoldMaeImprovesWithoutRmseRegression": target_wins,
            "fullAggregateAndEveryFoldWithinTolerance": full_safe,
            "positionFoldMaterialRegressions": position_material_regressions,
            "acceptedForIntegration": bool(
                target_wins and full_safe and not position_material_regressions
            ),
        }
    return {
        "candidates": candidates,
        "fullRegressionTolerance": FULL_REGRESSION_TOLERANCE,
        "acceptedForIntegration": any(
            value["acceptedForIntegration"] for value in candidates.values()
        ),
        "policy": (
            "Accept only if pooled locked-draftable MAE improves and RMSE does not "
            "regress in both scoring formats for every 2023-2025 fold and aggregate, "
            "while no full-cohort pooled or position-fold MAE/RMSE regresses over 0.5%."
        ),
    }


def load_training_data(data_dir: Path) -> tuple[pd.DataFrame, list[str]]:
    stats, _ = load_stats(data_dir)
    players, _ = load_players(data_dir / "players.csv")
    draft_picks, _ = load_draft_picks(data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, draft_picks)
    roles, _ = load_depth_charts(data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dst_stats, dst_players, _ = load_dst_stats(data_dir, data_dir / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    return build_dataset(stats, players, roles)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir", default="data/private/owned-model/raw", type=Path
    )
    parser.add_argument(
        "--out",
        default="data/research/owned-model-draftable-stack.json",
        type=Path,
    )
    args = parser.parse_args()
    dataset, features = load_training_data(args.data_dir)
    oof = build_oof(dataset, features)
    all_records: list[dict[str, Any]] = []
    cohort_details: dict[str, Any] = {}
    for position in CORE_POSITIONS:
        records, detail = score_position(position, oof[position], dataset)
        all_records.extend(records)
        cohort_details[position] = detail
    summary = summarize(all_records)
    report = {
        "schemaVersion": 1,
        "kind": "research-only draftable-cohort stack audit",
        "method": (
            "Nested expanding temporal folds. The candidate's fixed stack objective "
            "assigns 75% weight to a cohort locked by prior-only empirical PPR "
            "projection and 25% to all players. Each 2023-2025 fold learns component "
            "weights and median calibration exclusively from earlier OOF seasons."
        ),
        "cohort": (
            "Top position-specific DRAFTABLE_LIMITS per season by empirical games "
            "times empirical PPR/game; no realized outcome enters selection."
        ),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "cohortDetails": cohort_details,
        **summary,
    }
    report["acceptance"] = acceptance(summary)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "out": str(args.out),
                "acceptance": report["acceptance"],
                "overall": report["overall"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
