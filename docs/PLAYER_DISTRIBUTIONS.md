# Player probability distributions

## Status and integration contract

Draft Goblin supports the `player.distribution` contract below and samples an accepted promoted curve directly. A missing, rejected, or unsupported scoring format uses the legacy position-level `mean`, `floor`, and `ceiling` simulator unchanged.

A player-aware weekly backtest joins pre-week projections to nflverse weekly rosters and statistics, then models performance only on 25,144 active-observed rows. It uses 2021-2022 for training, 2023 for shrinkage selection, and 5,597 untouched 2024 player-weeks for evaluation. Heavily shrunk player residual quantiles improved holdout weighted interval score by 0.21%; P10-P90 coverage moved from 79.56% to 79.97%. A 2,000-draw player-season cluster bootstrap placed the raw score improvement between 0.0055 and 0.0199, with positive results at QB, RB, WR, and TE. K regressed by 0.08% and stays position-only.

The production season model is a direct empirical distribution of active-role season actual/projected ratios by position and projected-volume tier, with player location effects heavily shrunk toward the tier. Parameters are selected across rolling 2022 and 2023 folds; a position is personalized only after at least 100 validation seasons and improvement in both folds. On untouched 2024 data, the scoped QB/TE half-PPR policy improved weighted interval score by 0.71%, moved coverage from 74.45% to 75.11%, and produced a clustered 95% gain interval of 0.055 to 0.338. Standard scoring independently passed and promotes QB/WR personalization. RB, half-PPR WR, TE in standard, kicker, and every PPR player retain the position fallback because their player effects did not clear the same gate.

The executable decision is therefore `promote-scoped`, not universal promotion. Performance distributions are conditional on active role and compose with the separate 2026 availability model. The failed P10 decision heuristic is not used by runtime ranking.

Forward-looking `stable` and `boom-bust` labels are withheld. Prior-only labels separated the downside tail, but the pooled upper-tail contrast had a 95% interval of -1.76 to 5.16 percentage points. The promoted model also applies no rookie multiplier: true-rookie validation selected 1.10 rather than 1.20, but its clustered confidence interval crossed zero. Rookies therefore use the promoted position-volume distribution until stronger evidence exists.

The contract intentionally separates three concerns:

1. `player.distribution` is the marginal fantasy-performance curve conditional on the player having an active role.
2. `player.availability` owns injury, inactive, and limited-role probabilities.
3. A versioned scenario/correlation model composes teammates and shared football environments. Correlation coefficients do not belong in an individual player's marginal curve.

This prevents injury uncertainty from manufacturing upside, prevents missed games from being counted twice, and lets the same calibrated marginal distribution be tested independently from correlation assumptions.

## `quantile-v1` schema

The canonical shape is:

```json
{
  "distribution": {
    "schemaVersion": "quantile-v1",
    "unit": "season-fantasy-points",
    "season": 2026,
    "scoringFormat": "ppr",
    "conditionedOn": "active-role",
    "mean": 204.3,
    "quantiles": [
      { "p": 0.01, "value": 76.1 },
      { "p": 0.05, "value": 111.4 },
      { "p": 0.10, "value": 132.0 },
      { "p": 0.20, "value": 154.3 },
      { "p": 0.30, "value": 171.0 },
      { "p": 0.40, "value": 186.2 },
      { "p": 0.50, "value": 200.1 },
      { "p": 0.60, "value": 215.8 },
      { "p": 0.70, "value": 232.4 },
      { "p": 0.80, "value": 251.8 },
      { "p": 0.90, "value": 278.1 },
      { "p": 0.95, "value": 300.2 },
      { "p": 0.99, "value": 342.7 }
    ],
    "provenance": {
      "modelId": "hierarchical-player-quantiles",
      "modelVersion": "2026.1",
      "calibrationId": "walk-forward-2025",
      "generatedAt": "2026-07-14T12:00:00.000Z",
      "forecastAsOf": "2026-07-14T11:55:00.000Z",
      "trainedThrough": "2026-02-10T00:00:00.000Z",
      "sourceSnapshotIds": ["espn:2026:ppr:2026-07-14"],
      "estimationLevel": "player"
    },
    "correlationRefs": [
      { "kind": "offense", "key": "offense:2026:CHI" },
      { "kind": "pass-game", "key": "pass-game:2026:CHI" }
    ]
  }
}
```

