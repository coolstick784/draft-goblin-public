# Draft Goblin owned projection model

The owned model is an independent shadow candidate. It does not use ESPN, Sleeper, or FantasyPros projections as features or labels, and it has zero influence on the extension's current three-source consensus.

## Architecture

The candidate builds player-season examples from nflverse regular-season player/team statistics, static player metadata, depth charts, and draft results. Every example for season `Y` is constructed only from information available before that regular season. It models expected games, standard points per game, and PPR points per game separately for QB, RB, WR, TE, K, and DST, then reconstructs standard, half-PPR, and PPR season totals.

Three model families are stacked:

1. A recency-weighted empirical model with experience-aware regression to position priors.
2. Standardized ridge regression.
3. Robust histogram gradient boosting.

Stacking weights are nonnegative, sum to one, and are selected from expanding-season out-of-fold forecasts. The checked-in research report records the learned weights and candidate-versus-empirical metrics. Uncertainty ranges use out-of-fold season-total residuals rather than invented percentage bands.

The current version includes a specialist K model and a separate team-level DST target. K outcomes and lag baselines use [ESPN's default scoring](https://support.espn.com/hc/en-us/articles/360003914032-Scoring-Formats): 3 points through 39 yards, 4 at 40-49, 5 at 50-59, 6 at 60+, 1 per PAT, and -1 per missed field goal. DST points use ESPN's current points-allowed buckets plus sacks, turnovers, defensive/special-teams touchdowns, and safeties. The season-level inputs cannot attribute blocked kicks to the opposing DST, so those events are recorded as a limitation instead of guessed. A strict temporal selector falls DST back to the six-PPG prior whenever the learned residual regresses overall or in any held-out season.

Current rookies are admitted through canonical GSIS IDs, ESPN-backed provisional identities, or an unambiguous name-position fallback. The [nflverse draft-picks dataset](https://github.com/nflverse/nflverse-data/releases/tag/draft_picks) fills missing draft capital only when draft season equals rookie season; existing metadata is never overwritten. Version 2026.12 projects all 231 eligible current rookies, connects 220 to a current depth role, and assigns verified draft capital to 81 fantasy-position draftees. Dated historical depth charts use the last snapshot strictly before the first regular-season date. K/PK players present at that cutoff but absent from the completed stats release are restored as zero-game, zero-point outcomes, avoiding participant-only survivorship bias.

Version 2026.12 adds a WR-rookie direct-total specialist while retaining the existing base forecast for every other cohort. Its histogram-gradient model and fixed 50% STD / 75% PPR specialist blends were selected once on the unseen 2022 season. In the original participant-only 2023-2025 WR harness, the locked policy improved MAE, RMSE, absolute bias, and Spearman rank correlation in both formats; aggregate STD MAE fell from 26.07 to 24.21 and PPR MAE from 38.80 to 35.43. A later exact-ID drafted-WR robustness audit added known zero-recorded totals. Error and bias still improved in every fold, but PPR rank regressed in 2024 and 2025 and aggregate rank slipped slightly. The broader rookie specialist was rejected because QB, RB, and TE folds were not stable. The WR specialist therefore remains an experimental shadow candidate, not a claim of universal retrospective improvement or promotion evidence.

## Commands

Install the isolated Python requirements:

```sh
python -m pip install -r requirements-owned-model.txt
```

Fetch the expressly attributed nflverse inputs into the ignored private cache:

```sh
python scripts/fetch-owned-model-data.py --end-season 2025
```

Train, walk-forward evaluate, and generate the 2026 candidate:

```sh
python scripts/train-owned-model.py --season 2026
```

Outputs:

- `data/private/owned-model/model.joblib`: ignored trained estimator.
- `data/generated/owned-projections-2026.json`: shadow candidate.
- `data/research/owned-model-walk-forward.json`: development evidence.

The scheduled `owned-model-shadow.yml` workflow repeats this process and
retains the candidate and evidence as workflow artifacts. On public
repositories it also creates a GitHub/Sigstore provenance attestation for the
input manifest, verifier receipt, candidate, report, and policy. It cannot
deploy to GitHub Pages or modify promotion policy.

## Consensus shadow comparison

The local shadow evaluator can compare a frozen owned candidate with frozen ESPN, Sleeper, and FantasyPros snapshots:

```sh
node scripts/evaluate-owned-shadow.js <owned.json> <espn.json> <sleeper.json> <fantasypros.json> <report.json>
```

The output contains only aggregate distances, correlations, counts, and input hashes. It mirrors live source renormalization over every player having at least one source and reports the all-three subset separately. Provider rows are not copied into the report and never enter model training.

The prospectively tested replacement is preregistered as a position-aware
overlay: 50% owned / 50% consensus for QB, RB, WR, TE, and K, but
consensus-only for DST because the owned DST safety selector rejected its
learned ranking. The 50% default is the largest five-percentage-point step that
passes the all-format closeness constraints before outcomes are known; 55%
would exceed the p90 distance limit. The complete STD/HALF/PPR freeze dry run covers 1,683
paired rows and all 18 format-position slices with 0.974 rank correlation,
0.108 median standardized distance, and 0.389 90th-percentile distance. The
pure owned forecast remains separately reported for research.

## Prospective freeze

Before the first regular-season game, freeze the exact owned candidate, final
weighted live consensus, and private source comparison evidence into an
ignored ledger:

```sh
npm run owned:refresh-final -- data/snapshots 2026-09-09T00:00:00Z
```

This cross-platform final-refresh command first downloads the current licensed
nflverse inputs through the completed 2025 season plus the latest dated 2026
depth chart into a new ignored staging directory. It trains a staged model,
report, and v2026.12 candidate; reproduces the candidate independently from
the staged saved estimator; runs the complete Python artifact verifier; verifies the candidate, report, and
projection-model policy all remain explicitly shadow-only; writes exact input
and output digests; runs the normal freeze preflight; and atomically installs
`data/private/owned-model/final-refresh-2026/`. It refuses overwrite and removes
staging on any failed download, training, verification, or cutoff check, so a
mixed input cache or half-refreshed candidate cannot pass freshness. It never
freezes, promotes, deploys, or changes the live consensus. Set
`OWNED_MODEL_PYTHON` when `python`/`python3` is not the desired interpreter.

The owned candidate and all six final provider snapshots must each be no more
than 72 hours old relative to the cutoff. Refresh near the cutoff; a July
candidate is deliberately rejected even if its provider snapshots are fresh.
After a successful refresh, the read-only preflight can also be rerun directly:

```sh
npm run owned:preflight-freeze -- data/private/owned-model/final-refresh-2026/owned-projections-2026.json data/snapshots 2026-09-09T00:00:00Z
```

All final preflight and freeze commands use the atomically installed pinned
candidate. The immutable freeze refuses any candidate not bound to that
installation's complete manifest, saved-model reproduction, artifact-verifier
receipt, complete evaluable 18-slice preflight, and unchanged projection-model
policy.
The July `data/generated` shadow remains a development artifact and
is intentionally too stale for final evidence.

The preflight is read-only. It reconciles provider IDs, requires at least ten
joined rows in each of all 18 format-position slices, and reports the same
consensus-closeness diagnostic as the immutable command. Closeness does not
authorize or block pure-owned replacement evidence. It also reports whether all six raw STD/PPR inputs are
within 72 hours of the cutoff and separately reports owned-candidate freshness.
Run it freely as snapshots change. The immutable command refuses stale source
inputs or a stale owned JSON. When the final preseason inputs are ready, freeze once:

```sh
npm run owned:freeze-latest -- data/private/owned-model/final-refresh-2026/owned-projections-2026.json data/snapshots data/private/owned-model/prospective-2026.json data/research/owned-prospective-freeze-2026.json 2026-09-09T00:00:00Z
```

This is the preferred operational command. It selects the latest eligible
pre-cutoff ESPN, Sleeper, and FantasyPros STD/PPR snapshots and derives each
source's half-PPR points as the arithmetic midpoint of matched standard and PPR
rows. It fails closed if any source or format is absent. Lower-level immutable
capture is intentionally unavailable because it could bypass the verified
final-refresh manifest. The command refuses to overwrite either output or accept a candidate, snapshot, or
freeze time after the preregistered cutoff. The ignored private ledger retains
salted identity hashes, the owned value, the final weighted consensus, and the
exact three source projections needed to prove individual-source superiority.
Provider values never enter a public artifact. The public receipt contains
only the ledger digest, input digests, aggregate coverage, and no player
identities or source rows.

The freeze stages the private ledger, its separate SHA-256 anchor, and the
public receipt before installing immutable destinations. If private evidence
installs but receipt publication fails, the ledger and anchor are preserved.
Recover the aggregate receipt without recapturing or overwriting evidence:

```sh
npm run owned:recover-freeze-receipt -- data/private/owned-model/prospective-2026.json data/research/owned-prospective-freeze-2026.json
```

Recovery verifies the exact private bytes against the independently installed
digest anchor before reconstructing the public receipt.

The aggregate receipt must then receive an external pre-cutoff timestamp. The
dedicated `attest-owned-prospective-freeze.yml` workflow validates that the
receipt contains no private rows or source values, fails if its runner starts
after the cutoff, and submits three checksum-only subjects to GitHub/Sigstore:
the private candidate digest, private-ledger digest, and public-receipt digest.
It uploads none of those private bytes. GitHub's free attestation service
requires a public repository. Because the main `ffb` repository is private,
copy the preinstalled workflow and validator to a small public evidence
repository before September, then push only
`data/research/owned-prospective-freeze-2026.json`. Verify the resulting
attestation with:

Prepare the clean repository contents locally first:

```sh
npm run owned:prepare-public-evidence-repo
```

The preparer refuses overwrite, copies only the checksum validator and
attestation workflow, adds the required ESM package boundary, and emits an
exact allowlist manifest under the ignored
`data/private/owned-model/public-evidence-repo/`. It cannot copy the dirty main
worktree, source snapshots, model binaries, private ledgers, or provider rows.
After creating the public repository, publish only that prepared directory.

```sh
gh attestation verify data/research/owned-prospective-freeze-2026.json --repo <owner>/ffb-evidence
```

Here, “owned value” means the preregistered position-aware candidate; the
public receipt records the 0.5 default plus exact per-position weights,
including `DST: 0`.
The same immutable ledger retains the exact pure independent owned projection
separately from the position-aware overlay and consensus. Provider values and
pure-owned player rows remain private. Only aggregate outcome metrics are
published. The overlay is a non-authorizing product diagnostic: it cannot prove
that the owned model can replace its source inputs. Runtime replacement requires
the pure owned forecast itself to pass every consensus, ESPN, Sleeper,
FantasyPros, format-position, season, error, bias, RMSE, and rank gate. The four
primary superiority claims use Bonferroni-adjusted simultaneous intervals.
Each claim must remain supported under both stable private player clustering
across seasons and team-season clustering; the more conservative bound is used.

The ledger also retains a diagnostic-only no-specialist base overlay for
matched WR rows whose specialist forecast differs from the owned base
forecast. This resolves the
specialist's error-versus-rank tradeoff prospectively. The diagnostic is
explicitly ineligible for promotion, does not alter the primary candidate,
and emits only aggregate metrics after outcomes are complete.

After the season is complete, build private nflverse outcomes and score the
unchanged ledger:

```sh
python scripts/build-owned-outcomes.py --season 2026 --complete
npm run owned:score-season -- data/private/owned-model/prospective-2026.json data/research/owned-prospective-freeze-2026.json data/private/owned-model/outcomes-2026.json data/research/owned-prospective-outcomes-2026.json
```

The outcome builder requires the atomically pinned final candidate by default.
It emits exactly that preseason population: players with completed stats
receive recorded STD/HALF/PPR totals, while frozen players absent from the
completed production release receive zero recorded fantasy production—not an
invented zero-games label. Scoring verifies the candidate digest and refuses
participant-only, incomplete, or identity-attrited outcomes.

The public outcome report is aggregate-only and separately reports the
all-three-source cohort. Neither command changes runtime or promotion policy.

## Prospective availability evidence

The 2026 roster/availability source is being collected prospectively because
current historical nflverse roster and injury assets cannot prove their bytes
were frozen before earlier seasons began. This evidence is not a model feature
and has no runtime effect.

Run the no-key, read-only preflight before the fixed cutoff:

```sh
npm run owned:preflight-availability
```

It downloads the two public nflverse release assets into memory, validates the
2026 season and required schemas, requires an `ETag` or `Last-Modified` header,
and reports `not-published` cleanly when either asset is absent. It writes
nothing. Preflight may run at any time, but `readyToFreeze` remains false until
the final 72 hours before the cutoff so an irreversible early-season snapshot
cannot masquerade as final preseason evidence. The weekly roster is required. Injury bytes are optional only when
the release URL returns an explicit 404 at the final cutoff; that unavailable
status is retained in the receipt so valid roster evidence is not discarded.
Network failures, invalid published bytes, and missing HTTP validators still
fail closed. The cutoff is `2026-09-09T00:00:00Z`, strictly before the first
regular-season kickoff at `2026-09-10T00:20:00Z`, as listed in the
[official NFL Week 1 schedule](https://www.nfl.com/news/2026-nfl-schedule-release-complete-slate-of-week-1-games).

Once the required roster and any already-published optional injury asset pass
validation before the cutoff, freeze the evidence exactly once:

```sh
npm run owned:freeze-availability
```

Run the freeze as close as operationally practical to the final cutoff to
maximize the chance that the optional injury file is included. `capturedAt`
records completion of both HTTP requests, not their start; a request that
finishes after the cutoff is rejected.

The immutable command writes the exact CSV bytes and a private manifest under
ignored `data/private/owned-model/availability/2026/`. The checked-in public
receipt is `data/research/owned-availability-freeze-2026.json` and contains
only source URLs, capture and boundary timestamps, HTTP validators, byte and
row counts, SHA-256 values, and schema hashes. It contains no player rows. The
command refuses overwrites, partial evidence, invalid schemas or seasons, and
any collection after the cutoff.

Writes are staged before the private directory is installed. If the private
rename succeeds but publishing the public receipt fails, the exact private
bytes and manifest are preserved. After fixing the filesystem issue, rebuild
the aggregate-only receipt deterministically:

```sh
npm run owned:recover-availability-receipt
```

An alternate cutoff may be supplied only when it is still before kickoff:

```sh
npm run owned:preflight-availability -- 2026-09-08T12:00:00Z
npm run owned:freeze-availability -- 2026-09-08T12:00:00Z
```

This is evidence collection only. A later reviewed research change must define
and prospectively score any roster or injury feature before it can enter the
owned model.

Once the policy's required completed preseason seasons exist, an ignored
manifest can list each private ledger, public receipt, and private outcomes
file. Run `npm run owned:evaluate-promotion -- <manifest.json> <report.json>`.
The evaluator reconstructs salted paired rows only in memory and writes an
aggregate gate report. Even a passing report leaves runtime disabled until a
separate reviewed policy change pins the exact candidate and evidence hashes.

## Promotion boundary

`data/projection-model-policy.json` is separate from data-source licensing policy. A model can affect runtime only when all of the following are true:

- At least three completed, timestamped prospective shadow seasons exist,
  beginning with 2026.
- The adaptively reused 2023-2025 development seasons are excluded from
  replacement evidence and cannot be declared prospective.
- Every season carries the same immutable model-recipe digest and verified
  training-source policy: nflverse supplies projection features; the Sleeper
  catalog is identity-only; ESPN, Sleeper projections, and FantasyPros are
  prohibited as owned-model features.
- The pure independent owned forecast—not its consensus-anchored overlay—beats
  the current consensus MAE by at least 2%.
- A paired, simultaneous-error-controlled clustered interval supports the improvement.
- On each provider's own matched cohort, MAE beats ESPN, Sleeper, and
  FantasyPros by at least 1%, the paired interval establishes improvement,
  and RMSE/rank guards pass.
- Completed outcomes cover the exact hashed frozen-candidate population;
  participant-only or identity-attrited outcome files are rejected.
- RMSE, bias, rank, and every QB/RB/WR/TE/K/DST format-slice guard passes.
- An explicit reviewed policy record marks the exact candidate and evidence hashes as `promoted`.

The position-aware overlay and its closeness metrics remain reported, but are
explicitly non-authorizing. A perfect overlay result cannot mask a worse pure
owned forecast, including at DST, and an overlay closeness failure cannot
discard an otherwise valid pure-owned prospective evaluation.

Evaluation is deliberately incapable of promoting a model. The present candidate is `shadow`, `eligibleAsLiveProjection: false`, and must remain invisible to the extension.

Even a reviewed policy cannot feed the extension directly. After a future
aggregate promotion report proves `evaluationTarget:
pure-independent-owned`, the policy must explicitly pin the raw candidate and
report hashes, gate version 2, and reviewed promoted status. Only then can the
fail-closed builder create a pure-owned runtime artifact:

```sh
npm run owned:build-runtime-bundle -- <owned-candidate.json> <promotion-report.json> data/projection-model-policy.json <runtime-bundle.json>
```

The builder parses the report rather than trusting an opaque evidence hash. It
requires independent-owned replacement eligibility, same-season candidate
provenance in the frozen source evidence, every exact policy hash, and a pure
owned target. Consensus-anchored or merely hash-correct evidence is rejected.
The current shadow policy therefore cannot produce a runtime bundle.

## Known limitations and next research increments

Development backtests are not proof of superiority over the current consensus. Version 2026.12 retains the v2026.11 base improvements and adds only the separately gated WR-rookie specialist described above. The corrected K cohort covers 127 rows and beats baseline MAE and RMSE in each 2023-2025 fold. The learned DST residual still fails its safety gate and is replaced by the constant prior in the prospective overlay. The current live-shaped comparison covers 558 players at 0.8998 rank correlation. The older 104-player all-three subset remains as a diagnostic, but it is not the primary current-standard claim because it contains only four wide receivers. A broad market-defined shadow benchmark now covers essentially every likely drafted player, while the first honest realized-outcome superiority comparison remains the frozen 2026 preseason candidate versus the frozen 2026 consensus after outcomes exist.

The all-three-source shadow now defines the current worst-provider comparison
without letting a provider benefit from its own consensus weight: ESPN,
Sleeper, and FantasyPros are each compared with the weighted consensus of the
other two, while pure owned is compared with the full three-source consensus.
On the 104-player cohort, the weakest provider-peer rank correlation is 0.9742.
Restoring the target-season depth-chart snapshot to the reproducible data fetch
raises the raw expected-value owned model from 0.8387 to 0.8695 rank correlation
and reduces MAD from 39.20 to 36.56. A separate lawful 2026 Fantasy Football
Calculator ADP screen matches 88 of those players after correctly normalizing
FFC's `PK` position label to `K`. Its initial
adaptive ordering variant raises rank correlation from 0.8662 to 0.9432 but
still fails point-scale and tail-distance thresholds. The raw ADP snapshot is
private, the checked-in report is aggregate-only, and this current-consensus-
tuned screen cannot authorize production or substitute for realized outcomes.
A second screen assigns the FFC within-position order a point scale learned
only from median realized position-rank totals in completed 2021-2025 seasons.
That fixes the scale and tail errors (0.334 median and 2.070 P90 standardized
distance) but reaches only 0.9069 rank correlation and 26.90 MAD, so it also
fails the worst-provider threshold. An active-role convention diagnostic gives
current depth-chart starters 17 games, then blends those totals with the same
completed-season rank curves. Its best adaptive screen reaches 0.9686 rank
correlation, 18.97 MAD, 0.510 median standardized distance, and 1.829 P90
distance. The three distance gates pass, but rank remains below 0.9742. A
second lawful FFC two-QB market did not improve quarterback ordering.

A fixed current-market position policy closes the remaining convention gap
without using provider projections or provider coverage at inference. Offensive
positions use the completed-2021-2025 position-rank curve, FFC order reassigns
the owned kicker and quarterback distributions, and DST blends 20% of its
historical rank curve with the owned prior. The policy was selected against the
current provider benchmark, so it remains an adaptive shadow rather than
prospective evidence.

The primary broad benchmark is the 217-player FFC 12-team PPR draft market.
Draft Goblin covers 215 players (99.08%); Brandon Aiyuk and Travis Hunter are the
two explicit owned-model exceptions. Every covered player has at least one
point-projection provider and 202 have two or more. Identity reconciliation uses
accent-insensitive player names and team identity for defenses, preventing
`PK`/`K`, `DEF`/`DST`, and defense-name formatting from shrinking coverage.

For each provider, both the provider and Draft Goblin are compared with the
same leave-one-provider-out peer consensus on the exact same player cohort.
The raw provider-independent candidate dominates ESPN across 171 players and
Sleeper across 202 players on rank correlation, MAD, median standardized
distance, and P90 standardized distance.

The displayed shadow adds a provider-range smoothing layer. Values inside the
available provider range are unchanged. Every value above or below that range
is continuously compressed toward the nearest boundary using a symmetric
`tanh` transform. The exported `smoothingPoints` parameter defaults to 20, so
the residual excess approaches but never reaches 20 points; unlike a hard
clamp, every outside value receives a proportional adjustment. The audit
retains raw and smoothed metrics separately. It adjusts 126 of 215 drafted
players with a mean absolute change of 1.74 points and zero violations of the
smoothing envelope. Against Sleeper, the smoothed shadow records 0.97573 rank
correlation, 16.16 MAD, 0.331 median standardized distance, and 0.850 P90
distance versus 0.96341, 20.81, 0.369, and 1.958. It also beats the weakest
provider's within-position market-rank correlation at QB, RB, WR, TE, K, and
DST. The aggregate evidence is
`data/research/owned-model-broad-drafted-shadow.json`.

Because the smoothing layer consumes current provider values, it is not
independent evidence and cannot authorize promotion. The raw metrics remain
the relevant independent comparison; the smoothed value is an operational
outlier guard only.

The corresponding all-player PPR artifact is rebuilt without provider inputs:

```sh
npm run owned:build-market-shadow -- data/generated/owned-projections-2026.json data/private/owned-model/market/ffc-2026-ppr-12.json data/research/historical-position-rank-ppr-curves.json data/generated/owned-market-shadow-2026.json
```

It is intentionally marked `runtimeStatus: shadow`,
`eligibleAsLiveProjection: false`, and every player row is recommendation-
ineligible. It cannot enter the extension through the runtime bundle path.

This satisfies the broad current relative-consensus floor, not the realized-
outcome promotion gate. The FFC collection window ends after the retained
provider snapshots, the weights were developed adaptively, and no 2026 outcomes exist.
The candidate therefore remains evaluation-only and ineligible for live
promotion pending the immutable prospective process.
The legacy all-three report and timestamp series remain checked in to document
the earlier narrow experiment. They must not be used to substitute for the
broad drafted-player gate.

The following isolated candidates were tested and rejected rather than folded
into the model:

- Offensive zero-outcome restoration improved some pooled metrics but failed
  chronological bias, rank, MAE, or RMSE guards at every offensive position;
  absence from player stats also does not prove zero active games.
- The draft-defined rookie audit found 172 exact-ID drafted skill players
  (18.1%) with no player-stat row from 2014-2025. Participant-only means were
  about 22.9% above the complete drafted cohort; for the WR policy's 2023-2025
  development window, the gap was 10.5% STD and 10.3% PPR. Draft results make
  zero recorded offensive production defensible for this bounded cohort, but
  cannot establish zero games and omit undrafted rookies, so no policy changed.
- A follow-up scored the locked WR policy on all 98 exact-ID drafted WRs in the
  2023-2025 development folds, including nine zero-recorded totals and two
  position-reclassified stat rows. The incumbent-trained specialist still
  improved MAE, RMSE, and absolute bias in every fold, but PPR rank regressed
  in 2024 and 2025 and aggregate rank slipped in both formats. Training the
  specialist on prior bounded zero totals also failed the every-metric gate.
  This invalidates an all-metric robustness claim but does not alter v12.
- Draftable-cohort stack weighting and joint season-total optimization
  overfit earlier folds and materially regressed in 2025.
- A broad rookie specialist improved pooled rookie error but failed QB, RB,
  and TE folds; only the independently gated WR policy survived.
- Direct season-total models, additional tree-ensemble families, physical and
  lifecycle metadata, and expanded veteran-efficiency features all failed at
  least one full-field, draftable-cohort, position, or temporal guard.
- Team reconciliation, kicker calibration variants, and learned DST
  preseason residuals improved selected aggregates but failed the
  every-fold safety rule.
- Depth-based opportunity allocation and prior-only schedule/team-environment
  features failed full-field or chronological guards.
- Rookie/veteran conformal uncertainty bands marginally improved pooled
  calibration but widened intervals and regressed ten adequately sized
  temporal cohorts.
- Lawful nflverse combine and Next Gen Stats features improved selected
  aggregates but failed bias, rank, coverage, or later-fold guards.
- Prior-season offensive snap-share features covered 89% of veteran examples
  but failed every position's locked all-fold gate. A direct season-total
  residual learner also selected the incumbent identity blend for all 12
  position/format policies.
- A fixed prior-season final-six role-momentum family made locked-cohort MAE
  worse for RB, WR, and TE and was rejected without changing production.
- Prior-season official injury/practice burden modestly improved aggregate QB
  and WR games and total-point errors, but failed chronological fold and bias
  guards; RB and TE regressed. It is retained as a rejected research result,
  not selectively adopted.
- Historical depth charts use the contemporaneous `STL`, `SD`, and `OAK`
  abbreviations while nflverse season stats normalize those franchises to
  `LA`, `LAC`, and `LV`. A fixed alias-join correction changed 878 depth roles
  and 172 model rows. It modestly improved selected QB/TE aggregates but
  regressed required draftable-cohort, fold, RMSE, bias, or rank guards at
  every offensive position, so the model recipe remains unchanged.
- A follow-up split the existing aggregate roster context into same-team
  incumbents, incoming veterans, genuinely vacated carries/targets/PPR, and
  top-three depth additions/losses. It covered 78.6% of the 2023-2025
  offensive evaluation rows. Some QB draftable-cohort errors improved, but
  the complete QB veteran/fold/rank policy failed and RB/WR/TE regressed, so
  none of the churn features entered the candidate.
- A fixed offensive head-coach family used only target-season Week-1 coach
  identity plus prior-season continuity, entering tenure, and shrinkage-
  weighted historical plays, pass rate, yards/play, touchdowns, and scoring.
  It improved selected QB, RB, and WR aggregates but failed complementary
  formats, draftable cohorts, or chronological folds at every position. It
  remains a rejected research result rather than a selectively applied signal.
- The complete 2025 nflverse play-participation release became available in
  February 2026, closing the previously noted freshness gap. A fixed
  2018-2025 audit then measured prior offensive-play share, same-position
  share, active-game share, and shotgun/under-center/11-personnel opportunity.
  It covered 75.7% of 2023-2025 offensive rows and improved selected RB/TE
  error and bias measures, but every position failed a required format,
  cohort, fold, or rank guard. The feature family was rejected.
- Retrospectively collected Sleeper draft ADP correlated with outcomes, but it
  lacks retained pre-kickoff timestamps and comes from a survivor-selected
  user-network sample. It is rejected as a model feature; a future ADP signal
  would need a prospectively frozen sampling manifest and immutable receipts.
- Rank-preserving additive, scale, and positive-affine season-total
  calibration all failed the 2022 full-field or draftable admissibility gate;
  identity was the only admissible policy and cannot strictly improve MAE.
- Fixed 4x starter / 2x other top-three / 1x remaining role weights worsened
  aggregate draftable MAE by 0.74 STD and 0.72 PPR points and produced broad
  position-fold regressions, so role-weighted component fitting was rejected.
- Five-knot position/format quantile calibration was inadmissible in all 12
  2022 selection cells; identity remained locked for 2023-2025 evaluation.
- Target-season Week-1 nflverse game totals, signed spreads, implied team
  points, home status, and named quarterbacks covered 91.1% of model rows.
  Quarterback aggregate errors and full-cohort rank improved, but 2025 and
  draftable-cohort guards regressed; every position and the pooled candidate
  failed the complete chronological policy, so the family was rejected.

Their reproducible harnesses are retained under `scripts/research-*.py`, with
aggregate reports under `data/research/`, so failed searches are not silently
repeated or mistaken for accepted evidence.

Repeated adaptive use of the same 2023-2025 folds now creates more
multiple-testing risk than trustworthy information. Retrospective feature
search is therefore paused. The next model increment is the immutable,
prospective 2026 roster/injury freeze, followed by realized-season scoring.
Only new timestamped evidence or a genuinely new preregistered holdout should
justify another shadow-model change.

### Daily refresh operations

Both scheduled GitHub workflows run every day. The public publisher rebuilds
the owned projections, refreshes the licensed Fantasy Football Calculator
market snapshot, builds the provider-independent market shadow, and runs the
ESPN, Sleeper, FantasyPros, and provider-range smoothing contract tests before
it can publish. The research workflow retains the timestamped FFC input and
resulting market-shadow artifact for each run.

ESPN remains an authenticated, in-browser adapter: it refreshes from the
user's open draft rather than exporting session credentials to GitHub Actions.
Sleeper's local runtime connector retries the live endpoint and labels its
bundled-data fallback explicitly. FantasyPros retries transient failures and
uses its official API whenever a server-side key is configured. Current
provider rows are not added to the public daily feed unless
`data/source-policy.json` records redistribution permission; smoothing is
applied locally from the current provider values.
