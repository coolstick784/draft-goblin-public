"""Leakage-safe audit of one additional conservative tree-family component.

This is an isolated research harness.  It recreates the v2026.11 OOF
components, produces ExtraTrees and RandomForest forecasts using only seasons
before each forecast season, and selects the extra component for each
2023-2025 fold using only earlier OOF predictions.  It never changes the
production model or projection payload.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import warnings
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
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
    utc_now,
)


SEED = 20260715
BASE_OOF_SEASONS = (2021, 2022, 2023, 2024, 2025)
EVALUATION_SEASONS = (2023, 2024, 2025)
FAMILY_NAMES = ("extraTrees", "randomForest")


def family_models(seed: int) -> dict[str, Any]:
    """Small fixed family set; no test-fold hyperparameter search is allowed."""
    common = {
        "n_estimators": 160,
        "max_features": 0.65,
        "min_samples_leaf": 8,
        "max_depth": 12,
        "random_state": seed,
        "n_jobs": 1,
    }
    return {
        "extraTrees": make_pipeline(
            SimpleImputer(strategy="median", add_indicator=True),
            ExtraTreesRegressor(**common),
        ),
        "randomForest": make_pipeline(
            SimpleImputer(strategy="median", add_indicator=True),
            RandomForestRegressor(**common),
        ),
    }


def simplex4_weights(predictions: np.ndarray, actual: np.ndarray) -> np.ndarray:
    """Select four-component weights on a conservative 10-point simplex."""
    best = np.asarray([1.0, 0.0, 0.0, 0.0])
    best_loss = math.inf
    for values in product(range(11), repeat=3):
        used = sum(values)
        if used > 10:
            continue
        weights = np.asarray([*values, 10 - used], dtype=float) / 10.0
        loss = float(np.mean(np.abs(predictions @ weights - actual)))
        regularized = loss + 0.015 * float(np.sum((weights - 0.25) ** 2))
        if regularized < best_loss:
            best_loss = regularized
            best = weights
    return best


def build_oof(
    dataset: pd.DataFrame, features: list[str]
) -> dict[str, dict[str, pd.DataFrame]]:
    output: dict[str, dict[str, pd.DataFrame]] = {}
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"].eq(position)]
        output[position] = {}
        frames: dict[str, list[pd.DataFrame]] = {target: [] for target in TARGETS}
        for season in BASE_OOF_SEASONS:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            if len(train) < 80 or len(test) < 8:
                continue
            for target in TARGETS:
                incumbent, _ = _fit_predict(
                    train, test, features, target, position, SEED + season
                )
                values: dict[str, np.ndarray] = {
                    "empirical": incumbent[:, 0],
                    "ridge": incumbent[:, 1],
                    "boosted": incumbent[:, 2],
                }
                y = train[f"target_{target}"].to_numpy(dtype=float)
                for name, model in family_models(SEED + season).items():
                    model.fit(train[features], y)
                    values[name] = _clip_prediction(
                        target, model.predict(test[features])
                    )
                frames[target].append(
                    pd.DataFrame(values, index=test.index).assign(season=season)
                )
        for target, target_frames in frames.items():
            if not target_frames:
                raise ValueError(f"No OOF rows for {position} {target}.")
            output[position][target] = pd.concat(target_frames).sort_index()
    return output


def nested_predictions(
    components: pd.DataFrame,
    actual: np.ndarray,
    target: str,
    force_control_empirical: bool,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    seasons = components["season"].to_numpy(dtype=int)
    incumbent_matrix = components[
        ["empirical", "ridge", "boosted"]
    ].to_numpy(dtype=float)
    control = np.full(len(components), np.nan)
    candidate = np.full(len(components), np.nan)
    details: dict[str, Any] = {}
    for season in EVALUATION_SEASONS:
        prior = seasons < season
        test = seasons == season
        if not prior.any() or not test.any():
            raise ValueError(f"Missing nested fold {season} for {target}.")
        if force_control_empirical:
            control_weights = np.asarray([1.0, 0.0, 0.0])
            control_offset = 0.0
        else:
            control_weights = _stack_weights(
                incumbent_matrix[prior], actual[prior]
            )
            control_offset = float(
                np.median(actual[prior] - incumbent_matrix[prior] @ control_weights)
            )
        control[test] = _clip_prediction(
            target,
            incumbent_matrix[test] @ control_weights + control_offset,
        )

        # Family selection is based exclusively on prior OOF absolute error.
        family_losses: dict[str, float] = {}
        for name in FAMILY_NAMES:
            raw = components[name].to_numpy(dtype=float)
            offset = float(np.median(actual[prior] - raw[prior]))
            family_losses[name] = float(
                np.mean(np.abs(raw[prior] + offset - actual[prior]))
            )
        selected = min(FAMILY_NAMES, key=lambda name: (family_losses[name], name))
        candidate_matrix = np.column_stack(
            [incumbent_matrix, components[selected].to_numpy(dtype=float)]
        )
        candidate_weights = simplex4_weights(
            candidate_matrix[prior], actual[prior]
        )
        candidate_offset = float(
            np.median(actual[prior] - candidate_matrix[prior] @ candidate_weights)
        )
        candidate[test] = _clip_prediction(
            target,
            candidate_matrix[test] @ candidate_weights + candidate_offset,
        )
        details[str(season)] = {
            "priorOofSeasons": sorted(set(int(value) for value in seasons[prior])),
            "priorRows": int(prior.sum()),
            "familyPriorMae": {
                key: round(value, 6) for key, value in family_losses.items()
            },
            "selectedFamily": selected,
            "controlWeights": control_weights.tolist(),
            "controlCalibrationOffset": round(control_offset, 6),
            "candidateWeights": {
                "empirical": float(candidate_weights[0]),
                "ridge": float(candidate_weights[1]),
                "boosted": float(candidate_weights[2]),
                selected: float(candidate_weights[3]),
            },
            "candidateCalibrationOffset": round(candidate_offset, 6),
        }
    return control, candidate, details


def locked_draftable(
    position: str, components: dict[str, pd.DataFrame], common: pd.Index
) -> np.ndarray:
    games = components["games"].loc[common]
    ppr = components["ppr_ppg"].loc[common]
    seasons = games["season"].to_numpy(dtype=int)
    prior_only_total = (
        games["empirical"].to_numpy(dtype=float)
        * ppr["empirical"].to_numpy(dtype=float)
    )
    selected = np.zeros(len(common), dtype=bool)
    for season in EVALUATION_SEASONS:
        indices = np.flatnonzero(seasons == season)
        order = indices[np.argsort(-prior_only_total[indices])]
        selected[order[: DRAFTABLE_LIMITS[position]]] = True
    return selected


def metric_pair(
    control: np.ndarray, candidate: np.ndarray, actual: np.ndarray, mask: np.ndarray
) -> dict[str, Any]:
    return {
        "control": _metrics(control[mask], actual[mask]),
        "candidate": _metrics(candidate[mask], actual[mask]),
    }


def evaluate_position(
    position: str,
    components: dict[str, pd.DataFrame],
    dataset: pd.DataFrame,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    common = components[TARGETS[0]].index
    for target in TARGETS[1:]:
        common = common.intersection(components[target].index)
    seasons = components["games"].loc[common, "season"].to_numpy(dtype=int)
    truth = dataset.loc[common]
    predictions: dict[str, dict[str, np.ndarray]] = {
        "control": {},
        "candidate": {},
    }
    parameters: dict[str, Any] = {}
    for target in TARGETS:
        actual = truth[f"target_{target}"].to_numpy(dtype=float)
        control, candidate, detail = nested_predictions(
            components[target].loc[common],
            actual,
            target,
            force_control_empirical=position == "DST",
        )
        predictions["control"][target] = control
        predictions["candidate"][target] = candidate
        parameters[target] = detail

    totals: dict[str, dict[str, np.ndarray]] = {"control": {}, "candidate": {}}
    for model in ("control", "candidate"):
        totals[model]["STD"] = (
            predictions[model]["games"] * predictions[model]["std_ppg"]
        )
        totals[model]["PPR"] = (
            predictions[model]["games"] * predictions[model]["ppr_ppg"]
        )
    actuals = {
        "STD": truth["target_std_total"].to_numpy(dtype=float),
        "PPR": truth["target_ppr_total"].to_numpy(dtype=float),
    }
    evaluation = np.isin(seasons, EVALUATION_SEASONS)
    draftable = locked_draftable(position, components, common)
    result: dict[str, Any] = {
        "parameters": parameters,
        "lockedDraftableRows": int((evaluation & draftable).sum()),
        "fullRows": int(evaluation.sum()),
        "overall": {},
        "folds": {},
    }
    records: list[dict[str, Any]] = []
    for scoring in ("STD", "PPR"):
        result["overall"][scoring] = {}
        for scope, scope_mask in (
            ("full", evaluation),
            ("draftable", evaluation & draftable),
        ):
            result["overall"][scoring][scope] = metric_pair(
                totals["control"][scoring],
                totals["candidate"][scoring],
                actuals[scoring],
                scope_mask,
            )
    for season in EVALUATION_SEASONS:
        result["folds"][str(season)] = {}
        fold = seasons == season
        for scoring in ("STD", "PPR"):
            result["folds"][str(season)][scoring] = {}
            for scope, scope_mask in (
                ("full", fold),
                ("draftable", fold & draftable),
            ):
                pair = metric_pair(
                    totals["control"][scoring],
                    totals["candidate"][scoring],
                    actuals[scoring],
                    scope_mask,
                )
                result["folds"][str(season)][scoring][scope] = pair
                for model in ("control", "candidate"):
                    mask = scope_mask
                    for projected, actual in zip(
                        totals[model][scoring][mask], actuals[scoring][mask]
                    ):
                        records.append(
                            {
                                "position": position,
                                "season": season,
                                "scoring": scoring,
                                "scope": scope,
                                "model": model,
                                "projected": float(projected),
                                "actual": float(actual),
                            }
                        )
    return result, records


def pooled_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    frame = pd.DataFrame(records)
    output: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        output[scoring] = {}
        for scope in ("full", "draftable"):
            output[scoring][scope] = {}
            for model in ("control", "candidate"):
                rows = frame[
                    frame["scoring"].eq(scoring)
                    & frame["scope"].eq(scope)
                    & frame["model"].eq(model)
                ]
                output[scoring][scope][model] = _metrics(
                    rows["projected"].to_numpy(dtype=float),
                    rows["actual"].to_numpy(dtype=float),
                )
    return output


def acceptance(positions: dict[str, Any], pooled: dict[str, Any]) -> dict[str, Any]:
    regressions: list[str] = []
    wins = 0
    cells = 0

    def inspect(label: str, pair: dict[str, Any], require_win: bool) -> None:
        nonlocal wins, cells
        control = pair["control"]
        candidate = pair["candidate"]
        cells += 1
        if candidate["mae"] < control["mae"]:
            wins += 1
        elif require_win:
            regressions.append(f"{label}: MAE did not improve")
        if candidate["mae"] > control["mae"]:
            regressions.append(f"{label}: MAE regressed")
        if candidate["rmse"] > control["rmse"]:
            regressions.append(f"{label}: RMSE regressed")
        if (
            candidate["spearman"] is not None
            and control["spearman"] is not None
            and candidate["spearman"] < control["spearman"]
        ):
            regressions.append(f"{label}: Spearman regressed")

    for scoring in ("STD", "PPR"):
        for scope in ("full", "draftable"):
            inspect(
                f"pooled {scoring} {scope}",
                pooled[scoring][scope],
                require_win=True,
            )
    for position, result in positions.items():
        for scoring in ("STD", "PPR"):
            for scope in ("full", "draftable"):
                inspect(
                    f"{position} aggregate {scoring} {scope}",
                    result["overall"][scoring][scope],
                    require_win=False,
                )
                for season in EVALUATION_SEASONS:
                    inspect(
                        f"{position} {season} {scoring} {scope}",
                        result["folds"][str(season)][scoring][scope],
                        require_win=False,
                    )
    return {
        "policy": (
            "Accept only if pooled MAE improves in all four scoring/cohort cells "
            "and no pooled, position, or 2023-2025 position-fold cell regresses "
            "in MAE, RMSE, or Spearman. Family and stack selection for each test "
            "fold may use only earlier OOF seasons."
        ),
        "evaluatedCells": cells,
        "maeWins": wins,
        "regressions": sorted(set(regressions)),
        "acceptedForIntegration": not regressions,
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
        "--data-dir", type=Path, default="data/private/owned-model/raw"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default="data/research/owned-model-family-audit.json",
    )
    args = parser.parse_args()
    for variable in (
        "LOKY_MAX_CPU_COUNT",
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ[variable] = "1"
    warnings.filterwarnings(
        "ignore", message="Skipping features without any observed values"
    )
    dataset, features = load_training_data(args.data_dir)
    oof = build_oof(dataset, features)
    positions: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    for position in CORE_POSITIONS:
        positions[position], position_records = evaluate_position(
            position, oof[position], dataset
        )
        records.extend(position_records)
    pooled = pooled_metrics(records)
    gate = acceptance(positions, pooled)
    report = {
        "schemaVersion": 1,
        "kind": "research-only conservative model-family audit",
        "generatedAt": utc_now(),
        "method": (
            "Expanding-season OOF forecasts. ExtraTrees and RandomForest are "
            "trained only on seasons before each OOF season. For each 2023-2025 "
            "test fold and target, family selection, four-way stack weights, and "
            "median calibration use only earlier OOF seasons."
        ),
        "families": {
            "candidates": list(FAMILY_NAMES),
            "fixedParameters": {
                "nEstimators": 160,
                "maxFeatures": 0.65,
                "minSamplesLeaf": 8,
                "maxDepth": 12,
                "nJobs": 1,
            },
        },
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "baseOofSeasons": list(BASE_OOF_SEASONS),
        "cohort": (
            "Locked before outcomes: top DRAFTABLE_LIMITS per position and "
            "season by incumbent empirical PPR season-total forecast."
        ),
        "pooled": pooled,
        "positions": positions,
        "acceptance": gate,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "out": str(args.out),
                "pooled": pooled,
                "acceptance": gate,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
