from __future__ import annotations

import hashlib
import json
import math
import os
import re
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

MODEL_VERSION = "draft-goblin-owned-2026.12"
CORE_POSITIONS = ("QB", "RB", "WR", "TE", "K", "DST")
TARGETS = ("games", "std_ppg", "ppr_ppg")
LAG_STATS = (
    "games", "fantasy_points", "fantasy_points_ppr", "attempts", "passing_yards",
    "passing_tds", "passing_interceptions", "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds", "target_share",
    "air_yards_share", "wopr", "passing_epa", "rushing_epa", "receiving_epa",
    "fg_made", "fg_att", "fg_missed", "pat_made", "pat_att",
    "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49",
    "fg_made_50_59", "fg_made_60_",
    "def_sacks", "def_interceptions", "fumble_recovery_opp", "def_tds",
    "fumble_recovery_tds", "def_safeties", "special_teams_tds", "points_allowed_fantasy",
)
POSITION_PRIORS = {
    "QB": {"games": 12.0, "std_ppg": 15.0, "ppr_ppg": 15.0},
    "RB": {"games": 11.0, "std_ppg": 6.0, "ppr_ppg": 8.0},
    "WR": {"games": 11.0, "std_ppg": 5.0, "ppr_ppg": 7.0},
    "TE": {"games": 11.0, "std_ppg": 4.0, "ppr_ppg": 6.0},
    "K": {"games": 12.0, "std_ppg": 7.0, "ppr_ppg": 7.0},
    "DST": {"games": 17.0, "std_ppg": 6.0, "ppr_ppg": 6.0},
}
DRAFTABLE_LIMITS = {"QB": 36, "RB": 72, "WR": 96, "TE": 36, "K": 32, "DST": 32}
WR_ROOKIE_SPECIALIST = {
    "family": "hist-gradient-boosting-direct-total",
    "minSamplesLeaf": 10,
    "stdBlend": 0.50,
    "pprBlend": 0.75,
    "selectionSeason": 2022,
    "evidenceStatus": "development-only-adaptive-subgroup",
}
WR_ROOKIE_SPECIALIST_EVIDENCE = {
    "evaluationSeasons": [2023, 2024, 2025],
    "aggregate": {
        "STD": {
            "base": {"mae": 26.0675, "rmse": 39.7943, "bias": -16.2625, "spearman": 0.6208},
            "final": {"mae": 24.2130, "rmse": 36.8717, "bias": -12.2002, "spearman": 0.6384},
        },
        "PPR": {
            "base": {"mae": 38.7967, "rmse": 58.7553, "bias": -22.2702, "spearman": 0.6232},
            "final": {"mae": 35.4274, "rmse": 53.7712, "bias": -14.2645, "spearman": 0.6471},
        },
    },
    "folds": {
        "2023": {
            "STD": {"base": {"mae": 30.4626, "rmse": 47.7629, "bias": -23.8753, "spearman": 0.6700}, "final": {"mae": 29.7636, "rmse": 46.5761, "bias": -22.1081, "spearman": 0.7268}},
            "PPR": {"base": {"mae": 45.0955, "rmse": 70.2392, "bias": -33.3200, "spearman": 0.6938}, "final": {"mae": 43.9758, "rmse": 67.8135, "bias": -30.9316, "spearman": 0.7684}},
        },
        "2024": {
            "STD": {"base": {"mae": 30.3406, "rmse": 42.5618, "bias": -14.7495, "spearman": 0.5303}, "final": {"mae": 27.2322, "rmse": 37.3903, "bias": -7.8862, "spearman": 0.5552}},
            "PPR": {"base": {"mae": 47.1110, "rmse": 64.7228, "bias": -21.1656, "spearman": 0.4854}, "final": {"mae": 40.3068, "rmse": 55.1789, "bias": -7.5832, "spearman": 0.5149}},
        },
        "2025": {
            "STD": {"base": {"mae": 18.3050, "rmse": 27.3744, "bias": -10.6950, "spearman": 0.6472}, "final": {"mae": 16.5107, "rmse": 24.3106, "bias": -7.0265, "spearman": 0.6981}},
            "PPR": {"base": {"mae": 25.7363, "rmse": 38.1764, "bias": -13.2245, "spearman": 0.6819}, "final": {"mae": 23.3622, "rmse": 34.7464, "bias": -5.0522, "spearman": 0.6970}},
        },
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


_CANONICAL_GSIS = re.compile(r"^00-\d{7}$")


def _normalized_name(value: Any) -> str:
    return "".join(character for character in str(value or "").lower() if character.isalnum())


def _espn_identity(value: Any) -> str:
    number = _number(value, np.nan)
    return str(int(number)) if math.isfinite(number) and number > 0 else ""


def _stable_player_identity(gsis_id: Any, espn_id: Any, name: Any, position: Any) -> tuple[str, str]:
    """Return an owned internal key without mislabeling provisional IDs as GSIS IDs."""
    nflverse_id = str(gsis_id or "").strip()
    if _CANONICAL_GSIS.fullmatch(nflverse_id):
        return nflverse_id, "gsis"
    espn = _espn_identity(espn_id)
    if espn:
        return f"ESPN:{espn}", "espn"
    normalized = _normalized_name(name)
    normalized_position = str(position or "").upper()
    if normalized and normalized_position:
        return f"NAME:{normalized}:{normalized_position}", "namePosition"
    return "", "unresolved"


def load_stats(data_dir: Path) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    files = sorted(data_dir.glob("stats_player_reg_*.csv"))
    if len(files) < 5:
        raise ValueError("Owned model requires at least five seasons of nflverse player stats.")
    frames: list[pd.DataFrame] = []
    manifest: list[dict[str, Any]] = []
    for path in files:
        frame = pd.read_csv(path, low_memory=False)
        required = {"player_id", "player_display_name", "position", "season", "games", "fantasy_points", "fantasy_points_ppr"}
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"{path.name} is missing required columns: {', '.join(missing)}")
        frames.append(frame)
        manifest.append({
            "file": path.name,
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            "license": "CC-BY-4.0",
            "source": "https://github.com/nflverse/nflverse-data/releases/tag/stats_player",
        })
    stats = pd.concat(frames, ignore_index=True)
    stats["player_id"] = stats["player_id"].astype(str).str.strip()
    stats["position"] = stats["position"].astype(str).str.upper()
    stats = stats[stats["position"].isin(CORE_POSITIONS)].copy()
    stats["season"] = pd.to_numeric(stats["season"], errors="raise").astype(int)
    for column in LAG_STATS:
        if column not in stats:
            stats[column] = np.nan
        stats[column] = pd.to_numeric(stats[column], errors="coerce")
    stats = stats.sort_values(["season", "player_id"]).drop_duplicates(["season", "player_id"], keep="last")
    return stats, manifest


def load_players(path: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    players = pd.read_csv(path, low_memory=False)
    required = {"gsis_id", "display_name", "position", "birth_date", "rookie_season", "draft_round", "draft_pick"}
    missing = sorted(required - set(players.columns))
    if missing:
        raise ValueError(f"players.csv is missing required columns: {', '.join(missing)}")
    players["gsis_id"] = players["gsis_id"].fillna("").astype(str).str.strip()
    players["position"] = players["position"].astype(str).str.upper()
    players["birth_date"] = pd.to_datetime(players["birth_date"], errors="coerce")
    for column in ("rookie_season", "draft_round", "draft_pick", "espn_id", "last_season"):
        if column in players:
            players[column] = pd.to_numeric(players[column], errors="coerce")
    identities = players.apply(
        lambda row: _stable_player_identity(row.get("gsis_id"), row.get("espn_id"), row.get("display_name"), row.get("position")),
        axis=1,
    )
    players["player_id"] = [value[0] for value in identities]
    players["identity_method"] = [value[1] for value in identities]
    players["canonical_gsis_id"] = players["gsis_id"].where(players["gsis_id"].str.fullmatch(_CANONICAL_GSIS.pattern), "")
    # A normalized-name fallback is admitted only when it identifies one player
    # within a position. ESPN and canonical GSIS identities remain authoritative.
    ambiguous_names = players["player_id"].str.startswith("NAME:") & players.duplicated("player_id", keep=False)
    unresolved = players["player_id"].eq("") | ambiguous_names
    identity_counts = players.loc[~unresolved, "identity_method"].value_counts().to_dict()
    players = players.loc[~unresolved].drop_duplicates("player_id", keep="last").copy()
    return players, {
        "file": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "license": "CC-BY-4.0",
        "source": "https://github.com/nflverse/nflverse-data/releases/tag/players",
        "identityCoverage": {**{key: int(identity_counts.get(key, 0)) for key in ("gsis", "espn", "namePosition")}, "unresolvedOrAmbiguous": int(unresolved.sum())},
    }


def load_draft_picks(path: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load nflverse draft capital, which is public before the rookie season starts."""
    picks = pd.read_csv(path, low_memory=False)
    required = {"season", "round", "pick", "gsis_id", "pfr_player_id", "pfr_player_name", "position"}
    missing = sorted(required - set(picks.columns))
    if missing:
        raise ValueError(f"draft_picks.csv is missing required columns: {', '.join(missing)}")
    for column in ("season", "round", "pick", "espn_id"):
        if column in picks:
            picks[column] = pd.to_numeric(picks[column], errors="coerce")
    picks["gsis_id"] = picks["gsis_id"].fillna("").astype(str).str.strip()
    picks["pfr_player_id"] = picks["pfr_player_id"].fillna("").astype(str).str.strip()
    picks["position"] = picks["position"].fillna("").astype(str).str.upper()
    picks["normalized_name"] = picks["pfr_player_name"].map(_normalized_name)
    valid = (
        picks["season"].notna() & picks["round"].between(1, 7)
        & picks["pick"].between(1, 300) & picks["normalized_name"].ne("")
    )
    picks = picks.loc[valid].copy()
    picks[["season", "round", "pick"]] = picks[["season", "round", "pick"]].astype(int)
    if picks.duplicated(["season", "pick"], keep=False).any():
        raise ValueError("draft_picks.csv contains duplicate season/pick identities.")
    return picks, {
        "file": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "license": "CC-BY-4.0",
        "source": "https://github.com/nflverse/nflverse-data/releases/tag/draft_picks",
        "featureCutoff": "NFL draft result; known before the drafted player's rookie regular season",
        "seasonCoverage": {"first": int(picks["season"].min()), "last": int(picks["season"].max())},
    }


def enrich_players_with_draft_picks(players: pd.DataFrame, picks: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Fill absent player draft fields using conservative, season-bounded identities.

    The draft season must equal the player's rookie season. Exact nflverse GSIS,
    PFR, or ESPN IDs win. Name/position is admitted only when it is unique on
    both sides within that season. Existing player metadata is never overwritten.
    """
    enriched = players.copy()
    for column in ("draft_round", "draft_pick", "draft_year"):
        if column not in enriched:
            enriched[column] = np.nan
    match_counts = {"gsis": 0, "pfr": 0, "espn": 0, "uniqueNamePosition": 0}
    conflicts = 0
    new_pick_values = 0
    candidates: dict[int, tuple[pd.Series, str]] = {}

    def unique_index(frame: pd.DataFrame, keys: list[str]) -> dict[tuple[Any, ...], int]:
        present = frame.dropna(subset=keys).copy()
        for key in keys:
            present = present[present[key].astype(str).str.strip().ne("")]
        unique = present.loc[~present.duplicated(keys, keep=False)]
        return {tuple(row[key] for key in keys): int(index) for index, row in unique.iterrows()}

    player_year = pd.to_numeric(enriched.get("rookie_season"), errors="coerce")
    enriched["_draft_year_key"] = player_year
    enriched["_draft_name_key"] = enriched.get("display_name", "").map(_normalized_name)
    picks_local = picks.copy()
    indexes: list[tuple[str, list[str], list[str]]] = [
        ("gsis", ["season", "gsis_id"], ["_draft_year_key", "gsis_id"]),
    ]
    if "pfr_id" in enriched:
        indexes.append(("pfr", ["season", "pfr_player_id"], ["_draft_year_key", "pfr_id"]))
    if "espn_id" in picks_local and "espn_id" in enriched:
        indexes.append(("espn", ["season", "espn_id"], ["_draft_year_key", "espn_id"]))
    indexes.append(("uniqueNamePosition", ["season", "normalized_name", "position"], ["_draft_year_key", "_draft_name_key", "position"]))
    for method, draft_keys, player_keys in indexes:
        draft_index = unique_index(picks_local, draft_keys)
        player_index = unique_index(enriched, player_keys)
        for key, player_row_index in player_index.items():
            if player_row_index in candidates or key not in draft_index:
                continue
            candidates[player_row_index] = (picks_local.loc[draft_index[key]], method)

    for player_index_value, (pick, method) in candidates.items():
        existing_round = _number(enriched.at[player_index_value, "draft_round"], np.nan)
        existing_pick = _number(enriched.at[player_index_value, "draft_pick"], np.nan)
        if (math.isfinite(existing_round) and existing_round != float(pick["round"])) or (math.isfinite(existing_pick) and existing_pick != float(pick["pick"])):
            conflicts += 1
            continue
        if not math.isfinite(existing_round):
            enriched.at[player_index_value, "draft_round"] = int(pick["round"])
        if not math.isfinite(existing_pick):
            enriched.at[player_index_value, "draft_pick"] = int(pick["pick"])
            new_pick_values += 1
        if not math.isfinite(_number(enriched.at[player_index_value, "draft_year"], np.nan)):
            enriched.at[player_index_value, "draft_year"] = int(pick["season"])
        match_counts[method] += 1
    enriched = enriched.drop(columns=["_draft_year_key", "_draft_name_key"])
    core_rookies = enriched[enriched["position"].isin(CORE_POSITIONS) & enriched["rookie_season"].notna()]
    latest_draft = int(picks["season"].max())
    latest_core = core_rookies[pd.to_numeric(core_rookies["rookie_season"], errors="coerce") == latest_draft]
    return enriched, {
        "matchCoverage": match_counts,
        "matchedPlayers": int(sum(match_counts.values())),
        "newDraftPicksFilled": int(new_pick_values),
        "conflictsPreserved": int(conflicts),
        "corePlayersWithDraftPick": int(core_rookies["draft_pick"].notna().sum()),
        "latestDraftSeason": latest_draft,
        "latestCoreRookiesWithDraftPick": int(latest_core["draft_pick"].notna().sum()),
        "temporalJoin": "draft season equals rookie_season",
    }


def _points_allowed_score(points: float) -> float:
    if points <= 0:
        return 5.0
    if points <= 6:
        return 4.0
    if points <= 13:
        return 3.0
    if points <= 17:
        return 1.0
    if points <= 27:
        return 0.0
    if points <= 34:
        return -1.0
    if points <= 45:
        return -3.0
    return -5.0


def _kicker_points(row: Any) -> float:
    """ESPN default kicker points: distance tiers, PATs, and missed-FG penalty."""
    get = row.get if hasattr(row, "get") else lambda key, default=0.0: getattr(row, key, default)
    return (
        3.0 * sum(_number(get(column)) for column in ("fg_made_0_19", "fg_made_20_29", "fg_made_30_39"))
        + 4.0 * _number(get("fg_made_40_49"))
        + 5.0 * _number(get("fg_made_50_59"))
        + 6.0 * _number(get("fg_made_60_"))
        + _number(get("pat_made"))
        - _number(get("fg_missed"))
    )


def load_dst_stats(data_dir: Path, schedules_path: Path) -> tuple[pd.DataFrame, pd.DataFrame, list[dict[str, Any]]]:
    files = sorted(data_dir.glob("stats_team_reg_*.csv"))
    if len(files) < 5:
        raise ValueError("DST model requires at least five seasons of nflverse team stats.")
    schedules = pd.read_csv(schedules_path, low_memory=False)
    schedules = schedules[schedules["game_type"].astype(str).eq("REG")].copy()
    allowed: dict[tuple[int, str], float] = {}
    for game in schedules.to_dict("records"):
        season = int(_number(game.get("season")))
        home, away = str(game.get("home_team") or ""), str(game.get("away_team") or "")
        home_score, away_score = _number(game.get("home_score"), np.nan), _number(game.get("away_score"), np.nan)
        if home and away and math.isfinite(home_score) and math.isfinite(away_score):
            allowed[(season, home)] = allowed.get((season, home), 0.0) + _points_allowed_score(away_score)
            allowed[(season, away)] = allowed.get((season, away), 0.0) + _points_allowed_score(home_score)
    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    latest_season = 0
    latest_teams: set[str] = set()
    for path in files:
        frame = pd.read_csv(path, low_memory=False)
        season = int(path.stem.rsplit("_", 1)[-1])
        latest_season = max(latest_season, season)
        required = {"team", "games", "def_sacks", "def_interceptions", "fumble_recovery_opp", "def_tds", "fumble_recovery_tds", "def_safeties", "special_teams_tds"}
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"{path.name} is missing DST columns: {', '.join(missing)}")
        for value in frame.to_dict("records"):
            team = str(value.get("team") or "")
            if season == latest_season:
                latest_teams.add(team)
            fantasy = (
                _number(value.get("def_sacks"))
                + 2.0 * _number(value.get("def_interceptions"))
                + 2.0 * _number(value.get("fumble_recovery_opp"))
                + 6.0 * (_number(value.get("def_tds")) + _number(value.get("fumble_recovery_tds")) + _number(value.get("special_teams_tds")))
                + 2.0 * _number(value.get("def_safeties"))
                + allowed.get((season, team), 0.0)
            )
            rows.append({
                **value,
                "player_id": f"DST:{team}", "player_name": f"{team} DST", "player_display_name": f"{team} DST",
                "position": "DST", "position_group": "DST", "recent_team": team,
                "fantasy_points": fantasy, "fantasy_points_ppr": fantasy,
                "points_allowed_fantasy": allowed.get((season, team), 0.0),
            })
        manifest.append({"file": path.name, "sha256": sha256_file(path), "bytes": path.stat().st_size, "license": "CC-BY-4.0", "source": "https://github.com/nflverse/nflverse-data/releases/tag/stats_team"})
    manifest.append({"file": schedules_path.name, "sha256": sha256_file(schedules_path), "bytes": schedules_path.stat().st_size, "license": "CC-BY-4.0", "source": "https://github.com/nflverse/nflverse-data/releases/tag/schedules"})
    latest_teams = set(pd.DataFrame(rows).query("season == @latest_season")["recent_team"].astype(str))
    pseudo_players = pd.DataFrame([{
        "gsis_id": f"DST:{team}", "display_name": f"{team} DST", "position": "DST", "birth_date": pd.NaT,
        "rookie_season": np.nan, "draft_round": np.nan, "draft_pick": np.nan, "espn_id": np.nan,
        "last_season": latest_season, "latest_team": team, "status": "ACT",
    } for team in sorted(latest_teams)])
    dst = pd.DataFrame(rows)
    dst["season"] = pd.to_numeric(dst["season"], errors="raise").astype(int)
    for column in LAG_STATS:
        if column not in dst:
            dst[column] = np.nan
        dst[column] = pd.to_numeric(dst[column], errors="coerce")
    return dst, pseudo_players, manifest


def _player_metadata(players: pd.DataFrame) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in players.to_dict("records"):
        value = row.get("player_id")
        player_id = str(value).strip() if value is not None and pd.notna(value) else ""
        if not player_id:
            source_id = str(row.get("gsis_id") or "").strip()
            if str(row.get("position") or "").upper() == "DST" and source_id.startswith("DST:"):
                player_id = source_id
            else:
                player_id = _stable_player_identity(source_id, row.get("espn_id"), row.get("display_name"), row.get("position"))[0]
        if player_id:
            result[player_id] = row
    return result


def _lag_value(history: dict[int, dict[str, Any]], season: int, lag: int, stat: str) -> float:
    row = history.get(season - lag)
    if not row:
        return np.nan
    value = _number(row.get(stat), np.nan)
    if stat != "games" and stat not in ("target_share", "air_yards_share", "wopr"):
        games = max(1.0, _number(row.get("games"), 0.0))
        value /= games
    return value


def load_depth_charts(data_dir: Path, projection_season: int) -> tuple[dict[tuple[int, str], dict[str, Any]], list[dict[str, Any]]]:
    files = sorted([*data_dir.glob("depth_charts_*.csv"), *data_dir.glob("depth_charts_*.csv.gz")])
    roles: dict[tuple[int, str], dict[str, Any]] = {}
    manifest: list[dict[str, Any]] = []
    first_regular_dates: dict[int, pd.Timestamp] = {}
    schedules_path = data_dir / "games.csv"
    if schedules_path.exists():
        schedules = pd.read_csv(schedules_path, usecols=["season", "game_type", "gameday"], low_memory=False)
        schedules = schedules[schedules["game_type"].astype(str).eq("REG")].copy()
        schedules["gameday"] = pd.to_datetime(schedules["gameday"], errors="coerce", utc=True)
        first_regular_dates = {
            int(season): value
            for season, value in schedules.groupby("season")["gameday"].min().items()
            if pd.notna(value)
        }
    for path in files:
        frame = pd.read_csv(path, low_memory=False)
        season = int(path.name.split("_")[-1].split(".")[0])
        if {"gsis_id", "week", "depth_team", "club_code"}.issubset(frame.columns):
            frame = frame[pd.to_numeric(frame["week"], errors="coerce") == pd.to_numeric(frame["week"], errors="coerce").min()].copy()
            frame["rank"] = pd.to_numeric(frame["depth_team"], errors="coerce")
            frame["team_at_cutoff"] = frame["club_code"]
            frame["position_at_cutoff"] = frame.get("position", "")
            if "full_name" in frame:
                frame["name_at_cutoff"] = frame["full_name"]
            elif {"first_name", "last_name"}.issubset(frame.columns):
                frame["name_at_cutoff"] = frame["first_name"].fillna("").astype(str) + " " + frame["last_name"].fillna("").astype(str)
            else:
                frame["name_at_cutoff"] = ""
            cutoff = "week-1-depth-chart; exact publication timestamp unavailable"
        elif {"gsis_id", "dt", "pos_rank", "team"}.issubset(frame.columns):
            frame["dt"] = pd.to_datetime(frame["dt"], errors="coerce", utc=True)
            if season == projection_season:
                cutoff_time = frame["dt"].max()
            else:
                first_regular = first_regular_dates.get(season)
                eligible = frame.loc[frame["dt"] < first_regular, "dt"] if first_regular is not None else pd.Series(dtype="datetime64[ns, UTC]")
                if eligible.empty:
                    raise ValueError(f"{path.name} has no depth snapshot before the first regular-season date.")
                cutoff_time = eligible.max()
            frame = frame[frame["dt"] == cutoff_time].copy()
            frame["rank"] = pd.to_numeric(frame["pos_rank"], errors="coerce")
            frame["team_at_cutoff"] = frame["team"]
            frame["position_at_cutoff"] = frame.get("pos_abb", "")
            frame["name_at_cutoff"] = frame.get("player_name", "")
            cutoff = f"{cutoff_time.isoformat()}; strictly before first regular-season date" if season != projection_season else cutoff_time.isoformat()
        else:
            raise ValueError(f"Unsupported nflverse depth-chart schema: {path.name}")
        frame["gsis_id"] = frame["gsis_id"].fillna("").astype(str).str.strip()
        if "espn_id" not in frame:
            frame["espn_id"] = np.nan
        identities = frame.apply(
            lambda row: _stable_player_identity(row.get("gsis_id"), row.get("espn_id"), row.get("name_at_cutoff"), row.get("position_at_cutoff")),
            axis=1,
        )
        frame["player_identity"] = [value[0] for value in identities]
        # Name-only identities spanning multiple clubs at the same cutoff are
        # ambiguous and are intentionally not joined.
        name_rows = frame["player_identity"].str.startswith("NAME:")
        ambiguous_names = set(
            frame.loc[name_rows].groupby("player_identity")["team_at_cutoff"].nunique().loc[lambda values: values > 1].index
        )
        for player_id, rows in frame.groupby("player_identity"):
            if not player_id or player_id in ambiguous_names:
                continue
            best = rows.sort_values("rank").iloc[0]
            roles[(season, str(player_id))] = {
                "rank": _number(best.get("rank"), np.nan),
                "team": str(best.get("team_at_cutoff") or ""),
                "position": str(best.get("position_at_cutoff") or "").upper(),
                "name": str(best.get("name_at_cutoff") or player_id),
            }
        identity_methods = pd.Series([value[1] for value in identities]).value_counts().to_dict()
        manifest.append({"file": path.name, "sha256": sha256_file(path), "bytes": path.stat().st_size, "license": "CC-BY-4.0", "source": "https://github.com/nflverse/nflverse-data/releases/tag/depth_charts", "featureCutoff": cutoff, "identityCoverage": {key: int(identity_methods.get(key, 0)) for key in ("gsis", "espn", "namePosition", "unresolved")}})
    return roles, manifest


def add_kicker_zero_outcomes(
    stats: pd.DataFrame, roles: dict[tuple[int, str], dict[str, Any]], through_season: int
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Restore depth-listed kicker seasons omitted from participant-only stats."""
    existing = set(zip(
        pd.to_numeric(stats["season"], errors="coerce").astype(int),
        stats["player_id"].astype(str),
    ))
    first_target_season = int(pd.to_numeric(stats["season"], errors="coerce").min()) + 2
    additions: list[dict[str, Any]] = []
    by_season: dict[str, int] = {}
    for (season, player_id), role in sorted(roles.items()):
        position = str(role.get("position") or "").upper()
        if season < first_target_season or season > through_season or position not in {"K", "PK"}:
            continue
        if (season, str(player_id)) in existing:
            continue
        row: dict[str, Any] = {
            "player_id": str(player_id),
            "player_display_name": str(role.get("name") or player_id),
            "position": "K", "season": int(season), "games": 0,
            "fantasy_points": 0.0, "fantasy_points_ppr": 0.0,
            "recent_team": str(role.get("team") or ""),
        }
        row.update({column: 0.0 for column in LAG_STATS if column not in row})
        additions.append(row)
        by_season[str(season)] = by_season.get(str(season), 0) + 1
    augmented = pd.concat([stats, pd.DataFrame(additions)], ignore_index=True) if additions else stats.copy()
    return augmented, {
        "method": "K/PK listed on the leakage-safe preseason depth snapshot but absent from completed-season player stats receives a zero-games, zero-points outcome.",
        "throughSeason": int(through_season), "addedRows": len(additions), "bySeason": by_season,
    }


def _team_contexts(histories: dict[str, dict[int, dict[str, Any]]], roles: dict[tuple[int, str], dict[str, Any]], season: int) -> dict[tuple[str, str], dict[str, float]]:
    totals: dict[str, dict[str, float]] = {}
    returning: dict[str, dict[str, float]] = {}
    competition: dict[tuple[str, str], float] = {}
    for history in histories.values():
        row = history.get(season - 1)
        if not row:
            continue
        # Offensive team context should not be inflated by the separately
        # reconstructed kicker or team-defense fantasy totals.
        if str(row.get("position") or "").upper() in {"K", "DST"}:
            continue
        team = str(row.get("recent_team") or "")
        if not team:
            continue
        record = totals.setdefault(team, {"games": 0.0, "attempts": 0.0, "carries": 0.0, "targets": 0.0, "ppr": 0.0})
        record["games"] = max(record["games"], _number(row.get("games")))
        for key, column in (("attempts", "attempts"), ("carries", "carries"), ("targets", "targets"), ("ppr", "fantasy_points_ppr")):
            record[key] += _number(row.get(column))
    for (role_season, player_id), role in roles.items():
        if role_season != season:
            continue
        team, position = str(role.get("team") or ""), str(role.get("position") or "")
        if not team:
            continue
        if _number(role.get("rank"), 99) <= 3 and position in CORE_POSITIONS:
            competition[(team, position)] = competition.get((team, position), 0.0) + 1.0
        row = histories.get(player_id, {}).get(season - 1)
        if not row:
            continue
        if str(row.get("position") or "").upper() in {"K", "DST"}:
            continue
        record = returning.setdefault(team, {"carries": 0.0, "targets": 0.0, "ppr": 0.0})
        record["carries"] += _number(row.get("carries"))
        record["targets"] += _number(row.get("targets"))
        record["ppr"] += _number(row.get("fantasy_points_ppr"))
    contexts: dict[tuple[str, str], dict[str, float]] = {}
    for team, total in totals.items():
        games = max(1.0, total["games"])
        returned = returning.get(team, {})
        for position in CORE_POSITIONS:
            contexts[(team, position)] = {
                "team_attempts_pg": total["attempts"] / games,
                "team_carries_pg": total["carries"] / games,
                "team_targets_pg": total["targets"] / games,
                "team_ppr_pg": total["ppr"] / games,
                "returning_carry_share": _number(returned.get("carries")) / max(1.0, total["carries"]),
                "returning_target_share": _number(returned.get("targets")) / max(1.0, total["targets"]),
                "returning_ppr_share": _number(returned.get("ppr")) / max(1.0, total["ppr"]),
                "position_competition": competition.get((team, position), 0.0),
            }
    return contexts


def _features_for(history: dict[int, dict[str, Any]], meta: dict[str, Any], season: int, position: str, role: dict[str, Any] | None = None, team_context: dict[str, float] | None = None) -> dict[str, float]:
    result: dict[str, float] = {}
    for stat in LAG_STATS:
        values = []
        for lag in (1, 2, 3):
            value = _lag_value(history, season, lag, stat)
            result[f"{stat}_lag{lag}"] = value
            values.append(value)
        present = [(value, weight) for value, weight in zip(values, (0.60, 0.27, 0.13)) if math.isfinite(value)]
        result[f"{stat}_ewma"] = sum(value * weight for value, weight in present) / sum(weight for _, weight in present) if present else np.nan
        result[f"{stat}_trend"] = values[0] - values[1] if all(math.isfinite(value) for value in values[:2]) else 0.0
    birth = meta.get("birth_date")
    result["age"] = float(season - birth.year) if pd.notna(birth) else np.nan
    rookie_season = _number(meta.get("rookie_season"), np.nan)
    result["experience"] = max(0.0, season - rookie_season) if math.isfinite(rookie_season) else np.nan
    result["rookie"] = 1.0 if math.isfinite(rookie_season) and season <= rookie_season else 0.0
    result["draft_round"] = _number(meta.get("draft_round"), 9.0)
    result["draft_pick"] = _number(meta.get("draft_pick"), 300.0)
    result["draft_capital"] = 1.0 / math.sqrt(max(1.0, result["draft_pick"]))
    depth_rank = _number((role or {}).get("rank"), np.nan)
    result["depth_rank"] = depth_rank
    result["depth_starter"] = 1.0 if math.isfinite(depth_rank) and depth_rank <= 1 else 0.0
    result["depth_top_three"] = 1.0 if math.isfinite(depth_rank) and depth_rank <= 3 else 0.0
    result["depth_missing"] = 0.0 if math.isfinite(depth_rank) else 1.0
    previous_team = str(history.get(season - 1, {}).get("recent_team") or "")
    role_team = str((role or {}).get("team") or "")
    result["team_changed"] = 1.0 if previous_team and role_team and previous_team != role_team else 0.0
    for key in ("team_attempts_pg", "team_carries_pg", "team_targets_pg", "team_ppr_pg", "returning_carry_share", "returning_target_share", "returning_ppr_share", "position_competition"):
        result[key] = _number((team_context or {}).get(key), np.nan)
    for candidate in CORE_POSITIONS:
        result[f"position_{candidate}"] = 1.0 if position == candidate else 0.0
    return result


def build_dataset(stats: pd.DataFrame, players: pd.DataFrame, roles: dict[tuple[int, str], dict[str, Any]] | None = None) -> tuple[pd.DataFrame, list[str]]:
    metadata = _player_metadata(players)
    histories: dict[str, dict[int, dict[str, Any]]] = {}
    for row in stats.to_dict("records"):
        histories.setdefault(str(row["player_id"]), {})[int(row["season"])] = row
    contexts_by_season = {season: _team_contexts(histories, roles or {}, season) for season in sorted(int(value) for value in stats["season"].unique())}
    examples: list[dict[str, Any]] = []
    for player_id, history in histories.items():
        meta = metadata.get(player_id, {})
        for season, target in sorted(history.items()):
            if season <= min(stats["season"]) + 1:
                continue
            position = str(target["position"])
            games = max(1.0, _number(target.get("games"), 1.0))
            role = (roles or {}).get((season, player_id))
            role_team = str((role or {}).get("team") or "")
            features = _features_for(history, meta, season, position, role, contexts_by_season.get(season, {}).get((role_team, position)))
            if position == "K":
                std_total = _kicker_points(target)
                ppr_total = std_total
            else:
                std_total = _number(target.get("fantasy_points"))
                ppr_total = _number(target.get("fantasy_points_ppr"))
            examples.append({
                "player_id": player_id,
                "name": target.get("player_display_name") or target.get("player_name") or player_id,
                "position": position,
                "season": season,
                "feature_cutoff_season": season - 1,
                **features,
                "target_games": _number(target.get("games")),
                "target_std_ppg": std_total / games,
                "target_ppr_ppg": ppr_total / games,
                "target_std_total": std_total,
                "target_ppr_total": ppr_total,
            })
    dataset = pd.DataFrame(examples)
    if dataset.empty:
        raise ValueError("No player-season training examples were produced.")
    if not (dataset["feature_cutoff_season"] < dataset["season"]).all():
        raise ValueError("Temporal leakage detected: feature cutoff is not before target season.")
    feature_columns = sorted(column for column in dataset.columns if column not in {
        "player_id", "name", "position", "season", "feature_cutoff_season",
        "target_games", "target_std_ppg", "target_ppr_ppg", "target_std_total", "target_ppr_total",
    })
    return dataset, feature_columns


def _empirical_predict(rows: pd.DataFrame, target: str, position: str) -> np.ndarray:
    prior = POSITION_PRIORS[position][target]
    if target == "games":
        columns = ["games_lag1", "games_lag2", "games_lag3"]
        values = rows[columns].to_numpy(dtype=float)
    elif position == "K":
        values = (
            3.0 * sum(rows[[f"{column}_lag1", f"{column}_lag2", f"{column}_lag3"]].to_numpy(dtype=float) for column in ("fg_made_0_19", "fg_made_20_29", "fg_made_30_39"))
            + 4.0 * rows[["fg_made_40_49_lag1", "fg_made_40_49_lag2", "fg_made_40_49_lag3"]].to_numpy(dtype=float)
            + 5.0 * rows[["fg_made_50_59_lag1", "fg_made_50_59_lag2", "fg_made_50_59_lag3"]].to_numpy(dtype=float)
            + 6.0 * rows[["fg_made_60__lag1", "fg_made_60__lag2", "fg_made_60__lag3"]].to_numpy(dtype=float)
            + rows[["pat_made_lag1", "pat_made_lag2", "pat_made_lag3"]].to_numpy(dtype=float)
            - rows[["fg_missed_lag1", "fg_missed_lag2", "fg_missed_lag3"]].to_numpy(dtype=float)
        )
    elif target == "std_ppg":
        columns = ["fantasy_points_lag1", "fantasy_points_lag2", "fantasy_points_lag3"]
        values = rows[columns].to_numpy(dtype=float)
    else:
        columns = ["fantasy_points_ppr_lag1", "fantasy_points_ppr_lag2", "fantasy_points_ppr_lag3"]
        values = rows[columns].to_numpy(dtype=float)
    weights = np.array([0.60, 0.27, 0.13])
    valid = np.isfinite(values)
    weighted = np.where(valid, values * weights, 0.0).sum(axis=1)
    denominator = np.where(valid, weights, 0.0).sum(axis=1)
    estimate = np.divide(weighted, denominator, out=np.full(len(rows), prior), where=denominator > 0)
    experience = rows["experience"].to_numpy(dtype=float)
    confidence = np.clip(np.nan_to_num(experience, nan=0.0) / 3.0, 0.0, 1.0)
    return estimate * confidence + prior * (1.0 - confidence)


def _models(seed: int) -> dict[str, Any]:
    return {
        "ridge": make_pipeline(SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True), StandardScaler(), Ridge(alpha=18.0)),
        "boosted": make_pipeline(SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True), HistGradientBoostingRegressor(
            loss="absolute_error", learning_rate=0.06, max_iter=80, max_leaf_nodes=15,
            min_samples_leaf=18, l2_regularization=3.0, random_state=seed,
        )),
    }


def _wr_rookie_total_model(seed: int) -> Any:
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        HistGradientBoostingRegressor(
            loss="absolute_error", learning_rate=0.05, max_iter=120,
            max_leaf_nodes=15, min_samples_leaf=WR_ROOKIE_SPECIALIST["minSamplesLeaf"],
            l2_regularization=5.0, random_state=seed,
        ),
    )


def _blend_wr_rookie_total(base: np.ndarray, specialist: np.ndarray, scoring_format: str) -> np.ndarray:
    blend = WR_ROOKIE_SPECIALIST["pprBlend" if scoring_format.upper() == "PPR" else "stdBlend"]
    return np.maximum(0.0, np.asarray(base, dtype=float) * (1.0 - blend) + np.asarray(specialist, dtype=float) * blend)


def _clip_prediction(target: str, values: np.ndarray) -> np.ndarray:
    if target == "games":
        return np.clip(values, 0.0, 17.0)
    return np.clip(values, -2.0, 35.0)


def _fit_predict(train: pd.DataFrame, test: pd.DataFrame, features: list[str], target: str, position: str, seed: int) -> tuple[np.ndarray, dict[str, Any]]:
    predictions = [_empirical_predict(test, target, position)]
    fitted: dict[str, Any] = {}
    y = train[f"target_{target}"].to_numpy(dtype=float)
    for name, model in _models(seed).items():
        model.fit(train[features], y)
        fitted[name] = model
        predictions.append(model.predict(test[features]))
    return np.column_stack([_clip_prediction(target, prediction) for prediction in predictions]), fitted


def _stack_weights(predictions: np.ndarray, actual: np.ndarray) -> np.ndarray:
    best = np.array([1.0, 0.0, 0.0])
    best_loss = math.inf
    for a in range(21):
        for b in range(21 - a):
            weights = np.array([a, b, 20 - a - b], dtype=float) / 20.0
            loss = np.mean(np.abs(predictions @ weights - actual))
            regularized = loss + 0.015 * np.sum((weights - 1 / 3) ** 2)
            if regularized < best_loss:
                best_loss, best = regularized, weights
    return best


def _metrics(projected: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    errors = projected - actual
    if not len(errors):
        return {"rows": 0, "mae": math.nan, "rmse": math.nan, "bias": math.nan, "spearman": math.nan}
    if np.std(projected) == 0 or np.std(actual) == 0:
        rank_correlation = math.nan
    else:
        rank_correlation = float(pd.Series(projected).corr(pd.Series(actual), method="spearman"))
    return {
        "rows": int(len(errors)),
        "mae": round(float(np.mean(np.abs(errors))), 4),
        "rmse": round(float(np.sqrt(np.mean(errors ** 2))), 4),
        "bias": round(float(np.mean(errors)), 4),
        "spearman": round(rank_correlation, 4) if math.isfinite(rank_correlation) else None,
    }


def _dst_safety_acceptance(season_totals: dict[str, Any], fold_metrics: dict[str, Any]) -> tuple[bool, list[str]]:
    """Require a DST learner to win overall without hiding a bad temporal fold."""
    reasons: list[str] = []
    for scoring_format in ("STD", "PPR"):
        aggregate = season_totals[scoring_format]
        if aggregate["candidate"]["mae"] >= aggregate["empiricalBaseline"]["mae"]:
            reasons.append(f"{scoring_format} aggregate MAE did not improve")
        if aggregate["candidate"]["rmse"] > aggregate["empiricalBaseline"]["rmse"]:
            reasons.append(f"{scoring_format} aggregate RMSE regressed")
        for season, result in fold_metrics.items():
            candidate = result[scoring_format]["candidate"]
            baseline = result[scoring_format]["empiricalBaseline"]
            if candidate["mae"] > baseline["mae"]:
                reasons.append(f"{season} {scoring_format} MAE regressed")
            if candidate["rmse"] > baseline["rmse"]:
                reasons.append(f"{season} {scoring_format} RMSE regressed")
    return not reasons, reasons


@dataclass
class TrainedOwnedModel:
    feature_columns: list[str]
    positions: dict[str, Any]
    residuals: dict[str, list[float]]
    training_cutoff: int
    input_manifest: list[dict[str, Any]]


def train_owned_model(dataset: pd.DataFrame, feature_columns: list[str], input_manifest: list[dict[str, Any]], seed: int = 20260715) -> tuple[TrainedOwnedModel, dict[str, Any]]:
    seasons = sorted(int(value) for value in dataset["season"].unique())
    evaluation_seasons = seasons[-3:]
    base_oof_seasons = seasons[-5:]
    report: dict[str, Any] = {"schemaVersion": 1, "modelVersion": MODEL_VERSION, "generatedAt": utc_now(), "method": "Nested expanding-season walk-forward. Base models forecast five unseen seasons; each 2023-2025 evaluation fold learns stack weights and bias calibration only from earlier out-of-fold seasons. Final production weights use all completed out-of-fold seasons.", "folds": [], "positions": {}}
    trained_positions: dict[str, Any] = {}
    residuals: dict[str, list[float]] = {}
    for position in CORE_POSITIONS:
        position_rows = dataset[dataset["position"] == position].copy()
        position_result: dict[str, Any] = {"targets": {}}
        trained_positions[position] = {}
        oof_by_target: dict[str, pd.DataFrame] = {}
        for target in TARGETS:
            oof_predictions: list[np.ndarray] = []
            oof_actual: list[np.ndarray] = []
            oof_seasons: list[np.ndarray] = []
            oof_indices: list[np.ndarray] = []
            for fold_season in base_oof_seasons:
                train = position_rows[position_rows["season"] < fold_season]
                test = position_rows[position_rows["season"] == fold_season]
                if len(train) < 80 or len(test) < 8:
                    continue
                predictions, _ = _fit_predict(train, test, feature_columns, target, position, seed + fold_season)
                oof_predictions.append(predictions)
                oof_actual.append(test[f"target_{target}"].to_numpy(dtype=float))
                oof_seasons.append(np.full(len(test), fold_season))
                oof_indices.append(test.index.to_numpy())
            if not oof_predictions:
                raise ValueError(f"Insufficient temporal folds for {position} {target}.")
            stacked_predictions = np.vstack(oof_predictions)
            actual = np.concatenate(oof_actual)
            fold_labels = np.concatenate(oof_seasons)
            weights = _stack_weights(stacked_predictions, actual)
            final_offset = float(np.median(actual - stacked_predictions @ weights))
            all_indices = np.concatenate(oof_indices)
            evaluation_mask = np.isin(fold_labels, evaluation_seasons)
            blended_all = np.full(len(actual), np.nan)
            evaluation_weights: dict[str, Any] = {}
            for fold_season in evaluation_seasons:
                fold_mask = fold_labels == fold_season
                prior_mask = fold_labels < fold_season
                if not fold_mask.any() or not prior_mask.any():
                    continue
                fold_weights = _stack_weights(stacked_predictions[prior_mask], actual[prior_mask])
                fold_offset = float(np.median(actual[prior_mask] - stacked_predictions[prior_mask] @ fold_weights))
                blended_all[fold_mask] = _clip_prediction(target, stacked_predictions[fold_mask] @ fold_weights + fold_offset)
                evaluation_weights[str(fold_season)] = {"weights": fold_weights.tolist(), "calibrationOffset": round(fold_offset, 4), "trainedOnOofSeasons": sorted(set(int(value) for value in fold_labels[prior_mask]))}
            if np.isnan(blended_all[evaluation_mask]).any():
                raise ValueError(f"Nested stack could not score every evaluation fold for {position} {target}.")
            blended = blended_all[evaluation_mask]
            evaluation_actual = actual[evaluation_mask]
            evaluation_indices = all_indices[evaluation_mask]
            evaluation_labels = fold_labels[evaluation_mask]
            evaluation_empirical = stacked_predictions[evaluation_mask, 0]
            final_models = _models(seed)
            y = position_rows[f"target_{target}"].to_numpy(dtype=float)
            for model in final_models.values():
                model.fit(position_rows[feature_columns], y)
            trained_positions[position][target] = {"models": final_models, "weights": weights.tolist(), "calibrationOffset": final_offset}
            residual_key = f"{position}:{target}"
            residuals[residual_key] = (evaluation_actual - blended).tolist()
            oof_by_target[target] = pd.DataFrame({
                "row_index": evaluation_indices,
                "season": evaluation_labels,
                "candidate": blended,
                "empirical": evaluation_empirical,
            }).set_index("row_index")
            position_result["targets"][target] = {
                "weights": {"empirical": round(float(weights[0]), 4), "ridge": round(float(weights[1]), 4), "boosted": round(float(weights[2]), 4)},
                "calibrationOffset": round(final_offset, 4),
                "nestedEvaluationWeights": evaluation_weights,
                "oof": _metrics(blended, evaluation_actual),
                "empiricalBaseline": _metrics(evaluation_empirical, evaluation_actual),
                "foldSeasons": evaluation_seasons,
            }
        if position == "WR":
            rookie_rows = position_rows[position_rows["rookie"] == 1.0]
            specialist_models: dict[str, Any] = {}
            for scoring_format, target_column in (("STD", "target_std_total"), ("PPR", "target_ppr_total")):
                specialist = _wr_rookie_total_model(seed)
                specialist.fit(rookie_rows[feature_columns], rookie_rows[target_column].to_numpy(dtype=float))
                specialist_models[scoring_format] = specialist
            trained_positions[position]["rookieTotalSpecialist"] = {
                "models": specialist_models,
                "stdBlend": WR_ROOKIE_SPECIALIST["stdBlend"],
                "pprBlend": WR_ROOKIE_SPECIALIST["pprBlend"],
            }
            position_result["rookieTotalSpecialist"] = {
                **WR_ROOKIE_SPECIALIST,
                "trainingRows": int(len(rookie_rows)),
                "trainingSeasons": sorted(int(value) for value in rookie_rows["season"].unique()),
                "evidenceReport": "data/research/owned-model-rookie-specialist.json",
                "policy": "Configuration and fixed blends were selected on 2022 only; every 2023-2025 WR development holdout improved MAE, RMSE, absolute bias, and rank in STD and PPR.",
                "adaptiveResearchCaveat": "The WR subgroup was prioritized after reviewing the broader rookie audit, so 2023-2025 are development evidence rather than untouched confirmatory evidence. Independent confirmation requires the prospectively frozen 2026 season.",
                "developmentEvidence": WR_ROOKIE_SPECIALIST_EVIDENCE,
                "uncertaintyPolicy": "Mean totals use the specialist blend. Quantile width retains the full held-out WR residual distribution rather than narrowing to the participant-only rookie cohort.",
            }
        joined = oof_by_target["games"].join(
            oof_by_target["std_ppg"][["candidate", "empirical"]], rsuffix="_std"
        ).join(oof_by_target["ppr_ppg"][["candidate", "empirical"]], rsuffix="_ppr")
        truth = position_rows.loc[joined.index]
        candidate_std = joined["candidate"].to_numpy() * joined["candidate_std"].to_numpy()
        candidate_ppr = joined["candidate"].to_numpy() * joined["candidate_ppr"].to_numpy()
        empirical_std = joined["empirical"].to_numpy() * joined["empirical_std"].to_numpy()
        empirical_ppr = joined["empirical"].to_numpy() * joined["empirical_ppr"].to_numpy()
        actual_std = truth["target_std_total"].to_numpy(dtype=float)
        actual_ppr = truth["target_ppr_total"].to_numpy(dtype=float)
        position_result["seasonTotals"] = {
            "STD": {"candidate": _metrics(candidate_std, actual_std), "empiricalBaseline": _metrics(empirical_std, actual_std)},
            "PPR": {"candidate": _metrics(candidate_ppr, actual_ppr), "empiricalBaseline": _metrics(empirical_ppr, actual_ppr)},
        }
        if position == "WR":
            position_result["seasonTotalsScope"] = "Base v2026.11 all-WR stack only; these tables intentionally exclude the v2026.12 WR-rookie direct-total specialist. Canonical base-vs-final rookie metrics are embedded under rookieTotalSpecialist.developmentEvidence."
        fold_metrics: dict[str, Any] = {}
        for fold_season in sorted(int(value) for value in joined["season"].unique()):
            mask = joined["season"].to_numpy(dtype=int) == fold_season
            fold_metrics[str(fold_season)] = {
                "STD": {"candidate": _metrics(candidate_std[mask], actual_std[mask]), "empiricalBaseline": _metrics(empirical_std[mask], actual_std[mask])},
                "PPR": {"candidate": _metrics(candidate_ppr[mask], actual_ppr[mask]), "empiricalBaseline": _metrics(empirical_ppr[mask], actual_ppr[mask])},
            }
        position_result["seasonTotalFolds"] = fold_metrics
        if position == "DST":
            accepted, safety_reasons = _dst_safety_acceptance(position_result["seasonTotals"], fold_metrics)
            position_result["safetySelector"] = {
                "acceptedLearnedResidual": accepted,
                "policy": "Learned DST residual must lower aggregate MAE, avoid aggregate RMSE regression, and avoid MAE or RMSE regression in every temporal holdout season.",
                "reasons": safety_reasons,
            }
            if not accepted:
                position_result["learnedCandidateBeforeSafetyFallback"] = {
                    "seasonTotals": position_result["seasonTotals"],
                    "seasonTotalFolds": position_result["seasonTotalFolds"],
                }
                candidate_std = empirical_std.copy()
                candidate_ppr = empirical_ppr.copy()
                position_result["seasonTotals"] = {
                    "STD": {"candidate": _metrics(candidate_std, actual_std), "empiricalBaseline": _metrics(empirical_std, actual_std)},
                    "PPR": {"candidate": _metrics(candidate_ppr, actual_ppr), "empiricalBaseline": _metrics(empirical_ppr, actual_ppr)},
                }
                fallback_folds: dict[str, Any] = {}
                for fold_season in sorted(int(value) for value in joined["season"].unique()):
                    mask = joined["season"].to_numpy(dtype=int) == fold_season
                    fallback_folds[str(fold_season)] = {
                        "STD": {"candidate": _metrics(candidate_std[mask], actual_std[mask]), "empiricalBaseline": _metrics(empirical_std[mask], actual_std[mask])},
                        "PPR": {"candidate": _metrics(candidate_ppr[mask], actual_ppr[mask]), "empiricalBaseline": _metrics(empirical_ppr[mask], actual_ppr[mask])},
                    }
                position_result["seasonTotalFolds"] = fallback_folds
                for target in TARGETS:
                    target_result = position_result["targets"][target]
                    target_result["learnedCandidateBeforeSafetyFallback"] = {
                        "weights": target_result["weights"],
                        "calibrationOffset": target_result["calibrationOffset"],
                        "oof": target_result["oof"],
                    }
                    target_result["weights"] = {"empirical": 1.0, "ridge": 0.0, "boosted": 0.0}
                    target_result["calibrationOffset"] = 0.0
                    target_result["oof"] = target_result["empiricalBaseline"]
                    trained_positions[position][target]["weights"] = [1.0, 0.0, 0.0]
                    trained_positions[position][target]["calibrationOffset"] = 0.0
                    target_truth = position_rows.loc[oof_by_target[target].index, f"target_{target}"].to_numpy(dtype=float)
                    target_empirical = oof_by_target[target]["empirical"].to_numpy(dtype=float)
                    residuals[f"{position}:{target}"] = (target_truth - target_empirical).tolist()
        draftable_indices: list[int] = []
        for fold_season in sorted(int(value) for value in joined["season"].unique()):
            candidates_in_fold = np.flatnonzero(joined["season"].to_numpy(dtype=int) == fold_season)
            ranked = candidates_in_fold[np.argsort(-empirical_ppr[candidates_in_fold])]
            draftable_indices.extend(ranked[:DRAFTABLE_LIMITS[position]].tolist())
        draftable = np.asarray(draftable_indices, dtype=int)
        position_result["lockedDraftableCohort"] = {
            "selection": f"Top {DRAFTABLE_LIMITS[position]} per season by prior-only empirical PPR projection; outcomes are never used for cohort selection.",
            "STD": {"candidate": _metrics(candidate_std[draftable], actual_std[draftable]), "empiricalBaseline": _metrics(empirical_std[draftable], actual_std[draftable])},
            "PPR": {"candidate": _metrics(candidate_ppr[draftable], actual_ppr[draftable]), "empiricalBaseline": _metrics(empirical_ppr[draftable], actual_ppr[draftable])},
        }
        residuals[f"{position}:std_total"] = (actual_std - candidate_std).tolist()
        residuals[f"{position}:ppr_total"] = (actual_ppr - candidate_ppr).tolist()
        report["positions"][position] = position_result
    # Season-total evaluation is reconstructed from independently predicted games and per-game values.
    for fold_season in evaluation_seasons:
        fold_rows = dataset[dataset["season"] == fold_season]
        fold_summary: dict[str, Any] = {"season": fold_season, "positions": {}}
        for position in CORE_POSITIONS:
            rows = fold_rows[fold_rows["position"] == position]
            if rows.empty:
                continue
            # Use final OOF diagnostics for visibility; production eligibility remains false until prospective evidence exists.
            fold_summary["positions"][position] = {"rows": int(len(rows))}
        report["folds"].append(fold_summary)
    report["eligibility"] = {
        "eligibleForLivePromotion": False,
        "reasons": [
            "Owned candidate has development backtests but no completed prospective preseason shadow season.",
            "No lawful multi-season paired point-projection benchmark against the active three-source consensus exists.",
            "Promotion requires an explicit reviewed policy change; evaluation never promotes automatically.",
        ],
    }
    return TrainedOwnedModel(feature_columns, trained_positions, residuals, max(seasons), input_manifest), report


def _identity_name(value: Any) -> str:
    return _normalized_name(value)


def _catalog_map(path: Path | None) -> dict[str, dict[str, dict[str, Any]]]:
    if not path or not path.exists():
        return {"gsis": {}, "espn": {}, "name": {}, "team": {}}
    raw = json.loads(path.read_text(encoding="utf-8"))
    by_gsis: dict[str, dict[str, Any]] = {}
    by_espn: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    by_team: dict[str, dict[str, Any]] = {}
    ambiguous: set[str] = set()
    for value in raw.values():
        gsis = str(value.get("gsis_id") or "").strip()
        if gsis and gsis not in by_gsis:
            by_gsis[gsis] = value
        espn = _espn_identity(value.get("espn_id"))
        if espn and espn not in by_espn:
            by_espn[espn] = value
        position = str(value.get("position") or "").upper()
        if position == "DEF":
            position = "DST"
        key = f"{_identity_name(value.get('full_name'))}:{position}"
        team = str(value.get("team") or "").upper()
        if team and position == "DST":
            by_team[team] = value
        if key in by_name and str(by_name[key].get("player_id")) != str(value.get("player_id")):
            ambiguous.add(key)
        else:
            by_name[key] = value
    for key in ambiguous:
        by_name.pop(key, None)
    return {"gsis": by_gsis, "espn": by_espn, "name": by_name, "team": by_team}


def _quantiles(mean: float, residuals: Iterable[float]) -> dict[str, float]:
    values = np.asarray(list(residuals), dtype=float)
    if not len(values):
        values = np.array([-0.28 * mean, -0.14 * mean, 0.0, 0.14 * mean, 0.28 * mean])
    quantiles = np.quantile(values, [0.10, 0.25, 0.50, 0.75, 0.90])
    output = [max(0.0, mean + float(value)) for value in quantiles]
    return {key: round(value, 2) for key, value in zip(("p10", "p25", "p50", "p75", "p90"), output)}


def predict_owned_model(model: TrainedOwnedModel, stats: pd.DataFrame, players: pd.DataFrame, season: int, catalog_path: Path | None = None, roles: dict[tuple[int, str], dict[str, Any]] | None = None) -> dict[str, Any]:
    metadata = _player_metadata(players)
    catalog = _catalog_map(catalog_path)
    histories: dict[str, dict[int, dict[str, Any]]] = {}
    for row in stats.to_dict("records"):
        histories.setdefault(str(row["player_id"]), {})[int(row["season"])] = row
    team_contexts = _team_contexts(histories, roles or {}, season)
    records: list[dict[str, Any]] = []
    identity_coverage = {"gsis": 0, "espn": 0, "team": 0, "uniqueNamePosition": 0, "unmapped": 0}
    eligible_players = players[
        players["position"].isin(CORE_POSITIONS)
        & players["latest_team"].fillna("").astype(str).ne("")
        & players["status"].fillna("").astype(str).isin(["ACT", "DEV", "RES", "INA", "PUP", "UDF"])
        & (players["last_season"].fillna(0) >= season - 1)
    ]
    candidates: list[dict[str, Any]] = []
    universe_coverage = {
        "eligibleRows": int(len(eligible_players)), "projectedRows": 0,
        "currentRookiesEligible": 0, "currentRookiesProjected": 0,
        "currentRookiesWithDepthRole": 0, "teamAssignedUdfExcludedUnresolved": 0,
        "identityMethods": {"gsis": 0, "espn": 0, "namePosition": 0, "team": 0},
    }
    for meta in eligible_players.to_dict("records"):
        player_id_value = meta.get("player_id")
        player_id = str(player_id_value).strip() if player_id_value is not None and pd.notna(player_id_value) else ""
        position = str(meta["position"])
        source_id = str(meta.get("gsis_id") or "").strip()
        if not player_id:
            player_id = source_id if position == "DST" and source_id.startswith("DST:") else _stable_player_identity(source_id, meta.get("espn_id"), meta.get("display_name"), position)[0]
        if not player_id:
            continue
        role = (roles or {}).get((season, player_id))
        role_team = str((role or {}).get("team") or meta.get("latest_team") or "")
        canonical_gsis = source_id if _CANONICAL_GSIS.fullmatch(source_id) else ""
        espn = _espn_identity(meta.get("espn_id"))
        catalog_player = catalog["team"].get(str(meta.get("latest_team") or "").upper()) if position == "DST" else catalog["gsis"].get(canonical_gsis)
        catalog_method = "team" if catalog_player and position == "DST" else ("gsis" if catalog_player else "")
        if not catalog_player and espn:
            catalog_player = catalog["espn"].get(espn)
            catalog_method = "espn" if catalog_player else ""
        if not catalog_player:
            catalog_player = catalog["name"].get(f"{_identity_name(meta.get('display_name'))}:{position}")
            catalog_method = "uniqueNamePosition" if catalog_player else ""
        is_rookie = int(_number(meta.get("rookie_season"), -1)) == season
        if is_rookie:
            universe_coverage["currentRookiesEligible"] += 1
        if str(meta.get("status") or "") == "UDF" and not role and not catalog_player:
            universe_coverage["teamAssignedUdfExcludedUnresolved"] += 1
            continue
        identity_method = "team" if position == "DST" else ("gsis" if canonical_gsis else ("espn" if espn else "namePosition"))
        universe_coverage["identityMethods"][identity_method] += 1
        if is_rookie:
            universe_coverage["currentRookiesProjected"] += 1
            universe_coverage["currentRookiesWithDepthRole"] += int(role is not None)
        candidates.append({"meta": meta, "player_id": player_id, "position": position, "catalog": catalog_player, "catalog_method": catalog_method, "canonical_gsis": canonical_gsis, "source_id": source_id, "features": _features_for(histories.get(player_id, {}), meta, season, position, role, team_contexts.get((role_team, position)))})
    universe_coverage["projectedRows"] = len(candidates)
    feature_frame = pd.DataFrame([candidate["features"] for candidate in candidates])
    for column in model.feature_columns:
        if column not in feature_frame:
            feature_frame[column] = np.nan
    predictions_by_target = {target: np.zeros(len(candidates), dtype=float) for target in TARGETS}
    rookie_wr_totals = {scoring_format: np.full(len(candidates), np.nan) for scoring_format in ("STD", "PPR")}
    for position in CORE_POSITIONS:
        indices = np.array([index for index, candidate in enumerate(candidates) if candidate["position"] == position], dtype=int)
        if not len(indices):
            continue
        features = feature_frame.iloc[indices]
        for target in TARGETS:
            config = model.positions[position][target]
            component = [_empirical_predict(features, target, position)]
            component.extend(config["models"][name].predict(features[model.feature_columns]) for name in ("ridge", "boosted"))
            predictions_by_target[target][indices] = _clip_prediction(target, np.column_stack(component) @ np.asarray(config["weights"]) + float(config.get("calibrationOffset", 0.0)))
        if position == "WR" and "rookieTotalSpecialist" in model.positions[position]:
            rookie_indices = np.array([
                index for index in indices
                if int(_number(candidates[index]["meta"].get("rookie_season"), -1)) == season
            ], dtype=int)
            if len(rookie_indices):
                rookie_features = feature_frame.iloc[rookie_indices]
                specialist = model.positions[position]["rookieTotalSpecialist"]
                base_std = predictions_by_target["games"][rookie_indices] * predictions_by_target["std_ppg"][rookie_indices]
                base_ppr = predictions_by_target["games"][rookie_indices] * predictions_by_target["ppr_ppg"][rookie_indices]
                specialist_std = specialist["models"]["STD"].predict(rookie_features[model.feature_columns])
                specialist_ppr = specialist["models"]["PPR"].predict(rookie_features[model.feature_columns])
                rookie_wr_totals["STD"][rookie_indices] = _blend_wr_rookie_total(base_std, specialist_std, "STD")
                rookie_wr_totals["PPR"][rookie_indices] = _blend_wr_rookie_total(base_ppr, specialist_ppr, "PPR")
    for index, candidate in enumerate(candidates):
        meta, player_id, position = candidate["meta"], candidate["player_id"], candidate["position"]
        predictions = {target: float(predictions_by_target[target][index]) for target in TARGETS}
        games = predictions["games"]
        mean_std = max(0.0, games * predictions["std_ppg"])
        mean_ppr = max(mean_std, games * predictions["ppr_ppg"])
        base_mean_std = mean_std
        base_mean_ppr = mean_ppr
        base_mean_half = (base_mean_std + base_mean_ppr) / 2.0
        if position == "WR" and math.isfinite(rookie_wr_totals["STD"][index]):
            mean_std = float(rookie_wr_totals["STD"][index])
            mean_ppr = max(mean_std, float(rookie_wr_totals["PPR"][index]))
        mean_half = (mean_std + mean_ppr) / 2.0
        depth_rank = _number(candidate["features"].get("depth_rank"), np.nan)
        is_current_starter = math.isfinite(depth_rank) and depth_rank <= 1
        active_role_games = 17.0 if is_current_starter else games
        active_role_scale = 17.0 / max(games, 1.0) if is_current_starter else 1.0
        sleeper = candidate.get("catalog")
        identity_method = candidate.get("catalog_method") or "unmapped"
        if not sleeper:
            sleeper = catalog["name"].get(f"{_identity_name(meta.get('display_name'))}:{position}")
            identity_method = "uniqueNamePosition" if sleeper else "unmapped"
        sleeper = sleeper or {}
        identity_coverage[identity_method] += 1
        uncertainty = _quantiles(mean_ppr, model.residuals.get(f"{position}:ppr_total", []))
        records.append({
            "id": str(sleeper.get("player_id") or player_id),
            "gsisId": candidate.get("canonical_gsis") or None,
            "nflverseId": candidate.get("source_id") or None,
            "ownedPlayerId": player_id,
            "espnId": int(meta["espn_id"]) if pd.notna(meta.get("espn_id")) else sleeper.get("espn_id"),
            "name": meta.get("display_name") or sleeper.get("full_name") or player_id,
            "position": position,
            "team": meta.get("latest_team"),
            "mean": round(mean_ppr, 2),
            "meanPpr": round(mean_ppr, 2),
            "meanHalf": round(mean_half, 2),
            "meanStd": round(mean_std, 2),
            "baseMeanPpr": round(base_mean_ppr, 2),
            "baseMeanHalf": round(base_mean_half, 2),
            "baseMeanStd": round(base_mean_std, 2),
            "floor": uncertainty["p10"],
            "ceiling": uncertainty["p90"],
            "risk": round(min(0.95, max(0.05, (uncertainty["p90"] - uncertainty["p10"]) / max(1.0, 2.0 * mean_ppr))), 3),
            "expectedGames": round(games, 2),
            "depthRank": round(depth_rank, 2) if math.isfinite(depth_rank) else None,
            "activeRoleGames": round(active_role_games, 2),
            "activeRoleMeanPpr": round(mean_ppr * active_role_scale, 2),
            "activeRoleMeanHalf": round(mean_half * active_role_scale, 2),
            "activeRoleMeanStd": round(mean_std * active_role_scale, 2),
            "uncertainty": uncertainty,
            "source": MODEL_VERSION,
            "eligibleForRecommendation": mean_ppr > 0,
        })
    records.sort(key=lambda row: (-row["meanPpr"], row["position"], row["name"]))
    generated_at = utc_now()
    source_policy = {
        "projectionFeatureSources": ["nflverse"],
        "identityOnlySources": ["sleeper-player-catalog"],
        "prohibitedProjectionFeatureSources": ["espn", "sleeper-projections", "fantasypros"],
    }
    recipe = {
        "modelVersion": MODEL_VERSION,
        "positions": list(CORE_POSITIONS),
        "targets": list(TARGETS),
        "featureColumns": list(model.feature_columns),
        "positionPriors": POSITION_PRIORS,
        "draftableLimits": DRAFTABLE_LIMITS,
        "wrRookieSpecialist": WR_ROOKIE_SPECIALIST,
        "trainingSeed": 20260715,
        "projectionSourcePolicy": source_policy,
    }
    canonical_digest = lambda value: hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "schemaVersion": 1,
        "artifactType": "draft-goblin-owned-candidate",
        "modelVersion": MODEL_VERSION,
        "runtimeStatus": "shadow",
        "eligibleAsLiveProjection": False,
        "projectionSeason": season,
        "generatedAt": generated_at,
        "trainingCutoffSeason": model.training_cutoff,
        "scoringFormats": ["STD", "HALF", "PPR"],
        "dataQuality": "shadow",
        "method": "Out-of-fold stack of recency/empirical-Bayes, ridge, and robust histogram gradient boosting models. Games and conditional points are modeled separately by position.",
        "attribution": ["Historical statistics and player metadata: nflverse, CC-BY-4.0"],
        "inputManifest": model.input_manifest,
        "modelRecipeSha256": canonical_digest(recipe),
        "trainingProjectionSourcePolicy": source_policy,
        "trainingProjectionSourcePolicySha256": canonical_digest(source_policy),
        "identityCoverage": identity_coverage,
        "playerUniverseCoverage": universe_coverage,
        "players": records,
    }


def save_model(model: TrainedOwnedModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, path)


def load_model(path: Path) -> TrainedOwnedModel:
    return joblib.load(path)
