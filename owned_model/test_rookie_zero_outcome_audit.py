import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audit-rookie-zero-outcomes.py"
SPEC = importlib.util.spec_from_file_location("rookie_zero_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)


class RookieZeroOutcomeAuditTests(unittest.TestCase):
    def test_exact_drafted_nonparticipant_is_bounded_zero_production(self):
        picks = pd.DataFrame(
            [
                {
                    "season": 2024,
                    "pick": 10,
                    "position": "QB",
                    "gsis_id": "00-0000001",
                },
                {
                    "season": 2024,
                    "pick": 20,
                    "position": "WR",
                    "gsis_id": "00-0000002",
                },
            ]
        )
        players = pd.DataFrame(
            {"gsis_id": ["00-0000001", "00-0000002"]}
        )
        stats = pd.DataFrame(
            [
                {
                    "season": 2024,
                    "player_id": "00-0000002",
                    "position": "WR",
                    "games": 2,
                    "fantasy_points": 8,
                    "fantasy_points_ppr": 11,
                }
            ]
        )
        rows = AUDIT.build_rows(picks, players, stats)
        summary = AUDIT.cohort_summary(rows)
        self.assertEqual(summary["exactGsisRows"], 2)
        self.assertEqual(summary["zeroRecordedProductionRows"], 1)
        self.assertEqual(summary["productionParticipantRows"], 1)
        self.assertEqual(summary["expandedDraftedTotals"]["STD"]["mean"], 4.0)
        self.assertEqual(
            summary["participantOnlyOptimism"]["STD"]["meanPointDifference"],
            4.0,
        )

    def test_noncanonical_identity_is_not_silently_labeled_zero(self):
        picks = pd.DataFrame(
            [
                {
                    "season": 2024,
                    "pick": 10,
                    "position": "QB",
                    "gsis_id": "",
                }
            ]
        )
        players = pd.DataFrame({"gsis_id": []})
        stats = pd.DataFrame(
            columns=[
                "season",
                "player_id",
                "position",
                "games",
                "fantasy_points",
                "fantasy_points_ppr",
            ]
        )
        rows = AUDIT.build_rows(picks, players, stats)
        summary = AUDIT.cohort_summary(rows)
        self.assertEqual(summary["exactGsisRows"], 0)
        self.assertEqual(summary["unresolvedIdentityRows"], 1)
        self.assertEqual(summary["zeroRecordedProductionRows"], 0)

    def test_reclassified_stats_row_is_not_called_zero_production(self):
        picks = pd.DataFrame(
            [
                {
                    "season": 2025,
                    "pick": 2,
                    "position": "WR",
                    "gsis_id": "00-0000003",
                }
            ]
        )
        players = pd.DataFrame({"gsis_id": ["00-0000003"]})
        stats = pd.DataFrame(
            [
                {
                    "season": 2025,
                    "player_id": "00-0000003",
                    "position": "CB",
                    "games": 7,
                    "fantasy_points": 35.8,
                    "fantasy_points_ppr": 63.8,
                }
            ]
        )
        rows = AUDIT.build_rows(picks, players, stats)
        summary = AUDIT.cohort_summary(rows)
        self.assertEqual(summary["zeroRecordedProductionRows"], 0)
        self.assertEqual(
            summary["statsRowsReclassifiedOutsideDraftPosition"], 1
        )
        self.assertAlmostEqual(
            summary["expandedDraftedTotals"]["PPR"]["mean"], 63.8
        )


if __name__ == "__main__":
    unittest.main()
