# Projection sources and methodology

## Live-season eligibility

Recommendations use only values for the season declared by the open draft. An undrafted player must be active, assigned to a current NFL team, not marked retired/inactive, and have either a positive current-site projection or a positive same-season Draft Goblin projection. Already-drafted players remain in draft state even when projection data is unavailable so roster and positional-need calculations remain intact.

This document describes exactly where Draft Goblin's projected points come from and what evidence is required before changing the live model.

See also the broader [historical source inventory](HISTORICAL_SOURCE_INVENTORY.md).

## What the extension currently uses

The daily market-adjusted Draft Goblin projection is the default projected-points input for every position. After the existing player-level consensus calibration, it becomes the player `mean`, which directly drives the player board, recommendation ranking, floor and ceiling construction, and championship simulations.

Users may explicitly switch the projection driver to the current ESPN or Sleeper projection visible in their open draft. Switching replaces the projected-points input for the board and simulations; it does not blend the selected provider with Draft Goblin. Other available provider rows remain displayed separately for comparison but are not selectable unless their runtime-use rights are approved.

The market adjustment is built daily from the independent owned projection, licensed Fantasy Football Calculator PPR ADP, and historical position-rank scoring curves. PPR retains the evaluated market-shadow value. Half-PPR and standard preserve each player's owned scoring-format difference from PPR while applying the same market adjustment. The live runtime requires the `market-adjusted-shadow-v2` feed marker, then applies the player-level local-tier consensus calibration that controls residual disagreement while retaining a bounded portion of Draft Goblin's signal.

If the selected driver is unavailable for a player, the extension falls back to the market-adjusted Draft Goblin value and labels the fallback; when Draft Goblin is unavailable, it uses an available current provider. A player with no current projection is excluded from recommendations. The conservative owned ensemble is not fetched, displayed, or used by the live recommendation pipeline.

Historical outcomes provide range calibration but never replace a missing current-season point projection. The production distribution uses 25,144 activity-verified player-weeks from 2021-2024, separates inactive/unknown rows from active-role performance, and selects parameters across rolling 2022 and 2023 folds before one untouched 2024 evaluation. Standard scoring promotes player effects for QB/WR; half-PPR promotes QB/TE. Other positions and all PPR players use the established position-level range because personalization did not clear clustered holdout and calibration gates.

The original 1.20 rookie multiplier is removed. A true-rookie, activity-aware calibration selected 1.10 on 2023, but neither 1.10 nor 1.20 had a positive 2024 cluster-bootstrap lower bound. Rookies now use the position-volume baseline rather than an unsupported conservative widening. Predictive stable/boom-bust labels and the failed risk-aware decision heuristic are likewise excluded from runtime. Availability remains a separate 2026 model, preventing missed games from being counted again inside performance ranges.

The pure owned model is directionally close to consensus but has not yet proven that it beats consensus on realized 2026 outcomes. On the current 590-player matched PPR cohort, the market-adjusted shadow followed by live player calibration has 0.9958 Spearman correlation and a 2.60-point mean absolute difference from consensus. These are agreement metrics, not realized-outcome accuracy. The explicit driver selector keeps the current draft-site projection available as an alternative. Ranking-emphasis choices change how projected points, roster need, scarcity, risk, and market rank are weighted; they do not silently change the selected projection driver.

ADP is used primarily to estimate whether a player will survive until the user's next pick. It is not treated as a projected-points source.

## Source provenance and rights

### nflverse historical outcomes

- Project: https://github.com/nflverse/nflverse-data
- Use: historical player performance for the owned baseline and realized outcomes for backtests.
- Repository license: CC BY 4.0. Attribution is required.
- Important boundary: nflverse notes that underlying NFL data can remain subject to the respective owners' terms. Review individual datasets before redistribution.

### Commercial projection candidates

- FantasyPros Commercial API and SportsDataIO are disabled candidates, not runtime sources.
- A candidate may enter a private shadow bakeoff only after its commercial agreement, allowed uses, retention, model-training, and derived-output rights are recorded.
- Free/public page visibility or a personal-use API tier is not authorization to automate collection or ship derived provider data.
- Raw vendor rows are never placed in the extension or public feed.

### Sleeper player/draft data and visible signals

- Official public API documentation: https://docs.sleeper.com/
- Use: documented read-only player/draft APIs for catalog, picks, and settings; visible draft-page text for a current-site projection or market rank when rendered.
- Storage: raw visible site values remain in the open page/extension memory and are not published; only the locally selected projected-points value may be retained in a private on-device draft report.
- Important boundary: the undocumented projection endpoint is prohibited by `data/model-signal-policy.json` and removed from runtime permissions and code.

### Historical source-comparison fixture

