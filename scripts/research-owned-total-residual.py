"""Research a causal season-total residual target against owned v2026.12.

The candidate predicts ``actual season total - prior-only empirical total``.
That is a genuinely different target from the incumbent games x points/game
stack and the previously audited raw direct-total target.  Hyperparameters are
fixed.  Position/format blend fractions are selected only on 2021-2022 and are
then frozen for development evaluation on 2023-2025.

This harness is research-only and cannot modify the model, policy, or live
projection payload.
"""

from __future__ import annotations

import argparse
import gc
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
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    DRAFTABLE_LIMITS,
    MODEL_VERSION,
    POSITION_PRIORS,
    TARGETS,
    WR_ROOKIE_SPECIALIST,
    _clip_prediction,
    _empirical_predict,
    _fit_predict,
    _metrics,
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

SEED = 20260715
COMPONENT_SEASONS = tuple(range(2019, 2026))
SELECTION_SEASONS = (2021, 2022)
DEVELOPMENT_SEASONS = (2023, 2024, 2025)
BLENDS = (0.0, 0.10, 0.25, 0.50, 0.75, 1.0)
TOTAL_CLIP = (0.0, 600.0)


def metric(predicted: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return _metrics(np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float))


def no_regression(candidate: dict[str, Any], baseline: dict[str, Any]) -> bool:
    return (
        candidate["mae"] <= baseline["mae"] + 1e-12
        and candidate["rmse"] <= baseline["rmse"] + 1e-12
        and abs(candidate["bias"]) <= abs(baseline["bias"]) + 1e-12
        and (
            candidate["spearman"] is None
            or baseline["spearman"] is None
            or candidate["spearman"] >= baseline["spearman"] - 1e-12
        )
    )


def empirical_total(rows: pd.DataFrame, scoring: str, position: str) -> np.ndarray:
    points = "fantasy_points" if scoring == "STD" else "fantasy_points_ppr"
    values = np.column_stack([
        rows[f"{points}_lag{lag}"].to_numpy(dtype=float)
        * rows[f"games_lag{lag}"].to_numpy(dtype=float)
        for lag in (1, 2, 3)
    ])
    weights = np.asarray([0.60, 0.27, 0.13])
    valid = np.isfinite(values)
    numerator = np.where(valid, values * weights, 0.0).sum(axis=1)
    denominator = np.where(valid, weights, 0.0).sum(axis=1)
    ppg_target = "std_ppg" if scoring == "STD" else "ppr_ppg"
    prior = POSITION_PRIORS[position]["games"] * POSITION_PRIORS[position][ppg_target]
    estimate = np.divide(
        numerator,
        denominator,
        out=np.full(len(rows), prior, dtype=float),
        where=denominator > 0,
    )
    experience = rows["experience"].to_numpy(dtype=float)
    confidence = np.clip(np.nan_to_num(experience, nan=0.0) / 3.0, 0.0, 1.0)
    return np.clip(estimate * confidence + prior * (1.0 - confidence), *TOTAL_CLIP)


def residual_model(seed: int) -> Any:
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        HistGradientBoostingRegressor(
            loss="absolute_error",
            learning_rate=0.05,
            max_iter=120,
            max_leaf_nodes=15,
            min_samples_leaf=18,
            l2_regularization=5.0,
            random_state=seed,
        ),
    )


