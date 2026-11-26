# UNI LP guide APR verification — 26 November 2026

The current calculator passes the independent Uniswap arithmetic checks. Its APR is a conditional extrapolation of the preceding day’s pool fee growth. It does not predict realized income reliably in this historical sample.

## Scope and evidence

- Source checkout: `f6569e4ed5cb6da9901967560ecd7304418c00ae`.
- Nineteen closed UNI/USDC positions on Base, all in the 0.30% Uniswap V3 pool `0x1261d6c23a2d719e2543d2d51aec87656050b70d`, plus one open position checked separately.
- `lpbook.json` supplies actual ranges, one initial deposit per position, claim tokens/prices, closed fee tokens and recorded in-range time. `uni-strategy.json` supplies the original integer add/remove/collect receipt amounts.
- Forty-five historical `uni-pools.json` revisions were inspected. Each reconstructed quote uses the most recent applicable pool reading committed BEFORE the LP opened. Pool blocks and timestamps also precede the deposit; the historical fee window ends before entry. No later readings were allowed.
- The stored quotes were 0.71–7.54 hours old at entry. All selected fee windows use verified fee growth and fall within the current calculator’s eight-hour validity limit.
- These are reconstructed estimates using today’s unchanged `uniEstimate` implementation with the real capital and tick range. The owner’s exact original browser quotes and typed inputs were not recorded. This is not a precise replay of what the owner saw at entry.

## Comparable results

For each LP, actual native fee tokens and predicted native fees are valued at the SAME pre-entry UNI/USD price. This removes subsequent UNI price changes from the error comparison. USD is then summed across positions. Fees exclude principal and token price P&L.

Because the guide explicitly says “while in range”, predicted daily income is multiplied by each position’s ACTUAL in-range seconds, not all elapsed seconds. This is an ex-post diagnostic: future in-range time was not known at entry and is not being presented as a forecast.

- Observed fees on this common-price basis: **$19.48**.
- Projected fees after the actual in-range adjustment: **$31.24**.
- Aggregate overestimate: **60.4%**.
- Weighted absolute dollar error / observed fees: **76.1%**. This is an error metric, not a probability or an “accuracy score”.
- Twelve positions earned nonzero fees. Seven had no recorded in-range time and earned zero. The zero cases cannot yield a meaningful per-position percentage error.
- Restricting the sample to the six positions held for at least six hours still produces a **76.8%** aggregate overestimate after the same in-range adjustment. Very short positions do not explain the whole discrepancy.

| LP | Holding hours | In range | Guide active APR | Observed active APR | Projected fees, in-range adjusted | Observed fees, same price | Error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| #6607586 | 17.36 | 26.8% | 361.4% | 104.4% | $0.0979 | $0.0283 | +246.2% |
| #6611265 | 12.63 | 73.2% | 310.3% | 145.2% | $0.3267 | $0.1529 | +113.7% |
| #6614022 | 9.43 | 55.5% | 650.2% | 1103.6% | $0.7514 | $1.2753 | -41.1% |
| #6616041 | 0.09 | 4.0% | 783.2% | 913.9% | $0.0006 | $0.0007 | -14.3% |
| #6616136 | 0.44 | 0.0% | 776.8% | n/a | $0.0000 | $0.0000 | n/a |
| #6616840 | 1.70 | 82.3% | 571.8% | 1259.8% | $0.2188 | $0.4821 | -54.6% |
| #6617298 | 0.10 | 0.0% | 867.0% | n/a | $0.0000 | $0.0000 | n/a |
| #6617330 | 0.12 | 0.0% | 1175.1% | n/a | $0.0000 | $0.0000 | n/a |
| #6617359 | 9.49 | 67.1% | 996.8% | 965.1% | $1.7094 | $1.6550 | +3.3% |
| #6620433 | 0.46 | 0.0% | 1023.5% | n/a | $0.0000 | $0.0000 | n/a |
| #6620528 | 0.18 | 0.0% | 1023.5% | n/a | $0.0000 | $0.0000 | n/a |
| #6620573 | 0.78 | 17.7% | 903.9% | 2104.1% | $0.0333 | $0.0774 | -57.0% |
| #6638767 | 2.69 | 56.3% | 1177.0% | 351.4% | $0.5535 | $0.1653 | +234.9% |
| #6639316 | 0.21 | 0.0% | 2434.5% | n/a | $0.0000 | $0.0000 | n/a |
| #6640090 | 0.28 | 0.0% | 2118.4% | n/a | $0.0000 | $0.0000 | n/a |
| #6643139 | 1.27 | 89.3% | 3526.0% | 5549.3% | $1.2195 | $1.9193 | -36.5% |
| #6644270 | 5.18 | 67.6% | 2441.7% | 1666.9% | $2.5859 | $1.7654 | +46.5% |
| #6647794 | 16.95 | 80.4% | 1298.4% | 408.6% | $5.4155 | $1.7042 | +217.8% |
| #6651270 | 74.85 | 90.1% | 892.9% | 499.3% | $18.3280 | $10.2495 | +78.8% |

