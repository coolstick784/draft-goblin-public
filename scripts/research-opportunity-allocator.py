"""Leakage-safe preseason opportunity-allocation research.

Research only: forecast a team/position scoring budget and allocate it using
preseason depth order plus prior usage.  Hyperparameters are selected on the
immediately prior season and every test fold is strictly later than all fit
outcomes.  This script never writes production model or projection artifacts.
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
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (
    DRAFTABLE_LIMITS,
    MODEL_VERSION,
    TARGETS,
    WR_ROOKIE_SPECIALIST,
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

POSITIONS = ("QB", "RB", "WR", "TE")
SCORINGS = ("STD", "PPR")
EVALUATION_SEASONS = (2023, 2024, 2025)
RIDGE_ALPHAS = (50.0, 500.0)
BUDGET_BLENDS = (0.0, 0.10, 0.20, 0.35)
SHARE_BLENDS = (0.0, 0.10, 0.20, 0.35)
RATIO_LIMIT = (0.85, 1.15)

BUDGET_FEATURES = (
    "baseline_sum", "empirical_sum", "team_position_points_lag1",
    "team_position_points_lag2", "team_points_lag1", "team_points_lag2",
    "team_attempts_pg", "team_carries_pg", "team_targets_pg", "team_ppr_pg",
    "returning_carry_share", "returning_target_share", "returning_ppr_share",
    "position_competition", "roster_rows", "depth_starters",
    "depth_top_three", "depth_missing_rows", "position_QB", "position_RB",
    "position_WR", "position_TE",
)
SHARE_FEATURES = (
    "baseline_share", "empirical_share", "depth_rank", "depth_starter",
    "depth_top_three", "depth_missing", "games_lag1", "carries_lag1",
    "targets_lag1", "fantasy_points_ppr_lag1", "returning_carry_share",
    "returning_target_share", "returning_ppr_share", "position_competition",
    "roster_rows", "team_changed", "rookie", "position_QB", "position_RB",
    "position_WR", "position_TE",
)


def model(alpha: float) -> Any:
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        StandardScaler(),
        Ridge(alpha=alpha),
    )


def nested_forecasts(
    dataset: pd.DataFrame, features: list[str], seed: int
) -> pd.DataFrame:
    """Return production-style OOF totals, including the v2026.12 WR specialist."""
    seasons = sorted(int(value) for value in dataset["season"].unique())
    oof_seasons = seasons[-5:]
    outputs: list[pd.DataFrame] = []
    for position in POSITIONS:
        rows = dataset[dataset["position"].eq(position)].copy()
        targets: dict[str, pd.DataFrame] = {}
        for target in TARGETS:
            pieces = []
            for season in oof_seasons:
                train = rows[rows["season"] < season]
                test = rows[rows["season"] == season]
                components, _ = _fit_predict(
                    train, test, features, target, position, seed + season
                )
                pieces.append(pd.DataFrame({
                    "row_index": test.index,
                    "season": season,
                    "actual": test[f"target_{target}"].to_numpy(float),
                    "empirical": components[:, 0],
                    "ridge": components[:, 1],
                    "boosted": components[:, 2],
                }))
            frame = pd.concat(pieces).set_index("row_index")
            matrix = frame[["empirical", "ridge", "boosted"]].to_numpy(float)
            actual = frame["actual"].to_numpy(float)
            labels = frame["season"].to_numpy(int)
            candidate = np.full(len(frame), np.nan)
            for season in EVALUATION_SEASONS:
                prior, test = labels < season, labels == season
                weights = _stack_weights(matrix[prior], actual[prior])
                offset = float(np.median(actual[prior] - matrix[prior] @ weights))
                candidate[test] = _clip_prediction(
                    target, matrix[test] @ weights + offset
                )
            frame["candidate"] = candidate
            targets[target] = frame
        common = targets["games"].index
        joined = pd.DataFrame(index=common)
        joined["season"] = targets["games"].loc[common, "season"]
        for prefix, source in (("empirical", "empirical"), ("candidate", "candidate")):
            games = targets["games"].loc[common, source].to_numpy(float)
            joined[f"{prefix}_STD"] = games * targets["std_ppg"].loc[common, source].to_numpy(float)
            joined[f"{prefix}_PPR"] = games * targets["ppr_ppg"].loc[common, source].to_numpy(float)
        truth = rows.loc[common]
        joined["player_id"] = truth["player_id"].astype(str)
        joined["position"] = position
        joined["actual_STD"] = truth["target_std_total"].to_numpy(float)
        joined["actual_PPR"] = truth["target_ppr_total"].to_numpy(float)
        # The fixed WR rookie specialist was selected on 2022 only.  Apply it
        # to later OOF folds exactly as production does, with fold-local fits.
        if position == "WR":
            for season in EVALUATION_SEASONS:
                test_rows = rows[(rows["season"] == season) & (rows["rookie"] == 1.0)]
                if test_rows.empty:
                    continue
                train_rows = rows[(rows["season"] < season) & (rows["rookie"] == 1.0)]
                for scoring in SCORINGS:
                    specialist = _wr_rookie_total_model(seed + season)
                    specialist.fit(
                        train_rows[features],
                        train_rows[f"target_{scoring.lower()}_total"].to_numpy(float),
                    )
                    direct = specialist.predict(test_rows[features])
                    base = joined.loc[test_rows.index, f"candidate_{scoring}"].to_numpy(float)
                    joined.loc[test_rows.index, f"candidate_{scoring}"] = _blend_wr_rookie_total(
                        base, direct, scoring
                    )
        outputs.append(joined)
    return pd.concat(outputs).sort_values(["season", "position", "player_id"])


def prior_totals(stats: pd.DataFrame, scoring: str) -> tuple[dict[Any, float], dict[Any, float]]:
    offense = stats[stats["position"].isin(POSITIONS)].copy()
    column = "fantasy_points_ppr" if scoring == "PPR" else "fantasy_points"
    offense[column] = pd.to_numeric(offense[column], errors="coerce").fillna(0.0)
    return (
        offense.groupby(["season", "recent_team", "position"])[column].sum().to_dict(),
        offense.groupby(["season", "recent_team"])[column].sum().to_dict(),
    )


def attach_context(
    forecasts: pd.DataFrame,
    dataset: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    stats: pd.DataFrame,
) -> pd.DataFrame:
    rows = forecasts.copy()
    rows["team"] = [
        str(roles.get((int(season), str(player_id)), {}).get("team") or "")
        for season, player_id in zip(rows["season"], rows["player_id"])
    ]
    rows["mapped"] = rows["team"].ne("")
    context = (
        "team_attempts_pg", "team_carries_pg", "team_targets_pg", "team_ppr_pg",
        "returning_carry_share", "returning_target_share", "returning_ppr_share",
        "position_competition", "depth_rank", "depth_starter", "depth_top_three",
        "depth_missing", "games_lag1", "carries_lag1", "targets_lag1",
        "fantasy_points_ppr_lag1", "team_changed", "rookie",
    )
    for name in context:
        rows[name] = dataset.loc[rows.index, name].to_numpy(float)
    for position in POSITIONS:
        rows[f"position_{position}"] = (rows["position"] == position).astype(float)
    for scoring in SCORINGS:
        by_position, by_team = prior_totals(stats, scoring)
        rows[f"team_position_{scoring}_lag1"] = [
            by_position.get((season - 1, team, position), np.nan)
            for season, team, position in zip(rows["season"], rows["team"], rows["position"])
        ]
        rows[f"team_position_{scoring}_lag2"] = [
            by_position.get((season - 2, team, position), np.nan)
            for season, team, position in zip(rows["season"], rows["team"], rows["position"])
        ]
        rows[f"team_{scoring}_lag1"] = [
            by_team.get((season - 1, team), np.nan)
            for season, team in zip(rows["season"], rows["team"])
        ]
        rows[f"team_{scoring}_lag2"] = [
            by_team.get((season - 2, team), np.nan)
            for season, team in zip(rows["season"], rows["team"])
        ]
    return rows


def group_tables(rows: pd.DataFrame, scoring: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    players = rows.copy()
    # Before 2023, use only the empirical OOF forecast as a model input.
    players["baseline"] = players[f"candidate_{scoring}"].where(
        players["season"] >= 2023, players[f"empirical_{scoring}"]
    )
    players["actual"] = players[f"actual_{scoring}"]
    mapped = players[players["mapped"]].copy()
    group_keys = ["season", "team", "position"]
    aggregates = mapped.groupby(group_keys).agg(
        actual=("actual", "sum"), baseline_sum=("baseline", "sum"),
        empirical_sum=(f"empirical_{scoring}", "sum"),
        roster_rows=("player_id", "size"), depth_starters=("depth_starter", "sum"),
        depth_top_three=("depth_top_three", "sum"),
        depth_missing_rows=("depth_missing", "sum"),
        team_attempts_pg=("team_attempts_pg", "first"),
        team_carries_pg=("team_carries_pg", "first"),
        team_targets_pg=("team_targets_pg", "first"),
        team_ppr_pg=("team_ppr_pg", "first"),
        returning_carry_share=("returning_carry_share", "first"),
        returning_target_share=("returning_target_share", "first"),
        returning_ppr_share=("returning_ppr_share", "first"),
        position_competition=("position_competition", "first"),
        team_position_points_lag1=(f"team_position_{scoring}_lag1", "first"),
        team_position_points_lag2=(f"team_position_{scoring}_lag2", "first"),
        team_points_lag1=(f"team_{scoring}_lag1", "first"),
        team_points_lag2=(f"team_{scoring}_lag2", "first"),
    ).reset_index()
    for position in POSITIONS:
        aggregates[f"position_{position}"] = (
            aggregates["position"] == position
        ).astype(float)
    lookup = aggregates.set_index(group_keys)
    keys = pd.MultiIndex.from_frame(mapped[group_keys])
    mapped["group_actual"] = lookup.loc[keys, "actual"].to_numpy(float)
    mapped["group_baseline"] = lookup.loc[keys, "baseline_sum"].to_numpy(float)
    mapped["group_empirical"] = lookup.loc[keys, "empirical_sum"].to_numpy(float)
    mapped["baseline_share"] = mapped["baseline"] / mapped["group_baseline"].clip(lower=1e-9)
    mapped["empirical_share"] = mapped[f"empirical_{scoring}"] / mapped["group_empirical"].clip(lower=1e-9)
    mapped["actual_share"] = mapped["actual"] / mapped["group_actual"].clip(lower=1e-9)
    for column in ("roster_rows",):
        mapped[column] = lookup.loc[keys, column].to_numpy(float)
    return aggregates, mapped


def fit_predictions(
    groups: pd.DataFrame,
    mapped: pd.DataFrame,
    test_season: int,
    alpha: float,
) -> tuple[dict[tuple[str, str], float], pd.Series]:
    budget = model(alpha)
    budget_train = groups[groups["season"] < test_season]
    budget_test = groups[groups["season"] == test_season].copy()
    budget.fit(budget_train[list(BUDGET_FEATURES)], budget_train["actual"])
    budget_values = np.maximum(0.0, budget.predict(budget_test[list(BUDGET_FEATURES)]))
    budgets = {
        (str(row.team), str(row.position)): float(value)
        for row, value in zip(budget_test.itertuples(), budget_values)
    }
    share = model(alpha)
    share_train = mapped[mapped["season"] < test_season]
    share_test = mapped[mapped["season"] == test_season]
    share.fit(share_train[list(SHARE_FEATURES)], share_train["actual_share"])
    shares = pd.Series(
        np.clip(share.predict(share_test[list(SHARE_FEATURES)]), 0.0, 1.0),
        index=share_test.index,
    )
    return budgets, shares


def allocate(
    players: pd.DataFrame,
    groups: pd.DataFrame,
    mapped: pd.DataFrame,
    season: int,
    position: str,
    alpha: float,
    budget_blend: float,
    share_blend: float,
) -> tuple[np.ndarray, pd.DataFrame]:
    season_rows = players[
        (players["season"] == season) & (players["position"] == position)
    ].copy()
    budgets, modeled_shares = fit_predictions(groups, mapped, season, alpha)
    output = season_rows["baseline"].to_numpy(float).copy()
    local_positions = {index: offset for offset, index in enumerate(season_rows.index)}
    eligible = mapped[(mapped["season"] == season) & (mapped["position"] == position)]
    for (_, team, _), indices in eligible.groupby(["season", "team", "position"]).groups.items():
        offsets = np.asarray([local_positions[index] for index in indices], dtype=int)
        base = season_rows.loc[indices, "baseline"].to_numpy(float)
        base_total = float(base.sum())
        if base_total <= 0:
            continue
        budget = budgets.get((str(team), position), base_total)
        ratio = float(np.clip(budget / base_total, *RATIO_LIMIT))
        total = base_total * (1.0 + budget_blend * (ratio - 1.0))
        base_share = base / base_total
        learned = modeled_shares.loc[indices].to_numpy(float)
        learned = learned / learned.sum() if learned.sum() > 0 else base_share
        shares = (1.0 - share_blend) * base_share + share_blend * learned
        shares /= shares.sum()
        output[offsets] = total * shares
    return output, season_rows


def choose(
    players: pd.DataFrame,
    groups: pd.DataFrame,
    mapped: pd.DataFrame,
    validation_season: int,
    position: str,
) -> dict[str, Any]:
    choices = []
    for alpha in RIDGE_ALPHAS:
        for budget_blend in BUDGET_BLENDS:
            for share_blend in SHARE_BLENDS:
                prediction, rows = allocate(
                    players, groups, mapped, validation_season, position,
                    alpha, budget_blend, share_blend,
                )
                metrics = _metrics(prediction, rows["actual"].to_numpy(float))
                choices.append({
                    "alpha": alpha, "budgetBlend": budget_blend,
                    "shareBlend": share_blend, "mae": metrics["mae"],
                    "rmse": metrics["rmse"],
                })
    return min(
        choices,
        key=lambda item: (
            item["mae"], item["rmse"],
            item["budgetBlend"] + item["shareBlend"],
        ),
    )


def locked_ids(players: pd.DataFrame, position: str) -> set[int]:
    selected: set[int] = set()
    rows = players[players["position"] == position]
    for _, fold in rows.groupby("season"):
        selected.update(
            int(value) for value in fold.nlargest(
                min(DRAFTABLE_LIMITS[position], len(fold)), f"empirical_PPR"
            ).index
        )
    return selected


def metric_pair(candidate: np.ndarray, base: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return {"candidate": _metrics(candidate, actual), "base": _metrics(base, actual)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("data/private/owned-model/raw"))
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260715)
    parser.add_argument("--out", type=Path, default=Path("data/research/owned-model-opportunity-allocator.json"))
    args = parser.parse_args()
    stats, _ = load_stats(args.data_dir)
    players, _ = load_players(args.data_dir / "players.csv")
    picks, _ = load_draft_picks(args.data_dir / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(args.data_dir, args.season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dataset, features = build_dataset(stats, players, roles)
    forecasts = attach_context(
        nested_forecasts(dataset, features, args.seed), dataset, roles, stats
    )
    fold_outputs: list[dict[str, Any]] = []
    aggregate_rows: dict[tuple[str, str], list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]] = {}
    selections = []
    strata_values: dict[tuple[str, str, str], list[tuple[np.ndarray, np.ndarray, np.ndarray]]] = {}
    for scoring in SCORINGS:
        groups, mapped = group_tables(forecasts, scoring)
        scoring_players = forecasts.copy()
        scoring_players["baseline"] = scoring_players[f"candidate_{scoring}"].where(
            scoring_players["season"] >= 2023, scoring_players[f"empirical_{scoring}"]
        )
        scoring_players["actual"] = scoring_players[f"actual_{scoring}"]
        for position in POSITIONS:
            locked = locked_ids(scoring_players, position)
            for season in EVALUATION_SEASONS:
                selected = choose(
                    scoring_players, groups, mapped, season - 1, position
                )
                prediction, rows = allocate(
                    scoring_players, groups, mapped, season, position,
                    selected["alpha"], selected["budgetBlend"], selected["shareBlend"],
                )
                base = rows["baseline"].to_numpy(float)
                actual = rows["actual"].to_numpy(float)
                lock_mask = np.asarray([int(index) in locked for index in rows.index])
                fold_outputs.append({
                    "season": season, "position": position, "scoring": scoring,
                    "rows": int(len(rows)), "mappedRows": int(rows["mapped"].sum()),
                    "selected": selected,
                    "full": metric_pair(prediction, base, actual),
                    "lockedDraftable": metric_pair(
                        prediction[lock_mask], base[lock_mask], actual[lock_mask]
                    ),
                })
                selections.append({
                    "season": season, "position": position, "scoring": scoring,
                    "selectionSeason": season - 1, **selected,
                })
                aggregate_rows.setdefault((position, scoring), []).append(
                    (prediction, base, actual, lock_mask)
                )
                strata = {
                    "starter": rows["depth_starter"].eq(1).to_numpy(),
                    "topThreeReserve": (
                        rows["depth_top_three"].eq(1) & rows["depth_starter"].ne(1)
                    ).to_numpy(),
                    "depthMissing": rows["depth_missing"].eq(1).to_numpy(),
                }
                for stratum, mask in strata.items():
                    strata_values.setdefault((position, scoring, stratum), []).append(
                        (prediction[mask], base[mask], actual[mask])
                    )
    aggregate: dict[str, Any] = {}
    reasons: list[str] = []
    for position in POSITIONS:
        aggregate[position] = {}
        for scoring in SCORINGS:
            pieces = aggregate_rows[(position, scoring)]
            candidate = np.concatenate([piece[0] for piece in pieces])
            base = np.concatenate([piece[1] for piece in pieces])
            actual = np.concatenate([piece[2] for piece in pieces])
            locked_candidate = np.concatenate([piece[0][piece[3]] for piece in pieces])
            locked_base = np.concatenate([piece[1][piece[3]] for piece in pieces])
            locked_actual = np.concatenate([piece[2][piece[3]] for piece in pieces])
            aggregate[position][scoring] = {
                "full": metric_pair(candidate, base, actual),
                "lockedDraftable": metric_pair(
                    locked_candidate, locked_base, locked_actual
                ),
                "depthStrata": {},
            }
            for stratum in ("starter", "topThreeReserve", "depthMissing"):
                values = strata_values[(position, scoring, stratum)]
                aggregate[position][scoring]["depthStrata"][stratum] = metric_pair(
                    np.concatenate([value[0] for value in values]),
                    np.concatenate([value[1] for value in values]),
                    np.concatenate([value[2] for value in values]),
                )
            for cohort in ("full", "lockedDraftable"):
                pair = aggregate[position][scoring][cohort]
                if pair["candidate"]["mae"] >= pair["base"]["mae"]:
                    reasons.append(f"{position} {scoring} {cohort} aggregate MAE did not improve")
                if pair["candidate"]["rmse"] > pair["base"]["rmse"]:
                    reasons.append(f"{position} {scoring} {cohort} aggregate RMSE regressed")
                if abs(pair["candidate"]["bias"]) > abs(pair["base"]["bias"]):
                    reasons.append(f"{position} {scoring} {cohort} aggregate absolute bias regressed")
                if pair["candidate"]["spearman"] < pair["base"]["spearman"]:
                    reasons.append(f"{position} {scoring} {cohort} aggregate rank regressed")
    for fold in fold_outputs:
        for cohort in ("full", "lockedDraftable"):
            pair = fold[cohort]
            prefix = f"{fold['season']} {fold['position']} {fold['scoring']} {cohort}"
            if pair["candidate"]["mae"] > pair["base"]["mae"]:
                reasons.append(f"{prefix} MAE regressed")
            if pair["candidate"]["rmse"] > pair["base"]["rmse"]:
                reasons.append(f"{prefix} RMSE regressed")
    report = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "baseModelVersion": MODEL_VERSION,
        "status": "research-only",
        "method": (
            "Nested post-model team/position budget and within-group opportunity "
            "share allocation. Ridge models use only prior outcomes; blend and "
            "regularization are selected on the immediately prior season. "
            "Team assignment and depth order come from preseason depth snapshots."
        ),
        "boundedGrid": {
            "ridgeAlphas": list(RIDGE_ALPHAS),
            "budgetBlends": list(BUDGET_BLENDS),
            "shareBlends": list(SHARE_BLENDS),
            "budgetRatioLimit": list(RATIO_LIMIT),
            "candidatesPerPositionScoringFold": (
                len(RIDGE_ALPHAS) * len(BUDGET_BLENDS) * len(SHARE_BLENDS)
            ),
        },
        "leakageControls": {
            "budgetFeatures": list(BUDGET_FEATURES),
            "shareFeatures": list(SHARE_FEATURES),
            "cohort": "Top position-specific limit by prior-only empirical PPR OOF forecast in each season.",
            "testSeasons": list(EVALUATION_SEASONS),
            "wrRookieBaseline": {
                "modelVersion": MODEL_VERSION,
                "fixedPolicy": WR_ROOKIE_SPECIALIST,
            },
            "depthInputs": [
                {"file": item["file"], "featureCutoff": item["featureCutoff"]}
                for item in depth_manifest
                if item["file"].startswith(("depth_charts_2022", "depth_charts_2023", "depth_charts_2024", "depth_charts_2025"))
            ],
            "historicalTimingCaveat": (
                "Historical week-1 depth files do not provide exact publication "
                "timestamps; this independently blocks promotion."
            ),
        },
        "coverage": {
            "forecastRows": int(len(forecasts)),
            "mappedRows": int(forecasts["mapped"].sum()),
        },
        "selections": selections,
        "aggregate": aggregate,
        "folds": fold_outputs,
        "acceptance": {
            "accepted": not reasons,
            "policy": (
                "Every position and scoring format must strictly improve full and "
                "locked aggregate MAE without aggregate RMSE, absolute bias, or "
                "rank regression; no material position-season full/locked MAE or "
                "RMSE may regress."
            ),
            "reasons": reasons,
            "productionAction": (
                "Report for review before any integration."
                if not reasons else "Reject; retain current owned model."
            ),
        },
    }
    report["researchStatus"] = "accepted-for-production-review" if not reasons else "rejected"
    report["productionChanged"] = False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(args.out),
        "baseModelVersion": MODEL_VERSION,
        "accepted": report["acceptance"]["accepted"],
        "reasonCount": len(reasons),
        "aggregate": aggregate,
    }, indent=2))


if __name__ == "__main__":
    main()
