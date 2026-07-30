import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd

from owned_model.outcomes import build_owned_outcomes
from owned_model.pipeline import _blend_wr_rookie_total, _catalog_map, _dst_safety_acceptance, _kicker_points, _points_allowed_score, _stack_weights, add_kicker_zero_outcomes, build_dataset, enrich_players_with_draft_picks, load_depth_charts, load_draft_picks, load_dst_stats, load_players


class OwnedModelPipelineTests(unittest.TestCase):
    def test_private_outcomes_build_all_scoring_formats(self):
        stats = pd.DataFrame([
            {"player_id": "00-0000001", "player_display_name": "Runner", "position": "RB", "season": 2026, "fantasy_points": 100, "fantasy_points_ppr": 140},
            {"player_id": "00-0000002", "player_display_name": "Kicker", "position": "K", "season": 2026, "fg_made_0_19": 1, "fg_made_20_29": 1, "fg_made_30_39": 1, "fg_made_40_49": 1, "fg_made_50_59": 1, "fg_made_60_": 0, "pat_made": 2, "fg_missed": 1},
        ])
        players = pd.DataFrame([
            {"gsis_id": "00-0000001", "player_id": "00-0000001", "canonical_gsis_id": "00-0000001", "display_name": "Runner", "position": "RB", "espn_id": 101},
            {"gsis_id": "00-0000002", "player_id": "00-0000002", "canonical_gsis_id": "00-0000002", "display_name": "Kicker", "position": "K", "espn_id": 102},
        ])
        result = build_owned_outcomes(stats, players, 2026, complete=True)
        by_position = {row["position"]: row for row in result["players"]}
        self.assertEqual(by_position["RB"]["pointsHalf"], 120)
        self.assertEqual(by_position["K"]["pointsStd"], 19)
        self.assertTrue(result["complete"])

    def test_private_outcomes_expand_to_frozen_candidate_zero_production(self):
        stats = pd.DataFrame([
            {"player_id": "00-0000001", "player_display_name": "Runner", "position": "RB", "season": 2026, "fantasy_points": 100, "fantasy_points_ppr": 140},
        ])
        players = pd.DataFrame([
            {"gsis_id": "00-0000001", "player_id": "00-0000001", "canonical_gsis_id": "00-0000001", "display_name": "Runner", "position": "RB", "espn_id": 101},
        ])
        candidate = {
            "projectionSeason": 2026,
            "players": [
                {"id": "r1", "gsisId": "00-0000001", "ownedPlayerId": "00-0000001", "name": "Runner", "position": "RB"},
                {"id": "w1", "gsisId": "00-0000002", "ownedPlayerId": "00-0000002", "name": "No Stats", "position": "WR"},
            ],
        }
        result = build_owned_outcomes(
            stats, players, 2026, complete=True, frozen_candidate=candidate,
            frozen_candidate_sha256="a" * 64,
        )
        self.assertEqual(len(result["players"]), 2)
        self.assertEqual(result["players"][0]["pointsPpr"], 140)
        self.assertEqual(result["players"][1]["pointsPpr"], 0)
        self.assertTrue(result["populationComplete"])
        self.assertEqual(result["population"]["zeroRecordedProductionRows"], 1)
        self.assertEqual(result["frozenCandidateSha256"], "a" * 64)

    def test_draft_capital_enrichment_is_temporal_and_preserves_existing_values(self):
        players = pd.DataFrame([
            {"gsis_id": "AAA000001", "display_name": "First Rookie", "position": "RB", "rookie_season": 2026, "draft_round": np.nan, "draft_pick": np.nan},
            {"gsis_id": "BBB000002", "display_name": "Protected Veteran", "position": "WR", "rookie_season": 2025, "draft_round": 2, "draft_pick": 40},
            {"gsis_id": "", "display_name": "Unique Name", "position": "TE", "rookie_season": 2026, "draft_round": np.nan, "draft_pick": np.nan},
        ])
        picks = pd.DataFrame([
            {"season": 2026, "round": 1, "pick": 3, "gsis_id": "AAA000001", "pfr_player_id": "", "pfr_player_name": "First Rookie", "position": "RB", "normalized_name": "firstrookie"},
            {"season": 2025, "round": 1, "pick": 9, "gsis_id": "BBB000002", "pfr_player_id": "", "pfr_player_name": "Protected Veteran", "position": "WR", "normalized_name": "protectedveteran"},
            {"season": 2026, "round": 2, "pick": 45, "gsis_id": "", "pfr_player_id": "", "pfr_player_name": "Unique Name", "position": "TE", "normalized_name": "uniquename"},
        ])
        enriched, coverage = enrich_players_with_draft_picks(players, picks)
        self.assertEqual(enriched.loc[0, "draft_pick"], 3)
        self.assertEqual(enriched.loc[1, "draft_pick"], 40)
        self.assertEqual(enriched.loc[2, "draft_pick"], 45)
        self.assertEqual(coverage["newDraftPicksFilled"], 2)
        self.assertEqual(coverage["latestCoreRookiesWithDraftPick"], 2)

    def test_draft_loader_rejects_duplicate_season_pick(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "draft_picks.csv"
            row = {"season": 2026, "round": 1, "pick": 1, "gsis_id": "AAA", "pfr_player_id": "A", "pfr_player_name": "A Player", "position": "QB"}
            pd.DataFrame([row, {**row, "gsis_id": "BBB"}]).to_csv(path, index=False)
            with self.assertRaisesRegex(ValueError, "duplicate"):
                load_draft_picks(path)

    def test_player_loader_admits_stable_alternate_identities(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "players.csv"
            required = {"birth_date": "2002-01-01", "rookie_season": 2026, "draft_round": 1, "draft_pick": 10}
            pd.DataFrame([
                {**required, "gsis_id": "00-0000001", "espn_id": 10, "display_name": "Canonical", "position": "RB"},
                {**required, "gsis_id": "PROVISIONAL", "espn_id": 20, "display_name": "ESPN Rookie", "position": "WR"},
                {**required, "gsis_id": "", "espn_id": np.nan, "display_name": "Unique Rookie", "position": "TE"},
                {**required, "gsis_id": "", "espn_id": np.nan, "display_name": "Ambiguous", "position": "WR"},
                {**required, "gsis_id": "", "espn_id": np.nan, "display_name": "Ambiguous", "position": "WR"},
            ]).to_csv(path, index=False)
            players, manifest = load_players(path)
            self.assertEqual(set(players.player_id), {"00-0000001", "ESPN:20", "NAME:uniquerookie:TE"})
            self.assertEqual(players.set_index("player_id").loc["ESPN:20", "canonical_gsis_id"], "")
            self.assertEqual(manifest["identityCoverage"]["unresolvedOrAmbiguous"], 2)

    def test_depth_chart_joins_provisional_player_through_espn(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "depth_charts_2026.csv.gz"
            pd.DataFrame([{
                "dt": "2026-07-01T00:00:00Z", "team": "A", "player_name": "Rookie",
                "espn_id": 1234, "gsis_id": "PROVISIONAL", "pos_abb": "RB", "pos_rank": 1,
            }]).to_csv(path, index=False, compression="gzip")
            roles, manifest = load_depth_charts(Path(directory), 2026)
            self.assertEqual(roles[(2026, "ESPN:1234")]["rank"], 1)
            self.assertEqual(manifest[0]["identityCoverage"]["espn"], 1)

    def test_catalog_supports_espn_identity(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text('{"one":{"player_id":"sleep-1","espn_id":1234,"full_name":"Rookie","position":"RB"}}', encoding="utf-8")
            self.assertEqual(_catalog_map(path)["espn"]["1234"]["player_id"], "sleep-1")

    def test_dataset_uses_only_prior_seasons(self):
        rows = []
        for season, points in [(2019, 80), (2020, 100), (2021, 120), (2022, 140)]:
            rows.append({
                "player_id": "00-0000001", "player_display_name": "Test Player", "position": "RB",
                "season": season, "games": 10, "fantasy_points": points, "fantasy_points_ppr": points + 20,
            })
        stats = pd.DataFrame(rows)
        players = pd.DataFrame([{
            "gsis_id": "00-0000001", "birth_date": pd.Timestamp("1995-01-01"), "rookie_season": 2019,
            "draft_round": 2, "draft_pick": 50,
        }])
        dataset, features = build_dataset(stats, players)
        self.assertTrue((dataset.feature_cutoff_season < dataset.season).all())
        target = dataset[dataset.season == 2022].iloc[0]
        self.assertEqual(target.fantasy_points_lag1, 12)
        self.assertIn("draft_capital", features)

    def test_stacking_is_deterministic_and_on_the_simplex(self):
        predictions = np.array([[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6]], dtype=float)
        actual = np.array([2, 3, 4, 5], dtype=float)
        first = _stack_weights(predictions, actual)
        second = _stack_weights(predictions, actual)
        np.testing.assert_array_equal(first, second)
        self.assertAlmostEqual(float(first.sum()), 1.0)
        self.assertTrue((first >= 0).all())

    def test_wr_rookie_specialist_uses_locked_format_specific_blends(self):
        base = np.array([100.0, 120.0])
        specialist = np.array([140.0, 80.0])
        np.testing.assert_array_equal(
            _blend_wr_rookie_total(base, specialist, "STD"),
            np.array([120.0, 100.0]),
        )
        np.testing.assert_array_equal(
            _blend_wr_rookie_total(base, specialist, "PPR"),
            np.array([130.0, 90.0]),
        )

    def test_depth_chart_loader_uses_week_one_for_historical_roles(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "depth_charts_2024.csv"
            pd.DataFrame([
                {"season": 2024, "club_code": "A", "week": 1, "depth_team": 2, "gsis_id": "00-0000001"},
                {"season": 2024, "club_code": "A", "week": 2, "depth_team": 1, "gsis_id": "00-0000001"},
            ]).to_csv(path, index=False)
            roles, manifest = load_depth_charts(Path(directory), 2026)
            self.assertEqual(roles[(2024, "00-0000001")]["rank"], 2)
            self.assertIn("timestamp unavailable", manifest[0]["featureCutoff"])

    def test_dated_depth_chart_uses_latest_strictly_preseason_snapshot(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pd.DataFrame([
                {"season": 2025, "game_type": "REG", "gameday": "2025-09-04"},
            ]).to_csv(root / "games.csv", index=False)
            pd.DataFrame([
                {"dt": "2025-08-03T10:00:00Z", "team": "A", "player_name": "Camp Kicker", "espn_id": 1, "gsis_id": "", "pos_rank": 1, "pos_abb": "PK"},
                {"dt": "2025-09-03T10:00:00Z", "team": "A", "player_name": "Final Kicker", "espn_id": 2, "gsis_id": "", "pos_rank": 1, "pos_abb": "PK"},
                {"dt": "2025-09-05T10:00:00Z", "team": "A", "player_name": "Leaky Kicker", "espn_id": 3, "gsis_id": "", "pos_rank": 1, "pos_abb": "PK"},
            ]).to_csv(root / "depth_charts_2025.csv", index=False)
            roles, manifest = load_depth_charts(root, 2026)
            self.assertNotIn((2025, "ESPN:1"), roles)
            self.assertIn((2025, "ESPN:2"), roles)
            self.assertNotIn((2025, "ESPN:3"), roles)
            self.assertIn("strictly before first regular-season date", manifest[0]["featureCutoff"])

    def test_kicker_zero_outcome_restores_only_depth_listed_missing_season(self):
        stats = pd.DataFrame([
            {"player_id": "existing", "position": "K", "season": 2025, "games": 2},
            {"player_id": "history", "position": "K", "season": 2024, "games": 17},
            {"player_id": "old", "position": "K", "season": 2021, "games": 1},
            {"player_id": "seed", "position": "K", "season": 2020, "games": 1},
        ])
        roles = {
            (2025, "existing"): {"position": "PK", "team": "A", "rank": 1},
            (2025, "history"): {"position": "PK", "team": "B", "rank": 1, "name": "Missing Kicker"},
            (2026, "future"): {"position": "PK", "team": "C", "rank": 1},
            (2025, "not-kicker"): {"position": "QB", "team": "D", "rank": 1},
        }
        augmented, manifest = add_kicker_zero_outcomes(stats, roles, 2025)
        restored = augmented[(augmented["season"] == 2025) & (augmented["player_id"] == "history")].iloc[0]
        self.assertEqual(restored["games"], 0)
        self.assertEqual(restored["fantasy_points"], 0)
        self.assertEqual(manifest["addedRows"], 1)

    def test_standard_dst_points_allowed_buckets(self):
        self.assertEqual(
            [_points_allowed_score(value) for value in [0, 1, 6, 7, 13, 14, 17, 18, 27, 28, 34, 35, 45, 46]],
            [5, 4, 4, 3, 3, 1, 1, 0, 0, -1, -1, -3, -3, -5],
        )

    def test_espn_default_kicker_scoring_uses_distance_and_miss_penalty(self):
        self.assertEqual(_kicker_points({
            "fg_made_0_19": 1, "fg_made_20_29": 1, "fg_made_30_39": 1,
            "fg_made_40_49": 1, "fg_made_50_59": 1, "fg_made_60_": 1,
            "pat_made": 2, "fg_missed": 3,
        }), 23)

    def test_dst_loader_reconstructs_standard_points(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            columns = {
                "team": "A", "games": 1, "def_sacks": 3, "def_interceptions": 2,
                "fumble_recovery_opp": 1, "def_tds": 1, "fumble_recovery_tds": 0,
                "def_safeties": 1, "special_teams_tds": 0,
            }
            for season in range(2021, 2026):
                pd.DataFrame([{**columns, "season": season}]).to_csv(root / f"stats_team_reg_{season}.csv", index=False)
            schedules = root / "games.csv"
            pd.DataFrame([{
                "season": season, "game_type": "REG", "home_team": "A", "away_team": "B",
                "home_score": 21, "away_score": 6,
            } for season in range(2021, 2026)]).to_csv(schedules, index=False)
            stats, players, manifest = load_dst_stats(root, schedules)
            # 3 sacks + 4 INT + 2 FR + 6 TD + 2 safety + 4 points allowed.
            self.assertEqual(stats.iloc[0].fantasy_points, 21)
            self.assertEqual(players.iloc[0].gsis_id, "DST:A")
            self.assertEqual(len(manifest), 6)

    def test_dst_safety_selector_rejects_one_bad_temporal_fold(self):
        totals = {scoring: {
            "candidate": {"mae": 9.0, "rmse": 10.0},
            "empiricalBaseline": {"mae": 10.0, "rmse": 11.0},
        } for scoring in ("STD", "PPR")}
        folds = {"2025": {scoring: {
            "candidate": {"mae": 10.1, "rmse": 11.1},
            "empiricalBaseline": {"mae": 10.0, "rmse": 11.0},
        } for scoring in ("STD", "PPR")}}
        accepted, reasons = _dst_safety_acceptance(totals, folds)
        self.assertFalse(accepted)
        self.assertIn("2025 PPR MAE regressed", reasons)

    def test_dst_safety_selector_accepts_consistent_improvement(self):
        totals = {scoring: {
            "candidate": {"mae": 9.0, "rmse": 10.0},
            "empiricalBaseline": {"mae": 10.0, "rmse": 11.0},
        } for scoring in ("STD", "PPR")}
        folds = {"2025": {scoring: {
            "candidate": {"mae": 9.5, "rmse": 10.5},
            "empiricalBaseline": {"mae": 10.0, "rmse": 11.0},
        } for scoring in ("STD", "PPR")}}
        accepted, reasons = _dst_safety_acceptance(totals, folds)
        self.assertTrue(accepted)
        self.assertEqual(reasons, [])


if __name__ == "__main__":
    unittest.main()