APR values above are simple annual equivalents of short measured periods, not predictions of a year’s return. “Observed active APR” divides fees by recorded in-range time; full-holding-period realized APR is lower when time was spent outside the range.

## Longest closed position: #6651270

- Initial capital **$266.53**; held **74.85 hours**, with **90.1%** in range.
- The applicable prior guide rate was **892.9% APR while active**, about **$6.52/day**. Its dated input was **4.59 hours** before entry, from pool snapshot commit `ff61a46bf76f5ba1e6f9b817e19dfc3e09d74f76`.
- After known in-range time, projected fees were **$18.33** versus **$10.25** of recorded fees at that same UNI price: **78.8% high**.
- Observed active APR was **499.3%**; observed full-holding-period APR at this common price was **450.1%**.
- At the individual actual claim-time prices, fee income was **$10.28**. The existing frozen LP Book fee figure is **$10.02**, using its recorded close-price basis. These valuation bases are different; no historic ledger figure was rewritten.
- Repeating the comparison with the exact receipt liquidity instead of the calculator’s capital-based hypothetical liquidity still overestimates this position by **82.4%**. The small capital/price/liquidity reconstruction differences do not explain the gap.

## What the check establishes

- The tick/range, capital-to-liquidity, dilution, fee/day and APR arithmetic is internally correct for its declared assumptions. An independent reference used official Uniswap TickMath integer constants and 80-digit Decimal arithmetic for all twenty reconstructed inputs.
- Maximum fee/day arithmetic difference: **$2.16e-11**. Maximum APR relative numerical difference: **1.53e-10%**. These tiny arithmetic errors do not explain the forecasting gap.
- The projection carries a prior 24-hour fee-growth rate into a future period and uses the currently observed background liquidity. Actual earnings depend on the fee growth experienced while the exact range is active. The historical outcomes do not remain at the extrapolated pace.
- The discrepancy is not always upward: #6617359 was close (+3.3%); #6643139 earned more than the reconstructed estimate (−36.5% error). A single fitted discount is not justified.
- A pool-card APR uses total pool TVL as its denominator. A custom-range position APR uses the supplied position capital; these are different measures. This historical position test evaluates the custom-range estimator.
- Fee APR excludes price changes, impermanent loss, transaction costs and borrowing costs. It must not be interpreted as net portfolio return.

## Limits and next improvements

- These positions are correlated observations from one pool over 18–25 November, not nineteen independent market cycles. There is no personal BNB LP history here to establish BNB accuracy.
- The guide’s exact live quotes were not persisted. Older saved pool readings and assumptions about capital at their prices limit a precise forecast-accuracy claim.
- The open #6684331 position is excluded from the closed-position score; it has not completed its lifecycle.
- Recommended next change: show actual trailing fee APR beside the conditional estimate, include observed time in range, and provide an earnings range. Save timestamped forecast inputs/results so later performance can be checked against the exact quote.
- Use any calibration only after enough forward observations and an out-of-sample check. Do not apply the 60% discrepancy as an automatic universal haircut.

## Validation and progress

- [x] Reconcile all nineteen closed positions’ fee tokens to integer receipt collections minus withdrawn principal.
- [x] Check pre-entry commit/time/block ordering, pool/token identity, range equality, single-deposit capital and time coverage: **195 integrity checks passed**.
- [x] Independently verify twenty calculator cases against official integer/80-digit math.
- [x] Existing calculator checks pass: **292** pool/math assertions and **2,264** current-price/single-sided assertions.
- [x] Leave application code and all financial ledgers unchanged.
- [ ] Exact live-quote forward validation needs persisted forecast inputs/results.
- [ ] BNB forecast validation needs matching BNB LP history.

Local reproducible audit inputs/scripts/results are under `/workspace/tiger-agent-validation/uni-apr-history/`: `snapshots.json`, `audit.mjs`, `audit.json`, `summary.json`, `cases.json`, `integrity.py`, `integrity.json`, `independent.py`, `independent-results.json` and logs. Sources are the repository’s saved, dated read-only observations; no paid API, wallet transaction or history rewrite was used.

The baseline above is source commit `f6569e4`. A subsequent local estimator improvement is documented in [UNI-APR-ESTIMATE.md](UNI-APR-ESTIMATE.md); the original audit figures remain unchanged.
