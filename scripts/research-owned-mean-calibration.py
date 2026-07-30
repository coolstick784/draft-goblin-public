"""Locked post-hoc season-total calibration audit for owned v2026.12."""

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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    DRAFTABLE_LIMITS,
    MODEL_VERSION,
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

COMPONENT_SEASONS = (2021, 2022, 2023, 2024, 2025)
EVALUATION_SEASONS = (2023, 2024, 2025)
AFFINE_SLOPES = (0.75, 0.875, 1.0, 1.125, 1.25)


def metric(predicted: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return _metrics(np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float))


def exact_base_forecasts(
    rows: pd.DataFrame, features: list[str], position: str, seed: int
) -> dict[int, pd.DataFrame]:
    components: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    actual: dict[str, dict[int, np.ndarray]] = {target: {} for target in TARGETS}
    for target in TARGETS:
        for season in COMPONENT_SEASONS:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            values, _ = _fit_predict(train, test, features, target, position, seed + season)
            components[target][season] = values
            actual[target][season] = test[f"target_{target}"].to_numpy(dtype=float)
        gc.collect()
    output: dict[int, pd.DataFrame] = {}
    for season in (2022, *EVALUATION_SEASONS):
        predicted: dict[str, np.ndarray] = {}
        for target in TARGETS:
            prior = [value for value in COMPONENT_SEASONS if value < season]
            stacked = np.vstack([components[target][value] for value in prior])
            truth = np.concatenate([actual[target][value] for value in prior])
            weights = _stack_weights(stacked, truth)
            offset = float(np.median(truth - stacked @ weights))
            predicted[target] = _clip_prediction(
                target, components[target][season] @ weights + offset
            )
        test = rows[rows["season"] == season]
        mean_std = np.maximum(0.0, predicted["games"] * predicted["std_ppg"])
        mean_ppr = np.maximum(mean_std, predicted["games"] * predicted["ppr_ppg"])
        output[season] = pd.DataFrame({
            "row_index": test.index,
            "season": season,
            "position": position,
            "rookie": test["rookie"].to_numpy(dtype=float) == 1.0,
            "mean_std": mean_std,
            "mean_ppr": mean_ppr,
            "actual_std": test["target_std_total"].to_numpy(dtype=float),
            "actual_ppr": test["target_ppr_total"].to_numpy(dtype=float),
        }).set_index("row_index")
    return output


def apply_wr_specialist(
    forecasts: dict[int, pd.DataFrame],
    rows: pd.DataFrame,
    features: list[str],
    seed: int,
) -> None:
    rookies = rows[rows["rookie"] == 1.0]
    for season in (2022, *EVALUATION_SEASONS):
        train = rookies[rookies["season"] < season]
        test = rookies[rookies["season"] == season]
        if test.empty:
            continue
        for scoring, blend in (
            ("std", float(WR_ROOKIE_SPECIALIST["stdBlend"])),
            ("ppr", float(WR_ROOKIE_SPECIALIST["pprBlend"])),
        ):
            model = _wr_rookie_total_model(seed + season)
            model.fit(train[features], train[f"target_{scoring}_total"].to_numpy(dtype=float))
            specialist = np.maximum(0.0, model.predict(test[features]))
            base = forecasts[season].loc[test.index, f"mean_{scoring}"].to_numpy(dtype=float)
            forecasts[season].loc[test.index, f"mean_{scoring}"] = (
                base * (1.0 - blend) + specialist * blend
            )
        forecasts[season].loc[test.index, "mean_ppr"] = np.maximum(
            forecasts[season].loc[test.index, "mean_std"].to_numpy(dtype=float),
            forecasts[season].loc[test.index, "mean_ppr"].to_numpy(dtype=float),
        )


def policy_candidates(predicted: np.ndarray, actual: np.ndarray) -> list[dict[str, Any]]:
    predicted = np.asarray(predicted, dtype=float)
    actual = np.asarray(actual, dtype=float)
    candidates: list[dict[str, Any]] = [{"family": "identity", "slope": 1.0, "offset": 0.0}]
    candidates.append({
        "family": "additive",
        "slope": 1.0,
        "offset": float(np.median(actual - predicted)),
    })
    positive = predicted > 1e-9
    scale = float(np.median(actual[positive] / predicted[positive])) if positive.any() else 1.0
    candidates.append({
        "family": "multiplicative",
        "slope": float(np.clip(scale, 0.50, 1.50)),
        "offset": 0.0,
    })
    for slope in AFFINE_SLOPES:
        candidates.append({
            "family": "monotoneAffine",
            "slope": float(slope),
            "offset": float(np.median(actual - slope * predicted)),
        })
    return candidates


