"""Leakage-safe audit of nflverse combine features for rookie WR totals."""

from __future__ import annotations

import argparse
import importlib.util
import json
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    MODEL_VERSION,
    _metrics,
    add_kicker_zero_outcomes,
    build_dataset,
    enrich_players_with_draft_picks,
    load_depth_charts,
    load_draft_picks,
    load_dst_stats,
    load_players,
    load_stats,
    sha256_file,
    utc_now,
)

_SPEC = importlib.util.spec_from_file_location(
    "rookie_specialist_research",
    Path(__file__).with_name("research-rookie-specialist.py"),
)
assert _SPEC and _SPEC.loader
_ROOKIE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_ROOKIE)

TEST_SEASONS = (2023, 2024, 2025)
FEATURE_SETS = {
    "base": (),
    "size": ("combine_height_inches", "combine_weight"),
    "rawAthletic": (
        "combine_height_inches", "combine_weight", "combine_forty",
        "combine_bench", "combine_vertical", "combine_broad_jump",
        "combine_cone", "combine_shuttle",
    ),
    "derivedAthletic": (
        "combine_height_inches", "combine_weight", "combine_forty",
        "combine_bench", "combine_vertical", "combine_broad_jump",
        "combine_cone", "combine_shuttle", "combine_speed_score", "combine_bmi",
    ),
}


def height_inches(value: Any) -> float:
    text = str(value or "").strip()
    if "-" not in text:
        return np.nan
    feet, inches = text.split("-", 1)
    try:
        return float(feet) * 12.0 + float(inches)
    except ValueError:
        return np.nan


