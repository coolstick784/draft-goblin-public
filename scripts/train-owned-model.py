import argparse
import json
import sys
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from owned_model.pipeline import add_kicker_zero_outcomes, build_dataset, enrich_players_with_draft_picks, load_depth_charts, load_draft_picks, load_dst_stats, load_players, load_stats, predict_owned_model, save_model, train_owned_model


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and shadow-predict Draft Goblin's independently owned projection model.")
    parser.add_argument("--data-dir", default="data/private/owned-model/raw")
    parser.add_argument("--players", default="data/private/owned-model/raw/players.csv")
    parser.add_argument("--draft-picks", default="data/private/owned-model/raw/draft_picks.csv")
    parser.add_argument("--catalog", default="data/generated/sleeper-current-catalog.json")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--model-out", default="data/private/owned-model/model.joblib")
    parser.add_argument("--projection-out", default=None)
    parser.add_argument("--report-out", default="data/research/owned-model-walk-forward.json")
    args = parser.parse_args()

    stats, stats_manifest = load_stats(Path(args.data_dir))
    players, players_manifest = load_players(Path(args.players))
    draft_picks, draft_manifest = load_draft_picks(Path(args.draft_picks))
    players, draft_coverage = enrich_players_with_draft_picks(players, draft_picks)
    draft_manifest["identityCoverage"] = draft_coverage
    roles, depth_manifest = load_depth_charts(Path(args.data_dir), args.season)
    stats, zero_outcome_manifest = add_kicker_zero_outcomes(stats, roles, args.season - 1)
    dst_stats, dst_players, dst_manifest = load_dst_stats(Path(args.data_dir), Path(args.data_dir) / "games.csv")
    stats = pd.concat([stats, dst_stats], ignore_index=True)
    players = pd.concat([players, dst_players], ignore_index=True)
    dataset, feature_columns = build_dataset(stats, players, roles)
    model, report = train_owned_model(dataset, feature_columns, [*stats_manifest, players_manifest, draft_manifest, {"kickerZeroOutcomeCohort": zero_outcome_manifest}, *dst_manifest, *depth_manifest])
    model_path = Path(args.model_out)
    save_model(model, model_path)
    report_path = Path(args.report_out)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    projection_path = Path(args.projection_out or f"data/generated/owned-projections-{args.season}.json")
    projection = predict_owned_model(model, stats, players, args.season, Path(args.catalog), roles)
    projection_path.parent.mkdir(parents=True, exist_ok=True)
    projection_path.write_text(json.dumps(projection, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"model": str(model_path), "report": str(report_path), "projection": str(projection_path), "trainingRows": len(dataset), "players": len(projection["players"])}, indent=2))


if __name__ == "__main__":
    main()