def apply_policy(values: np.ndarray, policy: dict[str, Any]) -> np.ndarray:
    return np.maximum(
        0.0,
        float(policy["slope"]) * np.asarray(values, dtype=float)
        + float(policy["offset"]),
    )


def no_regression(candidate: dict[str, Any], baseline: dict[str, Any]) -> bool:
    return (
        candidate["mae"] <= baseline["mae"]
        and candidate["rmse"] <= baseline["rmse"]
        and abs(candidate["bias"]) <= abs(baseline["bias"])
        and (
            candidate["spearman"] is None
            or baseline["spearman"] is None
            or candidate["spearman"] >= baseline["spearman"] - 1e-12
        )
    )


def cohort_indices(frame: pd.DataFrame, scoring: str, position: str) -> np.ndarray:
    count = min(DRAFTABLE_LIMITS[position], len(frame))
    return np.argsort(-frame[f"mean_{scoring}"].to_numpy(dtype=float))[:count]


def choose_policy(validation: pd.DataFrame, scoring: str, position: str) -> dict[str, Any]:
    predicted = validation[f"mean_{scoring}"].to_numpy(dtype=float)
    actual = validation[f"actual_{scoring}"].to_numpy(dtype=float)
    draftable = cohort_indices(validation, scoring, position)
    base_full = metric(predicted, actual)
    base_draftable = metric(predicted[draftable], actual[draftable])
    evaluated: list[dict[str, Any]] = []
    for policy in policy_candidates(predicted, actual):
        candidate = apply_policy(predicted, policy)
        full = metric(candidate, actual)
        locked = metric(candidate[draftable], actual[draftable])
        admissible = no_regression(full, base_full) and no_regression(locked, base_draftable)
        objective = (
            full["mae"] / max(base_full["mae"], 1e-9)
            + locked["mae"] / max(base_draftable["mae"], 1e-9)
        )
        evaluated.append({
            **policy,
            "admissibleOn2022": admissible,
            "objective": round(float(objective), 6),
            "full": full,
            "lockedDraftable": locked,
        })
    admissible = [value for value in evaluated if value["admissibleOn2022"]]
    selected = min(admissible, key=lambda value: (value["objective"], value["family"] != "identity"))
    return {
        "selectionSeason": 2022,
        "selected": selected,
        "baseline": {"full": base_full, "lockedDraftable": base_draftable},
        "alternatives": evaluated,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
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
    dataset, features = build_dataset(stats, players, roles)
    seed = int(args.seed)

    forecasts: dict[str, dict[int, pd.DataFrame]] = {}
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"] == position]
        values = exact_base_forecasts(rows, features, position, seed)
        if position == "WR":
            apply_wr_specialist(values, rows, features, seed)
        if position == "DST":
            for season in (2022, *EVALUATION_SEASONS):
                test = rows[rows["season"] == season]
                empirical_games = _empirical_predict(test, "games", position)
                empirical_std = empirical_games * _empirical_predict(test, "std_ppg", position)
                empirical_ppr = empirical_games * _empirical_predict(test, "ppr_ppg", position)
                values[season]["mean_std"] = np.maximum(0.0, empirical_std)
                values[season]["mean_ppr"] = np.maximum(
                    values[season]["mean_std"].to_numpy(dtype=float), empirical_ppr
                )
        forecasts[position] = values
        gc.collect()

    selections: dict[str, Any] = {}
    fold_results: list[dict[str, Any]] = []
    aggregate_results: dict[str, Any] = {}
    accepted_policies: list[dict[str, Any]] = []
    rejected_policies: list[dict[str, Any]] = []
    for position in CORE_POSITIONS:
        selections[position] = {}
        for scoring in ("std", "ppr"):
            selection = choose_policy(forecasts[position][2022], scoring, position)
            selections[position][scoring.upper()] = selection
            policy = selection["selected"]
            full_base_parts: list[np.ndarray] = []
            full_candidate_parts: list[np.ndarray] = []
            full_actual_parts: list[np.ndarray] = []
            draft_base_parts: list[np.ndarray] = []
            draft_candidate_parts: list[np.ndarray] = []
            draft_actual_parts: list[np.ndarray] = []
            failures: list[str] = []
            for season in EVALUATION_SEASONS:
                frame = forecasts[position][season]
                base = frame[f"mean_{scoring}"].to_numpy(dtype=float)
                actual = frame[f"actual_{scoring}"].to_numpy(dtype=float)
                candidate = apply_policy(base, policy)
                draftable = cohort_indices(frame, scoring, position)
                fold = {
                    "season": season,
                    "position": position,
                    "scoring": scoring.upper(),
                    "rows": int(len(frame)),
                    "policy": {key: policy[key] for key in ("family", "slope", "offset")},
                    "full": {
                        "baseline": metric(base, actual),
                        "candidate": metric(candidate, actual),
                    },
                    "lockedDraftable": {
                        "rows": int(len(draftable)),
                        "baseline": metric(base[draftable], actual[draftable]),
                        "candidate": metric(candidate[draftable], actual[draftable]),
                    },
                }
                if not no_regression(fold["full"]["candidate"], fold["full"]["baseline"]):
                    failures.append(f"{season} full guard failed")
                if not no_regression(
                    fold["lockedDraftable"]["candidate"],
                    fold["lockedDraftable"]["baseline"],
                ):
                    failures.append(f"{season} locked-draftable guard failed")
                fold_results.append(fold)
                full_base_parts.append(base)
                full_candidate_parts.append(candidate)
                full_actual_parts.append(actual)
                draft_base_parts.append(base[draftable])
                draft_candidate_parts.append(candidate[draftable])
                draft_actual_parts.append(actual[draftable])
            base_full = np.concatenate(full_base_parts)
            candidate_full = np.concatenate(full_candidate_parts)
            actual_full = np.concatenate(full_actual_parts)
            base_draft = np.concatenate(draft_base_parts)
            candidate_draft = np.concatenate(draft_candidate_parts)
            actual_draft = np.concatenate(draft_actual_parts)
            aggregate = {
                "policy": {key: policy[key] for key in ("family", "slope", "offset")},
                "full": {
                    "baseline": metric(base_full, actual_full),
                    "candidate": metric(candidate_full, actual_full),
                },
                "lockedDraftable": {
                    "baseline": metric(base_draft, actual_draft),
                    "candidate": metric(candidate_draft, actual_draft),
                },
            }
            aggregate_results.setdefault(position, {})[scoring.upper()] = aggregate
            strict_improvement = (
                aggregate["full"]["candidate"]["mae"] < aggregate["full"]["baseline"]["mae"]
                and aggregate["lockedDraftable"]["candidate"]["mae"]
                < aggregate["lockedDraftable"]["baseline"]["mae"]
            )
            aggregate_safe = (
                no_regression(aggregate["full"]["candidate"], aggregate["full"]["baseline"])
                and no_regression(
                    aggregate["lockedDraftable"]["candidate"],
                    aggregate["lockedDraftable"]["baseline"],
                )
            )
            result = {
                "position": position,
                "scoring": scoring.upper(),
                "policy": aggregate["policy"],
                "accepted": strict_improvement and aggregate_safe and not failures,
                "reasons": failures
                + ([] if strict_improvement else ["aggregate full and draftable MAE did not both strictly improve"])
                + ([] if aggregate_safe else ["aggregate guard failed"]),
            }
            (accepted_policies if result["accepted"] else rejected_policies).append(result)

    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "baseModelVersion": MODEL_VERSION,
        "researchStatus": "accepted-position-specific-policies" if accepted_policies else "rejected",
        "method": "Rank-preserving post-hoc season-total calibration. Identity, additive, multiplicative, and positive affine policies are fit and selected on 2022 only, then locked for untouched 2023-2025 evaluation.",
        "wrRookieSpecialistAppliedBeforeCalibration": True,
        "selection": selections,
        "aggregate": aggregate_results,
        "folds": fold_results,
        "acceptanceRule": "A position-format policy must strictly improve both full and locked-draftable aggregate MAE and avoid MAE, RMSE, absolute-bias, or Spearman regression in every full and locked-draftable 2023-2025 fold and aggregate.",
        "acceptedPolicies": accepted_policies,
        "rejectedPolicies": rejected_policies,
        "productionChanged": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260715)
    parser.add_argument("--output", default="data/research/owned-model-mean-calibration.json")
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "status": report["researchStatus"],
        "acceptedPolicies": report["acceptedPolicies"],
        "rejectedCount": len(report["rejectedPolicies"]),
    }, indent=2))


if __name__ == "__main__":
    main()
