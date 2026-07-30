"""Audit a position-specific quantile calibration selected on 2022 only.

The challenger maps each position/format's predicted 0/25/50/75/100th
percentiles to the corresponding realized percentiles.  The mapping is
monotone, is learned without provider inputs, and is admitted only when it
passes both full-field and preseason-locked draftable guards in 2022.  Any
admitted mapping is then frozen for untouched 2023-2025 evaluation.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

import numpy as np


BASE_SCRIPT = Path(__file__).with_name("research-owned-mean-calibration.py")
SPEC = importlib.util.spec_from_file_location("owned_mean_calibration", BASE_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {BASE_SCRIPT}")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
ORIGINAL_APPLY_POLICY = BASE.apply_policy

PROBABILITIES = np.asarray([0.0, 0.25, 0.5, 0.75, 1.0], dtype=float)


def quantile_candidates(predicted: np.ndarray, actual: np.ndarray) -> list[dict[str, Any]]:
    predicted = np.asarray(predicted, dtype=float)
    actual = np.asarray(actual, dtype=float)
    x = np.quantile(predicted, PROBABILITIES)
    y = np.maximum.accumulate(np.quantile(actual, PROBABILITIES))
    # np.interp requires increasing x values. Preserve the last (highest-y)
    # mapping when a low-volume position has tied predicted quantiles.
    unique: dict[float, float] = {}
    for source, target in zip(x, y, strict=True):
        unique[float(source)] = float(target)
    return [
        {"family": "identity", "slope": 1.0, "offset": 0.0},
        {
            "family": "positionQuantile5",
            "slope": 1.0,
            "offset": 0.0,
            "sourceKnots": list(unique),
            "targetKnots": list(unique.values()),
        },
    ]


def apply_quantile_policy(values: np.ndarray, policy: dict[str, Any]) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if policy["family"] == "positionQuantile5":
        return np.maximum(
            0.0,
            np.interp(
                values,
                np.asarray(policy["sourceKnots"], dtype=float),
                np.asarray(policy["targetKnots"], dtype=float),
            ),
        )
    return ORIGINAL_APPLY_POLICY(values, policy)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--seed", type=int, default=20260720)
    parser.add_argument(
        "--output",
        default="data/research/owned-model-position-quantile-calibration.json",
    )
    args = parser.parse_args()
    BASE.policy_candidates = quantile_candidates
    BASE.apply_policy = apply_quantile_policy
    report = BASE.run(args)
    report.update(
        {
            "artifactType": "owned-model-position-quantile-calibration",
            "method": (
                "For each position and scoring format, identity competes with one "
                "fixed monotone five-knot quantile map fit and selected on 2022 only. "
                "Any admitted map is frozen for untouched 2023-2025 evaluation."
            ),
            "providerInputsUsed": False,
            "productionChanged": False,
        }
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output),
                "status": report["researchStatus"],
                "acceptedPolicies": report["acceptedPolicies"],
                "rejectedCount": len(report["rejectedPolicies"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
