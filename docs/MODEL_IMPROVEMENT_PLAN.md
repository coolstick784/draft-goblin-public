# Draft Goblin projection improvement plan

## Outcome

The goal is to improve Draft Goblin's independent projections while keeping the extension free, private, fast, and independent of user API keys. A candidate is not promoted because it looks closer to a provider consensus. It must improve leakage-safe prediction of later fantasy outcomes.

Production now uses the calibrated daily owned model as its default projection driver. The projection already present in the user's current draft site remains an explicit alternative. Raw ESPN/Sleeper values are not collected, transmitted, or published; only the locally selected projection may be retained in a private on-device draft report. The owned-model improvement track is separate and starts in shadow mode.

## Operational work already in place

1. `data/model-signal-policy.json` is the machine-readable source, runtime-driver, news, and promotion policy.
2. `npm run model:verify-signal-policy` fails if a restricted source is enabled, a commercial source lacks authorization, runtime weights drift, or the promotion gate is weakened.
3. `.github/workflows/capture-model-signals.yml` captures lawful structured signals every day at 10:47 UTC.
4. Each private evidence archive contains the raw licensed input, pre-event timestamp, source URL, response metadata when available, byte count, SHA-256, license, and an explicit `eligibleToAffectProduction: false`.
5. Evidence is retained as immutable assets on a prerelease in the private source repository. It is never read by the extension or copied to the public feed.

The first capture set is:

- nflverse weekly rosters: required; current team, active status, and roster movement.
- nflverse injuries: optional until the season file is published; injury and practice status.

The `nflverse-data` repository labels these releases CC-BY-4.0, while nflverse also cautions that underlying NFL data can remain subject to the respective owners' terms. The private evidence manifest records that caveat; raw rows are never placed in the extension or public feed, and each dataset receives a separate rights review before any expanded use or model promotion.

The capture job fails if a required source disappears, retries transient failures, and records an optional 404 without breaking the daily production projection publisher.

## Candidate sequence

### 1. Structured role and availability model

Start with signals that describe opportunity without scraping articles:

- current depth-chart role and movement;
- roster additions, releases, IR/PUP status, and team changes;
- injury designation and practice participation;
- recent snap/route/target/carry opportunity when the season is active;
- rookie draft capital and experience, which are already present in the owned model.

Build two frozen candidates: a role/availability adjustment and a no-adjustment control. Generate both from the same pre-event snapshot. The candidate may reduce expected games or expected opportunity; it may not use post-event status or realized fantasy points.

### 2. Expected-opportunity bakeoff

Evaluate `ffopportunity` only after confirming the share-alike obligations for the exact dataset and derived artifacts. Test whether expected carries/targets/air yards improve the owned model beyond its existing box-score and depth features. Keep it shadow-only unless its chronological holdout wins.

### 3. Licensed vendor bakeoff

If structured open signals are insufficient, price and test one commercial source at a time:

- SportsDataIO commercial projections/injuries/news;
- FantasyPros Commercial API.

Before collection, record the contract/authorization ID and verify automation, retention, training/feature use, and derived-output/redistribution rights. Personal/free plans and visible web pages are not candidates. Vendor rows remain private, and only an authorized final derived projection could ever be published.

### 4. News extraction only if it adds measurable value

Do not scrape publisher articles. Structured injuries, transactions, depth changes, and practice participation cover the highest-value news events with much lower legal and parsing risk. If a licensed news feed is acquired, extract only versioned event fields such as player, event type, effective time, confidence, and expected-games/opportunity adjustment. Do not redistribute article text.

The news candidate must beat the structured-events candidate on the same frozen folds. If it does not, remove it rather than keeping an expensive noisy feature.

## Evaluation and promotion

Every candidate is evaluated by position and scoring format using at least three timestamped seasons:

1. Train only on earlier seasons.
2. Select model family and hyperparameters on the next season.
3. Evaluate once on an untouched final season.
4. Use season-block bootstrap intervals so many players from one season are not treated as independent seasons.
5. Compare against the production Draft Goblin model and the current-site projection when it was captured in-browser with user consent for local evaluation.

Promotion requires all of the following:

- at least 2% lower overall MAE and RMSE on the untouched season;
- no more than 1% worse MAE for QB, RB, WR, or TE;
- Spearman rank correlation no more than 0.01 below either required baseline;
- top-tier recall no more than 0.02 below baseline (top 12 QB/TE, top 24 RB/WR);
- no leakage, timestamp, identity, source-policy, or license failure;
- deterministic regeneration from hash-pinned inputs;
- a separately reviewed weight change. K remains 20% owned and D/ST remains 0% owned until their own gates pass.

Passing historical backtests is necessary but not sufficient. The first production claim of improved 2026 accuracy must wait for realized 2026 results.

## Release path

1. Candidate code and evidence stay in the private repository.
2. Shadow output is compared with the unchanged production feed; it cannot change recommendations.
3. A signed-off promotion report pins input hashes, code commit, metrics, thresholds, and license decisions.
4. Only the final sanitized Draft Goblin output is sent to `coolstick784/draft-goblin-projections`.
5. Daily public feed refreshes continue without an extension update. Runtime code changes still require reloading the private unpacked extension, not publishing it to the Chrome Web Store.

## Commands

- Verify the policy: `npm run model:verify-signal-policy`
- Capture a private season snapshot: `npm run model:capture-signals -- --season 2026 --output data/private/prospective-model-signals/manual`
- Run capture unit tests: `python owned_model/test_capture_prospective_model_signals.py`
- Run the complete test suite: `npm test`
