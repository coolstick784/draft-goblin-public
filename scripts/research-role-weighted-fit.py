"""Audit preseason role-weighted component fitting with temporal holdouts.

This research-only challenger changes how the ridge and boosted components are
fit, not their features or outcomes.  A player's sample weight is fixed from
the preseason depth chart: 4 for starters, 2 for other top-three players, and
1 otherwise.  Provider projections and realized outcomes never determine the
weights.  Every 2023-2025 test fold learns component stacks and offsets only
from earlier out-of-fold predictions.
"""

from __future__ import annotations

import argparse
import json
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
    _empirical_predict,
    _metrics,
    _models,
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


SEED = 20260720
EVALUATION_SEASONS = (2023, 2024, 2025)
FULL_REGRESSION_TOLERANCE = 0.005
MODELS = ("control", "roleWeighted4x2x1")


def role_sample_weights(rows: pd.DataFrame) -> np.ndarray:
    """Return outcome-independent weights from preseason depth roles."""
    starter = rows["depth_starter"].fillna(0).to_numpy(dtype=float) > 0
    top_three = rows["depth_top_three"].fillna(0).to_numpy(dtype=float) > 0
    return np.where(starter, 4.0, np.where(top_three, 2.0, 1.0))


def fit_components(
    train: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
    target: str,
    position: str,
    seed: int,
    weighted: bool,
) -> np.ndarray:
    predictions = [_empirical_predict(test, target, position)]
    y = train[f"target_{target}"].to_numpy(dtype=float)
    sample_weight = role_sample_weights(train) if weighted else None
    for model in _models(seed).values():
        fit_args: dict[str, Any] = {}
        if sample_weight is not None:
            fit_args[f"{model.steps[-1][0]}__sample_weight"] = sample_weight
        model.fit(train[features], y, **fit_args)
        predictions.append(model.predict(test[features]))
    return np.column_stack(
        [_clip_prediction(target, prediction) for prediction in predictions]
    )


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


def build_oof(
    dataset: pd.DataFrame, features: list[str]
) -> dict[str, dict[str, pd.DataFrame]]:
    base_seasons = sorted(int(value) for value in dataset["season"].unique())[-5:]
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
                control = fit_components(
                    train, test, features, target, position, SEED + season, False
                )
                candidate = (
                    control
                    if position == "DST"
                    else fit_components(
                        train, test, features, target, position, SEED + season, True
                    )
                )
                frames.append(
                    pd.DataFrame(
                        {
                            "row_index": test.index.to_numpy(),
                            "season": season,
                            "actual": test[f"target_{target}"].to_numpy(dtype=float),
                            **{
                                f"control_{name}": control[:, index]
                                for index, name in enumerate(("empirical", "ridge", "boosted"))
                            },
                            **{
                                f"candidate_{name}": candidate[:, index]
                                for index, name in enumerate(("empirical", "ridge", "boosted"))
                            },
                        }
                    )
                )
            result[position][target] = pd.concat(frames, ignore_index=True).set_index(
                "row_index"
            )
    return result


def locked_cohort(position: str, frames: dict[str, pd.DataFrame]) -> pd.Series:
    games = frames["games"]
    ppr = frames["ppr_ppg"]
    common = games.index.intersection(ppr.index)
    table = pd.DataFrame(
        {
            "season": games.loc[common, "season"],
            "empirical_total": (
                games.loc[common, "control_empirical"].to_numpy()
                * ppr.loc[common, "control_empirical"].to_numpy()
            ),
        },
        index=common,
    )
    selected = pd.Series(False, index=common)
    for _, fold in table.groupby("season"):
        count = min(DRAFTABLE_LIMITS[position], len(fold))
        selected.loc[fold.nlargest(count, "empirical_total").index] = True
    return selected


def score_position(
    position: str, frames: dict[str, pd.DataFrame], truth: pd.DataFrame
) -> list[dict[str, Any]]:
    cohort = locked_cohort(position, frames)
    common = cohort.index
    for target in TARGETS:
        common = common.intersection(frames[target].index)
    seasons = frames["games"].loc[common, "season"].to_numpy(dtype=int)
    draftable = cohort.loc[common].to_numpy(dtype=bool)
    target_predictions: dict[str, dict[str, np.ndarray]] = {
        model: {} for model in MODELS
    }
    for target in TARGETS:
        frame = frames[target].loc[common]
        actual = frame["actual"].to_numpy(dtype=float)
        for model, prefix in (("control", "control"), ("roleWeighted4x2x1", "candidate")):
            components = frame[
                [f"{prefix}_empirical", f"{prefix}_ridge", f"{prefix}_boosted"]
            ].to_numpy(dtype=float)
            predicted = np.full(len(common), np.nan)
            for season in EVALUATION_SEASONS:
                prior = seasons < season
                test = seasons == season
                weights = _stack_weights(components[prior], actual[prior])
                offset = float(np.median(actual[prior] - components[prior] @ weights))
                predicted[test] = _clip_prediction(
                    target, components[test] @ weights + offset
                )
            target_predictions[model][target] = predicted
    records: list[dict[str, Any]] = []
    for scoring, total_column, ppg_target in (
        ("STD", "target_std_total", "std_ppg"),
        ("PPR", "target_ppr_total", "ppr_ppg"),
    ):
        actual = truth.loc[common, total_column].to_numpy(dtype=float)
        for season in EVALUATION_SEASONS:
            fold = seasons == season
            for scope, mask in (("full", fold), ("draftable", fold & draftable)):
                for model in MODELS:
                    projected = (
                        target_predictions[model]["games"]
                        * target_predictions[model][ppg_target]
                    )
                    records.append(
                        {
                            "position": position,
                            "scoring": scoring,
                            "season": season,
                            "scope": scope,
                            "model": model,
                            "projected": projected[mask],
                            "actual": actual[mask],
                        }
                    )
    return records


