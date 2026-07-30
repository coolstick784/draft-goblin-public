"""Leakage-aware audit of offensive participant-only survivorship bias.

This is deliberately isolated from the production trainer.  It identifies
QB/RB/WR/TE players present on the historical depth cutoff but absent from the
corresponding completed-season player-stat release, restores a zero-fantasy
outcome, and compares two nested walk-forward learners on the *same* holdout
rows:

* incumbent: training and stack calibration omit the restored rows;
* candidate: training and stack calibration include earlier restored rows.

The depth source does not prove how many NFL games an omitted player was active
for.  Accordingly, this harness calls the synthetic label "stat-recorded games"
and never silently promotes it to the production model.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    LAG_STATS,
    TARGETS,
    _clip_prediction,
    _fit_predict,
    _metrics,
    _stack_weights,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_players,
    load_stats,
    utc_now,
)

OFFENSE = ("QB", "RB", "WR", "TE")
EVALUATION_SEASONS = (2023, 2024, 2025)
BASE_OOF_SEASONS = (2021, 2022, 2023, 2024, 2025)


def _identity_method(player_id: str) -> str:
    if player_id.startswith("00-"):
        return "gsis"
    if player_id.startswith("ESPN:"):
        return "espn"
    if player_id.startswith("NAME:"):
        return "namePosition"
    return "other"


def add_offense_zero_outcomes(
    stats: pd.DataFrame,
    players: pd.DataFrame,
    roles: dict[tuple[int, str], dict[str, Any]],
    through_season: int,
) -> tuple[pd.DataFrame, list[dict[str, Any]], set[tuple[int, str]]]:
    """Restore depth-listed offensive identities missing from season stats."""
    existing = set(
        zip(
            pd.to_numeric(stats["season"], errors="coerce").astype(int),
            stats["player_id"].astype(str),
        )
    )
    metadata = {
        str(row["player_id"]): row
        for row in players.to_dict("records")
        if str(row.get("player_id") or "")
    }
    first_target = int(pd.to_numeric(stats["season"], errors="coerce").min()) + 2
    additions: list[dict[str, Any]] = []
    audit: list[dict[str, Any]] = []
    keys: set[tuple[int, str]] = set()
    for (season, player_id), role in sorted(roles.items()):
        role_position = str(role.get("position") or "").upper()
        if (
            season < first_target
            or season > through_season
            or role_position not in OFFENSE
            or (season, str(player_id)) in existing
        ):
            continue
        meta = metadata.get(str(player_id))
        # Historical status in the current player catalog is not a valid
        # preseason feature.  Position and identity are static enough to use
        # only as a conservative identity check.
        meta_position = str((meta or {}).get("position") or "").upper()
        if meta is None or meta_position != role_position:
            continue
        row: dict[str, Any] = {
            "player_id": str(player_id),
            "player_display_name": str(role.get("name") or player_id),
            "position": role_position,
            "season": int(season),
            "games": 0.0,
            "fantasy_points": 0.0,
            "fantasy_points_ppr": 0.0,
            "recent_team": str(role.get("team") or ""),
        }
        row.update({column: 0.0 for column in LAG_STATS if column not in row})
        additions.append(row)
        keys.add((int(season), str(player_id)))
        audit.append(
            {
                "season": int(season),
                "playerId": str(player_id),
                "name": str(role.get("name") or player_id),
                "position": role_position,
                "team": str(role.get("team") or ""),
                "depthRank": float(role["rank"])
                if math.isfinite(float(role.get("rank", math.nan)))
                else None,
                "identityMethod": _identity_method(str(player_id)),
                "hadPriorStatsHistory": bool(
                    (
                        (stats["player_id"].astype(str) == str(player_id))
                        & (pd.to_numeric(stats["season"], errors="coerce") < season)
                    ).any()
                ),
            }
        )
    augmented = (
        pd.concat([stats, pd.DataFrame(additions)], ignore_index=True)
        if additions
        else stats.copy()
    )
    return augmented, audit, keys


def _strict_guard(
    candidate: dict[str, Any], incumbent: dict[str, Any], scope: str
) -> list[str]:
    reasons: list[str] = []
    if candidate["mae"] >= incumbent["mae"]:
        reasons.append(f"{scope} MAE did not strictly improve")
    if candidate["rmse"] > incumbent["rmse"]:
        reasons.append(f"{scope} RMSE regressed")
    if abs(candidate["bias"]) > abs(incumbent["bias"]):
        reasons.append(f"{scope} absolute bias regressed")
    candidate_rank, incumbent_rank = candidate["spearman"], incumbent["spearman"]
    if (
        candidate_rank is not None
        and incumbent_rank is not None
        and candidate_rank < incumbent_rank
    ):
        reasons.append(f"{scope} Spearman rank regressed")
    return reasons


def _nested_predictions(
    rows: pd.DataFrame,
    features: list[str],
    target: str,
    position: str,
    zero_mask: np.ndarray,
    seed: int,
) -> dict[str, pd.DataFrame]:
    """Score identical OOF rows with and without prior synthetic labels."""
    predictions: dict[str, list[np.ndarray]] = {"incumbent": [], "candidate": []}
    actual_parts: list[np.ndarray] = []
    seasons: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    zero_parts: list[np.ndarray] = []
    zero_by_index = pd.Series(zero_mask, index=rows.index)
    for fold_season in BASE_OOF_SEASONS:
        test = rows[rows["season"] == fold_season]
        candidate_train = rows[rows["season"] < fold_season]
        incumbent_train = candidate_train.loc[~zero_by_index.loc[candidate_train.index]]
        if len(test) < 8 or len(incumbent_train) < 80:
            continue
        for variant, train in (
            ("incumbent", incumbent_train),
            ("candidate", candidate_train),
        ):
            matrix, _ = _fit_predict(
                train, test, features, target, position, seed + fold_season
            )
            predictions[variant].append(matrix)
        actual_parts.append(test[f"target_{target}"].to_numpy(dtype=float))
        seasons.append(np.full(len(test), fold_season, dtype=int))
        indices.append(test.index.to_numpy())
        zero_parts.append(zero_by_index.loc[test.index].to_numpy(dtype=bool))

    actual = np.concatenate(actual_parts)
    labels = np.concatenate(seasons)
    row_indices = np.concatenate(indices)
    is_zero = np.concatenate(zero_parts)
    result: dict[str, pd.DataFrame] = {}
    for variant in ("incumbent", "candidate"):
        matrix = np.vstack(predictions[variant])
        blended = np.full(len(actual), np.nan)
        for fold_season in EVALUATION_SEASONS:
            test_mask = labels == fold_season
            prior_mask = labels < fold_season
            if variant == "incumbent":
                prior_mask &= ~is_zero
            if not test_mask.any() or not prior_mask.any():
                continue
            weights = _stack_weights(matrix[prior_mask], actual[prior_mask])
            offset = float(
                np.median(actual[prior_mask] - matrix[prior_mask] @ weights)
            )
            blended[test_mask] = _clip_prediction(
                target, matrix[test_mask] @ weights + offset
            )
        evaluation = np.isin(labels, EVALUATION_SEASONS)
        if np.isnan(blended[evaluation]).any():
            raise ValueError(
                f"Nested evaluation was incomplete for {position} {target} {variant}"
            )
        result[variant] = pd.DataFrame(
            {
                "season": labels[evaluation],
                "prediction": blended[evaluation],
                "actual": actual[evaluation],
                "syntheticZero": is_zero[evaluation],
            },
            index=row_indices[evaluation],
        )
    return result


def evaluate_position(
    dataset: pd.DataFrame,
    features: list[str],
    zero_keys: set[tuple[int, str]],
    position: str,
    seed: int,
) -> dict[str, Any]:
    rows = dataset[dataset["position"] == position].copy()
    zero_mask = np.array(
        [
            (int(row.season), str(row.player_id)) in zero_keys
            for row in rows[["season", "player_id"]].itertuples(index=False)
        ],
        dtype=bool,
    )
    by_target = {
        target: _nested_predictions(
            rows, features, target, position, zero_mask, seed + index * 1000
        )
        for index, target in enumerate(TARGETS)
    }
    truth = rows.loc[by_target["games"]["candidate"].index]
    target_zero = by_target["games"]["candidate"]["syntheticZero"].to_numpy(dtype=bool)
    output: dict[str, Any] = {
        "evaluationRows": int(len(truth)),
        "restoredZeroRows": int(target_zero.sum()),
        "formats": {},
    }
    all_reasons: list[str] = []
    for scoring_format, ppg_target, truth_column in (
        ("STD", "std_ppg", "target_std_total"),
        ("PPR", "ppr_ppg", "target_ppr_total"),
    ):
        predictions: dict[str, np.ndarray] = {}
        for variant in ("incumbent", "candidate"):
            predictions[variant] = (
                by_target["games"][variant]["prediction"].to_numpy(dtype=float)
                * by_target[ppg_target][variant]["prediction"].to_numpy(dtype=float)
            )
        actual = truth[truth_column].to_numpy(dtype=float)
        aggregate = {
            variant: _metrics(predictions[variant], actual)
            for variant in ("incumbent", "candidate")
        }
        reasons = _strict_guard(
            aggregate["candidate"], aggregate["incumbent"], f"{scoring_format} aggregate"
        )
        folds: dict[str, Any] = {}
        for season in EVALUATION_SEASONS:
            mask = (
                by_target["games"]["candidate"]["season"].to_numpy(dtype=int) == season
            )
            fold = {
                variant: _metrics(predictions[variant][mask], actual[mask])
                for variant in ("incumbent", "candidate")
            }
            reasons.extend(
                _strict_guard(
                    fold["candidate"],
                    fold["incumbent"],
                    f"{season} {scoring_format}",
                )
            )
            folds[str(season)] = fold
        incumbent_only = ~target_zero
        restored_only = target_zero
        output["formats"][scoring_format] = {
            "aggregate": aggregate,
            "folds": folds,
            "participantRowsOnly": {
                variant: _metrics(
                    predictions[variant][incumbent_only], actual[incumbent_only]
                )
                for variant in ("incumbent", "candidate")
            },
            "restoredRowsOnly": {
                variant: _metrics(
                    predictions[variant][restored_only], actual[restored_only]
                )
                for variant in ("incumbent", "candidate")
            },
        }
        all_reasons.extend(reasons)
    output["safetySelector"] = {
        "accepted": not all_reasons,
        "policy": (
            "On the identical depth-locked cohort, candidate MAE must strictly "
            "improve and RMSE, absolute bias, and Spearman rank must not regress "
            "in aggregate or in any 2023-2025 fold, for STD and PPR."
        ),
        "reasons": all_reasons,
    }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument(
        "--output", default="data/research/offense-zero-outcome-audit.json"
    )
    parser.add_argument("--seed", type=int, default=20260717)
    args = parser.parse_args()
    root = Path(args.data_dir)
    stats, _ = load_stats(root)
    players, _ = load_players(root / "players.csv")
    picks, _ = load_draft_picks(root / "draft_picks.csv")
    players, _ = enrich_players_with_draft_picks(players, picks)
    roles, depth_manifest = load_depth_charts(root, args.season)
    augmented, audit, zero_keys = add_offense_zero_outcomes(
        stats, players, roles, args.season - 1
    )
    dataset, features = build_dataset(augmented, players, roles)
    positions = {
        position: evaluate_position(dataset, features, zero_keys, position, args.seed)
        for position in OFFENSE
    }
    by_season = Counter(str(row["season"]) for row in audit)
    by_position = Counter(row["position"] for row in audit)
    result = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "researchOnly": True,
        "productionChanged": False,
        "method": (
            "Restore zero fantasy outcomes for identity-validated QB/RB/WR/TE "
            "players present at the selected depth cutoff and absent from the "
            "completed-season player-stat release. Compare incumbent and "
            "candidate training on identical holdout rows."
        ),
        "labelLimitation": (
            "Absence from player stats proves no recorded fantasy production, "
            "not zero NFL active games. The synthetic target_games=0 label is "
            "therefore an availability proxy requiring independent validation."
        ),
        "depthCutoffs": [
            {
                "file": row["file"],
                "featureCutoff": row["featureCutoff"],
                "sha256": row["sha256"],
            }
            for row in depth_manifest
            if any(str(season) in row["file"] for season in range(2014, args.season))
        ],
        "cohort": {
            "rows": len(audit),
            "bySeason": dict(sorted(by_season.items())),
            "byPosition": dict(sorted(by_position.items())),
            "byIdentityMethod": dict(
                sorted(Counter(row["identityMethod"] for row in audit).items())
            ),
            "withPriorStatsHistory": sum(row["hadPriorStatsHistory"] for row in audit),
            "withoutPriorStatsHistory": sum(
                not row["hadPriorStatsHistory"] for row in audit
            ),
            "rowsDetail": audit,
        },
        "positions": positions,
        "decision": {
            "acceptedPositions": [
                position
                for position, value in positions.items()
                if value["safetySelector"]["accepted"]
            ],
            "rejectedPositions": [
                position
                for position, value in positions.items()
                if not value["safetySelector"]["accepted"]
            ],
            "productionIntegration": False,
        },
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "cohort": {
                    key: value
                    for key, value in result["cohort"].items()
                    if key != "rowsDetail"
                },
                "decision": result["decision"],
                "PPR": {
                    position: value["formats"]["PPR"]["aggregate"]
                    for position, value in positions.items()
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