The probability grid is fixed at P01, P05, P10, P20, P30, P40, P50, P60, P70, P80, P90, P95, and P99. A fixed grid makes interpolation, storage, calibration reporting, and cache identity deterministic. Values must be finite and non-decreasing. `mean` is the model's integrated conditional expectation; it is not inferred from P50 and need not equal the median.

`scoringFormat` is `standard`, `half-ppr`, `ppr`, or `custom`. A custom scoring model must also be identified in the enclosing draft settings and cache fingerprint. A distribution is usable only when its season and scoring format match the draft.

### Provenance and fallback levels

Every curve records the exact forecast model, calibration artifact, generation time, forecast boundary, training-data boundary, and input snapshot identities. `trainedThrough` must precede `forecastAsOf`; this is enforced at the shared validation boundary as a basic leakage guard. `estimationLevel` is one of:

- `player`: sufficient player evidence was available.
- `archetype`: shrunken to a role/experience archetype.
- `position`: shrunken to the position prior.
- `legacy-three-point`: mechanically reconstructed from legacy mean/floor/ceiling.

Every non-player level requires a human-readable `fallbackReason`. A `legacy-three-point` envelope is allowed for diagnostics and transport compatibility, but it must never be counted as evidence that the learned distribution model improved accuracy.

## Availability and injury boundary

`player.distribution` must not contain injury status, active probability, missed-game rate, limited-role probability, or inactive zero-point outcomes. It is calibrated only against active-role performance. Those inputs belong in a separately versioned `player.availability` model and are mixed into the unconditional season outcome exactly once by the simulator. Training rows used for the active-role curve must therefore exclude inactive zeroes (and label limited-role rows explicitly); otherwise the learned quantiles already contain the same downside that the availability mixture will add.

`availability-v1` accepts a player games forecast when the upstream row exposes at least 12 active-role games; missing or malformed rows fail closed to the position prior. The contract records both the total missed-game rate and `embeddedMissedGameRate`, the portion already reflected in the season mean. The simulator restores only that embedded portion on active weeks and gives roster depth replacement value during missed weeks. This prevents a second injury haircut. Live injury designations are recorded but do not receive a hand-tuned multiplier; they affect availability only through a timestamped projection update, because the historical injury-feature experiment did not pass the production gate.

## Correlation hooks

`correlationRefs` declare membership only. Supported v1 kinds are `offense`, `pass-game`, `backfield`, `position-room`, and `quarterback`. Coefficients, copula/factor mechanics, and shrinkage live in a separately versioned scenario model. That model must be included in the evaluation cache key.

This boundary permits conservative shared shocks while preventing a player document from embedding stale teammate coefficients. Unknown or missing references mean independent sampling, with a diagnostic counter; they must not invalidate the marginal distribution.

## Runtime fallback rules

The rollout order is strict:

1. Validate the envelope with `validatePlayerDistribution` from `shared/player-distribution.js` against draft season and scoring.
2. If valid and the distribution model is promoted, sample by inverse-CDF interpolation between adjacent quantiles. Tail behavior below P01 and above P99 must be versioned and bounded; v1 promotion should use clamped tails unless holdout evidence supports another rule.
3. Compose the separate promoted availability model exactly once.
4. Apply the promoted scenario correlation model after marginal calibration.
5. If any required promoted component is missing, mismatched, or invalid, use the existing legacy simulator for that player and emit a structured fallback reason. Do not partially use quantiles while also retaining the legacy asymmetric shock or position RMSE; that double-counts uncertainty.

The enrichment trust boundary rejects crossed quantiles and season/scoring mismatches. The core normalizer retains defensive isotonic repair for compact internal/test grids, but a published `quantile-v1` envelope must pass the shared validator before it reaches that normalizer. Never label a formula-derived three-point curve as learned `quantile-v1` evidence. Training pipelines may perform monotonic quantile correction before publishing and must record that transformation in the model version.

