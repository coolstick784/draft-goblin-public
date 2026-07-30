"""Leakage-safe nflverse Next Gen Stats feature audit.

The three official nflverse NGS aggregate assets are expected in the ignored
private raw-data cache.  Only REG week=0 summaries from season S-1 may feed a
target-season S forecast.  Exact GSIS joins are required; NGS threshold
omissions remain missing so the production imputer and missing indicators
provide a conservative fallback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    DRAFTABLE_LIMITS,
    MODEL_VERSION,
    TARGETS,
    _blend_wr_rookie_total,
    _clip_prediction,
    _fit_predict,
    _metrics,
    _stack_weights,
    _wr_rookie_total_model,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
    utc_now,
)


SEED = 20260715
POSITIONS = ("QB", "RB", "WR", "TE")
BASE_OOF_SEASONS = (2021, 2022, 2023, 2024, 2025)
EVALUATION_SEASONS = (2023, 2024, 2025)
SOURCE_URL = (
    "https://github.com/nflverse/nflverse-data/releases/tag/nextgen_stats"
)
LICENSE_URL = (
    "https://github.com/nflverse/nflverse-data/blob/master/LICENSE.md"
)
SCHEMA_URL = (
    "https://nflreadr.nflverse.com/articles/dictionary_nextgen_stats.html"
)

PASS_EFFICIENCY = (
    "avg_time_to_throw",
    "avg_completed_air_yards",
    "avg_intended_air_yards",
    "avg_air_yards_differential",
    "aggressiveness",
    "avg_air_yards_to_sticks",
    "expected_completion_percentage",
    "completion_percentage_above_expectation",
)
RECEIVING_EFFICIENCY = (
    "avg_cushion",
    "avg_separation",
    "avg_intended_air_yards",
    "avg_expected_yac",
    "avg_yac_above_expectation",
)
RUSHING_EFFICIENCY = (
    "efficiency",
    "avg_time_to_los",
    "rush_yards_over_expected_per_att",
    "rush_pct_over_expected",
)
RECEIVING_USAGE = ("percent_share_of_intended_air_yards",)
RUSHING_USAGE = ("percent_attempts_gte_eight_defenders",)
SOURCE_COLUMNS = {
    "passing": PASS_EFFICIENCY,
    "receiving": (*RECEIVING_EFFICIENCY, *RECEIVING_USAGE),
    "rushing": (*RUSHING_EFFICIENCY, *RUSHING_USAGE),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def feature_name(kind: str, column: str) -> str:
    return f"ngs_{kind}_{column}"


def variant_features(position: str) -> dict[str, list[str]]:
    kinds = {
        "QB": ("passing", "rushing"),
        "RB": ("rushing", "receiving"),
        "WR": ("receiving",),
        "TE": ("receiving",),
    }[position]
    efficiency: list[str] = []
    all_features: list[str] = []
    for kind in kinds:
        for column in SOURCE_COLUMNS[kind]:
            named = feature_name(kind, column)
            all_features.append(named)
            if column not in RECEIVING_USAGE and column not in RUSHING_USAGE:
                efficiency.append(named)
    return {
        "trackingEfficiency": efficiency,
        "trackingEfficiencyUsage": all_features,
    }


def load_ngs(
    data_dir: Path,
) -> tuple[dict[str, dict[tuple[int, str], dict[str, float]]], list[dict[str, Any]]]:
    maps: dict[str, dict[tuple[int, str], dict[str, float]]] = {}
    manifest: list[dict[str, Any]] = []
    for kind, columns in SOURCE_COLUMNS.items():
        path = data_dir / f"ngs_{kind}.csv.gz"
        if not path.exists():
            raise FileNotFoundError(
                f"Missing {path}; fetch the official nflverse NGS aggregate asset."
            )
        frame = pd.read_csv(path, low_memory=False)
        required = {
            "season",
            "season_type",
            "week",
            "player_gsis_id",
            *columns,
        }
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"{path.name} missing columns: {', '.join(missing)}")
        summary = frame[
            frame["season_type"].astype(str).eq("REG")
            & pd.to_numeric(frame["week"], errors="coerce").eq(0)
        ].copy()
        summary["season"] = pd.to_numeric(summary["season"], errors="raise").astype(int)
        summary["player_gsis_id"] = summary["player_gsis_id"].astype(str)
        if summary["player_gsis_id"].eq("").any() or summary["player_gsis_id"].eq("nan").any():
            raise ValueError(f"{path.name} summary has missing GSIS identities.")
        if summary.duplicated(["season", "player_gsis_id"]).any():
            raise ValueError(f"{path.name} summary has duplicate season/GSIS rows.")
        maps[kind] = {
            (int(row["season"]), str(row["player_gsis_id"])): {
                column: float(row[column])
                if pd.notna(row[column]) and math.isfinite(float(row[column]))
                else math.nan
                for column in columns
            }
            for row in summary.to_dict("records")
        }
        manifest.append(
            {
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "license": "CC-BY-4.0",
                "source": SOURCE_URL,
                "schema": SCHEMA_URL,
                "summaryRows": int(len(summary)),
                "seasons": sorted(int(value) for value in summary["season"].unique()),
                "exactGsisCoverage": float(summary["player_gsis_id"].notna().mean()),
                "uniqueSeasonGsis": int(
                    summary[["season", "player_gsis_id"]].drop_duplicates().shape[0]
                ),
            }
        )
    return maps, manifest


def augment_dataset(
    dataset: pd.DataFrame,
    maps: dict[str, dict[tuple[int, str], dict[str, float]]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    all_features = sorted(
        {
            feature_name(kind, column)
            for kind, columns in SOURCE_COLUMNS.items()
            for column in columns
        }
    )
    for column in all_features:
        result[column] = np.nan
    source_matches = {kind: np.zeros(len(result), dtype=bool) for kind in SOURCE_COLUMNS}
    for row_number, (index, row) in enumerate(result.iterrows()):
        source_season = int(row["season"]) - 1
        player_id = str(row["player_id"])
        for kind, columns in SOURCE_COLUMNS.items():
            values = maps[kind].get((source_season, player_id))
            if values is None:
                continue
            source_matches[kind][row_number] = True
            for column in columns:
                result.at[index, feature_name(kind, column)] = values[column]
    evaluation = result["season"].isin(EVALUATION_SEASONS).to_numpy()
    coverage: dict[str, Any] = {
        "rows": int(len(result)),
        "evaluationRows": int(evaluation.sum()),
        "sourceCutoff": (
            "Every target-season row S joins only exact (S-1, player_gsis_id) "
            "REG week=0 summary rows."
        ),
        "bySource": {},
        "byPosition": {},
    }
    for kind, matched in source_matches.items():
        coverage["bySource"][kind] = {
            "allRowsMatched": int(matched.sum()),
            "allRowCoverage": round(float(matched.mean()), 6),
            "evaluationRowsMatched": int((matched & evaluation).sum()),
            "evaluationRowCoverage": round(
                float((matched & evaluation).sum() / max(1, evaluation.sum())), 6
            ),
        }
    for position in POSITIONS:
        mask = result["position"].eq(position).to_numpy() & evaluation
        relevant = {
            "QB": ("passing", "rushing"),
            "RB": ("rushing", "receiving"),
            "WR": ("receiving",),
            "TE": ("receiving",),
        }[position]
        any_match = np.logical_or.reduce([source_matches[kind] for kind in relevant])
        coverage["byPosition"][position] = {
            "evaluationRows": int(mask.sum()),
            "matchedAnyRelevantSource": int((mask & any_match).sum()),
            "coverage": round(
                float((mask & any_match).sum() / max(1, mask.sum())), 6
            ),
            "sourceCoverage": {
                kind: round(
                    float((mask & source_matches[kind]).sum() / max(1, mask.sum())),
                    6,
                )
                for kind in relevant
            },
        }
    return result, coverage


def build_oof(
    rows: pd.DataFrame, features: list[str], position: str
) -> dict[str, pd.DataFrame]:
    output: dict[str, pd.DataFrame] = {}
    for target in TARGETS:
        frames: list[pd.DataFrame] = []
        for season in BASE_OOF_SEASONS:
            train = rows[rows["season"] < season]
            test = rows[rows["season"] == season]
            if len(train) < 80 or len(test) < 8:
                continue
            values, _ = _fit_predict(
                train, test, features, target, position, SEED + season
            )
            frames.append(
                pd.DataFrame(
                    {
                        "season": season,
                        "actual": test[f"target_{target}"].to_numpy(dtype=float),
                        "empirical": values[:, 0],
                        "ridge": values[:, 1],
                        "boosted": values[:, 2],
                    },
                    index=test.index,
                )
            )
        output[target] = pd.concat(frames).sort_index()
    return output


def nested_predictions(
    frames: dict[str, pd.DataFrame],
) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    output: dict[str, pd.DataFrame] = {}
    parameters: dict[str, Any] = {}
    for target, frame in frames.items():
        matrix = frame[["empirical", "ridge", "boosted"]].to_numpy(dtype=float)
        actual = frame["actual"].to_numpy(dtype=float)
        seasons = frame["season"].to_numpy(dtype=int)
        prediction = np.full(len(frame), np.nan)
        parameters[target] = {}
        for season in EVALUATION_SEASONS:
            prior = seasons < season
            test = seasons == season
            if not prior.any() or not test.any():
                raise ValueError(f"Missing nested rows for {season} {target}.")
            weights = _stack_weights(matrix[prior], actual[prior])
            offset = float(np.median(actual[prior] - matrix[prior] @ weights))
            prediction[test] = _clip_prediction(
                target, matrix[test] @ weights + offset
            )
            parameters[target][str(season)] = {
                "weights": weights.tolist(),
                "calibrationOffset": round(offset, 6),
                "priorOofSeasons": sorted(set(int(value) for value in seasons[prior])),
            }
        scored = frame.copy()
        scored["candidate"] = prediction
        output[target] = scored[scored["season"].isin(EVALUATION_SEASONS)]
    return output, parameters


def wr_rookie_specialist_oof(
    rows: pd.DataFrame, production_features: list[str]
) -> dict[str, pd.Series]:
    output = {
        "STD": pd.Series(index=rows.index, dtype=float),
        "PPR": pd.Series(index=rows.index, dtype=float),
    }
    rookies = rows[rows["rookie"].eq(1.0)]
    for season in EVALUATION_SEASONS:
        train = rookies[rookies["season"] < season]
        test = rookies[rookies["season"] == season]
        for scoring, target in (
            ("STD", "target_std_total"),
            ("PPR", "target_ppr_total"),
        ):
            model = _wr_rookie_total_model(SEED + season)
            model.fit(train[production_features], train[target].to_numpy(dtype=float))
            output[scoring].loc[test.index] = model.predict(test[production_features])
    return output


def locked_draftable_ids(
    baseline: dict[str, pd.DataFrame], position: str
) -> set[int]:
    common = baseline["games"].index.intersection(baseline["ppr_ppg"].index)
    table = pd.DataFrame(
        {
            "season": baseline["games"].loc[common, "season"],
            "priorPpr": (
                baseline["games"].loc[common, "empirical"].to_numpy(dtype=float)
                * baseline["ppr_ppg"].loc[common, "empirical"].to_numpy(dtype=float)
            ),
        },
        index=common,
    )
    selected: set[int] = set()
    for season in EVALUATION_SEASONS:
        fold = table[table["season"].eq(season)]
        selected.update(
            int(value)
            for value in fold.nlargest(
                min(DRAFTABLE_LIMITS[position], len(fold)), "priorPpr"
            ).index
        )
    return selected


def evaluate(
    predictions: dict[str, pd.DataFrame],
    truth: pd.DataFrame,
    position: str,
    locked_ids: set[int],
    rookie_specialist: dict[str, pd.Series] | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    common = predictions[TARGETS[0]].index
    for target in TARGETS[1:]:
        common = common.intersection(predictions[target].index)
    games = predictions["games"].loc[common, "candidate"].to_numpy(dtype=float)
    totals = {
        "STD": games
        * predictions["std_ppg"].loc[common, "candidate"].to_numpy(dtype=float),
        "PPR": games
        * predictions["ppr_ppg"].loc[common, "candidate"].to_numpy(dtype=float),
    }
    if position == "WR" and rookie_specialist:
        rookie = truth.loc[common, "rookie"].to_numpy(dtype=float) == 1.0
        for scoring in ("STD", "PPR"):
            specialist = rookie_specialist[scoring].reindex(common).to_numpy(dtype=float)
            apply = rookie & np.isfinite(specialist)
            totals[scoring][apply] = _blend_wr_rookie_total(
                totals[scoring][apply], specialist[apply], scoring
            )
    actuals = {
        "STD": truth.loc[common, "target_std_total"].to_numpy(dtype=float),
        "PPR": truth.loc[common, "target_ppr_total"].to_numpy(dtype=float),
    }
    seasons = truth.loc[common, "season"].to_numpy(dtype=int)
    draftable = np.asarray([int(index) in locked_ids for index in common])
    metrics: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    for scoring in ("STD", "PPR"):
        metrics[scoring] = {}
        for scope, mask in (
            ("full", np.ones(len(common), dtype=bool)),
            ("draftable", draftable),
        ):
            metrics[scoring][scope] = {
                "aggregate": _metrics(totals[scoring][mask], actuals[scoring][mask]),
                "folds": {
                    str(season): _metrics(
                        totals[scoring][mask & (seasons == season)],
                        actuals[scoring][mask & (seasons == season)],
                    )
                    for season in EVALUATION_SEASONS
                },
            }
            for projected, actual, season in zip(
                totals[scoring][mask], actuals[scoring][mask], seasons[mask]
            ):
                records.append(
                    {
                        "position": position,
                        "scoring": scoring,
                        "scope": scope,
                        "season": int(season),
                        "projected": float(projected),
                        "actual": float(actual),
                    }
                )
    return metrics, records


def acceptance(control: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    for scoring in ("STD", "PPR"):
        for scope in ("full", "draftable"):
            base = control[scoring][scope]["aggregate"]
            test = candidate[scoring][scope]["aggregate"]
            label = f"aggregate {scoring} {scope}"
            if test["mae"] >= base["mae"]:
                reasons.append(f"{label} MAE did not strictly improve")
            if test["rmse"] > base["rmse"]:
                reasons.append(f"{label} RMSE regressed")
            if abs(test["bias"]) > abs(base["bias"]):
                reasons.append(f"{label} absolute bias regressed")
            if (
                base["spearman"] is not None
                and test["spearman"] is not None
                and test["spearman"] < base["spearman"]
            ):
                reasons.append(f"{label} rank regressed")
            for season in EVALUATION_SEASONS:
                prior = control[scoring][scope]["folds"][str(season)]
                trial = candidate[scoring][scope]["folds"][str(season)]
                fold = f"{season} {scoring} {scope}"
                if trial["mae"] > prior["mae"]:
                    reasons.append(f"{fold} MAE regressed")
                if trial["rmse"] > prior["rmse"]:
                    reasons.append(f"{fold} RMSE regressed")
                if abs(trial["bias"]) > abs(prior["bias"]):
                    reasons.append(f"{fold} absolute bias regressed")
                if (
                    prior["spearman"] is not None
                    and trial["spearman"] is not None
                    and trial["spearman"] < prior["spearman"]
                ):
                    reasons.append(f"{fold} rank regressed")
    return {
        "accepted": not reasons,
        "policy": (
            "Full and locked-draftable STD/PPR aggregate MAE must strictly "
            "improve. Aggregate and every 2023-2025 fold MAE, RMSE, absolute "
            "bias, and Spearman must not regress."
        ),
        "reasons": reasons,
    }


def pooled(records: list[dict[str, Any]]) -> dict[str, Any]:
    frame = pd.DataFrame(records)
    output: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        output[scoring] = {}
        for scope in ("full", "draftable"):
            mask = frame["scoring"].eq(scoring) & frame["scope"].eq(scope)
            output[scoring][scope] = {
                "aggregate": _metrics(
                    frame.loc[mask, "projected"].to_numpy(dtype=float),
                    frame.loc[mask, "actual"].to_numpy(dtype=float),
                ),
                "folds": {
                    str(season): _metrics(
                        frame.loc[mask & frame["season"].eq(season), "projected"].to_numpy(dtype=float),
                        frame.loc[mask & frame["season"].eq(season), "actual"].to_numpy(dtype=float),
                    )
                    for season in EVALUATION_SEASONS
                },
            }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data/private/owned-model/raw")
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/research/owned-model-ngs-features.json"),
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

    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, _ = load_depth_charts(args.data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dataset, production_features = build_dataset(stats, players, roles)
    ngs_maps, manifest = load_ngs(args.data_dir)
    dataset, coverage = augment_dataset(dataset, ngs_maps)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only nflverse Next Gen Stats feature audit",
        "baselineModelVersion": MODEL_VERSION,
        "generatedAt": utc_now(),
        "sourceReview": {
            "release": SOURCE_URL,
            "schema": SCHEMA_URL,
            "repositoryLicense": "CC-BY-4.0",
            "licenseUrl": LICENSE_URL,
            "upstreamBoundary": (
                "nflverse applies CC-BY-4.0 to the release repository, while its "
                "terms note that underlying NFL data may remain subject to the "
                "respective owners' rights. Preserve attribution and do not "
                "redistribute raw NGS rows in the public projection payload."
            ),
            "providerThreshold": (
                "NFL NGS publishes only players above minimum pass/rush/receive "
                "attempt thresholds; missing joins are not zero outcomes."
            ),
            "assets": manifest,
        },
        "method": (
            "Exact GSIS join from target season S to REG week=0 NGS summary for "
            "S-1. Two fixed feature sets are evaluated with production-identical "
            "base learners and nested expanding OOF stacks. The v2026.12 WR-rookie "
            "specialist is held fixed and applied identically to both sides."
        ),
        "missingnessFallback": (
            "Unpublished/below-threshold NGS rows remain NaN. The production "
            "median imputer plus missing indicators handles them; no zero fill, "
            "name matching, or target-season data is allowed."
        ),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "baseOofSeasons": list(BASE_OOF_SEASONS),
        "coverage": coverage,
        "positions": {},
        "pooled": {},
        "decision": {},
    }
    record_sets: dict[str, list[dict[str, Any]]] = {
        "control": [],
        "trackingEfficiency": [],
        "trackingEfficiencyUsage": [],
    }
    for position in POSITIONS:
        rows = dataset[dataset["position"].eq(position)].copy()
        baseline_oof = build_oof(rows, production_features, position)
        locked = locked_draftable_ids(baseline_oof, position)
        specialist = (
            wr_rookie_specialist_oof(rows, production_features)
            if position == "WR"
            else None
        )
        baseline_nested, baseline_parameters = nested_predictions(baseline_oof)
        control, records = evaluate(
            baseline_nested, rows, position, locked, specialist
        )
        record_sets["control"].extend(records)
        variants: dict[str, Any] = {}
        for variant, additions in variant_features(position).items():
            candidate_oof = build_oof(
                rows, [*production_features, *additions], position
            )
            candidate_nested, parameters = nested_predictions(candidate_oof)
            metrics, candidate_records = evaluate(
                candidate_nested, rows, position, locked, specialist
            )
            record_sets[variant].extend(candidate_records)
            variants[variant] = {
                "addedFeatures": additions,
                "metrics": metrics,
                "parameters": parameters,
                "acceptance": acceptance(control, metrics),
            }
        report["positions"][position] = {
            "control": control,
            "controlParameters": baseline_parameters,
            "variants": variants,
        }
        report["decision"][position] = {
            variant: value["acceptance"]["accepted"]
            for variant, value in variants.items()
        }

    control_pooled = pooled(record_sets["control"])
    report["pooled"]["control"] = control_pooled
    for variant in ("trackingEfficiency", "trackingEfficiencyUsage"):
        metrics = pooled(record_sets[variant])
        report["pooled"][variant] = {
            "metrics": metrics,
            "acceptance": acceptance(control_pooled, metrics),
        }
    report["overallDecision"] = {
        variant: {
            "acceptedAllPositionsAndPooled": (
                report["pooled"][variant]["acceptance"]["accepted"]
                and all(report["decision"][position][variant] for position in POSITIONS)
            ),
            "productionAction": "research-only; no pipeline/runtime change",
        }
        for variant in ("trackingEfficiency", "trackingEfficiencyUsage")
    }
    report["researchStatus"] = (
        "accepted-for-production-review"
        if any(value["acceptedAllPositionsAndPooled"] for value in report["overallDecision"].values())
        else "rejected"
    )
    report["productionChanged"] = False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "out": str(args.out),
                "baselineModelVersion": MODEL_VERSION,
                "coverage": coverage,
                "decision": report["decision"],
                "overallDecision": report["overallDecision"],
                "pooled": {
                    variant: {
                        scoring: {
                            scope: report["pooled"][variant]["metrics"][scoring][scope]["aggregate"]
                            for scope in ("full", "draftable")
                        }
                        for scoring in ("STD", "PPR")
                    }
                    for variant in ("trackingEfficiency", "trackingEfficiencyUsage")
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
