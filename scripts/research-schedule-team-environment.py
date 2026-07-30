"""Audit preseason-known schedule and team-environment features.

Research only.  Target-season schedule structure is joined to team strength
calculated exclusively from the prior completed season.  Every base forecast,
stack weight, and calibration value is evaluated with expanding chronological
folds; this file never alters the owned-model pipeline or runtime artifacts.
"""

from __future__ import annotations

import argparse
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
    CORE_POSITIONS,
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
    load_dst_stats,
    load_players,
    load_stats,
    utc_now,
)


SEED = 20260715
BASE_OOF_SEASONS = (2021, 2022, 2023, 2024, 2025)
EVALUATION_SEASONS = (2023, 2024, 2025)
SCHEDULE_FEATURES = (
    "schedule_games",
    "schedule_home_share",
    "schedule_division_share",
    "schedule_opp_prior_points_for_pg",
    "schedule_opp_prior_points_allowed_pg",
    "schedule_opp_prior_point_diff_pg",
    "schedule_opp_prior_plays_pg",
    "schedule_opp_prior_pass_rate",
    "schedule_opp_prior_offensive_td_pg",
    "schedule_opp_prior_def_sacks_pg",
    "schedule_prior_coverage",
)
TEAM_FEATURES = (
    "team_prior_points_for_pg",
    "team_prior_points_allowed_pg",
    "team_prior_point_diff_pg",
    "team_prior_plays_pg",
    "team_prior_pass_rate",
    "team_prior_yards_per_play",
    "team_prior_offensive_td_pg",
    "team_prior_def_sacks_pg",
    "team_prior_takeaways_pg",
)
VARIANTS = {
    "schedule": list(SCHEDULE_FEATURES),
    "teamEnvironment": list(TEAM_FEATURES),
    "scheduleTeam": [*SCHEDULE_FEATURES, *TEAM_FEATURES],
}


def number(value: Any, default: float = math.nan) -> float:
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def canonical_team(value: Any) -> str:
    team = str(value or "").strip().upper()
    return {
        "LAR": "LA",
        "STL": "LA",
        "JAC": "JAX",
        "WSH": "WAS",
        "OAK": "LV",
        "SD": "LAC",
    }.get(team, team)


def prior_team_contexts(
    data_dir: Path, games: pd.DataFrame
) -> dict[tuple[int, str], dict[str, float]]:
    """Return contexts keyed by the completed source season and canonical team."""
    score_totals: dict[tuple[int, str], dict[str, float]] = {}
    completed = games[
        games["game_type"].astype(str).eq("REG")
        & pd.to_numeric(games["home_score"], errors="coerce").notna()
        & pd.to_numeric(games["away_score"], errors="coerce").notna()
    ]
    for row in completed.to_dict("records"):
        season = int(row["season"])
        home, away = canonical_team(row["home_team"]), canonical_team(row["away_team"])
        home_score, away_score = float(row["home_score"]), float(row["away_score"])
        for team, scored, allowed in (
            (home, home_score, away_score),
            (away, away_score, home_score),
        ):
            record = score_totals.setdefault(
                (season, team), {"games": 0.0, "points_for": 0.0, "points_allowed": 0.0}
            )
            record["games"] += 1.0
            record["points_for"] += scored
            record["points_allowed"] += allowed

    output: dict[tuple[int, str], dict[str, float]] = {}
    for path in sorted(data_dir.glob("stats_team_reg_*.csv")):
        frame = pd.read_csv(path, low_memory=False)
        for row in frame.to_dict("records"):
            season = int(number(row.get("season"), int(path.stem.rsplit("_", 1)[-1])))
            team = canonical_team(row.get("team"))
            games_played = max(1.0, number(row.get("games"), 1.0))
            attempts = number(row.get("attempts"), 0.0)
            carries = number(row.get("carries"), 0.0)
            plays = attempts + carries
            scores = score_totals.get((season, team), {})
            score_games = max(1.0, number(scores.get("games"), games_played))
            points_for = number(scores.get("points_for"), math.nan)
            points_allowed = number(scores.get("points_allowed"), math.nan)
            passing_yards = number(row.get("passing_yards"), 0.0)
            rushing_yards = number(row.get("rushing_yards"), 0.0)
            output[(season, team)] = {
                "points_for_pg": points_for / score_games,
                "points_allowed_pg": points_allowed / score_games,
                "point_diff_pg": (points_for - points_allowed) / score_games,
                "plays_pg": plays / games_played,
                "pass_rate": attempts / max(1.0, plays),
                "yards_per_play": (passing_yards + rushing_yards) / max(1.0, plays),
                "offensive_td_pg": (
                    number(row.get("passing_tds"), 0.0)
                    + number(row.get("rushing_tds"), 0.0)
                ) / games_played,
                "def_sacks_pg": number(row.get("def_sacks"), 0.0) / games_played,
                "takeaways_pg": (
                    number(row.get("def_interceptions"), 0.0)
                    + number(row.get("fumble_recovery_opp"), 0.0)
                ) / games_played,
            }
    return output