def incumbent_forecasts(
    rows: pd.DataFrame, features: list[str], position: str
) -> dict[int, pd.DataFrame]:
    components: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    actual: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    indices: dict[int, np.ndarray] = {}
    for season in COMPONENT_SEASONS:
        train = rows[rows["season"] < season]
        test = rows[rows["season"] == season]
        if len(train) < 80 or len(test) < 8:
            continue
        indices[season] = test.index.to_numpy()
        for target in TARGETS:
            values, _ = _fit_predict(
                train, test, features, target, position, SEED + season
            )
            components[target][season] = values
            actual[target][season] = test[f"target_{target}"].to_numpy(dtype=float)

    output: dict[int, pd.DataFrame] = {}
    for season in (*SELECTION_SEASONS, *DEVELOPMENT_SEASONS):
        predictions: dict[str, np.ndarray] = {}
        for target in TARGETS:
            prior = [value for value in components[target] if value < season]
            if len(prior) < 2:
                raise ValueError(f"Need at least two prior OOF folds for {position} {season}.")
            matrix = np.vstack([components[target][value] for value in prior])
            truth = np.concatenate([actual[target][value] for value in prior])
            weights = _stack_weights(matrix, truth)
            offset = float(np.median(truth - matrix @ weights))
            predictions[target] = _clip_prediction(
                target, components[target][season] @ weights + offset
            )
        test = rows.loc[indices[season]]
        mean_std = np.maximum(0.0, predictions["games"] * predictions["std_ppg"])
        mean_ppr = np.maximum(mean_std, predictions["games"] * predictions["ppr_ppg"])
        output[season] = pd.DataFrame({
            "row_index": test.index,
            "season": season,
            "rookie": test["rookie"].to_numpy(dtype=float) == 1.0,
            "empirical_ppr": (
                _empirical_predict(test, "games", position)
                * _empirical_predict(test, "ppr_ppg", position)
            ),
            "mean_std": mean_std,
            "mean_ppr": mean_ppr,
            "actual_std": test["target_std_total"].to_numpy(dtype=float),
            "actual_ppr": test["target_ppr_total"].to_numpy(dtype=float),
        }).set_index("row_index")
    return output


def apply_v12_safety_and_specialist(
    forecasts: dict[int, pd.DataFrame],
    rows: pd.DataFrame,
    features: list[str],
    position: str,
) -> None:
    if position == "DST":
        for season, frame in forecasts.items():
            test = rows.loc[frame.index]
            games = _empirical_predict(test, "games", position)
            frame["mean_std"] = np.maximum(
                0.0, games * _empirical_predict(test, "std_ppg", position)
            )
            frame["mean_ppr"] = np.maximum(
                frame["mean_std"].to_numpy(dtype=float),
                games * _empirical_predict(test, "ppr_ppg", position),
            )
    if position != "WR":
        return
    rookies = rows[rows["rookie"] == 1.0]
    for season in DEVELOPMENT_SEASONS:
        test = rookies[rookies["season"] == season]
        if test.empty:
            continue
        for scoring, blend in (
            ("std", float(WR_ROOKIE_SPECIALIST["stdBlend"])),
            ("ppr", float(WR_ROOKIE_SPECIALIST["pprBlend"])),
        ):
            model = _wr_rookie_total_model(SEED + season)
            train = rookies[rookies["season"] < season]
            model.fit(train[features], train[f"target_{scoring}_total"])
            raw = np.maximum(0.0, model.predict(test[features]))
            base = forecasts[season].loc[test.index, f"mean_{scoring}"].to_numpy()
            forecasts[season].loc[test.index, f"mean_{scoring}"] = (
                base * (1.0 - blend) + raw * blend
            )
        forecasts[season].loc[test.index, "mean_ppr"] = np.maximum(
            forecasts[season].loc[test.index, "mean_std"].to_numpy(),
            forecasts[season].loc[test.index, "mean_ppr"].to_numpy(),
        )


def residual_forecasts(
    rows: pd.DataFrame, features: list[str], position: str
) -> dict[str, dict[int, np.ndarray]]:
    output = {scoring: {} for scoring in ("STD", "PPR")}
    for season in (*SELECTION_SEASONS, *DEVELOPMENT_SEASONS):
        train = rows[rows["season"] < season]
        test = rows[rows["season"] == season]
        for scoring in ("STD", "PPR"):
            target = f"target_{scoring.lower()}_total"
            train_empirical = empirical_total(train, scoring, position)
            test_empirical = empirical_total(test, scoring, position)
            y = train[target].to_numpy(dtype=float) - train_empirical
            model = residual_model(SEED + season)
            model.fit(train[features], y)
            output[scoring][season] = np.clip(
                test_empirical + model.predict(test[features]), *TOTAL_CLIP
            )
    return output


def draftable_indices(frame: pd.DataFrame, position: str) -> np.ndarray:
    return np.argsort(-frame["empirical_ppr"].to_numpy(dtype=float))[
        : min(DRAFTABLE_LIMITS[position], len(frame))
    ]


