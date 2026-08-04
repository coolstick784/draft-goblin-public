# Paired scenario engine

## Objective

Every candidate at a draft state is evaluated in the same simulated worlds. The
only intentional difference between candidate A, candidate B, and the current
roster is the candidate selection itself. Opponent picks, player outcomes,
weekly volatility, schedules, tiebreakers, and playoff randomness are keyed by
scenario and entity rather than by iteration order.

This makes a displayed title-odds difference a measured candidate effect, not
ordinary Monte Carlo drift.

## Probability contract

- The current roster and every candidate share one immutable scenario bank.
- Random values are addressed by stable keys such as scenario, player, week,
  team, matchup, and playoff round. Adding or reordering candidates cannot alter
  another candidate's simulated worlds.
- Candidate value is computed from paired per-scenario outcomes against the
  current-roster baseline.
- Mutually exclusive candidates forced at the same user pick share one
  counterfactual performance and availability percentile. This preserves each
  player's marginal distribution while preventing player-ID noise from making
  a uniformly stronger alternative look worse across 10,000 worlds.
- Player projection uncertainty uses an expectation-preserving two-piece normal
  draw. The downside and upside scales are `(mean-floor)/1.5` and
  `(ceiling-mean)/1.5`, respectively, preserving the prior model's interpretation
  of the full projection range as three standard deviations without erasing
  asymmetric upside. The analytic half-normal correction keeps the simulated
  expectation equal to the player's projected mean.
- Raw probabilities remain internal. The UI may show a different tenth of a
  percentage point only when the paired evidence supports that direction.
- Balanced title odds sorts first by defensible championship probability, then
  uses a deterministic football-value tiebreaker when probabilities are tied.
- Live odds and the completed report use the same weekly scoring, matchup,
  playoff, and league-size calibration model.

## Performance design

- Build a scenario bank once per verified draft-state fingerprint.
- Reuse the bank across candidates, position filters, strategies, and report
  rendering.
- Produce an immediate stable estimate from a deterministic prefix, then refine
  by extending the same bank. Refinement must not replace cards with unrelated
  random outcomes.
- Cache roster lineups, replacement values, opponent draft paths, and player
  outcome shocks independently where safe.

## Acceptance gates

1. Candidate order, filter choice, and repeated evaluation do not change raw
   results for the same state, seed, and simulation count.
2. A dominated same-position player cannot outrank the dominating player unless
   a documented roster, availability, correlation, or risk objective explains
   it.
3. Standard one-QB/one-TE leagues do not recommend QB3, TE3, DST2, or K2.
4. Kicker or defense is compared with a replacement-level specialist and cannot
   receive credit for filling an artificial zero-point roster hole. Its edge is
   regressed 80% toward the expected waiver replacement, adjusted downward for
   risk, and capped at 12 season points. Exceptional projections can still earn
   a small advantage, but cannot dominate core-player value.
5. Live and final-report title probability match for an unchanged completed
   draft.
6. Boom-or-bust construction moves probability into both the top and bottom of
   the finish distribution relative to an equal-mean balanced roster.
7. Displayed 0.1-point differences have a positive paired lower confidence
   bound; otherwise the candidates share the same displayed percentage.
8. League-wide title probabilities and every team's finish probabilities sum to
   one within numerical tolerance.
9. Warm filter/strategy changes target under 50 ms; a verified pick update
   returns a stable recommendation target under one second while deeper
   refinement continues in the background.
10. Sleeper, ESPN, and Yahoo adapters pass mid-draft attach, on-clock, off-clock,
    completed-draft, reload, and stale-response tests.

## Validation loop

Run deterministic unit and invariant tests, saved real-draft replays,
walk-forward historical seasons, synthetic leagues by league size and scoring
format, latency benchmarks, and live Sleeper/ESPN/Yahoo mock drafts. Any observed
failure becomes a permanent regression fixture before the next iteration.

### Portable performance gates

`npm run benchmark:parallel-refinement` measures the production path. A result
is usable when the 1,000-scenario evidence stage is published within 45 seconds;
unresolved ties may continue to 10,000 in the background. The benchmark also
requires the evidence-ready top choice to survive the full run, at least 87.5%
top-eight overlap, a warm-cache response below 100 ms, no more than four workers
(or one fewer than the machine's logical cores), and less than 512 MB additional
resident memory.

`npm run benchmark:refinement-quality` is deliberately hardware-relative. It
records scenario-candidate throughput instead of weakening the evidence rules
on slower computers, and checks early, middle, and late states in 8-, 10-, and
12-team drafts. Speed and correctness are separate gates: a fast ranking fails
if it disagrees with the deterministic 10,000-scenario reference.