## Cache and reproducibility requirements

Every state/evaluation/simulation fingerprint that consumes distributions must change when any of these change:

- distribution schema, season, scoring format, conditioning, mean, or any quantile;
- model version, calibration ID, estimation level, fallback reason, or source snapshot identity;
- availability schema/model version or probabilities;
- correlation references or scenario/correlation model version;
- tail interpolation version, draft scoring settings, seed, and iteration count.

`playerDistributionFingerprintMaterial` supplies deterministic per-player material and includes the separate availability object. Server and in-process evaluation caches should hash it alongside the scenario-model version. Generated timestamps may cause deliberate cache misses; producers should reuse an immutable snapshot rather than regenerating equivalent documents on every UI refresh.

## Migration and compatibility

1. **Write and validate only:** attach optional envelopes, collect validation/fallback diagnostics, and preserve legacy output.
2. **Shadow sampling:** run quantile simulations beside legacy simulations using identical seeds. Do not affect recommendations.
3. **Offline promotion:** pass the gates below on frozen walk-forward folds.
4. **Small production cohort:** enable one atomic bundle—marginal, availability, tail, and cache versions—with rollback to legacy.
5. **Default and cleanup:** make quantiles authoritative only after production calibration is stable. Retain legacy readers for persisted draft reports until their schema retention window ends.

Top-level `mean`, `floor`, and `ceiling` remain required during migration for UI and old report compatibility. They must not be mixed into an accepted quantile simulation. Historical reports without `player.distribution` continue to use legacy behavior.

## Promotion gates

A model bundle is promotable only when all gates pass:

- leakage-safe chronological walk-forward evaluation with an untouched latest season and forecast timestamps before outcomes;
- at least three seasons where legally usable data exists, with player identity and scoring normalization audited;
- better CRPS and weighted interval score than both the legacy simulator and platform-only baseline, with bootstrap confidence intervals;
- improved or non-inferior pinball loss at every required quantile and empirical coverage near nominal for 50%, 80%, 90%, and 98% intervals;
- calibrated availability Brier/log loss evaluated separately from conditional performance;
- no material regression by QB, RB, WR, TE, scoring format, rookie/veteran, injury status, or fallback level;
- downstream title-odds calibration and draft-decision regret no worse than legacy on untouched drafts;
- correlation adds holdout value over independent marginals and does not degrade marginal PIT calibration;
- deterministic seeded replay, validator/fallback telemetry, cache invalidation tests, latency/memory budgets, source rights review, and a tested rollback path.

Synthetic leagues are useful for stress and invariant tests but cannot satisfy historical promotion gates.

## End-to-end integration checklist

- Projection ingestion preserves timestamped source snapshot IDs.
- Training emits monotone quantiles, integrated mean, shrinkage level, and calibration provenance.
- Enrichment attaches only season/scoring-matched envelopes and never folds injury into performance spread.
- Shared validation runs at the extension/service trust boundary.
- Recommendation discovery uses an explicitly chosen expectation (legacy during migration; distribution-derived after promotion).
- Simulation uses one outcome sampler per player, one availability mixture, and one shared-factor layer.
- Evaluation and server fingerprints include the complete distribution bundle.
- Workers receive the same immutable envelope and scenario-model version as the parent.
- Reports persist schema/model provenance and fallback diagnostics so decisions are reproducible.
- UI distinguishes conditional performance uncertainty from chance of playing and from chance of reaching the pick.
- Backtests report metrics and sample counts for every fallback level, including players excluded for invalid distributions.

## Principal risks

- Projection feeds may already embed expected missed games; training an active-role curve without deconvolving that assumption can double-count injury downside.
- Sparse player histories make unshrunk player curves look precise while being badly calibrated.
- Post-outcome or revised snapshots create subtle leakage even when the outcome column is absent.
- Independent marginal improvements can be erased by an overfit correlation layer.
- Mixing quantile uncertainty with the existing position RMSE shock produces distributions that are too wide.
- A cache key that ignores one probability, availability update, or scenario version can return recommendations from the wrong model.
- Source licensing may permit runtime display but not historical storage or redistribution needed for training.
