import importlib.util
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "research-wr-rookie-expanded-zero.py"
)
SPEC = importlib.util.spec_from_file_location("wr_expanded_zero", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)


class ExpandedWrZeroAuditTests(unittest.TestCase):
    def test_strict_comparison_checks_all_four_metrics(self):
        base = {"mae": 10.0, "rmse": 12.0, "bias": -4.0, "spearman": 0.5}
        better = {"mae": 9.0, "rmse": 11.0, "bias": -3.0, "spearman": 0.6}
        self.assertEqual(AUDIT._strict_comparison(base, better), (True, []))
        rank_regression = {**better, "spearman": 0.4}
        accepted, reasons = AUDIT._strict_comparison(base, rank_regression)
        self.assertFalse(accepted)
        self.assertIn("Spearman rank regressed", reasons)

    def test_variant_report_separates_selection_from_development(self):
        rows = []
        for season in AUDIT.AUDIT_SEASONS:
            for actual, base, incumbent in (
                (0.0, 2.0, 1.0),
                (10.0, 8.0, 9.0),
                (20.0, 17.0, 19.0),
            ):
                rows.append(
                    {
                        "season": season,
                        "actual_std": actual,
                        "actual_ppr": actual,
                        "base_std": base,
                        "base_ppr": base,
                        "incumbent_std": incumbent,
                        "incumbent_ppr": incumbent,
                    }
                )
        report = AUDIT._variant_report(pd.DataFrame(rows), "incumbent")
        self.assertTrue(report["improvesEveryDevelopmentMetricAndFold"])
        self.assertIn("2022", report["folds"])
        self.assertEqual(report["developmentAggregate"]["STD"]["base"]["rows"], 9)

    def test_exact_pick_filter_never_name_matches_unresolved_rows(self):
        picks = pd.DataFrame(
            [
                {
                    "season": 2024,
                    "position": "WR",
                    "gsis_id": "00-0000001",
                },
                {"season": 2024, "position": "WR", "gsis_id": ""},
                {
                    "season": 2024,
                    "position": "RB",
                    "gsis_id": "00-0000002",
                },
            ]
        )
        result = AUDIT._exact_wr_picks(picks)
        self.assertEqual(result["gsis_id"].tolist(), ["00-0000001"])


if __name__ == "__main__":
    unittest.main()