The repository's 2022 PPR fixture compares a FantasyPros projection snapshot and several ADP sources with realized outcomes. Its provenance and results are recorded in `data/research/2022-ppr-source-accuracy.json`. This fixture supports making projected points the primary ranking input, but one season is not sufficient to prove that any one projection driver is best.

### hvpkod/NFL-Data weekly history

- Repository: https://github.com/hvpkod/NFL-Data
- Coverage: weekly projections and outcomes from 2015 onward, divided by season, week, and position.
- Repository license: MIT.
- Use: multi-season historical projection-error measurement and calibration research.
- Leakage guard: only `PlayerWeekProjectedPts` is read as the forecast. `TotalPoints` is read solely as the later outcome; `ProjectionDiff` is never used as an input.
- Identity guard: player ID and name are used for matching. Historical team and opponent fields are ignored because those fields can reflect later affiliations.
- Redistribution boundary: the repository license is permissive, but the underlying data were extracted from Fantasy.NFL.com. Raw files are kept out of the browser package, and production redistribution still requires a rights review.

Run `npm run history:hvpkod` to regenerate `data/research/hvpkod-projection-accuracy.json`.

The current import contains 34,378 non-zero weekly forecasts covering 2021–2025. The report reserves the latest season as an untouched diagnostic holdout and reports position-specific error from earlier seasons for uncertainty modeling. It does not use weekly historical projections as if they were current preseason projections.

The championship simulator uses the 2021–2024 position-level RMSE values to set weekly lineup noise and season-projection uncertainty. The 2025 rows remain a diagnostic holdout and do not set those uncertainty parameters.

Run the reproducible range research pipeline with `npm run model:range-research`. It rebuilds weekly interval evidence, weekly-to-season aggregation, stability-label validation, a downstream choice shadow, and the final all-or-nothing promotion decision. The row-level joined dataset stays under `data/private`; aggregate audits and scored artifacts are written to `data/research`.

### FantasyPros historical rankings

FantasyPros pages accept historical `year` and `week` query parameters, which can be useful for locating snapshots. They are not automatically collected or shipped. Public visibility does not establish scraping or redistribution permission, and rankings are not the same as point projections. This source remains research-only until its terms or written permission allow automated reuse.

### Fantasy Football Data Pros 2019 ESPN fixture

Fantasy Football Data Pros publishes a 2019 ESPN weekly projection-versus-actual dataset and states that its datasets are free to download and use. Draft Goblin evaluates it separately with `npm run history:ffdp`. Because inclusion depended on a player being rostered in one 20-team league, it is not treated as an unbiased population or given automatic model weight.

### ESPN projections in the Internet Archive

The Wayback Machine can locate older ESPN projection pages. Archive timestamps are valuable for preventing leakage, but archival access does not grant a license to republish ESPN content. Current team and opponent fields must not be trusted for historical identity matching. This source remains research-only pending permission and a reproducible parser.

## What “best projections” means here

No projection source is promoted because of reputation or a single anecdote. A candidate source must be tested using snapshots captured before the season or game and evaluated only against later outcomes.

The production owned model or its runtime weight may change only when a candidate wins the following walk-forward evaluation:

1. Use at least three seasons of timestamped preseason snapshots.
2. Train candidate calibration or source-selection policies on earlier seasons, select them on the next season, and evaluate once on an untouched final season.
3. Compare fantasy-point MAE/RMSE, rank correlation, top-N recall, and calibration by position and scoring format.
4. Beat the existing Draft Goblin model and compare favorably with the current-site baseline on the untouched season.
5. Show no material regression for QB, RB, WR, or TE, or for standard, half-PPR, or PPR scoring.
6. Confirm licensing and redistribution rights before enabling the source for users.

Until a candidate passes that gate, it remains private shadow evidence and receives zero production weight.

## Current evidence and limitations

- In the reproducible 2022 PPR common cohort, FantasyPros point projections ranked first (Spearman 0.633; rank MAE 37.3), ahead of ESPN ADP (0.571; 42.8) and Sleeper ADP (0.516; 45.3).
- The historical draft-policy study uses 2023 for training, 2024 for selection, and 2025 as an untouched holdout. It found no reliable roster-pattern edge, so historical roster-pattern weights remain disabled.
- The repository does not yet contain three legally usable seasons of timestamped preseason candidate snapshots. Therefore, it cannot honestly claim that Draft Goblin or any provider is globally optimal.

## Reproducibility

