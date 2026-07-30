"""Leakage-safe research for a ranked preseason DST forecast.

Candidate selection is frozen using 2018-2022 expanding-season folds.  The
2023-2025 seasons are an untouched audit window and are never used to select a
feature set, regularization value, or shrinkage amount.  This file is research
only: it does not alter the owned-model artifact or the live consensus.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from owned_model.pipeline import build_dataset, load_dst_stats, utc_now  # noqa: E402


BASELINE = 102.0
DEVELOPMENT_FOLDS = tuple(range(2018, 2023))
AUDIT_FOLDS = (2023, 2024, 2025)


def metrics(prediction: np.ndarray, actual: np.ndarray) -> dict[str, float | int | None]:
    error = prediction - actual
    correlation = (
        float(pd.Series(prediction).corr(pd.Series(actual), method="spearman"))
        if np.std(prediction) > 0 and np.std(actual) > 0
        else math.nan
    )
    return {
        "rows": int(len(actual)),
        "mae": round(float(np.mean(np.abs(error))), 6),
        "rmse": round(float(np.sqrt(np.mean(error ** 2))), 6),
        "bias": round(float(np.mean(error)), 6),
        "spearman": round(correlation, 6) if math.isfinite(correlation) else None,
    }


def feature_frame(raw: pd.DataFrame, games_path: Path) -> tuple[pd.DataFrame, dict[str, list[str]]]:
    """Build only data knowable before the target regular season."""
    raw = raw.copy()
    numeric = [
        "games", "fantasy_points", "def_sacks", "def_qb_hits", "def_interceptions",
        "fumble_recovery_opp", "def_fumbles_forced", "def_pass_defended",
        "def_tackles_for_loss", "def_tds", "fumble_recovery_tds",
        "special_teams_tds", "def_safeties",
    ]
    for column in numeric:
        raw[column] = pd.to_numeric(raw.get(column), errors="coerce")
    raw["team"] = raw["recent_team"].astype(str)
    raw["actual"] = raw["fantasy_points"]
    games = pd.read_csv(games_path, low_memory=False)
    games = games[games["game_type"].astype(str).eq("REG")].copy()

    # Team-season real points allowed and week-one coach identity.
    allowed: dict[tuple[int, str], list[float]] = {}
    opponents: dict[tuple[int, str], list[str]] = {}
    week_one_coach: dict[tuple[int, str], str] = {}
    for row in games.to_dict("records"):
        season = int(row["season"])
        home, away = str(row.get("home_team") or ""), str(row.get("away_team") or "")
        if not home or not away:
            continue
        opponents.setdefault((season, home), []).append(away)
        opponents.setdefault((season, away), []).append(home)
        try:
            home_score, away_score = float(row["home_score"]), float(row["away_score"])
        except (TypeError, ValueError):
            home_score = away_score = math.nan
        if math.isfinite(home_score) and math.isfinite(away_score):
            allowed.setdefault((season, home), []).append(away_score)
            allowed.setdefault((season, away), []).append(home_score)
        if int(row.get("week") or 0) == 1:
            week_one_coach[(season, home)] = str(row.get("home_coach") or "")
            week_one_coach[(season, away)] = str(row.get("away_coach") or "")

    lookup = {(int(row.season), str(row.team)): row for row in raw.itertuples(index=False)}
    rows: list[dict[str, float | int | str]] = []
    for season in sorted(raw["season"].astype(int).unique()):
        if season < 2014:
            continue
        teams = sorted(raw.loc[raw["season"].eq(season), "team"].unique())
        for team in teams:
            current = lookup[(season, team)]
            prior = lookup.get((season - 1, team))
            if prior is None:
                continue
            record: dict[str, float | int | str] = {
                "season": season, "team": team, "player_id": f"DST:{team}",
                "actual": float(current.actual),
            }
            for lag in (1, 2, 3):
                historical = lookup.get((season - lag, team))
                if historical is None:
                    continue
                gp = max(1.0, float(historical.games))
                for column in numeric[1:]:
                    record[f"{column}_lag{lag}_pg"] = float(getattr(historical, column)) / gp
                prior_allowed = allowed.get((season - lag, team), [])
                record[f"real_points_allowed_lag{lag}_pg"] = (
                    float(np.mean(prior_allowed)) if prior_allowed else math.nan
                )
            record["coach_continuity"] = float(
                bool(week_one_coach.get((season - 1, team)))
                and week_one_coach.get((season, team)) == week_one_coach.get((season - 1, team))
            )

            # Current schedule is public preseason information; every opponent
            # characteristic comes strictly from the prior completed season.
            schedule = opponents.get((season, team), [])
            schedule_values = {
                "opp_points_scored": [], "opp_sacks_suffered": [],
                "opp_turnovers": [], "opp_offense_epa": [],
            }
            for opponent in schedule:
                opponent_prior = lookup.get((season - 1, opponent))
                if opponent_prior is None:
                    continue
                gp = max(1.0, float(opponent_prior.games))
                opponent_scores = allowed.get((season - 1, opponent), [])
                # In the schedule file "allowed" for a team is the opposing
                # offense's score against it; use team-stat offense directly
                # where possible and game scores only for points scored.
                scored = []
                for game in games.loc[games["season"].eq(season - 1)].to_dict("records"):
                    if game.get("home_team") == opponent:
                        scored.append(game.get("home_score"))
                    elif game.get("away_team") == opponent:
                        scored.append(game.get("away_score"))
                scored = [float(value) for value in scored if pd.notna(value)]
                schedule_values["opp_points_scored"].append(float(np.mean(scored)) if scored else math.nan)
                schedule_values["opp_sacks_suffered"].append(float(getattr(opponent_prior, "sacks_suffered", 0)) / gp)
                schedule_values["opp_turnovers"].append(
                    (float(getattr(opponent_prior, "passing_interceptions", 0))
                     + float(getattr(opponent_prior, "fumbles_lost_total", 0))) / gp
                )
                schedule_values["opp_offense_epa"].append(
                    (float(getattr(opponent_prior, "passing_epa", 0))
                     + float(getattr(opponent_prior, "rushing_epa", 0))) / gp
                )
            for name, values in schedule_values.items():
                finite = [value for value in values if math.isfinite(value)]
                record[f"schedule_prior_{name}"] = float(np.mean(finite)) if finite else math.nan
            rows.append(record)
    frame = pd.DataFrame(rows)
    lag1 = [column for column in frame if column.endswith("_lag1_pg")]
    lag123 = [column for column in frame if "_lag" in column]
    schedule = [column for column in frame if column.startswith("schedule_prior_")]
    groups = {
        "prior_dst": ["fantasy_points_lag1_pg"],
        "prior_core": [
            "fantasy_points_lag1_pg", "def_sacks_lag1_pg", "def_qb_hits_lag1_pg",
            "def_interceptions_lag1_pg", "fumble_recovery_opp_lag1_pg",
            "real_points_allowed_lag1_pg",
        ],
        "prior_all": lag1,
        "multi_year_core": [
            column for column in lag123
            if any(token in column for token in (
                "fantasy_points", "def_sacks", "def_qb_hits", "def_interceptions",
                "fumble_recovery_opp", "real_points_allowed",
            ))
        ],
        "schedule": schedule,
        "prior_core_schedule": sorted(set([
            "fantasy_points_lag1_pg", "def_sacks_lag1_pg", "def_qb_hits_lag1_pg",
            "def_interceptions_lag1_pg", "fumble_recovery_opp_lag1_pg",
            "real_points_allowed_lag1_pg", *schedule,
        ])),
        "multi_year_schedule_coach": sorted(set([
            *lag123, *schedule, "coach_continuity",
        ])),
    }
    return frame, groups


def fold_predictions(
    frame: pd.DataFrame, features: list[str], alpha: float, blend: float, seasons: tuple[int, ...]
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    predictions: list[float] = []
    actuals: list[float] = []
    folds: list[dict] = []
    for season in seasons:
        train = frame[frame["season"].lt(season)]
        test = frame[frame["season"].eq(season)]
        model = make_pipeline(
            SimpleImputer(strategy="median", add_indicator=True),
            StandardScaler(),
            Ridge(alpha=alpha),
        )
        model.fit(train[features], train["actual"])
        raw = model.predict(test[features])
        # The production fallback already provides the level forecast.  DST
        # learning is allowed to contribute rank only, so its cross-sectional
        # residual is centered to zero without looking at target outcomes.
        signal = raw - float(np.mean(raw))
        prediction = BASELINE + blend * signal
        actual = test["actual"].to_numpy(float)
        candidate = metrics(prediction, actual)
        baseline = metrics(np.full(len(actual), BASELINE), actual)
        folds.append({"season": season, "candidate": candidate, "baseline": baseline})
        predictions.extend(prediction)
        actuals.extend(actual)
    return np.asarray(predictions), np.asarray(actuals), folds


def no_regression(folds: list[dict]) -> bool:
    return all(
        fold["candidate"]["mae"] <= fold["baseline"]["mae"]
        and fold["candidate"]["rmse"] <= fold["baseline"]["rmse"]
        for fold in folds
    )


def summarize_vector(frame: pd.DataFrame, prediction: np.ndarray, seasons: tuple[int, ...]) -> dict:
    audit_rows = frame[frame["season"].isin(seasons)]
    actual = audit_rows["actual"].to_numpy(float)
    folds = []
    cursor = 0
    for season in seasons:
        count = int(frame["season"].eq(season).sum())
        fold_actual = actual[cursor:cursor + count]
        fold_prediction = prediction[cursor:cursor + count]
        folds.append({
            "season": season,
            "candidate": metrics(fold_prediction, fold_actual),
            "baseline": metrics(np.full(count, BASELINE), fold_actual),
        })
        cursor += count
    return {
        "candidate": metrics(prediction, actual),
        "baseline": metrics(np.full(len(actual), BASELINE), actual),
        "folds": folds,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--output")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    raw, players, manifest = load_dst_stats(data_dir, data_dir / "games.csv")
    # Ensure target construction agrees exactly with the production pipeline.
    production, _ = build_dataset(raw, players, {})
    frame, groups = feature_frame(raw, data_dir / "games.csv")
    expected = production[production["position"].eq("DST")][["season", "player_id", "target_std_total"]]
    check = frame.merge(expected, on=["season", "player_id"], how="inner")
    if not np.allclose(check["actual"], check["target_std_total"]):
        raise RuntimeError("Research target diverges from production DST scoring.")

    candidates = []
    for group_name, features in groups.items():
        for alpha in (1.0, 3.0, 10.0, 30.0, 100.0, 300.0):
            for blend in (0.025, 0.05, 0.075, 0.10, 0.15, 0.20, 0.30):
                prediction, actual, folds = fold_predictions(
                    frame, features, alpha, blend, DEVELOPMENT_FOLDS
                )
                overall = metrics(prediction, actual)
                baseline = metrics(np.full(len(actual), BASELINE), actual)
                if no_regression(folds) and overall["mae"] < baseline["mae"]:
                    candidates.append({
                        "featureSet": group_name, "features": features, "alpha": alpha,
                        "blend": blend, "development": {"candidate": overall, "baseline": baseline, "folds": folds},
                    })
    if not candidates:
        result = {
            "schemaVersion": 1, "generatedAt": utc_now(), "status": "rejected",
            "reason": "No candidate improved every 2018-2022 development fold.",
        }
    else:
        # This choice is now frozen before the audit window is evaluated.
        def robust_margin(row: dict) -> float:
            """Worst proportional MAE/RMSE gain across development seasons."""
            margins = []
            for fold in row["development"]["folds"]:
                for metric in ("mae", "rmse"):
                    baseline_value = fold["baseline"][metric]
                    margins.append((baseline_value - fold["candidate"][metric]) / baseline_value)
            return min(margins)

        selected = max(
            candidates,
            key=lambda row: (
                robust_margin(row),
                -row["development"]["candidate"]["mae"],
                -row["development"]["candidate"]["rmse"],
                -len(row["features"]),
            ),
        )
        selected["selectionRule"] = "maximize the worst proportional MAE/RMSE improvement across all development folds"
        selected["worstDevelopmentMargin"] = round(robust_margin(selected), 8)
        prediction, actual, folds = fold_predictions(
            frame, selected["features"], selected["alpha"], selected["blend"], AUDIT_FOLDS
        )
        audit = {
            "candidate": metrics(prediction, actual),
            "baseline": metrics(np.full(len(actual), BASELINE), actual),
            "folds": folds,
        }
        # Equal-weighting every development-passing recipe is a second,
        # pre-audit robustness rule: no audit result controls membership.
        ensemble_members = []
        for member in candidates:
            member_prediction, _, _ = fold_predictions(
                frame, member["features"], member["alpha"], member["blend"], AUDIT_FOLDS
            )
            ensemble_members.append(member_prediction)
        ensemble_audit = summarize_vector(frame, np.mean(ensemble_members, axis=0), AUDIT_FOLDS)
        ensemble_accepted = (
            no_regression(ensemble_audit["folds"])
            and ensemble_audit["candidate"]["mae"] < ensemble_audit["baseline"]["mae"]
            and ensemble_audit["candidate"]["rmse"] <= ensemble_audit["baseline"]["rmse"]
        )
        accepted = (
            no_regression(folds)
            and audit["candidate"]["mae"] < audit["baseline"]["mae"]
            and audit["candidate"]["rmse"] <= audit["baseline"]["rmse"]
        )
        result = {
            "schemaVersion": 1, "generatedAt": utc_now(),
            "status": "accepted" if accepted or ensemble_accepted else "rejected",
            "method": "Feature/hyperparameter/blend selected only on expanding 2018-2022 folds; the learned cross-sectional residual is mean-centered and contributes rank only; 2023-2025 held untouched for final audit.",
            "baseline": BASELINE,
            "selected": selected,
            "audit": audit,
            "developmentPassingEnsemble": {
                "memberCount": len(ensemble_members),
                "accepted": ensemble_accepted,
                "audit": ensemble_audit,
            },
            "candidateCountPassingDevelopment": len(candidates),
            "inputFiles": [item["file"] for item in manifest],
        }
    rendered = json.dumps(result, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
