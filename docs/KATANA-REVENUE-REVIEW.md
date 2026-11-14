# Katana revenue and buybacks — review and release, 14 November 2026

Initially prepared for local review. The owner's subsequent instruction to remove
inactive lending markets, add KAT/USDC and **push** authorizes publication of this
combined update. Unknown revenue streams and buyback allocations remain unknown.

## Progress

- [x] Read the full Foundation article supplied by the owner after the X link was
  blocked. Record the four revenue sources and distinguish the two percentages.
- [x] Add a separate revenue panel below the existing network and personal holdings.
- [x] Show daily, seven-day and thirty-day source income without extrapolating
  missing days. Keep gross fees, product revenue and personal income separate.
- [x] Reconstruct 30 completed days of normal Perps trading fees from chain logs.
- [x] Reconstruct 30 completed days of protocol fees for 49 priced Swap V3 pools.
- [x] Cross-check the latest Swap day using an independent scan of 3,970 swaps,
  and verify positive liquidity in all three USD reference pools at all 30 closes.
- [x] Add separate allocation, spending and purchased-KAT records/coverage.
- [x] Add a bounded, isolated collector to the existing scheduled job in code.
  No production workflow run was triggered while the draft was under review.
- [x] Test math, source boundaries, missing data, failure/recovery and both themes.
- [x] Receive the owner's follow-up push instruction; include active-market Lending
  filtering and KAT/USDC in Strategy, retaining the existing readers and accounting.
- [ ] Connect a verified Vault Bridge revenue feed and sequencer retained-revenue
  feed; source access/methodology remains unavailable here.
- [ ] Verify the linked tokenomics article's actual revenue-share percentages,
  eligible revenue basis and effective time. The owner was asked for its text.
- [ ] Connect published buyback budgets and a verified execution source after
  launch/executor details are available. An incoming KAT transfer is insufficient.
- [ ] Confirm the production deployment after the approved push. Live Vercel access
  is blocked by this workspace's outbound proxy.

## What the supplied article establishes

Source: <https://x.com/katana/status/2120517054558093364>, “Holding is a losing
trade. Time to act. Time to believe.” The owner pasted the complete article.
The workspace could not fetch X, its public mirrors, the Katana website or the
linked tokenomics article (proxy CONNECT 403).

- The Foundation acquired Katana's Sushi deployment, IDEX and Vault Bridge.
- The four revenue sources are Swap, Perps, Vault Bridge and sequencer fees.
- A **share** of those fees is announced to flow to avKAT from **17 November**.
  The supplied article does not state the percentage, eligible fee base or exact
  activation time. The date is recorded as an announcement, not verified activation.
- Programmatic open-market KAT buybacks launch **later**. No start date or
  execution address is supplied.
- **100% of purchased KAT** goes to avKAT stakers. This does **not** establish
  that 100% of network revenue buys KAT. No such multiplication is implemented.
- vKAT/voting sunset and a seven-day unstake cooldown are announced. This review
  does not change wallet access, locks, conversion, lending limits or transactions.

Further details requested: <https://katana.network/blog/kat-tokenomics-update-avkat-katana-revenue>.

## Actual data in the review snapshot

These are product-fee readings **before operating costs**, through **14 November
2026, 08:00 MYT** (the completed UTC reporting day is 13 November). Weekly/monthly
mean 7/30 completed reporting days. They are not current daily-rate projections.

| Source | Latest day | Last 7 days | Last 30 days | Coverage |
|---|---:|---:|---:|---|
| Swap protocol fees | $100.83 | $496.59 | $3,420.08 | 49 priced V3 pools; other pools/deployments excluded |
| Perps normal trading fees | $8,402.92 | $60,204.54 | $251,224.38 | Maker rebates netted; other exchange income/costs excluded |
| Vault Bridge | Unavailable | Unavailable | Unavailable | No verified revenue feed |
| Sequencer retained revenue | Unavailable | Unavailable | Unavailable | Gross gas is not assumed to be retained revenue |
| **Known subtotal** | **$8,503.75** | **$60,701.13** | **$254,644.46** | **Not total Katana revenue** |

Buyback allocation, spending and KAT purchased remain **unknown**, not zero.
Neither unavailable streams nor unconnected purchase records are silently zeroed.

## Accounting and sources

- Amounts are stored as integer USD millionths; history is append-only. Earlier
  observations retain their original USD marks if a provider later revises them.
  Displayed subtotals sum each source's displayed cents; exact micro-dollar sums
  are also retained so rounding never changes the source observations.
- Perps: deployed exchange `0x62230cea619f734cc215bb8074bbf07be4eb633e`, its
  `TradeExecuted` events. Maker fees are signed, taker fees unsigned; both are
  8-decimal pips. Negative maker rebates reduce revenue. Funding is excluded.
  The last complete day contained 36,022 normal trades. Receipts/logs are read-only;
  block ranges and raw quote totals are retained for every day.
