# Historical projection and accuracy source inventory

This inventory records sources discovered during the July 2026 projection-data audit. “Discovered” does not mean “safe to ship,” and published accuracy percentages are not directly comparable unless they use the same players, weeks, scoring, and metric.

| Source | Coverage / value | Access | Current use |
| --- | --- | --- | --- |
| hvpkod/NFL-Data | 34,378 non-zero weekly forecasts in the imported 2021–2025 files, with actual outcomes | MIT repository; underlying Fantasy.NFL.com rights caveat | Integrated for 2021–2024 position uncertainty; 2025 diagnostic holdout |
| Fantasy Football Data Pros | 2019 ESPN weekly projections and actuals from a 20-team league | Publisher says datasets are free to download and use | Integrated as a separate accuracy report; not weighted because of one-league selection bias |
| Fantasy Football Analytics historical archive | Weekly projections back to 2015; multi-source weighted ensemble; published 2015–2025 accuracy study | Historical downloads require subscription/API | Highest-priority licensed acquisition candidate |
| ffanalytics R package | Scrapers/configurations for CBS, ESPN, FantasyData, FantasyPros, FantasySharks, FFToday, Fleaflicker, NumberFire, Yahoo, FantasyFootballNerd, NFL, RTSports, and Walterfootball | GPL code; historical scraping is explicitly not expected to work | Tooling reference only; no historical data imported |
| FantasyPros historical accuracy | Expert/site accuracy tables from 2009 onward, split by position | Public tables; full lists may require membership | Research metadata for source prioritization; not point-projection training data |
| FantasyPros historical year/week pages | Historical rankings located through `year` and `week` query parameters | Terms and redistribution permission not established | Discovery only; no automated scraping |
| ESPN projections via Wayback Machine | Potential pre-2015 snapshots with reliable archive timestamps | Archived copyrighted pages; permission not established | Discovery only; no raw data shipped |
| GridIron Data | Weekly/season projections and actuals, advertised for 2020–2025 | Commercial API, advertised at $5/month | Candidate for licensed evaluation if budget is approved |
| FantasyData | Current weekly and season projections | Commercial/sign-up access | Candidate for licensed current-source comparison |
| PFF projection feed | Weekly and rest-of-season stat projections | Explicit commercial licensing | Candidate only with a data license |
| FantasyPros 2022 fixture | Preseason projections plus actual outcomes in the existing course repository | Repository states its data are free to use | Integrated one-season preseason comparison |
| IBM/ESPN Watson study | ESPN RMSE 6.81; adjusted model 6.92; combined 6.78 for the study population | Published aggregate results, no reusable row-level dataset found | External benchmark only |
| FantasyPros accuracy methodology/results | Long-running ranking accuracy contest | Results are ranking accuracy, not fantasy-point error | Source reputation signal only; never mixed directly with MAE/RMSE |
| Academic/Stanford fantasy studies | Historical Yahoo/ESPN projection-error analyses and modeling methods | Papers generally expose results, not reusable row-level forecasts | Methodology reference only |

## Priority order

1. Evaluate permissive row-level datasets against a shared outcome/scoring pipeline.
2. Seek licensed access to Fantasy Football Analytics’ historical multi-source archive; it is the most promising way to compare many projection vendors on identical cohorts.
3. Evaluate a commercial API only if its historical snapshots are true pre-event forecasts and the license permits product use.
4. Use accuracy leaderboards only to prioritize candidates, never as substitute observations.
5. Keep archived FantasyPros/ESPN pages out of production ingestion until reuse permission is established.

## Comparable-evaluation requirements

- Snapshot captured before kickoff or before the draft season begins.
- Player identity matched without trusting later team affiliations.
- Same scoring format and player cohort for every compared source.
- MAE, RMSE, bias, rank correlation, top-N recall, and position-level results.
- Walk-forward weights: earlier seasons only, next season for selection, final season untouched.
- Coverage and missing-player rates reported alongside accuracy.

