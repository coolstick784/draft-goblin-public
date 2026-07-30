# Pick availability calibration

`chance available at pick T` means the probability that the player's selection
pick is `T` or later, conditional on the player still being undrafted at the
current pick.

The former model assigned every Sleeper player an 18-pick spread and used it as
a logistic scale. That made elite players look almost as volatile as late-round
players and was inconsistent with the Gaussian draft simulation.

The replacement uses the same 2026-only, format-selected standard-deviation
curve in `core/availability.js` and `core/simulate.js`. The production artifact
contains twelve cells: 8/10/12/14 teams crossed with standard, half-PPR, and
PPR. Every source response is rejected unless its data-window dates begin with
2026 and its requested team count matches the response metadata.

On July 12, 2026, the free Fantasy Football Calculator API reported current
windows containing 291 standard mocks, 551 half-PPR mocks, and 1,619 PPR mocks.
Its early-market examples were tightly distributed: James Cook had ADP 7.7,
standard deviation 1.7, and an observed range of picks 4-10 in the 10-team
standard response. The API documents that computer selections are removed and
its data updates daily:

- https://help.fantasyfootballcalculator.com/article/42-adp-rest-api
- https://help.fantasyfootballcalculator.com/article/34-average-draft-position-adp-data

Rebuild `data/research/availability-calibration-2026.json` and the runtime
module with `npm run model:calibrate-availability`. The collector is deliberately
fixed to season 2026; no earlier-season record is read or accepted.

Limitations: these are mock-draft summaries, not raw selection histories, and
individual player sample counts can be much smaller than the window-wide draft
count because computer selections are excluded. The provider currently returns
identical aggregate curves across requested team counts even though it echoes
the requested team count in metadata; those cells remain separate so they can
diverge automatically when the upstream data does. A future 2026 raw-draft
collector can add discrete-hazard validation without introducing prior years.