- Swap: discover pools from the verified factory's `PoolCreated` logs; the full
  discovery returned 5,525 pools. Track only the 49 pools whose two assets are among
  vbUSDC, vbUSDT, KAT, avKAT, vbETH and vbWBTC. Each day's fee amounts are
  **closing protocol counter − opening counter + protocol collections**. These
  are protocol fees, never LP principal, LP earnings or all trading volume.
  Tokens are marked at that day's closing verified USD pool prices; avKAT uses
  its same-block vault conversion. New pools have zero counters only before their
  verified creation block. Missing counter/price/collection data invalidates a day.
- Complete event reads split explicit limit errors **and successful 10,000-log
  caps** into disjoint ranges. Failed children/duplicates cannot establish a day.
  Query/time budgets stop backfills; previously completed days remain usable.
- Independent latest-day Swap verification reconstructed per-token protocol fees
  from all 3,970 swaps and observed fee splits. The independently rounded event
  reconstruction differed from the exact counters by at most 17 raw token units
  per asset; the authoritative counter amounts remain the reporting basis. All
  USD anchor pools had positive liquidity at all 30 reporting closes.
- Open-source contract/metric references were inspected at DefiLlama
  `dimension-adapters` commit `9fef43d` (14 November 2026):
  `dexs/katana-perps.ts`, `dexs/sushiswap-v3.ts`, `fees/katana-chain.ts`.
  IDEX's public contract source confirms negative maker fees are fee credits.
- The free DefiLlama Swap API remains a validated fallback requiring explicit
  Katana scope; all-chain totals are rejected. Its gas feed is context only.
  Live API access is blocked here, so no unseen response format is declared proven.
- A Vault Bridge advertised yield/APY or bridged principal is not network revenue.
  No TVL × advertised-rate estimate is used to fill its missing figures.

## Files and operation

- `katana-revenue-core.mjs`: deterministic dated aggregation, announced policy,
  immutable history merging, allocation/purchase separation and coverage.
- `api/_katana-revenue.mjs`, `api/_katana-revenue-rpc.mjs`,
  `api/_katana-swap-revenue.mjs`: fixed read-only sources, bounded log readers,
  pinned historical prices, qualified coverage and independent provider failures.
- `katana-revenue.json`: new public network-revenue history and incremental pool
  discovery; personal holdings and all older financial histories are untouched.
- `api/vkat.mjs`: additive `?view=revenue` route with a separate warm checkpoint
  and short cache. Existing holdings/default vote routes keep their contracts.
- `vkat.html`, `vkat.css`, `katana-revenue.js`: independent revenue panel, dated
  snapshot-first display, retained readings on failure and five-minute refreshes.
- `scripts/katana-revenue.mjs`, `scripts/update-data.mjs`, workflow: isolate the new
  collector from the existing six-hour job and include only its new JSON file.
  Each normal run collects a bounded number of missing days; no full rebuild.
- `api/_core.mjs`: export the existing Multicall encoder/decoder for reuse; no
  existing LP math is changed. `scripts/check-project.mjs` checks new modules.
- `sw.js`: cache 167 for the combined approved release; previous switches
  remain hidden and both existing themes/preferences remain available.
- No new secret, paid subscription, D1 migration, transaction or wallet connection.

## Validation and preview

- `scripts/test-katana-revenue.mjs`: **91** closed assertions for period totals,
  zero vs missing, no extrapolation, same-chain scope, maker rebates, daily counter
  accounting, collector limits/duplicates, failed prices/children, revisions,
  buyback allocation vs spending and 100%-of-purchased-KAT semantics.
- Revenue browser acceptance: **132** checks, both themes at 320/360/1366 px;
  failure retains values, recovery clears stale state, no owner inputs, no page
  overflow, and personal holdings keep polling during revenue failures.
- Actual HTTP preview returns revenue and holdings separately. Actual measured
  data screenshots at 1366/360 px were inspected, including the tiger theme.
- `npm run check`: all **78** portable suites and matching Portfolio copies pass.
  The Worker bundle dry-run passes; no Worker was deployed.
- Logs, source audits and screenshots: `/workspace/tiger-agent-validation/revenue-audit/`.
- Local private preview: <http://127.0.0.1:4200/vkat.html>. The validation server
  uses an external curl transport because this workspace's native Node outbound
  RPC access differs from curl; production source code uses the standard fetch path.

## Lending and Strategy follow-up

- All confirmed inactive lending markets are hidden. Unavailable readings do not
  prove inactivity; an opened position returns automatically. The full reader and
  history remain intact, as do the per-visit LTV reset and 7D default charts.
- KAT/USDC's four standard fee tiers were verified against the factory at block
  47,920,615; funded tiers participate in volume/fee/APR sorting, daily range
  estimates and the existing optional KAT hedge. Coverage now expects six pairs.
- A live read confirmed only avKAT/KAT has a current lending position. Live
  Strategy reads returned KAT/USDC volume and fees in its 0.05% and 0.3% pools.
- Portable view/math assertions: Lending **49**, Strategy **163**, revenue **91**.
  Browser acceptance adds **162** Lending/Strategy assertions across both themes
  and 320/360/1366 px, including reactivation, failed reads, empty/unknown states,
  visit reset, numeric sorting, retained inputs, daily estimates and hedging.
- Final validation artifacts: `/workspace/tiger-agent-validation/2026-11-14-final/`.

Publication is authorized. No bot message, existing financial-ledger rewrite,
wallet action or private Cloudflare account change is included.