def select_blend(
    forecasts: dict[int, pd.DataFrame],
    residual: dict[int, np.ndarray],
    scoring: str,
    position: str,
) -> dict[str, Any]:
    alternatives: list[dict[str, Any]] = []
    for blend in BLENDS:
        fold_results: list[dict[str, Any]] = []
        admissible = True
        total_loss = 0.0
        for season in SELECTION_SEASONS:
            frame = forecasts[season]
            base = frame[f"mean_{scoring.lower()}"].to_numpy(dtype=float)
            # Keep WR rookies isolated from this new policy.
            apply = ~frame["rookie"].to_numpy(dtype=bool) if position == "WR" else np.ones(len(frame), dtype=bool)
            candidate = base.copy()
            candidate[apply] = base[apply] * (1.0 - blend) + residual[season][apply] * blend
            actual = frame[f"actual_{scoring.lower()}"].to_numpy(dtype=float)
            locked = draftable_indices(frame, position)
            base_full, candidate_full = metric(base, actual), metric(candidate, actual)
            base_locked = metric(base[locked], actual[locked])
            candidate_locked = metric(candidate[locked], actual[locked])
            safe = no_regression(candidate_full, base_full) and no_regression(
                candidate_locked, base_locked
            )
            admissible = admissible and safe
            total_loss += (
                candidate_full["mae"] / max(base_full["mae"], 1e-9)
                + candidate_locked["mae"] / max(base_locked["mae"], 1e-9)
            )
            fold_results.append({
                "season": season,
                "safe": safe,
                "full": {"baseline": base_full, "candidate": candidate_full},
                "lockedDraftable": {
                    "baseline": base_locked,
                    "candidate": candidate_locked,
                },
            })
        alternatives.append({
            "blend": blend,
            "admissibleOnBothSelectionFolds": admissible,
            "objective": round(total_loss, 6),
            "folds": fold_results,
        })
    admissible = [value for value in alternatives if value["admissibleOnBothSelectionFolds"]]
    selected = min(admissible, key=lambda value: (value["objective"], value["blend"]))
    return {"selected": selected, "alternatives": alternatives}


def evaluate_policy(
    forecasts: dict[int, pd.DataFrame],
    residual: dict[int, np.ndarray],
    selection: dict[str, Any],
    scoring: str,
    position: str,
) -> dict[str, Any]:
    blend = float(selection["selected"]["blend"])
    folds: list[dict[str, Any]] = []
    pooled: dict[str, list[np.ndarray]] = {
        key: [] for key in ("base", "candidate", "actual", "draft_base", "draft_candidate", "draft_actual")
    }
    failures: list[str] = []
    for season in DEVELOPMENT_SEASONS:
        frame = forecasts[season]
        base = frame[f"mean_{scoring.lower()}"].to_numpy(dtype=float)
        apply = ~frame["rookie"].to_numpy(dtype=bool) if position == "WR" else np.ones(len(frame), dtype=bool)
        candidate = base.copy()
        candidate[apply] = base[apply] * (1.0 - blend) + residual[season][apply] * blend
        actual = frame[f"actual_{scoring.lower()}"].to_numpy(dtype=float)
        locked = draftable_indices(frame, position)
        full = {"baseline": metric(base, actual), "candidate": metric(candidate, actual)}
        draftable = {
            "baseline": metric(base[locked], actual[locked]),
            "candidate": metric(candidate[locked], actual[locked]),
        }
        if not no_regression(full["candidate"], full["baseline"]):
            failures.append(f"{season} full guard failed")
        if not no_regression(draftable["candidate"], draftable["baseline"]):
            failures.append(f"{season} locked-draftable guard failed")
        folds.append({"season": season, "full": full, "lockedDraftable": draftable})
        for key, value in (
            ("base", base), ("candidate", candidate), ("actual", actual),
            ("draft_base", base[locked]), ("draft_candidate", candidate[locked]),
            ("draft_actual", actual[locked]),
        ):
            pooled[key].append(value)
    aggregate = {
        "full": {
            "baseline": metric(np.concatenate(pooled["base"]), np.concatenate(pooled["actual"])),
            "candidate": metric(np.concatenate(pooled["candidate"]), np.concatenate(pooled["actual"])),
        },
        "lockedDraftable": {
            "baseline": metric(np.concatenate(pooled["draft_base"]), np.concatenate(pooled["draft_actual"])),
            "candidate": metric(np.concatenate(pooled["draft_candidate"]), np.concatenate(pooled["draft_actual"])),
        },
    }
    aggregate_safe = no_regression(
        aggregate["full"]["candidate"], aggregate["full"]["baseline"]
    ) and no_regression(
        aggregate["lockedDraftable"]["candidate"],
        aggregate["lockedDraftable"]["baseline"],
    )
    strict = (
        aggregate["full"]["candidate"]["mae"] < aggregate["full"]["baseline"]["mae"]
        and aggregate["lockedDraftable"]["candidate"]["mae"]
        < aggregate["lockedDraftable"]["baseline"]["mae"]
    )
    accepted = blend > 0 and strict and aggregate_safe and not failures
    if blend == 0:
        failures.append("early-fold selector chose identity")
    if not strict:
        failures.append("aggregate full and draftable MAE did not both strictly improve")
    if not aggregate_safe:
        failures.append("aggregate guard failed")
    return {
        "blend": blend,
        "accepted": accepted,
        "reasons": failures,
        "aggregate": aggregate,
        "folds": folds,
    }