def load_combine(path: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    frame = pd.read_csv(path, low_memory=False)
    required = {
        "season", "draft_year", "pfr_id", "player_name", "pos", "ht", "wt",
        "forty", "bench", "vertical", "broad_jump", "cone", "shuttle",
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"combine.csv missing columns: {', '.join(missing)}")
    frame["season"] = pd.to_numeric(frame["season"], errors="coerce")
    frame["draft_year"] = pd.to_numeric(frame["draft_year"], errors="coerce")
    frame["pfr_id"] = frame["pfr_id"].fillna("").astype(str).str.strip()
    frame["pos"] = frame["pos"].fillna("").astype(str).str.upper()
    valid = frame["season"].between(2000, 2100) & (
        frame["draft_year"].isna() | frame["draft_year"].eq(frame["season"])
    )
    frame = frame.loc[valid].copy()
    frame["combine_height_inches"] = frame["ht"].map(height_inches)
    rename = {
        "wt": "combine_weight", "forty": "combine_forty",
        "bench": "combine_bench", "vertical": "combine_vertical",
        "broad_jump": "combine_broad_jump", "cone": "combine_cone",
        "shuttle": "combine_shuttle",
    }
    for source, target in rename.items():
        frame[target] = pd.to_numeric(frame[source], errors="coerce")
    frame["combine_speed_score"] = (
        frame["combine_weight"] * 200.0 / frame["combine_forty"].pow(4)
    )
    frame["combine_bmi"] = (
        frame["combine_weight"] * 703.0 / frame["combine_height_inches"].pow(2)
    )
    exact = frame[frame["pfr_id"].ne("")].copy()
    duplicate = exact.duplicated(["season", "pfr_id"], keep=False)
    exact = exact.loc[~duplicate]
    exact["combine_exact_pfr_match"] = 1.0
    return exact, {
        "file": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "license": "CC-BY-4.0",
        "source": "https://github.com/nflverse/nflverse-data/releases/tag/combine",
        "schema": "https://nflreadr.nflverse.com/articles/dictionary_combine.html",
        "temporalBoundary": "NFL combine measurements occur before the NFL draft and target rookie regular season; join additionally requires combine season == rookie_season.",
        "rows": int(len(frame)),
        "firstSeason": int(frame["season"].min()),
        "lastSeason": int(frame["season"].max()),
        "duplicateExactIdentitiesExcluded": int(duplicate.sum()),
    }


def metric(predicted: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    return _metrics(np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float))


def passes(candidate: dict[str, Any], baseline: dict[str, Any]) -> bool:
    return (
        candidate["mae"] <= baseline["mae"]
        and candidate["rmse"] <= baseline["rmse"]
        and abs(candidate["bias"]) <= abs(baseline["bias"])
        and candidate["spearman"] >= baseline["spearman"]
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.data_dir)
    stats, _ = load_stats(root)
    players, _ = load_players(Path(args.players))
    draft_picks, _ = load_draft_picks(Path(args.draft_picks))
    players, _ = enrich_players_with_draft_picks(players, draft_picks)
    combine, combine_manifest = load_combine(Path(args.combine))
    roles, _ = load_depth_charts(root, args.projection_season)
    stats, _ = add_kicker_zero_outcomes(stats, roles, args.projection_season - 1)
    dst_stats, dst_players, _ = load_dst_stats(root, root / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, base_features = build_dataset(stats, players, roles)

    player_keys = players[["player_id", "pfr_id", "rookie_season"]].copy()
    player_keys["pfr_id"] = player_keys["pfr_id"].fillna("").astype(str).str.strip()
    player_keys["rookie_season"] = pd.to_numeric(player_keys["rookie_season"], errors="coerce")
    combine_columns = sorted({column for values in FEATURE_SETS.values() for column in values})
    joined = player_keys.merge(
        combine[["season", "pfr_id", "combine_exact_pfr_match", *combine_columns]],
        left_on=["rookie_season", "pfr_id"],
        right_on=["season", "pfr_id"],
        how="left",
        validate="many_to_one",
    ).drop_duplicates("player_id")
    enriched = dataset.merge(
        joined[["player_id", "combine_exact_pfr_match", *combine_columns]], on="player_id", how="left", validate="many_to_one"
    )
    wr = enriched[(enriched["position"] == "WR") & (enriched["rookie"] == 1.0)].copy()
    position_rows = enriched[enriched["position"] == "WR"].copy()
    seed = int(args.seed)
    base_by_season = _ROOKIE.base_forecasts(
        position_rows, base_features, "WR", (2022, *TEST_SEASONS), seed
    )

    coverage = {
        str(season): {
            "rows": int(len(rows)),
            "exactPfrMatches": int(rows["combine_exact_pfr_match"].notna().sum()),
            "forty": int(rows["combine_forty"].notna().sum()),
            "vertical": int(rows["combine_vertical"].notna().sum()),
            "broadJump": int(rows["combine_broad_jump"].notna().sum()),
            "cone": int(rows["combine_cone"].notna().sum()),
            "shuttle": int(rows["combine_shuttle"].notna().sum()),
        }
        for season, rows in wr.groupby("season")
    }

    selected: dict[str, Any] = {}
    for scoring in ("std", "ppr"):
        train = wr[wr["season"] < 2022]
        validation = wr[wr["season"] == 2022]
        actual = validation[f"target_{scoring}_total"].to_numpy(dtype=float)
        base_total = base_by_season[2022].loc[validation.index, f"base_{scoring}"].to_numpy()
        blend = 0.50 if scoring == "std" else 0.75
        choices: list[tuple[float, str, dict[str, Any]]] = []
        for name, extra in FEATURE_SETS.items():
            features = [*base_features, *extra]
            specialist = _ROOKIE.predict_specialist(
                train, validation, features, f"target_{scoring}_total",
                ("boosted", 10.0), seed + 2022,
            )
            final = base_total * (1.0 - blend) + specialist * blend
            result = metric(final, actual)
            choices.append((result["mae"], name, result))
        choices.sort(key=lambda value: (value[0], len(FEATURE_SETS[value[1]])))
        selected[scoring.upper()] = {
            "featureSet": choices[0][1],
            "selectionSeason": 2022,
            "validationRows": int(len(validation)),
            "validationMetrics": choices[0][2],
            "alternatives": {
                name: result for _, name, result in choices
            },
        }

    folds: list[dict[str, Any]] = []
    outputs: list[pd.DataFrame] = []
    for season in TEST_SEASONS:
        train = wr[wr["season"] < season]
        test = wr[wr["season"] == season]
        output = pd.DataFrame(index=test.index)
        output["season"] = season
        for scoring in ("std", "ppr"):
            blend = 0.50 if scoring == "std" else 0.75
            base_total = base_by_season[season].loc[test.index, f"base_{scoring}"].to_numpy()
            baseline_specialist = _ROOKIE.predict_specialist(
                train, test, base_features, f"target_{scoring}_total",
                ("boosted", 10.0), seed + season,
            )
            candidate_features = [
                *base_features, *FEATURE_SETS[selected[scoring.upper()]["featureSet"]]
            ]
            candidate_specialist = _ROOKIE.predict_specialist(
                train, test, candidate_features, f"target_{scoring}_total",
                ("boosted", 10.0), seed + season,
            )
            output[f"baseline_{scoring}"] = base_total * (1.0 - blend) + baseline_specialist * blend
            output[f"candidate_{scoring}"] = base_total * (1.0 - blend) + candidate_specialist * blend
            output[f"actual_{scoring}"] = test[f"target_{scoring}_total"].to_numpy(dtype=float)
        fold: dict[str, Any] = {"season": season, "position": "WR", "rows": int(len(test))}
        for scoring in ("std", "ppr"):
            fold[scoring.upper()] = {
                "baselineV2026_12": metric(output[f"baseline_{scoring}"], output[f"actual_{scoring}"]),
                "combineCandidate": metric(output[f"candidate_{scoring}"], output[f"actual_{scoring}"]),
            }
        folds.append(fold)
        outputs.append(output)

    combined = pd.concat(outputs)
    aggregate: dict[str, Any] = {}
    reasons: list[str] = []
    for scoring in ("std", "ppr"):
        baseline = metric(combined[f"baseline_{scoring}"], combined[f"actual_{scoring}"])
        candidate = metric(combined[f"candidate_{scoring}"], combined[f"actual_{scoring}"])
        aggregate[scoring.upper()] = {
            "baselineV2026_12": baseline, "combineCandidate": candidate
        }
        if candidate["mae"] >= baseline["mae"]:
            reasons.append(f"{scoring.upper()} aggregate MAE did not strictly improve")
        if not passes(candidate, baseline):
            reasons.append(f"{scoring.upper()} aggregate full guard failed")
    for fold in folds:
        for scoring in ("STD", "PPR"):
            if not passes(fold[scoring]["combineCandidate"], fold[scoring]["baselineV2026_12"]):
                reasons.append(f"{fold['season']} {scoring} fold guard failed")
    accepted = not reasons
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "baseModelVersion": MODEL_VERSION,
        "researchStatus": "accepted-for-production-review" if accepted else "rejected",
        "dataProvenance": combine_manifest,
        "identityPolicy": "Exact PFR ID plus combine season == player rookie_season. No name-only joins.",
        "coverage": coverage,
        "selection": selected,
        "aggregate": aggregate,
        "folds": folds,
        "acceptanceRule": "Both formats must strictly improve aggregate MAE without aggregate RMSE, absolute-bias, or rank regression, and every 2023-2025 format fold must avoid regression in all four metrics.",
        "accepted": accepted,
        "rejectionReasons": reasons,
        "productionChanged": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--combine", default="data/private/owned-model/raw/combine.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260715)
    parser.add_argument("--output", default="data/research/owned-model-rookie-combine.json")
    args = parser.parse_args()
    report = run(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output), "status": report["researchStatus"],
        "coverage2023to2025": {season: report["coverage"][str(season)] for season in TEST_SEASONS},
        "selection": report["selection"], "aggregate": report["aggregate"],
        "rejectionReasons": report["rejectionReasons"],
    }, indent=2))


if __name__ == "__main__":
    main()
