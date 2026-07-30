from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "research-owned-snap-opportunity.py"
SPEC = importlib.util.spec_from_file_location("snap_opportunity_research", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class SnapOpportunityResearchTest(unittest.TestCase):
    def test_augment_uses_only_seasons_before_target(self) -> None:
        dataset = pd.DataFrame([
            {"player_id": "p1", "season": 2024},
            {"player_id": "p1", "season": 2025},
        ])
        result = MODULE.augment(dataset, {"p1": {
            2022: 0.2, 2023: 0.3, 2024: 0.9, 2025: 1.0,
        }})
        self.assertEqual(result.loc[0, "snap_share_lag1"], 0.3)
        self.assertEqual(result.loc[0, "snap_share_lag2"], 0.2)
        self.assertEqual(result.loc[1, "snap_share_lag1"], 0.9)
        self.assertNotEqual(result.loc[0, "snap_share_lag1"], 0.9)
        self.assertNotEqual(result.loc[1, "snap_share_lag1"], 1.0)

    def test_gate_requires_strict_improvement_in_every_metric(self) -> None:
        metrics = {"mae": 10.0, "rmse": 12.0, "bias": -2.0, "spearman": 0.5}
        folds = {str(season): dict(metrics) for season in (2023, 2024, 2025)}
        control = {"lockedDraftableVeterans": {
            scoring: {"aggregate": dict(metrics), "folds": folds}
            for scoring in ("STD", "PPR")
        }}
        improved = {"mae": 9.0, "rmse": 11.0, "bias": -1.0, "spearman": 0.6}
        improved_folds = {
            str(season): dict(improved) for season in (2023, 2024, 2025)
        }
        candidate = {"lockedDraftableVeterans": {
            scoring: {"aggregate": dict(improved), "folds": improved_folds}
            for scoring in ("STD", "PPR")
        }}
        self.assertTrue(MODULE.strict_locked_gate(control, candidate)["accepted"])
        candidate["lockedDraftableVeterans"]["PPR"]["folds"]["2025"]["mae"] = 10.0
        rejected = MODULE.strict_locked_gate(control, candidate)
        self.assertFalse(rejected["accepted"])
        self.assertIn(
            "PPR 2025 mae did not strictly improve", rejected["reasons"]
        )


if __name__ == "__main__":
    unittest.main()