def load_dataset(args: argparse.Namespace) -> tuple[pd.DataFrame, list[str]]:
    root = Path(args.data_dir)
    stats, _ = load_stats(root)
    players, _ = load_players(Path(args.players))
    picks, _ = load_draft_picks(Path(args.draft_picks))
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(root, args.projection_season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.projection_season - 1)
    dst_stats, dst_players, _ = load_dst_stats(root, root / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    return build_dataset(stats, players, roles)


def run(args: argparse.Namespace) -> dict[str, Any]:
    dataset, features = load_dataset(args)
    results: dict[str, Any] = {}
    accepted: list[dict[str, Any]] = []
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"] == position].copy()
        forecasts = incumbent_forecasts(rows, features, position)
        apply_v12_safety_and_specialist(forecasts, rows, features, position)
        residual = residual_forecasts(rows, features, position)
        results[position] = {}
        for scoring in ("STD", "PPR"):
            selection = select_blend(
                forecasts, residual[scoring], scoring, position
            )
            evaluation = evaluate_policy(
                forecasts, residual[scoring], selection, scoring, position
            )
            results[position][scoring] = {
                "selection": selection,
                "development": evaluation,
            }
            if evaluation["accepted"]:
                accepted.append({
                    "position": position,
                    "scoring": scoring,
                    "blend": evaluation["blend"],
                })
        gc.collect()
    return {
        "schemaVersion": 1,
        "kind": "research-only prior-forecast season-total residual audit",
        "generatedAt": utc_now(),
        "baseModelVersion": MODEL_VERSION,
        "researchStatus": "accepted-position-specific-policies" if accepted else "rejected",
        "targetFormulation": "actual season total minus a prior-only empirical season-total forecast",
        "model": {
            "family": "HistGradientBoostingRegressor",
            "loss": "absolute_error",
            "learningRate": 0.05,
            "maxIter": 120,
            "maxLeafNodes": 15,
            "minSamplesLeaf": 18,
            "l2Regularization": 5.0,
        },
        "temporalProtocol": {
            "componentSeasons": list(COMPONENT_SEASONS),
            "selectionSeasons": list(SELECTION_SEASONS),
            "developmentSeasons": list(DEVELOPMENT_SEASONS),
            "selectionRule": "Choose among fixed blends using only 2021-2022. A blend must avoid MAE, RMSE, absolute-bias, and Spearman regression in full and locked-draftable cohorts in each selection fold; minimize summed relative MAE, preferring smaller blend on ties.",
            "developmentRule": "Accept only a nonzero locked blend that strictly lowers aggregate full and locked-draftable MAE and avoids all four metric regressions in each 2023-2025 full and locked-draftable fold and aggregate.",
        },
        "wrRookiePolicy": "Existing v2026.12 specialist is retained in 2023-2025 baseline; the new residual candidate is never applied to WR rookies.",
        "results": results,
        "acceptedPolicies": accepted,
        "productionChanged": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--output", default="data/research/owned-model-total-residual.json")
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "output": str(output),
        "researchStatus": report["researchStatus"],
        "acceptedPolicies": report["acceptedPolicies"],
    }, indent=2))


if __name__ == "__main__":
    main()