def target_schedule_contexts(
    games: pd.DataFrame,
    prior: dict[tuple[int, str], dict[str, float]],
) -> dict[tuple[int, str], dict[str, float]]:
    regular = games[games["game_type"].astype(str).eq("REG")]
    matchups: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for row in regular.to_dict("records"):
        season = int(row["season"])
        home, away = canonical_team(row["home_team"]), canonical_team(row["away_team"])
        division = 1.0 if bool(row.get("div_game")) else 0.0
        matchups.setdefault((season, home), []).append(
            {"opponent": away, "home": 1.0, "division": division}
        )
        matchups.setdefault((season, away), []).append(
            {"opponent": home, "home": 0.0, "division": division}
        )
    result: dict[tuple[int, str], dict[str, float]] = {}
    opponent_keys = (
        "points_for_pg",
        "points_allowed_pg",
        "point_diff_pg",
        "plays_pg",
        "pass_rate",
        "offensive_td_pg",
        "def_sacks_pg",
    )
    for (season, team), rows in matchups.items():
        known = [
            prior[(season - 1, row["opponent"])]
            for row in rows
            if (season - 1, row["opponent"]) in prior
        ]
        context = {
            "schedule_games": float(len(rows)),
            "schedule_home_share": float(np.mean([row["home"] for row in rows])),
            "schedule_division_share": float(np.mean([row["division"] for row in rows])),
            "schedule_prior_coverage": len(known) / max(1.0, len(rows)),
        }
        for key in opponent_keys:
            context[f"schedule_opp_prior_{key}"] = (
                float(np.mean([row[key] for row in known])) if known else math.nan
            )
        own = prior.get((season - 1, team), {})
        for key in (
            "points_for_pg",
            "points_allowed_pg",
            "point_diff_pg",
            "plays_pg",
            "pass_rate",
            "yards_per_play",
            "offensive_td_pg",
            "def_sacks_pg",
            "takeaways_pg",
        ):
            context[f"team_prior_{key}"] = number(own.get(key))
        result[(season, team)] = context
    return result