- Build the owned baseline: `npm run baseline:build -- <stats files...> <sleeper-catalog.json> data/generated/current-baseline.json`
- Run source accuracy checks: `npm run historical:accuracy`
- Fit source/position projection calibration and run 50,000 residual simulations per model: `npm run model:calibrate-sources`
- Request a slower 1,000–20,000 iteration championship evaluation from `POST /v1/evaluate/deep`; the live overlay keeps its smaller pass for one-second responsiveness.
- Run the large historical projection/ADP calibration study: `npm run model:monte-carlo-history`
- Replay anonymized historical drafts against every team's actual regular-season rank and championship result: `npm run model:replay-history`

The expanded full-rank replay contains 994 usable completed redraft leagues spanning 2018–2025. It fits on 597 leagues from 2018–2023, selects model complexity and probability temperature on 296 leagues from 2024, and uses 101 untouched 2025 leagues for the final test. On 1,176 holdout teams, draft-slot and roster-construction features achieved 51.06% pairwise rank accuracy. Championship log loss beat uniform league-size odds by only 0.00025, with a 95% bootstrap interval from -0.00046 to 0.00097. The 100,000-draw bootstrap therefore did not establish a production-worthy rank or championship improvement. The report retains every anonymous 2025 projected rank beside its actual rank for auditability.

A stricter nested walk-forward study separately tests 2022, 2023, 2024, and 2025. Each fold trains only on earlier seasons and uses the immediately preceding season for model selection. Across 921 unseen leagues and 10,962 teams, pooled pairwise accuracy was 50.49% and championship log-loss improvement was only 0.00025. Results were not season-stable: 2022 pairwise accuracy was 47.85%, and 2024 championship log loss was worse than uniform league-size odds. No fold qualified for production. Run this audit with `npm run model:walk-forward-history`.

Synthetic leagues may be used for recovery tests, sensitivity analysis, and simulator stress testing, but they are never counted as historical validation records: their outcomes are generated by assumptions rather than observed fantasy seasons.

The synthetic size-calibration suite runs 10,000 leagues for every combination of season (2018–2025) and league size (8, 10, 12, and 14), for 320,000 leagues total. It selects probability temperature on synthetic 2024 and reports synthetic 2025 separately. The resulting title probabilities are audited in probability buckets for every size, and example leagues retain each team's predicted place, generated actual place, absolute error, and predicted title chance. Run it with `npm run model:synthetic-calibration`; its report is explicitly labeled non-empirical.
- Run historical draft-policy simulation: `npm run model:simulate-history`
- Run all leakage and model tests: `npm test`

## Permanent snapshot delivery

The installed extension can update projection data without an extension-store release. A scheduled GitHub Actions workflow rebuilds and publishes the current Draft Goblin projection feed from licensed nflverse inputs. The public feed-only repository contains no private model source, training rows, credentials, or third-party projection rows. The immutable content-addressed bundle and `manifest.json` are deployed atomically to GitHub Pages.

The extension checks the manifest every four hours, at browser startup, after installation, and whenever the side panel starts. It verifies the exact byte length and SHA-256 digest, requires both daily public feeds, rejects any bundle containing provider-specific feeds, validates upstream retrieval timestamps, season, scoring format, player identities, coverage, and projection values, and retains the two newest accepted downloads in `chrome.storage.local`.

The default Draft Goblin driver uses the fresh validated daily feed. Downloaded data older than 24 hours is rejected. Network, parsing, checksum, quota, or validation failures leave the last accepted snapshot untouched and never block opening a draft.

The updater is intentionally independent of unlicensed projection providers. As of July 17, 2026, neither `sleeper-projections` nor `fantasypros-current` is approved for public redistribution in `data/source-policy.json`, and ESPN remains adapter-only. The scheduled job does not request, ingest, or publish those projection feeds. The legacy provider-consensus publisher remains fail-closed for future use only if written redistribution permission is recorded.

Operational commands:

- `npm run projections:collect-feed` remains available for private, policy-approved research but is not part of the production owned-feed workflow.
- `node scripts/publish-projection-feed.js --owned-only <output> <draft-goblin-input>` requires a freshly generated shadow-only Draft Goblin artifact, verifies the sanitized Draft Goblin-only public bundle, and writes the Pages artifact under `dist/projection-site/projections/`.
- `.github/workflows/publish-projections.yml` runs daily at 10:17 UTC and supports manual dispatch.

Relevant implementation files:

- `extension/adapters/sleeper.js` — documented draft/catalog ingestion and visible page signals
- `extension/site-projection-blend.js` — Draft Goblin-primary projection-driver selection
- `extension/sidepanel.js` — projection-driver controls and displayed source comparisons
- `scripts/build-baseline.js` — owned baseline construction
- `scripts/historical-accuracy.js` — source evaluation
- `scripts/capture-prospective-model-signals.py` — immutable private shadow evidence
- `core/recommend.js` — recommendation scoring
