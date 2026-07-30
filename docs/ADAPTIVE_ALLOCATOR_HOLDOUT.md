# Adaptive allocator synthetic holdout v1

This holdout was frozen before an adaptive allocator candidate existed and must not be run during training. Its twelve tasks use only draft slots 3, 5, 8, and 10, which are absent from the existing eight-draft expanded promotion matrix, and fixed 327xxx–347xxx scenario seeds plus independent 927xxx–947xxx outcome seeds. There is no seed CLI and no replacement of failed tasks.

The candidate module must run exactly one causal draft path for both the frozen baseline arm and candidate arm on every task. A result is invalid after any timeout, pick mismatch, seed override, retry, second terminal path, incomplete draft, or missing set of sixteen decision latencies. The output is write-once.

The candidate passes only if all twelve task pairs are valid, it finishes first in at least 75% of drafts and no more than one draft fewer than baseline, mean title rank is at most 1.75 and no more than 0.25 worse than baseline, decision-time P95 is below five seconds and no more than the larger of 10% or 150 ms slower than baseline.

Passing is synthetic non-regression evidence only. It cannot promote forecast distributions, authorize real-draft automation, or substitute for the existing frozen CPU holdout. If this task set is inspected, executed, or changed, a subsequent candidate requires a new benchmark version with new untouched seeds.

After training is complete, run `npm run validate:allocator-holdout -- --candidate scripts/<candidate-adapter>.js` exactly once.
