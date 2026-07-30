"""Leakage-safe research harness for a rookie-specific projection specialist.

This is deliberately isolated from the production owned-model pipeline.  It
compares the current model family with direct rookie season-total models.  For
each 2023-2025 test season, specialist family, regularization, and base/specialist
blend are selected on the immediately preceding unseen season, then refit using
only seasons before the test season.
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
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
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
EVALUATION_SEASONS = (2023, 2024, 2025)
RIDGE_ALPHAS = (5.0, 20.0, 80.0, 320.0, 1280.0)
BOOSTED_LEAVES = (10, 18, 30)
BLENDS = (0.0, 0.25, 0.50, 0.75, 1.0)


def metric(predicted: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return _metrics(np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float))


def base_forecasts(
    rows: pd.DataFrame,
    features: list[str],
    position: str,
    requested_seasons: tuple[int, ...],
    seed: int,
) -> dict[int, pd.DataFrame]:
    """Recreate nested base stacks while fitting each temporal component once."""
    by_season: dict[int, dict[str, np.ndarray]] = {
        season: {} for season in requested_seasons
    }
    for target in TARGETS:
        components_by_season: dict[int, np.ndarray] = {}
        actual_by_season: dict[int, np.ndarray] = {}
        component_seasons = tuple(range(min(requested_seasons) - 2, max(requested_seasons) + 1))
        for component_season in component_seasons:
            component_train = rows[rows["season"] < component_season]
            component_test = rows[rows["season"] == component_season]
            if len(component_train) < 80 or len(component_test) < 8:
                continue
            components, _ = _fit_predict(
                component_train,
                component_test,
                features,
                target,
                position,
                seed + component_season,
            )
            components_by_season[component_season] = components
            actual_by_season[component_season] = component_test[
                f"target_{target}"
            ].to_numpy(dtype=float)
        for season in requested_seasons:
            prior_seasons = [
                value for value in component_seasons if value < season and value in components_by_season
            ][-5:]
            stacked = np.vstack([components_by_season[value] for value in prior_seasons])
            actual = np.concatenate([actual_by_season[value] for value in prior_seasons])
            weights = _stack_weights(stacked, actual)
            offset = float(np.median(actual - stacked @ weights))
            by_season[season][target] = _clip_prediction(
                target, components_by_season[season] @ weights + offset
            )
    output: dict[int, pd.DataFrame] = {}
    for season in requested_seasons:
        test = rows[rows["season"] == season]
        predictions = by_season[season]
        output[season] = pd.DataFrame(
            {
                "row_index": test.index,
                "season": season,
                "base_std": predictions["games"] * predictions["std_ppg"],
                "base_ppr": predictions["games"] * predictions["ppr_ppg"],
            }
        ).set_index("row_index")
    return output


def specialist_model(config: tuple[str, float], seed: int) -> Any:
    family, value = config
    if family == "ridge":
        return make_pipeline(
            SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
            StandardScaler(),
            Ridge(alpha=value),
        )
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        HistGradientBoostingRegressor(
            loss="absolute_error",
            learning_rate=0.05,
            max_iter=120,
            max_leaf_nodes=15,
            min_samples_leaf=int(value),
            l2_regularization=5.0,
            random_state=seed,
        ),
    )


def specialist_configs() -> list[tuple[str, float]]:
    return [
        *(("ridge", alpha) for alpha in RIDGE_ALPHAS),
        *(("boosted", float(leaves)) for leaves in BOOSTED_LEAVES),
    ]


def predict_specialist(
    train: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
    target_column: str,
    config: tuple[str, float],
    seed: int,
) -> np.ndarray:
    model = specialist_model(config, seed)
    model.fit(train[features], train[target_column].to_numpy(dtype=float))
    return np.maximum(0.0, model.predict(test[features]))


def choose_candidate(
    rookie_rows: pd.DataFrame,
    base_by_season: dict[int, pd.DataFrame],
    features: list[str],
    test_season: int,
    scoring: str,
    seed: int,
) -> tuple[tuple[str, float], float, dict[str, Any]]:
    validation_season = test_season - 1
    tuning_train = rookie_rows[rookie_rows["season"] < validation_season]
    validation = rookie_rows[rookie_rows["season"] == validation_season]
    target = f"target_{scoring}_total"
    base_validation = base_by_season[validation_season].loc[validation.index, f"base_{scoring}"].to_numpy()
    actual = validation[target].to_numpy(dtype=float)
    best: tuple[float, tuple[str, float], float, np.ndarray] | None = None
    for config in specialist_configs():
        specialist = predict_specialist(
            tuning_train, validation, features, target, config, seed + validation_season
        )
        for blend in BLENDS:
            candidate = base_validation * (1.0 - blend) + specialist * blend
            mae = float(np.mean(np.abs(candidate - actual)))
            # A tiny complexity penalty breaks effectively equal choices toward
            # retaining more of the already-validated base forecast.
            objective = mae + blend * 1e-5
            if best is None or objective < best[0]:
                best = (objective, config, blend, candidate)
    assert best is not None
    _, config, blend, selected_validation = best
    return config, blend, {
        "season": validation_season,
        "trainingSeasons": sorted(int(value) for value in tuning_train["season"].unique()),
        "rows": int(len(validation)),
        "selectedValidationMetrics": metric(selected_validation, actual),
        "baseValidationMetrics": metric(base_validation, actual),
    }


def acceptance(folds: list[dict[str, Any]], aggregate: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    for scoring in ("STD", "PPR"):
        result = aggregate[scoring]
        if result["candidate"]["mae"] >= result["base"]["mae"]:
            reasons.append(f"{scoring} aggregate MAE did not strictly improve")
        if result["candidate"]["rmse"] > result["base"]["rmse"]:
            reasons.append(f"{scoring} aggregate RMSE regressed")
    for fold in folds:
        for scoring in ("STD", "PPR"):
            result = fold[scoring]
            if result["candidate"]["mae"] > result["base"]["mae"]:
                reasons.append(
                    f"{fold['season']} {fold['position']} {scoring} MAE regressed"
                )
            if result["candidate"]["rmse"] > result["base"]["rmse"]:
                reasons.append(
                    f"{fold['season']} {fold['position']} {scoring} RMSE regressed"
                )
    return not reasons, reasons


def strict_position_acceptance(
    folds: list[dict[str, Any]], aggregate: dict[str, Any]
) -> tuple[bool, list[str]]:
    """Stricter gate for a position-only specialist, including bias and rank."""
    reasons: list[str] = []
    for scoring in ("STD", "PPR"):
        result = aggregate[scoring]
        if result["candidate"]["mae"] >= result["base"]["mae"]:
            reasons.append(f"{scoring} aggregate MAE did not strictly improve")
        if result["candidate"]["rmse"] > result["base"]["rmse"]:
            reasons.append(f"{scoring} aggregate RMSE regressed")
        if abs(result["candidate"]["bias"]) > abs(result["base"]["bias"]):
            reasons.append(f"{scoring} aggregate absolute bias regressed")
        if result["candidate"]["spearman"] < result["base"]["spearman"]:
            reasons.append(f"{scoring} aggregate rank correlation regressed")
    for fold in folds:
        for scoring in ("STD", "PPR"):
            result = fold[scoring]
            prefix = f"{fold['season']} {fold['position']} {scoring}"
            if result["candidate"]["mae"] > result["base"]["mae"]:
                reasons.append(f"{prefix} MAE regressed")
            if result["candidate"]["rmse"] > result["base"]["rmse"]:
                reasons.append(f"{prefix} RMSE regressed")
            if abs(result["candidate"]["bias"]) > abs(result["base"]["bias"]):
                reasons.append(f"{prefix} absolute bias regressed")
            if result["candidate"]["spearman"] < result["base"]["spearman"]:
                reasons.append(f"{prefix} rank correlation regressed")
    return not reasons, reasons


def run(args: argparse.Namespace) -> dict[str, Any]:
    raw = Path(args.data_dir)
    stats, _ = load_stats(raw)
    players, _ = load_players(Path(args.players))
    draft_picks, _ = load_draft_picks(Path(args.draft_picks))
    players, draft_coverage = enrich_players_with_draft_picks(players, draft_picks)
    roles, _ = load_depth_charts(raw, args.projection_season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.projection_season - 1)
    dst_stats, dst_players, _ = load_dst_stats(raw, raw / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, feature_columns = build_dataset(stats, players, roles)
    seed = int(args.seed)

    folds: list[dict[str, Any]] = []
    all_outputs: list[pd.DataFrame] = []
    cohort: dict[str, Any] = {}
    selections: list[dict[str, Any]] = []
    fixed_wr_outputs: list[pd.DataFrame] = []
    fixed_wr_policy: dict[str, Any] = {}
    for position in OFFENSE:
        position_rows = dataset[dataset["position"] == position].copy()
        rookies = position_rows[position_rows["rookie"] == 1.0].copy()
        cohort[position] = {
            "rows": int(len(rookies)),
            "bySeason": {
                str(season): int(count)
                for season, count in rookies.groupby("season").size().items()
            },
            "withDraftPick": int((rookies["draft_pick"] < 300).sum()),
            "withDepthRole": int((rookies["depth_missing"] == 0).sum()),
        }
        base_by_season = base_forecasts(
            position_rows,
            feature_columns,
            position,
            (2022, *EVALUATION_SEASONS),
            seed,
        )
        if position == "WR":
            # Lock the policy using 2022 only.  The 2023-2025 evaluation seasons
            # never influence family, regularization, or blend selection.
            for scoring in ("std", "ppr"):
                config, blend, validation = choose_candidate(
                    rookies, base_by_season, feature_columns, 2023, scoring, seed
                )
                fixed_wr_policy[scoring.upper()] = {
                    "specialist": {"family": config[0], "value": config[1]},
                    "specialistBlend": blend,
                    "selectionSeason": 2022,
                    "selection": validation,
                }
        for season in EVALUATION_SEASONS:
            test = rookies[rookies["season"] == season]
            if test.empty:
                continue
            output = pd.DataFrame(index=test.index)
            output["season"] = season
            output["position"] = position
            for scoring in ("std", "ppr"):
                config, blend, validation = choose_candidate(
                    rookies, base_by_season, feature_columns, season, scoring, seed
                )
                train = rookies[rookies["season"] < season]
                specialist = predict_specialist(
                    train,
                    test,
                    feature_columns,
                    f"target_{scoring}_total",
                    config,
                    seed + season,
                )
                base = base_by_season[season].loc[test.index, f"base_{scoring}"].to_numpy()
                output[f"base_{scoring}"] = base
                output[f"candidate_{scoring}"] = base * (1.0 - blend) + specialist * blend
                output[f"actual_{scoring}"] = test[f"target_{scoring}_total"].to_numpy(dtype=float)
                selections.append(
                    {
                        "season": season,
                        "position": position,
                        "scoring": scoring.upper(),
                        "specialist": {"family": config[0], "value": config[1]},
                        "specialistBlend": blend,
                        "validation": validation,
                        "refitTrainingSeasons": sorted(
                            int(value) for value in train["season"].unique()
                        ),
                    }
                )
            fold = {"season": season, "position": position, "rows": int(len(test))}
            for scoring in ("std", "ppr"):
                fold[scoring.upper()] = {
                    "base": metric(output[f"base_{scoring}"], output[f"actual_{scoring}"]),
                    "candidate": metric(
                        output[f"candidate_{scoring}"], output[f"actual_{scoring}"]
                    ),
                }
            folds.append(fold)
            all_outputs.append(output)
            if position == "WR":
                fixed_output = pd.DataFrame(index=test.index)
                fixed_output["season"] = season
                fixed_output["position"] = position
                for scoring in ("std", "ppr"):
                    policy = fixed_wr_policy[scoring.upper()]
                    config = (
                        policy["specialist"]["family"],
                        float(policy["specialist"]["value"]),
                    )
                    blend = float(policy["specialistBlend"])
                    train = rookies[rookies["season"] < season]
                    specialist = predict_specialist(
                        train,
                        test,
                        feature_columns,
                        f"target_{scoring}_total",
                        config,
                        seed + season,
                    )
                    base = base_by_season[season].loc[
                        test.index, f"base_{scoring}"
                    ].to_numpy()
                    fixed_output[f"base_{scoring}"] = base
                    fixed_output[f"candidate_{scoring}"] = (
                        base * (1.0 - blend) + specialist * blend
                    )
                    fixed_output[f"actual_{scoring}"] = test[
                        f"target_{scoring}_total"
                    ].to_numpy(dtype=float)
                fixed_wr_outputs.append(fixed_output)

    combined = pd.concat(all_outputs)
    aggregate: dict[str, Any] = {}
    by_position: dict[str, Any] = {}
    for scoring in ("std", "ppr"):
        aggregate[scoring.upper()] = {
            "base": metric(combined[f"base_{scoring}"], combined[f"actual_{scoring}"]),
            "candidate": metric(
                combined[f"candidate_{scoring}"], combined[f"actual_{scoring}"]
            ),
        }
    for position in OFFENSE:
        rows = combined[combined["position"] == position]
        by_position[position] = {}
        for scoring in ("std", "ppr"):
            by_position[position][scoring.upper()] = {
                "base": metric(rows[f"base_{scoring}"], rows[f"actual_{scoring}"]),
                "candidate": metric(
                    rows[f"candidate_{scoring}"], rows[f"actual_{scoring}"]
                ),
            }
    accepted, reasons = acceptance(folds, aggregate)
    fixed_wr = pd.concat(fixed_wr_outputs)
    fixed_wr_folds: list[dict[str, Any]] = []
    fixed_wr_aggregate: dict[str, Any] = {}
    for scoring in ("std", "ppr"):
        fixed_wr_aggregate[scoring.upper()] = {
            "base": metric(
                fixed_wr[f"base_{scoring}"], fixed_wr[f"actual_{scoring}"]
            ),
            "candidate": metric(
                fixed_wr[f"candidate_{scoring}"], fixed_wr[f"actual_{scoring}"]
            ),
        }
    for season in EVALUATION_SEASONS:
        rows = fixed_wr[fixed_wr["season"] == season]
        fold: dict[str, Any] = {
            "season": season,
            "position": "WR",
            "rows": int(len(rows)),
        }
        for scoring in ("std", "ppr"):
            fold[scoring.upper()] = {
                "base": metric(
                    rows[f"base_{scoring}"], rows[f"actual_{scoring}"]
                ),
                "candidate": metric(
                    rows[f"candidate_{scoring}"], rows[f"actual_{scoring}"]
                ),
            }
        fixed_wr_folds.append(fold)
    fixed_wr_accepted, fixed_wr_reasons = strict_position_acceptance(
        fixed_wr_folds, fixed_wr_aggregate
    )
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "baseModelVersion": "draft-goblin-owned-2026.11",
        "researchStatus": (
            "accepted-broad-rookie-policy"
            if accepted
            else (
                "partially-accepted-position-specific-policy"
                if fixed_wr_accepted
                else "rejected"
            )
        ),
        "method": (
            "Strict rolling-origin rookie audit. Each 2023-2025 test fold selects "
            "direct-total specialist family, regularization, and blend only on "
            "the immediately preceding unseen season, then refits on all earlier "
            "seasons. The base forecast is independently reconstructed with its "
            "own prior-only nested stack."
        ),
        "dataBoundary": (
            "Inputs are existing nflverse regular-season lags, player metadata, "
            "NFL draft results known before the rookie season, and the saved "
            "preseason/week-one depth feature already used by v2026.11. No "
            "provider projections, regular-season information from the target "
            "year, or network-fetched data are used."
        ),
        "importantCohortLimitation": (
            "The historical player-stat files are participant-only. Rookies who "
            "never recorded a stats row are absent, so this audit can overstate "
            "accuracy and cannot justify promotion by itself."
        ),
        "draftMetadataCoverage": draft_coverage,
        "rookieCohort": cohort,
        "aggregate": aggregate,
        "byPosition": by_position,
        "folds": folds,
        "selections": selections,
        "positionSpecificFixedPolicyAudit": {
            "position": "WR",
            "selectionBoundary": (
                "Family, regularization, and scoring-format blend were selected "
                "once on the unseen 2022 validation season, then locked for all "
                "2023-2025 development tests. Models alone are refit before each test using "
                "only earlier seasons."
            ),
            "adaptiveResearchCaveat": (
                "The WR subgroup was prioritized after reviewing the broader "
                "rookie audit. Consequently 2023-2025 are not pristine "
                "confirmatory evidence even though the WR configuration itself "
                "was selected only on 2022. Independent confirmation requires "
                "the prospectively frozen 2026 season."
            ),
            "policy": fixed_wr_policy,
            "aggregate": fixed_wr_aggregate,
            "folds": fixed_wr_folds,
            "acceptanceRule": (
                "Both formats must strictly improve aggregate MAE; aggregate "
                "RMSE, absolute bias, and rank cannot regress; and MAE, RMSE, "
                "absolute bias, and rank cannot regress in any 2023-2025 fold."
            ),
            "accepted": fixed_wr_accepted,
            "rejectionReasons": fixed_wr_reasons,
            "integratedIntoShadowModelVersion": MODEL_VERSION if fixed_wr_accepted else None,
            "productionChanged": fixed_wr_accepted,
        },
        "acceptanceRule": (
            "Both scoring formats must strictly improve aggregate MAE without "
            "aggregate RMSE regression, and neither MAE nor RMSE may regress in "
            "any position-season-format fold."
        ),
        "accepted": accepted,
        "rejectionReasons": reasons,
        "productionChanged": fixed_wr_accepted,
        "productionScope": (
            f"Shadow-only {MODEL_VERSION} WR-rookie policy; live consensus unchanged."
            if fixed_wr_accepted
            else None
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260717)
    parser.add_argument("--output", default="data/research/owned-model-rookie-specialist.json")
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "status": report["researchStatus"],
                "rookieRows": sum(
                    value["rows"] for value in report["rookieCohort"].values()
                ),
                "aggregate": report["aggregate"],
                "rejectionReasons": report["rejectionReasons"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
