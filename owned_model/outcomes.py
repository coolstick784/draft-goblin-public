from __future__ import annotations

from typing import Any

import pandas as pd

from owned_model.pipeline import _CANONICAL_GSIS, _catalog_map, _espn_identity, _kicker_points, _number, _player_metadata


def _identity_keys(row: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for field in ("id", "gsisId", "nflverseId", "ownedPlayerId"):
        value = str(row.get(field) or "").strip().lower()
        if value:
            keys.add(f"{field}:{value}")
    espn = str(row.get("espnId") or "").strip()
    if espn:
        keys.add(f"espn:{espn}")
    name = "".join(character for character in str(row.get("name") or "").lower() if character.isalnum())
    position = str(row.get("position") or "").upper()
    if name and position:
        keys.add(f"namePosition:{name}:{position}")
    return keys


def _bound_candidate_population(
    participant_rows: list[dict[str, Any]], candidate_players: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_key: dict[str, set[int]] = {}
    for index, row in enumerate(participant_rows):
        for key in _identity_keys(row):
            by_key.setdefault(key, set()).add(index)
    bounded: list[dict[str, Any]] = []
    used_participants: set[int] = set()
    zero_rows = 0
    for candidate in candidate_players:
        matches: set[int] = set()
        for key in _identity_keys(candidate):
            matches.update(by_key.get(key, set()))
        if len(matches) > 1:
            raise ValueError(f"Frozen candidate identity is ambiguous: {candidate.get('name') or candidate.get('id')}")
        if matches:
            participant_index = next(iter(matches))
            if participant_index in used_participants:
                raise ValueError(f"Frozen candidate duplicates an outcome identity: {candidate.get('name') or candidate.get('id')}")
            used_participants.add(participant_index)
            source = participant_rows[participant_index]
            points = {
                "pointsStd": source["pointsStd"],
                "pointsHalf": source["pointsHalf"],
                "pointsPpr": source["pointsPpr"],
            }
        else:
            zero_rows += 1
            points = {"pointsStd": 0.0, "pointsHalf": 0.0, "pointsPpr": 0.0}
        bounded.append({
            "id": str(candidate.get("id") or candidate.get("ownedPlayerId") or ""),
            "gsisId": candidate.get("gsisId") or None,
            "nflverseId": candidate.get("nflverseId") or None,
            "ownedPlayerId": str(candidate.get("ownedPlayerId") or candidate.get("id") or ""),
            "espnId": candidate.get("espnId"),
            "name": candidate.get("name") or candidate.get("id"),
            "position": str(candidate.get("position") or "").upper(),
            **points,
        })
    return bounded, {
        "candidateRows": len(candidate_players),
        "participantRows": len(candidate_players) - zero_rows,
        "zeroRecordedProductionRows": zero_rows,
        "unmatchedCandidateRows": 0,
        "populationComplete": len(bounded) == len(candidate_players),
    }


def build_owned_outcomes(
    stats: pd.DataFrame,
    players: pd.DataFrame,
    season: int,
    catalog_path=None,
    complete: bool = False,
    frozen_candidate: dict[str, Any] | None = None,
    frozen_candidate_sha256: str | None = None,
) -> dict[str, Any]:
    """Build private, identity-rich actuals for later salted-ledger matching."""
    metadata = _player_metadata(players)
    catalog = _catalog_map(catalog_path)
    rows = []
    selected = stats[pd.to_numeric(stats["season"], errors="coerce").eq(season)]
    for value in selected.to_dict("records"):
        source_id = str(value.get("player_id") or "").strip()
        position = str(value.get("position") or "").upper()
        meta = metadata.get(source_id, {})
        name = meta.get("display_name") or value.get("player_display_name") or value.get("player_name") or source_id
        canonical_gsis = source_id if _CANONICAL_GSIS.fullmatch(source_id) else str(meta.get("canonical_gsis_id") or "")
        espn = _espn_identity(meta.get("espn_id"))
        owned_id = str(meta.get("player_id") or source_id)
        if position == "DST":
            sleeper = catalog["team"].get(str(value.get("recent_team") or meta.get("latest_team") or "").upper())
        else:
            sleeper = catalog["gsis"].get(canonical_gsis) or catalog["espn"].get(espn)
        sleeper = sleeper or catalog["name"].get(f"{''.join(character for character in str(name).lower() if character.isalnum())}:{position}") or {}
        if position == "K":
            standard = _kicker_points(value)
            ppr = standard
        else:
            standard = _number(value.get("fantasy_points"))
            ppr = _number(value.get("fantasy_points_ppr"), standard)
        rows.append({
            "id": str(sleeper.get("player_id") or owned_id), "gsisId": canonical_gsis or None,
            "nflverseId": source_id or None, "ownedPlayerId": owned_id,
            "espnId": int(espn) if espn else None, "name": name, "position": position,
            "pointsStd": round(standard, 4), "pointsHalf": round((standard + ppr) / 2.0, 4), "pointsPpr": round(ppr, 4),
        })
    population = None
    if frozen_candidate is not None:
        if int(frozen_candidate.get("projectionSeason", -1)) != int(season):
            raise ValueError("Frozen candidate season does not match outcomes season.")
        candidate_players = frozen_candidate.get("players")
        if not isinstance(candidate_players, list) or not candidate_players:
            raise ValueError("Frozen candidate population is missing.")
        rows, population = _bound_candidate_population(rows, candidate_players)
    return {
        "schemaVersion": 1, "artifactType": "owned-model-private-actuals", "season": int(season),
        "complete": bool(complete), "players": rows,
        "populationBoundary": "frozen-owned-candidate" if population is not None else "participant-only",
        "populationComplete": bool(population and population["populationComplete"]),
        "frozenCandidateSha256": frozen_candidate_sha256 if population is not None else None,
        "population": population,
    }