def metric_pair(records: list[dict[str, Any]]) -> dict[str, Any]:
    output = {}
    for model in MODELS:
        selected = [record for record in records if record["model"] == model]
        output[model] = _metrics(
            np.concatenate([record["projected"] for record in selected]),
            np.concatenate([record["actual"] for record in selected]),
        )
    output["deltaCandidateMinusControl"] = {
        key: (
            None
            if output[model][key] is None or output["control"][key] is None
            else round(output[model][key] - output["control"][key], 4)
        )
        for model in ("roleWeighted4x2x1",)
        for key in ("mae", "rmse", "bias", "spearman")
    }
    return output


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    def cells(selected: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            **{
                str(season): metric_pair(
                    [record for record in selected if record["season"] == season]
                )
                for season in EVALUATION_SEASONS
            },
            "aggregate": metric_pair(selected),
        }

    overall = {
        scoring: {
            scope: cells(
                [
                    record
                    for record in records
                    if record["scoring"] == scoring and record["scope"] == scope
                ]
            )
            for scope in ("full", "draftable")
        }
        for scoring in ("STD", "PPR")
    }
    positions = {
        position: {
            scoring: {
                scope: cells(
                    [
                        record
                        for record in records
                        if record["position"] == position
                        and record["scoring"] == scoring
                        and record["scope"] == scope
                    ]
                )
                for scope in ("full", "draftable")
            }
            for scoring in ("STD", "PPR")
        }
        for position in CORE_POSITIONS
    }
    return {"overall": overall, "positions": positions}


def acceptance(summary: dict[str, Any]) -> dict[str, Any]:
    candidate = "roleWeighted4x2x1"
    draftable_cells = [
        summary["overall"][scoring]["draftable"][key]
        for scoring in ("STD", "PPR")
        for key in (*map(str, EVALUATION_SEASONS), "aggregate")
    ]
    full_cells = [
        summary["overall"][scoring]["full"][key]
        for scoring in ("STD", "PPR")
        for key in (*map(str, EVALUATION_SEASONS), "aggregate")
    ]
    target_wins = all(
        cell[candidate]["mae"] < cell["control"]["mae"]
        and cell[candidate]["rmse"] <= cell["control"]["rmse"]
        for cell in draftable_cells
    )
    full_safe = all(
        cell[candidate]["mae"] <= cell["control"]["mae"] * (1 + FULL_REGRESSION_TOLERANCE)
        and cell[candidate]["rmse"] <= cell["control"]["rmse"] * (1 + FULL_REGRESSION_TOLERANCE)
        for cell in full_cells
    )
    position_regressions = []
    for position in CORE_POSITIONS:
        for scoring in ("STD", "PPR"):
            for key in (*map(str, EVALUATION_SEASONS), "aggregate"):
                cell = summary["positions"][position][scoring]["full"][key]
                if (
                    cell[candidate]["mae"] > cell["control"]["mae"] * (1 + FULL_REGRESSION_TOLERANCE)
                    or cell[candidate]["rmse"] > cell["control"]["rmse"] * (1 + FULL_REGRESSION_TOLERANCE)
                ):
                    position_regressions.append(
                        {"position": position, "scoring": scoring, "fold": key}
                    )
    accepted = target_wins and full_safe and not position_regressions
    return {
        "draftableAggregateAndEveryFoldMaeImprovesWithoutRmseRegression": target_wins,
        "fullAggregateAndEveryFoldWithinTolerance": full_safe,
        "positionFoldMaterialRegressions": position_regressions,
        "fullRegressionTolerance": FULL_REGRESSION_TOLERANCE,
        "acceptedForIntegration": accepted,
        "policy": (
            "Accept only if locked-draftable MAE improves without RMSE regression "
            "in both formats for every 2023-2025 fold and aggregate, every pooled "
            "full cell stays within 0.5%, and no position fold exceeds 0.5%."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw", type=Path)
    parser.add_argument(
        "--out", default="data/research/owned-model-role-weighted-fit.json", type=Path
    )
    args = parser.parse_args()
    dataset, features = load_training_data(args.data_dir)
    oof = build_oof(dataset, features)
    records = []
    for position in CORE_POSITIONS:
        records.extend(score_position(position, oof[position], dataset))
    summary = summarize(records)
    report = {
        "schemaVersion": 1,
        "kind": "research-only preseason role-weighted component fit audit",
        "method": (
            "Expanding temporal folds with fixed 4x starter, 2x other top-three, "
            "1x otherwise sample weights. Each test fold learns component stacks "
            "and median offsets exclusively from earlier out-of-fold seasons."
        ),
        "providerInputsUsed": False,
        "evaluationSeasons": list(EVALUATION_SEASONS),
        **summary,
    }
    report["acceptance"] = acceptance(summary)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "acceptance": report["acceptance"], "overall": report["overall"]}, indent=2))


if __name__ == "__main__":
    main()
