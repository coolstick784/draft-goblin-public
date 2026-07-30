"""Fail-closed verification for an owned-model shadow build.

This binds the saved estimator, generated candidate, walk-forward report,
licensed-input manifest, policy, catalog, requirements, and an optional second
inference. It never promotes or publishes the candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import (  # noqa: E402
    CORE_POSITIONS,
    MODEL_VERSION,
    TARGETS,
    load_model,
)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain a JSON object.")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_fetch_manifest(manifest: dict[str, Any], data_dir: Path) -> None:
    assert manifest.get("schemaVersion") == 1
    assert manifest.get("attribution") == "nflverse, CC-BY-4.0"
    inputs = manifest.get("inputs")
    assert isinstance(inputs, list) and inputs
    names: set[str] = set()
    for item in inputs:
        name = str(item.get("file") or "")
        assert name and name not in names, f"Duplicate fetch-manifest input: {name}"
        names.add(name)
        path = data_dir / name
        assert path.is_file(), f"Fetched input is missing: {path}"
        assert path.stat().st_size == int(item["bytes"]), f"Byte mismatch: {name}"
        assert sha256(path) == item["sha256"], f"Digest mismatch: {name}"
        assert item.get("license") == "CC-BY-4.0"
        assert str(item.get("url") or "").startswith("https://")


def verify_candidate_inputs(
    candidate: dict[str, Any], fetch_manifest: dict[str, Any]
) -> None:
    fetched = {
        item["file"]: (item["sha256"], int(item["bytes"]))
        for item in fetch_manifest["inputs"]
    }
    model_inputs = candidate.get("inputManifest")
    assert isinstance(model_inputs, list) and model_inputs
    checked = 0
    for item in model_inputs:
        if not isinstance(item, dict) or not item.get("sha256"):
            continue
        name = str(item["file"])
        assert name in fetched, f"Model input absent from fetch manifest: {name}"
        assert fetched[name] == (
            item["sha256"],
            int(item["bytes"]),
        ), f"Model/fetch manifest mismatch: {name}"
        checked += 1
    assert checked >= 10, "Too few model inputs were bound to the fetch manifest."


def inference_payload(value: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(value)
    normalized.pop("generatedAt", None)
    return normalized


def verify_candidate_diagnostics(candidate: dict[str, Any]) -> None:
    players = candidate.get("players")
    assert isinstance(players, list) and players
    changed = 0
    for player in players:
        for key in ("baseMeanStd", "baseMeanHalf", "baseMeanPpr"):
            value = player.get(key)
            assert isinstance(value, (int, float)) and math.isfinite(value)
            assert value >= 0
        if (
            player["baseMeanStd"] != player.get("meanStd")
            or player["baseMeanPpr"] != player.get("meanPpr")
        ):
            assert player.get("position") == "WR"
            changed += 1
    assert changed > 0, "No WR-rookie specialist/base diagnostic differences found."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--candidate", type=Path, default=None)
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("data/research/owned-model-walk-forward.json"),
    )
    parser.add_argument(
        "--policy", type=Path, default=Path("data/projection-model-policy.json")
    )
    parser.add_argument(
        "--model", type=Path, default=Path("data/private/owned-model/model.joblib")
    )
    parser.add_argument(
        "--fetch-manifest",
        type=Path,
        default=Path("data/private/owned-model/raw/fetch-manifest.json"),
    )
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data/private/owned-model/raw")
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("data/generated/sleeper-current-catalog.json"),
    )
    parser.add_argument("--reproduced-candidate", type=Path, default=None)
    parser.add_argument(
        "--receipt",
        type=Path,
        default=Path("data/private/owned-model/shadow-build-manifest.json"),
    )
    args = parser.parse_args()

    candidate_path = args.candidate or Path(
        f"data/generated/owned-projections-{args.season}.json"
    )
    required_paths = (
        candidate_path,
        args.report,
        args.policy,
        args.model,
        args.fetch_manifest,
        args.catalog,
        Path("requirements-owned-model.txt"),
    )
    for path in required_paths:
        assert path.is_file(), f"Required shadow artifact is missing: {path}"

    candidate = read_json(candidate_path)
    report = read_json(args.report)
    policy = read_json(args.policy)
    fetch_manifest = read_json(args.fetch_manifest)
    model = load_model(args.model)

    assert MODEL_VERSION == candidate.get("modelVersion")
    assert report.get("modelVersion") == MODEL_VERSION
    assert candidate.get("artifactType") == "draft-goblin-owned-candidate"
    assert candidate.get("projectionSeason") == args.season
    assert candidate.get("trainingCutoffSeason") == args.season - 1
    assert candidate.get("runtimeStatus") == "shadow"
    assert candidate.get("eligibleAsLiveProjection") is False
    assert candidate.get("dataQuality") == "shadow"
    assert candidate.get("players")
    assert re.fullmatch(r"[a-f0-9]{64}", candidate.get("modelRecipeSha256", ""))
    source_policy = candidate.get("trainingProjectionSourcePolicy") or {}
    assert source_policy.get("projectionFeatureSources") == ["nflverse"]
    assert source_policy.get("identityOnlySources") == ["sleeper-player-catalog"]
    assert source_policy.get("prohibitedProjectionFeatureSources") == [
        "espn", "sleeper-projections", "fantasypros"
    ]
    assert re.fullmatch(
        r"[a-f0-9]{64}",
        candidate.get("trainingProjectionSourcePolicySha256", ""),
    )
    expected_source_policy_digest = hashlib.sha256(
        json.dumps(source_policy, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert candidate["trainingProjectionSourcePolicySha256"] == expected_source_policy_digest
    assert all(
        player.get("source") == MODEL_VERSION for player in candidate["players"]
    )
    verify_candidate_diagnostics(candidate)

    eligibility = report.get("eligibility") or {}
    assert eligibility.get("eligibleForLivePromotion") is False
    assert eligibility.get("reasons")
    assert model.training_cutoff == args.season - 1
    assert model.feature_columns
    for position in CORE_POSITIONS:
        assert position in model.positions
        for target in TARGETS:
            assert target in model.positions[position]

    matching_policy = [
        item for item in policy.get("models", []) if item.get("id") == MODEL_VERSION
    ]
    assert len(matching_policy) == 1
    policy_model = matching_policy[0]
    assert policy_model.get("status") == "shadow"
    assert policy_model.get("eligibleForRuntime") is False
    rules = policy.get("rules", {})
    assert rules.get("evaluationNeverPromotes") is True
    assert rules.get("requireExplicitReviewedPromotion") is True
    assert rules.get("requireIndividualSourceSuperiority") is True
    assert rules.get("requirePureOwnedReplacementSuperiority") is True
    assert rules.get("requireFrozenCandidateOutcomePopulation") is True
    assert rules.get("minimumProspectiveShadowSeasons") == 3
    assert rules.get("excludedAdaptiveDevelopmentSeasons") == [2023, 2024, 2025]
    overlay = policy_model.get("prospectiveOverlay") or {}
    assert overlay.get("candidateMethod") == (
        "position-aware-consensus-anchored-owned-overlay"
    )
    assert overlay.get("scoringFormats") == ["STD", "HALF", "PPR"]
    assert overlay.get("positionOwnedWeights") == {
        "QB": 0.5,
        "RB": 0.5,
        "WR": 0.5,
        "TE": 0.5,
        "K": 0.5,
        "DST": 0,
    }
    assert overlay.get("minimumRowsPerFormatPositionSlice") == 10
    assert overlay.get("immutableAfterCutoff") is True
    assert policy_model.get("promotionCandidateKind") == "pure-independent-owned"
    assert policy_model.get("promotionGateVersion") == 2
    assert policy_model.get("requireIndependentOwnedSuperiority") is True

    verify_fetch_manifest(fetch_manifest, args.data_dir)
    verify_candidate_inputs(candidate, fetch_manifest)

    reproduced_digest = None
    if args.reproduced_candidate:
        assert args.reproduced_candidate.is_file()
        reproduced = read_json(args.reproduced_candidate)
        assert inference_payload(reproduced) == inference_payload(candidate), (
            "Saved-model inference did not reproduce the generated candidate."
        )
        reproduced_digest = sha256(args.reproduced_candidate)

    files = {
        "model": args.model,
        "candidate": candidate_path,
        "walkReport": args.report,
        "fetchManifest": args.fetch_manifest,
        "policy": args.policy,
        "catalog": args.catalog,
        "requirements": Path("requirements-owned-model.txt"),
    }
    for artifact_path in files.values():
        assert artifact_path.is_file()
    receipt = {
        "schemaVersion": 1,
        "artifactType": "owned-model-shadow-build-manifest",
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "projectionSeason": args.season,
        "modelVersion": MODEL_VERSION,
        "runtimeStatus": "shadow",
        "eligibleAsLiveProjection": False,
        "sourceRevision": os.environ.get("GITHUB_SHA") or None,
        "workflowRunId": os.environ.get("GITHUB_RUN_ID") or None,
        "files": {
            name: {
                "path": artifact_path.as_posix(),
                "bytes": artifact_path.stat().st_size,
                "sha256": sha256(artifact_path),
            }
            for name, artifact_path in files.items()
        },
        "reproducedCandidateSha256": reproduced_digest,
        "rawInputRetention": (
            "Raw inputs are not included in the CI artifact. The fetch manifest "
            "binds their official URLs, byte sizes, and SHA-256 digests."
        ),
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(
        json.dumps(receipt, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "receipt": str(args.receipt),
                "modelVersion": MODEL_VERSION,
                "projectionSeason": args.season,
                "players": len(candidate["players"]),
                "reproduced": args.reproduced_candidate is not None,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
