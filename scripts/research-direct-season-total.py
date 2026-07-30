"""Research direct season-total forecasts against games x points/game.

This harness is intentionally isolated from the production owned-model
pipeline.  It uses the same lawful, preseason-available feature table and
recreates the incumbent nested stack.  Direct Ridge and histogram-boosted
models are trained on season totals, with stack weights and calibration fitted
only on earlier out-of-fold seasons.  Two fixed, conservative blends are also
reported; their blend fractions never inspect a test-fold outcome.
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

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    DRAFTABLE_LIMITS,
    POSITION_PRIORS,
    TARGETS,
    _clip_prediction,
    _empirical_predict,
    _fit_predict,
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
    utc_now,
)


SEED = 20260715
EVALUATION_SEASONS = (2023, 2024, 2025)
BASE_OOF_SEASONS = (2021, 2022, 2023, 2024, 2025)
MODELS = ("incumbent", "direct", "directBlend25", "directBlend50")
DIRECT_CLIP = (0.0, 600.0)


def direct_empirical(rows: pd.DataFrame, scoring: str, position: str) -> np.ndarray:
    """Prior-only empirical season total, reconstructed from lag seasons.

    Feature construction converts counting stats to per-game values, so each
    lag total is recovered by multiplying its points/game and games features.
    Missing lags use the same experience-shrunk position prior as production.
    """
    points = "fantasy_points" if scoring == "STD" else "fantasy_points_ppr"
    values = np.column_stack(
        [
            rows[f"{points}_lag{lag}"].to_numpy(dtype=float)
            * rows[f"games_lag{lag}"].to_numpy(dtype=float)
            for lag in (1, 2, 3)
        ]
    )
    weights = np.asarray([0.60, 0.27, 0.13])
    valid = np.isfinite(values)
    numerator = np.where(valid, values * weights, 0.0).sum(axis=1)
    denominator = np.where(valid, weights, 0.0).sum(axis=1)
    prior = POSITION_PRIORS[position][
        "std_ppg" if scoring == "STD" else "ppr_ppg"
    ] * POSITION_PRIORS[position]["games"]
    estimate = np.divide(
        numerator,
        denominator,
        out=np.full(len(rows), prior, dtype=float),
        where=denominator > 0,
    )
    experience = rows["experience"].to_numpy(dtype=float)
    confidence = np.clip(np.nan_to_num(experience, nan=0.0) / 3.0, 0.0, 1.0)
    return np.clip(
        estimate * confidence + prior * (1.0 - confidence), *DIRECT_CLIP
    )


def direct_components(
    train: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
    scoring: str,
    position: str,
    seed: int,
) -> np.ndarray:
    target = "target_std_total" if scoring == "STD" else "target_ppr_total"
    predictions = [direct_empirical(test, scoring, position)]
    y = train[target].to_numpy(dtype=float)
    for model in _models(seed).values():
        model.fit(train[features], y)
        predictions.append(np.clip(model.predict(test[features]), *DIRECT_CLIP))
    return np.column_stack(predictions)


def build_components(
    dataset: pd.DataFrame, features: list[str]
) -> dict[str, dict[str, pd.DataFrame]]:
    output: dict[str, dict[str, pd.DataFrame]] = {}
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"].eq(position)]
        output[position] = {}
        incumbent: dict[str, list[pd.DataFrame]] = {
            target: [] for target in TARGETS
        }
        direct: dict[str, list[pd.DataFrame]] = {
            scoring: [] for scoring in ("STD", "PPR")
        }
        for season in BASE_OOF_SEASONS:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            if len(train) < 80 or len(test) < 8:
                continue
            for target in TARGETS:
                component, _ = _fit_predict(
                    train, test, features, target, position, SEED + season
                )
                incumbent[target].append(
                    pd.DataFrame(
                        component,
                        index=test.index,
                        columns=["empirical", "ridge", "boosted"],
                    ).assign(season=season)
                )
            for scoring in ("STD", "PPR"):
                component = direct_components(
                    train, test, features, scoring, position, SEED + season
                )
                direct[scoring].append(
                    pd.DataFrame(
                        component,
                        index=test.index,
                        columns=["empirical", "ridge", "boosted"],
                    ).assign(season=season)
                )
        for target, frames in incumbent.items():
            output[position][f"incumbent:{target}"] = pd.concat(frames).sort_index()
        for scoring, frames in direct.items():
            output[position][f"direct:{scoring}"] = pd.concat(frames).sort_index()
    return output


def nested_stack(
    components: pd.DataFrame,
    actual: np.ndarray,
    seasons: np.ndarray,
    target: str,
    force_empirical: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    prediction = np.full(len(components), np.nan)
    parameters: dict[str, Any] = {}
    matrix = components[["empirical", "ridge", "boosted"]].to_numpy(dtype=float)
    for season in EVALUATION_SEASONS:
        prior = seasons < season
        test = seasons == season
        if not prior.any() or not test.any():
            raise ValueError(f"Missing nested rows for {season} {target}.")
        if force_empirical:
            weights = np.asarray([1.0, 0.0, 0.0])
            offset = 0.0
        else:
            weights = _stack_weights(matrix[prior], actual[prior])
            offset = float(np.median(actual[prior] - matrix[prior] @ weights))
        raw = matrix[test] @ weights + offset
        prediction[test] = (
            np.clip(raw, *DIRECT_CLIP)
            if target.endswith("_total")
            else _clip_prediction(target, raw)
        )
        parameters[str(season)] = {
            "weights": weights.tolist(),
            "calibrationOffset": round(offset, 4),
            "priorOofSeasons": sorted(set(int(value) for value in seasons[prior])),
            "priorRows": int(prior.sum()),
        }
    return prediction, parameters


def locked_draftable(
    position: str, games: pd.DataFrame, ppr: pd.DataFrame
) -> np.ndarray:
    seasons = games["season"].to_numpy(dtype=int)
    estimate = (
        games["empirical"].to_numpy(dtype=float)
        * ppr["empirical"].to_numpy(dtype=float)
    )
    selected = np.zeros(len(games), dtype=bool)
    for season in EVALUATION_SEASONS:
        indices = np.flatnonzero(seasons == season)
        order = indices[np.argsort(-estimate[indices])]
        selected[order[: DRAFTABLE_LIMITS[position]]] = True
    return selected


def position_records(
    position: str,
    components: dict[str, pd.DataFrame],
    truth: pd.DataFrame,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    keys = [
        *(f"incumbent:{target}" for target in TARGETS),
        "direct:STD",
        "direct:PPR",
    ]
    common = components[keys[0]].index
    for key in keys[1:]:
        common = common.intersection(components[key].index)
    seasons = components["incumbent:games"].loc[common, "season"].to_numpy(dtype=int)
    evaluation = np.isin(seasons, EVALUATION_SEASONS)
    games_actual = truth.loc[common, "target_games"].to_numpy(dtype=float)
    incumbent_parts: dict[str, np.ndarray] = {}
    parameters: dict[str, Any] = {"incumbent": {}, "direct": {}}
    for target in TARGETS:
        target_actual = truth.loc[common, f"target_{target}"].to_numpy(dtype=float)
        incumbent_parts[target], parameters["incumbent"][target] = nested_stack(
            components[f"incumbent:{target}"].loc[common],
            target_actual,
            seasons,
            target,
            force_empirical=position == "DST",
        )
    cohort = locked_draftable(
        position,
        components["incumbent:games"].loc[common],
        components["incumbent:ppr_ppg"].loc[common],
    )
    records: list[dict[str, Any]] = []
    for scoring, ppg_target, total_column in (
        ("STD", "std_ppg", "target_std_total"),
        ("PPR", "ppr_ppg", "target_ppr_total"),
    ):
        actual_total = truth.loc[common, total_column].to_numpy(dtype=float)
        incumbent = incumbent_parts["games"] * incumbent_parts[ppg_target]
        direct, parameters["direct"][scoring] = nested_stack(
            components[f"direct:{scoring}"].loc[common],
            actual_total,
            seasons,
            f"{scoring.lower()}_total",
        )
        predictions = {
            "incumbent": incumbent,
            "direct": direct,
            "directBlend25": incumbent * 0.75 + direct * 0.25,
            "directBlend50": incumbent * 0.50 + direct * 0.50,
        }
        for season in EVALUATION_SEASONS:
            fold = seasons == season
            for scope, scope_mask in (
                ("full", fold),
                ("draftable", fold & cohort),
            ):
                for model, projected in predictions.items():
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
        "evaluationRows": int(evaluation.sum()),
        "draftableRows": int((cohort & evaluation).sum()),
        "draftableLimitPerSeason": DRAFTABLE_LIMITS[position],
        "parameters": parameters,
        "gamesActualRows": int(np.isfinite(games_actual[evaluation]).sum()),
    }


def paired_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for model in MODELS:
        chosen = [record for record in records if record["model"] == model]
        projected = np.concatenate([record["projected"] for record in chosen])
        actual = np.concatenate([record["actual"] for record in chosen])
        output[model] = _metrics(projected, actual)
    output["deltaCandidateMinusIncumbent"] = {}
    incumbent = output["incumbent"]
    for model in MODELS[1:]:
        output["deltaCandidateMinusIncumbent"][model] = {
            metric: (
                None
                if output[model][metric] is None or incumbent[metric] is None
                else round(float(output[model][metric] - incumbent[metric]), 4)
            )
            for metric in ("mae", "rmse", "bias", "spearman")
        }
    return output


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    def section(selected: list[dict[str, Any]]) -> dict[str, Any]:
        result = {
            str(season): paired_metrics(
                [record for record in selected if record["season"] == season]
            )
            for season in EVALUATION_SEASONS
        }
        result["aggregate"] = paired_metrics(selected)
        return result

    overall: dict[str, Any] = {}
    positions: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        overall[scoring] = {}
        for scope in ("full", "draftable"):
            overall[scoring][scope] = section(
                [
                    record
                    for record in records
                    if record["scoring"] == scoring and record["scope"] == scope
                ]
            )
    for position in CORE_POSITIONS:
        positions[position] = {}
        for scoring in ("STD", "PPR"):
            positions[position][scoring] = {}
            for scope in ("full", "draftable"):
                positions[position][scoring][scope] = section(
                    [
                        record
                        for record in records
                        if record["position"] == position
                        and record["scoring"] == scoring
                        and record["scope"] == scope
                    ]
                )
    return {"overall": overall, "positions": positions}


def acceptance(summary: dict[str, Any]) -> dict[str, Any]:
    candidates: dict[str, Any] = {}
    for model in MODELS[1:]:
        regressions: list[dict[str, str]] = []
        aggregate_rank_regressions: list[dict[str, str]] = []
        aggregate_wins = 0
        for level, groups in (
            ("overall", {"ALL": summary["overall"]}),
            ("position", summary["positions"]),
        ):
            for group, table in groups.items():
                for scoring in ("STD", "PPR"):
                    for scope in ("full", "draftable"):
                        for fold in (*map(str, EVALUATION_SEASONS), "aggregate"):
                            cell = table[scoring][scope][fold]
                            incumbent = cell["incumbent"]
                            candidate = cell[model]
                            if (
                                candidate["mae"] > incumbent["mae"]
                                or candidate["rmse"] > incumbent["rmse"]
                            ):
                                regressions.append(
                                    {
                                        "level": level,
                                        "group": group,
                                        "scoring": scoring,
                                        "scope": scope,
                                        "fold": fold,
                                    }
                                )
                            if (
                                level == "overall"
                                and fold == "aggregate"
                                and candidate["mae"] < incumbent["mae"]
                            ):
                                aggregate_wins += 1
                            if (
                                fold == "aggregate"
                                and candidate["spearman"] is not None
                                and incumbent["spearman"] is not None
                                and candidate["spearman"] < incumbent["spearman"]
                            ):
                                aggregate_rank_regressions.append(
                                    {
                                        "level": level,
                                        "group": group,
                                        "scoring": scoring,
                                        "scope": scope,
                                    }
                                )
        accepted = (
            not regressions
            and not aggregate_rank_regressions
            and aggregate_wins == 4
        )
        candidates[model] = {
            "errorRegressions": regressions,
            "aggregateRankRegressions": aggregate_rank_regressions,
            "overallAggregateMaeWins": aggregate_wins,
            "requiredOverallAggregateMaeWins": 4,
            "acceptedForIntegration": accepted,
        }
    return {
        "policy": (
            "A candidate must avoid any MAE or RMSE regression in every 2023-2025 "
            "fold and aggregate for both scoring formats, both full and locked-"
            "draftable cohorts, pooled and at every position. It must also avoid "
            "aggregate Spearman regression in every slice and improve pooled "
            "aggregate MAE in all four scoring/cohort cells."
        ),
        "candidates": candidates,
        "acceptedForIntegration": any(
            value["acceptedForIntegration"] for value in candidates.values()
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
        "--data-dir", type=Path, default="data/private/owned-model/raw"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default="data/research/owned-model-direct-season-total.json",
    )
    args = parser.parse_args()
    dataset, features = load_training_data(args.data_dir)
    components = build_components(dataset, features)
    records: list[dict[str, Any]] = []
    details: dict[str, Any] = {}
    for position in CORE_POSITIONS:
        position_records_value, detail = position_records(
            position, components[position], dataset
        )
        records.extend(position_records_value)
        details[position] = detail
    summary = summarize(records)
    report = {
        "schemaVersion": 1,
        "kind": "research-only direct season-total audit",
        "generatedAt": utc_now(),
        "method": (
            "Strict nested expanding temporal evaluation. Every base forecast for "
            "an OOF season is trained only on earlier seasons. Every 2023-2025 "
            "stack learns weights and median calibration only from earlier OOF "
            "seasons. Fixed 25% and 50% direct blends do not use test outcomes."
        ),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "baseOofSeasons": list(BASE_OOF_SEASONS),
        "cohort": (
            "Top position-specific DRAFTABLE_LIMITS in each test season by the "
            "prior-only incumbent empirical PPR projection; outcomes are not used."
        ),
        "details": details,
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
