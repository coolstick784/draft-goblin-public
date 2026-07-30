"""Leakage-safe veteran feature ablations for the owned projection model.

This is a research-only harness.  It uses the production dataset builder and
base learners, adds only static player metadata or statistics from completed
prior seasons, and evaluates nested expanding-season OOF forecasts.  Nothing
in this file changes the saved model, projections, policy, or runtime.
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
    load_players,
    load_stats,
)


SEED = 20260715
BASELINE_MODEL_VERSION = "draft-goblin-owned-2026.11"
POSITIONS = ("QB", "RB", "WR", "TE")
EVALUATION_SEASONS = (2023, 2024, 2025)
RATE_SPECS = {
    "QB": {
        "passing_cpoe": ("passing_cpoe", None),
        "passing_pacr": ("pacr", None),
        "passing_ypa": ("passing_yards", "attempts"),
        "passing_td_rate": ("passing_tds", "attempts"),
        "passing_int_rate": ("passing_interceptions", "attempts"),
        "passing_first_down_rate": ("passing_first_downs", "attempts"),
        "passing_explosive20_rate": ("passing_20", "attempts"),
        "passing_sack_rate": ("sacks_suffered", "attempts"),
        "passing_fumble_rate": ("sack_fumbles_lost", "attempts"),
    },
    "RB": {
        "rushing_ypc": ("rushing_yards", "carries"),
        "rushing_td_rate": ("rushing_tds", "carries"),
        "rushing_first_down_rate": ("rushing_first_downs", "carries"),
        "rushing_explosive10_rate": ("rushing_10", "carries"),
        "rushing_explosive20_rate": ("rushing_20", "carries"),
        "receiving_ypt": ("receiving_yards", "targets"),
        "receiving_catch_rate": ("receptions", "targets"),
        "receiving_first_down_rate": ("receiving_first_downs", "targets"),
        "touch_fumble_lost_rate": ("fumbles_lost_total", "rb_touches"),
    },
    "WR": {
        "receiving_racr": ("racr", None),
        "receiving_ypt": ("receiving_yards", "targets"),
        "receiving_catch_rate": ("receptions", "targets"),
        "receiving_td_rate": ("receiving_tds", "targets"),
        "receiving_first_down_rate": ("receiving_first_downs", "targets"),
        "receiving_explosive10_rate": ("receiving_10", "targets"),
        "receiving_explosive20_rate": ("receiving_20", "targets"),
        "receiving_fumble_lost_rate": ("receiving_fumbles_lost", "targets"),
    },
    "TE": {
        "receiving_racr": ("racr", None),
        "receiving_ypt": ("receiving_yards", "targets"),
        "receiving_catch_rate": ("receptions", "targets"),
        "receiving_td_rate": ("receiving_tds", "targets"),
        "receiving_first_down_rate": ("receiving_first_downs", "targets"),
        "receiving_explosive10_rate": ("receiving_10", "targets"),
        "receiving_explosive20_rate": ("receiving_20", "targets"),
        "receiving_fumble_lost_rate": ("receiving_fumbles_lost", "targets"),
    },
}


def number(value: Any, default: float = math.nan) -> float:
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def height_inches(value: Any) -> float:
    if value is None or pd.isna(value):
        return math.nan
    text = str(value).strip()
    numeric = number(text)
    if math.isfinite(numeric):
        return numeric
    match = pd.Series([text]).str.extract(r"^\s*(\d+)\s*[-']\s*(\d+)\s*$").iloc[0]
    if match.notna().all():
        return float(match.iloc[0]) * 12.0 + float(match.iloc[1])
    return math.nan


def safe_rate(row: dict[str, Any], numerator: str, denominator: str | None) -> float:
    value = number(row.get(numerator))
    if denominator is None:
        return value
    if denominator == "rb_touches":
        base = number(row.get("carries"), 0.0) + number(row.get("receptions"), 0.0)
    else:
        base = number(row.get(denominator))
    if not math.isfinite(value) or not math.isfinite(base) or base < 8.0:
        return math.nan
    return value / base


def augment_features(
    dataset: pd.DataFrame, stats: pd.DataFrame, players: pd.DataFrame
) -> tuple[pd.DataFrame, dict[str, dict[str, list[str]]], dict[str, Any]]:
    result = dataset.copy()
    histories: dict[str, dict[int, dict[str, Any]]] = {}
    for row in stats.to_dict("records"):
        histories.setdefault(str(row["player_id"]), {})[int(row["season"])] = row
    metadata = {
        str(row["player_id"]): row
        for row in players.to_dict("records")
        if str(row.get("player_id") or "")
    }
    feature_groups: dict[str, dict[str, list[str]]] = {}
    coverage: dict[str, Any] = {}
    peaks = {"QB": 29.0, "RB": 25.0, "WR": 27.0, "TE": 28.0}

    for position in POSITIONS:
        position_index = result.index[result["position"].eq(position)]
        physical = ["physical_height_in", "physical_weight_lb", "physical_bmi"]
        lifecycle = [
            "lifecycle_age_sq", "lifecycle_age_post_peak",
            "lifecycle_age_distance_peak", "lifecycle_experience_sqrt",
            "lifecycle_experience_sq", "lifecycle_early_career",
        ]
        efficiency: list[str] = []
        for name in RATE_SPECS[position]:
            efficiency.extend(
                [f"eff_{name}_lag1", f"eff_{name}_lag2", f"eff_{name}_lag3",
                 f"eff_{name}_ewma", f"eff_{name}_trend"]
            )
        for column in physical + lifecycle + efficiency:
            if column not in result:
                result[column] = np.nan

        for index in position_index:
            row = result.loc[index]
            meta = metadata.get(str(row["player_id"]), {})
            height = height_inches(meta.get("height"))
            weight = number(meta.get("weight"))
            result.at[index, "physical_height_in"] = height
            result.at[index, "physical_weight_lb"] = weight
            if math.isfinite(height) and height > 0 and math.isfinite(weight):
                result.at[index, "physical_bmi"] = 703.0 * weight / (height * height)
            age = number(row.get("age"))
            experience = number(row.get("experience"))
            if math.isfinite(age):
                centered = age - peaks[position]
                result.at[index, "lifecycle_age_sq"] = centered * centered
                result.at[index, "lifecycle_age_post_peak"] = max(0.0, centered)
                result.at[index, "lifecycle_age_distance_peak"] = abs(centered)
            if math.isfinite(experience):
                result.at[index, "lifecycle_experience_sqrt"] = math.sqrt(max(0.0, experience))
                result.at[index, "lifecycle_experience_sq"] = experience * experience
                result.at[index, "lifecycle_early_career"] = 1.0 if experience <= 2 else 0.0

            history = histories.get(str(row["player_id"]), {})
            season = int(row["season"])
            for name, (numerator, denominator) in RATE_SPECS[position].items():
                values = [
                    safe_rate(history.get(season - lag, {}), numerator, denominator)
                    for lag in (1, 2, 3)
                ]
                for lag, value in enumerate(values, start=1):
                    result.at[index, f"eff_{name}_lag{lag}"] = value
                present = [
                    (value, weight_value)
                    for value, weight_value in zip(values, (0.60, 0.27, 0.13))
                    if math.isfinite(value)
                ]
                result.at[index, f"eff_{name}_ewma"] = (
                    sum(value * weight_value for value, weight_value in present)
                    / sum(weight_value for _, weight_value in present)
                    if present else math.nan
                )
                result.at[index, f"eff_{name}_trend"] = (
                    values[0] - values[1]
                    if math.isfinite(values[0]) and math.isfinite(values[1])
                    else 0.0
                )
        feature_groups[position] = {
            "physical": physical,
            "lifecycle": lifecycle,
            "efficiency": efficiency,
        }
        veteran = position_index[
            pd.to_numeric(result.loc[position_index, "experience"], errors="coerce").ge(1)
        ]
        coverage[position] = {
            group: {
                "features": len(columns),
                "veteranRows": int(len(veteran)),
                "nonMissingCells": int(result.loc[veteran, columns].notna().sum().sum()),
                "possibleCells": int(len(veteran) * len(columns)),
            }
            for group, columns in feature_groups[position].items()
        }
    return result, feature_groups, coverage


def oof_components(
    rows: pd.DataFrame, features: list[str], position: str
) -> dict[str, pd.DataFrame]:
    seasons = sorted(int(value) for value in rows["season"].unique())
    base_oof_seasons = seasons[-5:]
    result: dict[str, pd.DataFrame] = {}
    for target in TARGETS:
        frames = []
        for season in base_oof_seasons:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            if len(train) < 80 or len(test) < 8:
                continue
            components, _ = _fit_predict(
                train, test, features, target, position, SEED + season
            )
            frames.append(pd.DataFrame({
                "row_index": test.index.to_numpy(),
                "season": season,
                "actual": test[f"target_{target}"].to_numpy(dtype=float),
                "empirical": components[:, 0],
                "ridge": components[:, 1],
                "boosted": components[:, 2],
            }))
        result[target] = pd.concat(frames, ignore_index=True).set_index("row_index")
    return result


def nested_predictions(frames: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    result: dict[str, pd.DataFrame] = {}
    for target, frame in frames.items():
        components = frame[["empirical", "ridge", "boosted"]].to_numpy(dtype=float)
        actual = frame["actual"].to_numpy(dtype=float)
        seasons = frame["season"].to_numpy(dtype=int)
        candidate = np.full(len(frame), np.nan)
        for season in EVALUATION_SEASONS:
            prior = seasons < season
            test = seasons == season
            if not prior.any() or not test.any():
                continue
            weights = _stack_weights(components[prior], actual[prior])
            offset = float(np.median(actual[prior] - components[prior] @ weights))
            candidate[test] = _clip_prediction(
                target, components[test] @ weights + offset
            )
        scored = frame.copy()
        scored["candidate"] = candidate
        result[target] = scored[scored["season"].isin(EVALUATION_SEASONS)]
    return result


def cohort_metrics(
    predictions: dict[str, pd.DataFrame],
    truth: pd.DataFrame,
    position: str,
    locked_ids: set[int],
) -> dict[str, Any]:
    common = predictions["games"].index
    for target in TARGETS[1:]:
        common = common.intersection(predictions[target].index)
    common = common[predictions["games"].loc[common, "candidate"].notna()]
    games = predictions["games"].loc[common, "candidate"].to_numpy(float)
    std = games * predictions["std_ppg"].loc[common, "candidate"].to_numpy(float)
    ppr = games * predictions["ppr_ppg"].loc[common, "candidate"].to_numpy(float)
    actual_std = truth.loc[common, "target_std_total"].to_numpy(float)
    actual_ppr = truth.loc[common, "target_ppr_total"].to_numpy(float)
    season_values = truth.loc[common, "season"].to_numpy(int)
    veteran = pd.to_numeric(
        truth.loc[common, "experience"], errors="coerce"
    ).to_numpy(float) >= 1
    locked = np.asarray([int(index) in locked_ids for index in common]) & veteran
    cohorts = {"all": np.ones(len(common), dtype=bool), "veterans": veteran,
               "lockedDraftableVeterans": locked}
    report: dict[str, Any] = {}
    for cohort_name, cohort_mask in cohorts.items():
        report[cohort_name] = {}
        for scoring, projected, actual in (
            ("STD", std, actual_std), ("PPR", ppr, actual_ppr)
        ):
            report[cohort_name][scoring] = {
                "aggregate": _metrics(projected[cohort_mask], actual[cohort_mask]),
                "folds": {
                    str(season): _metrics(
                        projected[cohort_mask & (season_values == season)],
                        actual[cohort_mask & (season_values == season)],
                    )
                    for season in EVALUATION_SEASONS
                },
            }
    return report


def locked_draftable_ids(
    baseline: dict[str, pd.DataFrame], position: str
) -> set[int]:
    games = baseline["games"]
    ppr = baseline["ppr_ppg"]
    common = games.index.intersection(ppr.index)
    table = pd.DataFrame({
        "season": games.loc[common, "season"],
        "prior_only_ppr": (
            games.loc[common, "empirical"].to_numpy(float)
            * ppr.loc[common, "empirical"].to_numpy(float)
        ),
    }, index=common)
    selected: set[int] = set()
    for _, fold in table.groupby("season"):
        selected.update(int(value) for value in fold.nlargest(
            min(DRAFTABLE_LIMITS[position], len(fold)), "prior_only_ppr"
        ).index)
    return selected


def acceptance(control: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    for cohort in ("veterans", "lockedDraftableVeterans"):
        for scoring in ("STD", "PPR"):
            base = control[cohort][scoring]["aggregate"]
            test = candidate[cohort][scoring]["aggregate"]
            if test["mae"] >= base["mae"]:
                reasons.append(f"{cohort} {scoring} aggregate MAE did not strictly improve")
            if test["rmse"] > base["rmse"]:
                reasons.append(f"{cohort} {scoring} aggregate RMSE regressed")
            if abs(test["bias"]) > abs(base["bias"]):
                reasons.append(f"{cohort} {scoring} aggregate absolute bias regressed")
            if test["spearman"] is not None and base["spearman"] is not None and test["spearman"] < base["spearman"]:
                reasons.append(f"{cohort} {scoring} aggregate rank correlation regressed")
            for season in EVALUATION_SEASONS:
                base_fold = control[cohort][scoring]["folds"][str(season)]
                test_fold = candidate[cohort][scoring]["folds"][str(season)]
                if test_fold["mae"] > base_fold["mae"]:
                    reasons.append(f"{cohort} {season} {scoring} MAE regressed")
                if test_fold["rmse"] > base_fold["rmse"]:
                    reasons.append(f"{cohort} {season} {scoring} RMSE regressed")
    return {
        "accepted": not reasons,
        "policy": (
            "Both veteran and preseason-locked draftable-veteran cohorts must "
            "strictly improve aggregate MAE for STD/PPR; aggregate RMSE, absolute "
            "bias, and Spearman plus every 2023-2025 fold MAE/RMSE may not regress."
        ),
        "reasons": reasons,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("data/private/owned-model/raw"))
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--out", type=Path, default=Path("data/research/owned-model-veteran-feature-ablation.json"))
    args = parser.parse_args()

    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, production_features = build_dataset(stats, players, roles)
    dataset, groups, coverage = augment_features(dataset, stats, players)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only veteran feature ablation",
        "baselineModelVersion": BASELINE_MODEL_VERSION,
        "method": (
            "Production-identical base learners and nested expanding-season stack. "
            "All efficiency inputs are calculated only from completed prior seasons; "
            "height/weight are static; lifecycle terms use preseason-known age and "
            "experience. Evaluation folds are 2023-2025."
        ),
        "featureCutoff": "Every dynamic candidate feature is lagged at least one completed season.",
        "depthChartCaveat": [
            item["featureCutoff"] for item in depth_manifest
            if str(item.get("file", "")).endswith(("2023.csv", "2024.csv", "2025.csv"))
        ],
        "coverage": coverage,
        "positions": {},
        "decision": {},
    }
    variants = ("physical", "lifecycle", "efficiency", "physicalLifecycle", "all")
    for position in POSITIONS:
        rows = dataset[dataset["position"].eq(position)].copy()
        baseline_oof = oof_components(rows, production_features, position)
        locked_ids = locked_draftable_ids(baseline_oof, position)
        control = cohort_metrics(
            nested_predictions(baseline_oof), rows, position, locked_ids
        )
        position_report: dict[str, Any] = {"control": control, "variants": {}}
        position_groups = groups[position]
        additions = {
            "physical": position_groups["physical"],
            "lifecycle": position_groups["lifecycle"],
            "efficiency": position_groups["efficiency"],
            "physicalLifecycle": position_groups["physical"] + position_groups["lifecycle"],
            "all": position_groups["physical"] + position_groups["lifecycle"] + position_groups["efficiency"],
        }
        for variant in variants:
            feature_columns = production_features + additions[variant]
            candidate = cohort_metrics(
                nested_predictions(oof_components(rows, feature_columns, position)),
                rows, position, locked_ids,
            )
            position_report["variants"][variant] = {
                "addedFeatures": additions[variant],
                "metrics": candidate,
                "acceptance": acceptance(control, candidate),
            }
        accepted = [
            name for name, value in position_report["variants"].items()
            if value["acceptance"]["accepted"]
        ]
        report["positions"][position] = position_report
        report["decision"][position] = {
            "acceptedVariants": accepted,
            "productionAction": (
                "Research candidate only; requires independent review and full retrain."
                if accepted else "Reject all tested additions; retain v2026.11."
            ),
        }
    report["overallDecision"] = (
        "No runtime or v2026.11 changes were made. A position-specific addition "
        "is eligible for separate review only when its acceptedVariants list is nonempty."
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(args.out),
        "decisions": report["decision"],
    }, indent=2))


if __name__ == "__main__":
    main()