def augment_dataset(
    dataset: pd.DataFrame,
    stats: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    schedule_contexts: dict[tuple[int, str], dict[str, float]],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    result = dataset.copy()
    features = [*SCHEDULE_FEATURES, *TEAM_FEATURES]
    for feature in features:
        result[feature] = np.nan
    previous_team = {
        (int(row["season"]) + 1, str(row["player_id"])): canonical_team(
            row.get("recent_team")
        )
        for row in stats.to_dict("records")
    }
    matched = 0
    for index, row in result.iterrows():
        season = int(row["season"])
        player_id = str(row["player_id"])
        if player_id.startswith("DST:"):
            team = canonical_team(player_id.split(":", 1)[1])
        else:
            role = roles.get((season, player_id), {})
            team = canonical_team(role.get("team"))
            if not team:
                team = previous_team.get((season, player_id), "")
        context = schedule_contexts.get((season, team))
        if not context:
            continue
        matched += 1
        for feature in features:
            result.at[index, feature] = number(context.get(feature))
    coverage = {
        "rows": int(len(result)),
        "rowsWithContext": matched,
        "rowCoverage": round(matched / max(1, len(result)), 6),
        "featureCoverage": {
            feature: round(float(result[feature].notna().mean()), 6)
            for feature in features
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
        if not frames:
            raise ValueError(f"No OOF frames for {position} {target}.")
        output[target] = pd.concat(frames).sort_index()
    return output


def nested_predictions(
    frames: dict[str, pd.DataFrame], force_empirical: bool = False
) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    result: dict[str, pd.DataFrame] = {}
    parameters: dict[str, Any] = {}
    for target, frame in frames.items():
        matrix = frame[["empirical", "ridge", "boosted"]].to_numpy(dtype=float)
        actual = frame["actual"].to_numpy(dtype=float)
        seasons = frame["season"].to_numpy(dtype=int)
        candidate = np.full(len(frame), np.nan)
        parameters[target] = {}
        for season in EVALUATION_SEASONS:
            prior = seasons < season
            test = seasons == season
            if not prior.any() or not test.any():
                raise ValueError(f"Missing nested fold {season} {target}.")
            if force_empirical:
                weights = np.asarray([1.0, 0.0, 0.0])
                offset = 0.0
            else:
                weights = _stack_weights(matrix[prior], actual[prior])
                offset = float(np.median(actual[prior] - matrix[prior] @ weights))
            candidate[test] = _clip_prediction(
                target, matrix[test] @ weights + offset
            )
            parameters[target][str(season)] = {
                "weights": weights.tolist(),
                "calibrationOffset": round(offset, 6),
                "priorOofSeasons": sorted(set(int(value) for value in seasons[prior])),
            }
        scored = frame.copy()
        scored["candidate"] = candidate
        result[target] = scored[scored["season"].isin(EVALUATION_SEASONS)]
    return result, parameters


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
        if train.empty or test.empty:
            continue
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


def evaluate_predictions(
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
        rookie_mask = truth.loc[common, "rookie"].to_numpy(dtype=float) == 1.0
        for scoring in ("STD", "PPR"):
            specialist = rookie_specialist[scoring].reindex(common).to_numpy(dtype=float)
            apply = rookie_mask & np.isfinite(specialist)
            totals[scoring][apply] = _blend_wr_rookie_total(
                totals[scoring][apply], specialist[apply], scoring
            )
    actuals = {
        "STD": truth.loc[common, "target_std_total"].to_numpy(dtype=float),
        "PPR": truth.loc[common, "target_ppr_total"].to_numpy(dtype=float),
    }
    seasons = truth.loc[common, "season"].to_numpy(dtype=int)
    draftable = np.asarray([int(index) in locked_ids for index in common])
    report: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    for scoring in ("STD", "PPR"):
        report[scoring] = {}
        for scope, mask in (
            ("full", np.ones(len(common), dtype=bool)),
            ("draftable", draftable),
        ):
            report[scoring][scope] = {
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
                        "scoring": scoring,
                        "scope": scope,
                        "season": int(season),
                        "projected": float(projected),
                        "actual": float(actual),
                    }
                )
    return report, records


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
                test["spearman"] is not None
                and base["spearman"] is not None
                and test["spearman"] < base["spearman"]
            ):
                reasons.append(f"{label} rank regressed")
            for season in EVALUATION_SEASONS:
                base_fold = control[scoring][scope]["folds"][str(season)]
                test_fold = candidate[scoring][scope]["folds"][str(season)]
                fold_label = f"{season} {scoring} {scope}"
                if test_fold["mae"] > base_fold["mae"]:
                    reasons.append(f"{fold_label} MAE regressed")
                if test_fold["rmse"] > base_fold["rmse"]:
                    reasons.append(f"{fold_label} RMSE regressed")
                if abs(test_fold["bias"]) > abs(base_fold["bias"]):
                    reasons.append(f"{fold_label} absolute bias regressed")
                if (
                    test_fold["spearman"] is not None
                    and base_fold["spearman"] is not None
                    and test_fold["spearman"] < base_fold["spearman"]
                ):
                    reasons.append(f"{fold_label} rank regressed")
    return {
        "accepted": not reasons,
        "policy": (
            "Both full and locked-draftable STD/PPR aggregate MAE must strictly "
            "improve. Aggregate and every 2023-2025 fold RMSE, absolute bias, and "
            "Spearman may not regress; fold MAE may not regress."
        ),
        "reasons": reasons,
    }


def pooled_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    frame = pd.DataFrame(records)
    output: dict[str, Any] = {}
    for scoring in ("STD", "PPR"):
        output[scoring] = {}
        for scope in ("full", "draftable"):
            output[scoring][scope] = {
                "aggregate": _metrics(
                    frame[
                        frame["scoring"].eq(scoring) & frame["scope"].eq(scope)
                    ]["projected"].to_numpy(dtype=float),
                    frame[
                        frame["scoring"].eq(scoring) & frame["scope"].eq(scope)
                    ]["actual"].to_numpy(dtype=float),
                ),
                "folds": {
                    str(season): _metrics(
                        frame[
                            frame["scoring"].eq(scoring)
                            & frame["scope"].eq(scope)
                            & frame["season"].eq(season)
                        ]["projected"].to_numpy(dtype=float),
                        frame[
                            frame["scoring"].eq(scoring)
                            & frame["scope"].eq(scope)
                            & frame["season"].eq(season)
                        ]["actual"].to_numpy(dtype=float),
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
        default=Path("data/research/owned-model-schedule-team-environment.json"),
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
    roles, depth_manifest = load_depth_charts(args.data_dir, 2026)
    stats, _ = add_kicker_zero_outcomes(stats, roles, 2025)
    dst_stats, dst_players, _ = load_dst_stats(
        args.data_dir, args.data_dir / "games.csv"
    )
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, production_features = build_dataset(stats, players, roles)
    games = pd.read_csv(args.data_dir / "games.csv", low_memory=False)
    prior = prior_team_contexts(args.data_dir, games)
    contexts = target_schedule_contexts(games, prior)
    dataset, coverage = augment_dataset(dataset, stats, roles, contexts)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "research-only schedule and team environment audit",
        "baselineModelVersion": MODEL_VERSION,
        "generatedAt": utc_now(),
        "method": (
            "Target-season regular-season opponents/home/division structure is "
            "combined only with each team and opponent's prior completed-season "
            "scoring and nflverse team-stat context. Base forecasts use expanding "
            "OOF training; every 2023-2025 stack and calibration uses earlier OOF "
            "seasons only. The accepted v2026.12 WR-rookie specialist is held fixed "
            "and applied identically to control and candidates."
        ),
        "featureCutoff": (
            "For a target season S, dynamic team and opponent strength is sourced "
            "only from S-1. Target-season schedule rows contribute no scores, "
            "betting lines, quarterbacks, coaches, or realized game information."
        ),
        "evaluationSeasons": list(EVALUATION_SEASONS),
        "baseOofSeasons": list(BASE_OOF_SEASONS),
        "features": {
            "schedule": list(SCHEDULE_FEATURES),
            "teamEnvironment": list(TEAM_FEATURES),
        },
        "coverage": coverage,
        "depthChartCaveat": [
            item["featureCutoff"]
            for item in depth_manifest
            if str(item.get("file", "")).endswith(
                ("2023.csv", "2024.csv.gz", "2025.csv.gz")
            )
        ],
        "positions": {},
        "pooled": {},
        "decision": {},
    }
    records_by_variant: dict[str, list[dict[str, Any]]] = {
        "control": [],
        **{variant: [] for variant in VARIANTS},
    }
    for position in CORE_POSITIONS:
        rows = dataset[dataset["position"].eq(position)].copy()
        baseline_oof = build_oof(rows, production_features, position)
        locked_ids = locked_draftable_ids(baseline_oof, position)
        rookie_specialist = (
            wr_rookie_specialist_oof(rows, production_features)
            if position == "WR"
            else None
        )
        baseline_nested, baseline_parameters = nested_predictions(
            baseline_oof, force_empirical=position == "DST"
        )
        control, control_records = evaluate_predictions(
            baseline_nested, rows, position, locked_ids, rookie_specialist
        )
        for record in control_records:
            record["position"] = position
            record["variant"] = "control"
        records_by_variant["control"].extend(control_records)
        position_report: dict[str, Any] = {
            "control": control,
            "controlParameters": baseline_parameters,
            "variants": {},
        }
        for variant, additions in VARIANTS.items():
            candidate_oof = build_oof(
                rows, [*production_features, *additions], position
            )
            candidate_nested, parameters = nested_predictions(
                candidate_oof, force_empirical=False
            )
            metrics, candidate_records = evaluate_predictions(
                candidate_nested, rows, position, locked_ids, rookie_specialist
            )
            for record in candidate_records:
                record["position"] = position
                record["variant"] = variant
            records_by_variant[variant].extend(candidate_records)
            position_report["variants"][variant] = {
                "addedFeatures": additions,
                "metrics": metrics,
                "parameters": parameters,
                "acceptance": acceptance(control, metrics),
            }
        report["positions"][position] = position_report
        report["decision"][position] = {
            variant: position_report["variants"][variant]["acceptance"]["accepted"]
            for variant in VARIANTS
        }

    report["pooled"]["control"] = pooled_metrics(records_by_variant["control"])
    for variant in VARIANTS:
        metrics = pooled_metrics(records_by_variant[variant])
        report["pooled"][variant] = {
            "metrics": metrics,
            "acceptance": acceptance(report["pooled"]["control"], metrics),
        }
    report["overallDecision"] = {
        variant: {
            "acceptedAllPositionsAndPooled": (
                report["pooled"][variant]["acceptance"]["accepted"]
                and all(report["decision"][position][variant] for position in CORE_POSITIONS)
            ),
            "productionAction": "research-only; no pipeline/runtime change",
        }
        for variant in VARIANTS
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
                "overallDecision": report["overallDecision"],
                "pooled": {
                    variant: {
                        scoring: {
                            scope: report["pooled"][variant]["metrics"][scoring][
                                scope
                            ]["aggregate"]
                            for scope in ("full", "draftable")
                        }
                        for scoring in ("STD", "PPR")
                    }
                    for variant in VARIANTS
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
