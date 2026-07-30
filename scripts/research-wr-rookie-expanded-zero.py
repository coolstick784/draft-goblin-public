"""Research-only robustness audit for the locked v12 WR-rookie specialist.

The incumbent development audit scores participant-only rookie rows.  This
harness instead defines each season's evaluation population from the NFL draft
before examining outcomes, admits exact-GSIS drafted WRs with no player-stat row
as zero *recorded* STD/PPR totals, and scores the existing locked specialist
policy on that full bounded cohort.

Two specialist fits are reported:

* incumbent-training: only the participant rows available to v12 train the
  specialist;
* expanded-prior-training: earlier exact drafted rows with zero recorded totals
  are also admitted, but never rows from the season being tested.

The production base stack, policy family, hyperparameters, and blends remain
fixed.  Nothing in this file changes or promotes the model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
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
    LAG_STATS,
    MODEL_VERSION,
    TARGETS,
    WR_ROOKIE_SPECIALIST,
    _blend_wr_rookie_total,
    _clip_prediction,
    _fit_predict,
    _metrics,
    _stack_weights,
    _wr_rookie_total_model,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
    utc_now,
)

GSIS_PATTERN = re.compile(r"00-\d{7}")
FIRST_COHORT_SEASON = 2014
SELECTION_SEASON = 2022
DEVELOPMENT_SEASONS = (2023, 2024, 2025)
AUDIT_SEASONS = (SELECTION_SEASON, *DEVELOPMENT_SEASONS)
BASE_COMPONENT_FIRST_SEASON = 2020


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _exact_wr_picks(picks: pd.DataFrame) -> pd.DataFrame:
    rows = picks.copy()
    rows["season"] = pd.to_numeric(rows["season"], errors="coerce")
    rows["position"] = rows["position"].fillna("").astype(str).str.upper()
    rows["gsis_id"] = rows["gsis_id"].fillna("").astype(str).str.strip()
    rows = rows[
        rows["season"].between(FIRST_COHORT_SEASON, max(AUDIT_SEASONS))
        & rows["position"].eq("WR")
        & rows["gsis_id"].map(lambda value: bool(GSIS_PATTERN.fullmatch(value)))
    ].copy()
    rows["season"] = rows["season"].astype(int)
    if rows.duplicated(["season", "gsis_id"], keep=False).any():
        raise ValueError("Exact drafted-WR population is not unique by season/GSIS.")
    return rows


def _expanded_stats(
    production_stats: pd.DataFrame,
    all_stats: pd.DataFrame,
    exact_picks: pd.DataFrame,
) -> tuple[pd.DataFrame, set[tuple[int, str]], set[tuple[int, str]]]:
    """Add only exact drafted-WR target rows omitted by production loading."""
    production_index = {
        (int(row["season"]), str(row["player_id"])): row
        for row in production_stats.to_dict("records")
    }
    raw = all_stats.copy()
    raw["season"] = pd.to_numeric(raw["season"], errors="raise").astype(int)
    raw["player_id"] = raw["player_id"].fillna("").astype(str).str.strip()
    raw = raw.sort_values(["season", "player_id"]).drop_duplicates(
        ["season", "player_id"], keep="last"
    )
    raw_index = {
        (int(row["season"]), str(row["player_id"])): row
        for row in raw.to_dict("records")
    }
    additions: list[dict[str, Any]] = []
    zero_keys: set[tuple[int, str]] = set()
    reclassified_keys: set[tuple[int, str]] = set()
    replacement_keys: set[tuple[int, str]] = set()
    for pick in exact_picks.to_dict("records"):
        key = (int(pick["season"]), str(pick["gsis_id"]))
        production_row = production_index.get(key)
        if production_row is not None and str(
            production_row.get("position") or ""
        ).upper() == "WR":
            continue
        raw_row = production_row or raw_index.get(key)
        if raw_row is None:
            row: dict[str, Any] = {
                "season": key[0],
                "player_id": key[1],
                "player_display_name": str(pick.get("pfr_player_name") or key[1]),
                "position": "WR",
                "games": 0.0,
                "fantasy_points": 0.0,
                "fantasy_points_ppr": 0.0,
                "recent_team": str(pick.get("team") or ""),
            }
            row.update({column: 0.0 for column in LAG_STATS if column not in row})
            zero_keys.add(key)
        else:
            row = dict(raw_row)
            # Draft-declared WR is the preseason position. Preserve the outcome
            # totals while making the row eligible for the v12 WR feature path.
            row["position"] = "WR"
            reclassified_keys.add(key)
            if production_row is not None:
                replacement_keys.add(key)
        additions.append(row)
    retained = production_stats[
        [
            (int(row.season), str(row.player_id)) not in replacement_keys
            for row in production_stats[["season", "player_id"]].itertuples(
                index=False
            )
        ]
    ]
    expanded = (
        pd.concat([retained, pd.DataFrame(additions)], ignore_index=True)
        if additions
        else retained.copy()
    )
    expanded = expanded.sort_values(["season", "player_id"]).drop_duplicates(
        ["season", "player_id"], keep="last"
    )
    return expanded, zero_keys, reclassified_keys


def _cohort_rows(
    dataset: pd.DataFrame,
    exact_keys: set[tuple[int, str]],
    season: int,
) -> pd.DataFrame:
    mask = [
        int(row.season) == season
        and (int(row.season), str(row.player_id)) in exact_keys
        for row in dataset[["season", "player_id"]].itertuples(index=False)
    ]
    rows = dataset.loc[mask].copy()
    expected = sum(1 for candidate_season, _ in exact_keys if candidate_season == season)
    if len(rows) != expected:
        raise ValueError(
            f"Expanded {season} cohort has {len(rows)} rows; expected {expected}."
        )
    if not (rows["feature_cutoff_season"] < rows["season"]).all():
        raise ValueError(f"Temporal feature boundary failed for {season}.")
    return rows


def _base_prediction(
    incumbent_wr: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
    season: int,
    seed: int,
) -> dict[str, np.ndarray]:
    """Recreate the nested v12 base using only incumbent participant training."""
    output: dict[str, np.ndarray] = {}
    for target in TARGETS:
        prior_components: list[np.ndarray] = []
        prior_actual: list[np.ndarray] = []
        for component_season in range(BASE_COMPONENT_FIRST_SEASON, season):
            train = incumbent_wr[incumbent_wr["season"] < component_season]
            validation = incumbent_wr[incumbent_wr["season"] == component_season]
            if len(train) < 80 or len(validation) < 8:
                continue
            components, _ = _fit_predict(
                train,
                validation,
                features,
                target,
                "WR",
                seed + component_season,
            )
            prior_components.append(components)
            prior_actual.append(
                validation[f"target_{target}"].to_numpy(dtype=float)
            )
        prior_components = prior_components[-5:]
        prior_actual = prior_actual[-5:]
        if not prior_components:
            raise ValueError(f"No prior base calibration folds for {season} {target}.")
        calibration_matrix = np.vstack(prior_components)
        calibration_actual = np.concatenate(prior_actual)
        weights = _stack_weights(calibration_matrix, calibration_actual)
        offset = float(
            np.median(calibration_actual - calibration_matrix @ weights)
        )
        train = incumbent_wr[incumbent_wr["season"] < season]
        components, _ = _fit_predict(
            train, test, features, target, "WR", seed + season
        )
        output[target] = _clip_prediction(
            target, components @ weights + offset
        )
    return {
        "STD": output["games"] * output["std_ppg"],
        "PPR": output["games"] * output["ppr_ppg"],
    }


def _specialist_prediction(
    train: pd.DataFrame,
    test: pd.DataFrame,
    features: list[str],
    scoring: str,
    seed: int,
) -> np.ndarray:
    target = f"target_{scoring.lower()}_total"
    model = _wr_rookie_total_model(seed)
    model.fit(train[features], train[target].to_numpy(dtype=float))
    return np.maximum(0.0, model.predict(test[features]))


def _strict_comparison(
    base: dict[str, Any], candidate: dict[str, Any]
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if candidate["mae"] > base["mae"]:
        reasons.append("MAE regressed")
    if candidate["rmse"] > base["rmse"]:
        reasons.append("RMSE regressed")
    if abs(candidate["bias"]) > abs(base["bias"]):
        reasons.append("absolute bias regressed")
    if (
        candidate["spearman"] is not None
        and base["spearman"] is not None
        and candidate["spearman"] < base["spearman"]
    ):
        reasons.append("Spearman rank regressed")
    return not reasons, reasons


def _variant_report(
    predictions: pd.DataFrame, candidate_prefix: str
) -> dict[str, Any]:
    folds: dict[str, Any] = {}
    all_reasons: list[str] = []
    for season in AUDIT_SEASONS:
        rows = predictions[predictions["season"] == season]
        fold: dict[str, Any] = {"rows": int(len(rows))}
        for scoring in ("STD", "PPR"):
            key = scoring.lower()
            base = _metrics(
                rows[f"base_{key}"].to_numpy(dtype=float),
                rows[f"actual_{key}"].to_numpy(dtype=float),
            )
            candidate = _metrics(
                rows[f"{candidate_prefix}_{key}"].to_numpy(dtype=float),
                rows[f"actual_{key}"].to_numpy(dtype=float),
            )
            passes, reasons = _strict_comparison(base, candidate)
            fold[scoring] = {
                "base": base,
                "candidate": candidate,
                "improvesEveryTrackedMetric": passes,
                "reasons": reasons,
            }
            if not passes:
                all_reasons.extend(
                    f"{season} {scoring} {reason}" for reason in reasons
                )
        folds[str(season)] = fold
    development = predictions[
        predictions["season"].isin(DEVELOPMENT_SEASONS)
    ]
    aggregate: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        key = scoring.lower()
        base = _metrics(
            development[f"base_{key}"].to_numpy(dtype=float),
            development[f"actual_{key}"].to_numpy(dtype=float),
        )
        candidate = _metrics(
            development[f"{candidate_prefix}_{key}"].to_numpy(dtype=float),
            development[f"actual_{key}"].to_numpy(dtype=float),
        )
        passes, reasons = _strict_comparison(base, candidate)
        aggregate[scoring] = {
            "base": base,
            "candidate": candidate,
            "improvesEveryTrackedMetric": passes,
            "reasons": reasons,
        }
        if not passes:
            all_reasons.extend(f"aggregate {scoring} {reason}" for reason in reasons)
    return {
        "folds": folds,
        "developmentAggregate": aggregate,
        "improvesEveryMetricAndFoldIncludingSelection": not all_reasons,
        "improvesEveryDevelopmentMetricAndFold": all(
            folds[str(season)][scoring]["improvesEveryTrackedMetric"]
            for season in DEVELOPMENT_SEASONS
            for scoring in ("STD", "PPR")
        )
        and all(
            aggregate[scoring]["improvesEveryTrackedMetric"]
            for scoring in ("STD", "PPR")
        ),
        "failureReasons": all_reasons,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    raw = Path(args.data_dir)
    stats, stats_manifest = load_stats(raw)
    players, players_manifest = load_players(Path(args.players))
    picks, picks_manifest = load_draft_picks(Path(args.draft_picks))
    players, draft_coverage = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(raw, args.projection_season)
    all_stat_paths = sorted(raw.glob("stats_player_reg_*.csv"))
    all_stats = pd.concat(
        [pd.read_csv(path, low_memory=False) for path in all_stat_paths],
        ignore_index=True,
    )
    exact_picks = _exact_wr_picks(picks)
    exact_keys = set(
        zip(exact_picks["season"].astype(int), exact_picks["gsis_id"].astype(str))
    )
    expanded_stats, zero_keys, reclassified_keys = _expanded_stats(
        stats, all_stats, exact_picks
    )

    incumbent_dataset, features = build_dataset(stats, players, roles)
    expanded_dataset, expanded_features = build_dataset(
        expanded_stats, players, roles
    )
    if features != expanded_features:
        raise ValueError("Expanded cohort changed the v12 feature schema.")
    forbidden_features = {
        "target_games",
        "target_std_ppg",
        "target_ppr_ppg",
        "target_std_total",
        "target_ppr_total",
        "season",
    }
    if forbidden_features.intersection(features):
        raise ValueError("Target-season outcome leaked into model features.")

    incumbent_wr = incumbent_dataset[incumbent_dataset["position"] == "WR"].copy()
    incumbent_rookies = incumbent_wr[incumbent_wr["rookie"] == 1.0].copy()
    expanded_wr = expanded_dataset[expanded_dataset["position"] == "WR"].copy()
    expanded_rookies = expanded_wr[expanded_wr["rookie"] == 1.0].copy()
    seed = int(args.seed)
    outputs: list[pd.DataFrame] = []
    training_counts: dict[str, Any] = {}
    cohort_counts: dict[str, Any] = {}

    for season in AUDIT_SEASONS:
        test = _cohort_rows(expanded_wr, exact_keys, season)
        base = _base_prediction(incumbent_wr, test, features, season, seed)
        output = pd.DataFrame(
            {
                "season": season,
                "player_id": test["player_id"].astype(str).to_numpy(),
                "actual_std": test["target_std_total"].to_numpy(dtype=float),
                "actual_ppr": test["target_ppr_total"].to_numpy(dtype=float),
                "base_std": base["STD"],
                "base_ppr": base["PPR"],
            }
        )
        incumbent_train = incumbent_rookies[
            incumbent_rookies["season"] < season
        ]
        expanded_train = expanded_rookies[
            expanded_rookies["season"] < season
        ]
        for scoring in ("STD", "PPR"):
            base_values = base[scoring]
            incumbent_specialist = _specialist_prediction(
                incumbent_train,
                test,
                features,
                scoring,
                seed + season,
            )
            expanded_specialist = _specialist_prediction(
                expanded_train,
                test,
                features,
                scoring,
                seed + season,
            )
            key = scoring.lower()
            output[f"incumbent_{key}"] = _blend_wr_rookie_total(
                base_values, incumbent_specialist, scoring
            )
            output[f"expanded_{key}"] = _blend_wr_rookie_total(
                base_values, expanded_specialist, scoring
            )
        outputs.append(output)
        test_keys = set(zip(output["season"], output["player_id"]))
        cohort_counts[str(season)] = {
            "rows": int(len(test)),
            "zeroRecordedTotalRows": int(len(test_keys & zero_keys)),
            "reclassifiedStatsRows": int(len(test_keys & reclassified_keys)),
            "participantRows": int(
                len(test) - len(test_keys & zero_keys) - len(test_keys & reclassified_keys)
            ),
        }
        expanded_prior_keys = set(
            zip(
                expanded_train["season"].astype(int),
                expanded_train["player_id"].astype(str),
            )
        )
        training_counts[str(season)] = {
            "incumbentRookieRows": int(len(incumbent_train)),
            "expandedRookieRows": int(len(expanded_train)),
            "priorZeroRecordedRowsAdded": int(
                len(expanded_prior_keys & zero_keys)
            ),
            "latestTrainingSeason": int(expanded_train["season"].max()),
            "strictlyBeforeTestSeason": bool(
                (expanded_train["season"] < season).all()
            ),
        }

    predictions = pd.concat(outputs, ignore_index=True)
    incumbent_audit = _variant_report(predictions, "incumbent")
    expanded_audit = _variant_report(predictions, "expanded")
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "kind": "research-only expanded drafted-WR zero-total robustness audit",
        "baseModelVersion": MODEL_VERSION,
        "researchStatus": "rejected-no-production-change",
        "productionChanged": False,
        "liveConsensusChanged": False,
        "policyUnderTest": {
            **WR_ROOKIE_SPECIALIST,
            "modelVersion": MODEL_VERSION,
            "configurationChanged": False,
        },
        "method": (
            "Recreate the v12 participant-trained nested WR base. Score the "
            "locked HGB direct-total specialist and fixed 50% STD / 75% PPR "
            "blends on every exact-GSIS drafted WR in 2022-2025, assigning zero "
            "only when the completed player-stat release has no row. The "
            "expanded-training sensitivity admits only earlier-season bounded "
            "zero-total rows to specialist fitting."
        ),
        "temporalBoundary": {
            "featureRule": (
                "build_dataset enforces feature_cutoff_season < target season; "
                "target totals and season are excluded from the feature matrix."
            ),
            "draftRule": (
                "Draft season, pick, declared WR position, and name are known "
                "before the rookie regular season. Exact GSIS is linkage only."
            ),
            "trainingRule": (
                "Every base and specialist fit uses rows with season strictly "
                "less than the scored season. Expanded zero labels enter only "
                "after their completed prior season."
            ),
            "developmentCaveat": (
                "Historical depth rows use the same dated pre-Week-1 cutoff as "
                "the original v12 development harness, but the present asset "
                "bytes were not independently archived before kickoff. Results "
                "remain adaptive development evidence, never promotion proof."
            ),
        },
        "labelBoundary": {
            "supported": "Zero recorded offensive STD/PPR total.",
            "unsupported": "Zero NFL games played.",
            "population": "Exact-GSIS drafted WRs only; undrafted rookies excluded.",
        },
        "cohort": cohort_counts,
        "training": training_counts,
        "incumbentTrainingLockedPolicy": incumbent_audit,
        "expandedPriorZeroTrainingSensitivity": expanded_audit,
        "answer": {
            "existingSpecialistImprovesEveryMetricAndDevelopmentFold": (
                incumbent_audit["improvesEveryDevelopmentMetricAndFold"]
            ),
            "expandedTrainingImprovesEveryMetricAndDevelopmentFold": (
                expanded_audit["improvesEveryDevelopmentMetricAndFold"]
            ),
        },
        "decision": {
            "status": "do-not-integrate",
            "reason": (
                "This is an adaptive bounded-cohort robustness audit. Even a "
                "favorable result cannot replace prospective 2026 confirmation; "
                "an unfavorable fold invalidates any claim that the accepted "
                "specialist improves every metric once known zeros are included."
            ),
            "productionAction": "Keep v12 and the live consensus unchanged.",
        },
        "inputManifest": {
            "stats": stats_manifest,
            "players": players_manifest,
            "draftPicks": {**picks_manifest, "identityCoverage": draft_coverage},
            "depth": depth_manifest,
            "allPositionStatsForOutcomeLinkage": [
                {"file": path.name, "sha256": sha256_file(path)}
                for path in all_stat_paths
                if FIRST_COHORT_SEASON
                <= int(path.stem.replace(".csv", "").split("_")[-1])
                <= max(AUDIT_SEASONS)
            ],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument(
        "--players", default="data/private/owned-model/raw/players.csv"
    )
    parser.add_argument(
        "--draft-picks", default="data/private/owned-model/raw/draft_picks.csv"
    )
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260717)
    parser.add_argument(
        "--output",
        default="data/research/owned-model-wr-rookie-expanded-zero.json",
    )
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "answer": report["answer"],
                "cohort": report["cohort"],
                "incumbent": report["incumbentTrainingLockedPolicy"],
                "expanded": report["expandedPriorZeroTrainingSensitivity"],
                "decision": report["decision"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
