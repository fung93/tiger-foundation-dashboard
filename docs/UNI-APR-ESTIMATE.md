# Improve the existing UNI guide APR estimate

The owner asks for a more accurate estimated APR only. Keep the current guide
and inputs; update the estimate itself. No new analytics cards or settings.
After the completed local implementation and tests, the owner explicitly
requested **push**, authorizing publication of this reviewed change.

- [x] Reconcile the baseline audit and inspect the existing live estimator.
- [x] Extract completed, settled same-pool LP earnings from the saved ledger.
- [x] Adjust the existing estimated fees/day and APR together, automatically.
- [x] Replay historical predictions using only ledger commits available before
  each position opened; target/future outcomes never enter its calibration.
- [x] Validate the native-unit model, receipt liquidity and accounting isolation.
- [x] Complete **126 browser assertions** across 320/375/1366 px, both languages
  and themes: automatic history adjustment, no new fields/cards, preserved edits
  and focus, independent live polling, failed-history recovery and zero income
  while a single-sided position is waiting.
- [x] `npm run check` passes all **100 suites**. The final shared-module imports
  also pass model/API/language checks and browser verification. Portfolio copies
  and `git diff --check` pass.

## Method

`uni-fee-model.mjs` extracts realized fee tokens from complete closed positions.
Use a single original deposit, zero remaining liquidity/owed principal, complete
range-time coverage and matching claimed/frozen native fees. Reject top-ups,
unpriced/incomplete records, unknown owners/assets, active positions and short
observations (less than 30 active minutes or a one-hour position lifespan).

Mint token amounts and the original ticks determine original liquidity without
assuming an entry price. Normalize actual fee tokens by liquidity and time in
range. Match the exact chain, pool, fee tier, token addresses and decimals. Price
both the historical and current native fee rates at the current verified quote.

Require at least three qualifying positions and six total active hours within
the last seven days. Take the median rate weighted by active time and recency
(three-day half-life). When the market's one-day fee rate is above this observed
rate, blend half current market and half historical rate. A weaker market rate
is never increased by older strong earnings. There is no fixed percentage APR
haircut or target fitted to a future position's payout.

Apply the existing deposit dilution and capital denominator to this adjusted
unit rate. This keeps fees/day and APR identical in basis for every amount/range.
Single-sided positions still earn zero before entering their usable range; their
while-active estimate uses the same adjustment. Pool-card 24-hour fee totals and
pool-wide APR remain observations, not personal-range forecasts.

Pools without enough verified personal history retain the existing estimate.
Partial swap lower bounds are not discounted again. Unknown/failed history does
not become a zero-yield observation. History expires on its own dates; a failed
refresh retains the last verified history without changing its source time.

The guide reads `/lpbook.json` independently at opening, every five minutes and
on return to the page. This does not wait on an archive scan or block its
10-second current-price refresh. Editing range/amount is preserved. The existing
source note briefly says when verified LP history is used; no new form fields.

## Historical validation

`scripts/fixtures/uni-apr-history.json` contains the twenty original real-range
inputs (nineteen closed, one open), original pre-entry pool readings, and the
exact history available from the latest saved LP Book commit before each entry.
The observed fee outcome is used only to score the prediction. All results use
the audit's same historical token-price basis and realized active seconds.

On all nineteen closed positions, weighted absolute dollar error / actual fees
falls from **76.13% to 33.25%**. Seven entries had enough past history for an
adjustment; five of these earned nonzero fees. On that subset the metric falls
from **86.68% to 33.83%**. Earlier insufficient-history estimates remain unchanged.

For the longest position #6651270, the in-range-adjusted fee projection falls
from **$18.33 to $12.56**, against **$10.25** observed on the common price basis.
Its conditional active APR falls from approximately **893% to 612%**. This is a
chronological historical replay from one Base pool, not a guarantee of future
income or a verified BNB forecast. It is not an independent untouched test set;
current market changes can still defeat a historically informed estimate.

`test-uni-fee-model.mjs` checks the actual receipt liquidity independently,
invalid/future/stale/cross-pool evidence, enough sample exposure, no inflation of
weak live rates, single-sided waiting, and unchanged capital/deposit/edge P&L.
Current result: **190 assertions**. Existing guide tests pass **292 + 2,264**
assertions, alongside the source-timestamp and language checks.

App/guide/core/model/translation references use **194**. Other modules keep their
versions. Existing financial JSON, LP Book v9 and historical claims/P&L remain
unchanged. This implementation adds no API, dependency, credential,
paid service or wallet permission.

Validation logs/screenshots are in
`/workspace/tiger-agent-validation/uni-apr-improvement/`. Publication is authorized;
the real deployment's cache/guide readings still require live verification.
