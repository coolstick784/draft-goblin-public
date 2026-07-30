# Synthetic draft promotion gate

This gate is frozen before the next policy evaluation. It is an engineering and
decision-regression test, not evidence of real-world forecast superiority.

## Preregistered matrix

- League: 12 teams, 16 rounds, PPR, standard QB/RB/WR/TE/FLEX/K/DST roster.
- User slots: 1, 2, 4, 6, 7, 9, 11, and 12.
- Seeds: 14101, 14102, 14104, 14106, 14107, 14109, 14111, and 14112.
- Opponents: the frozen seeded ADP/roster-constrained policy in
  `scripts/mock-draft-tournament-lib.js`.
- User policy: the first title-only recommendation using only picks already made.
- Pick evidence: 180 common-random-number simulations per candidate.
- Final evidence: 10,000 simulations per completed draft.
- No retries, replacement seeds, or post-result slot selection.

## Required gates

- At least 6 of 8 teams (75%) finish with the highest modeled title chance.
- Mean modeled title rank is at most 1.75.
- Every draft completes with a legal 16-player roster.
- Every player outcome and title probability is finite and bounded.
- Deterministic reruns produce identical picks and final probabilities.
- Tournament-wide p95 user-pick decision time is below five seconds.
- The known pick-128 Shaheed regression and the complete repository suite pass.

If the first-place gate fails, report the raw result. Do not tune seeds or relax
the gate. Diagnose against the unchanged legacy sampler before reverting a
distribution change.
