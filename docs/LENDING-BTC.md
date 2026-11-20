# BTC lending market and collapsible history — 20 November 2026

The owner explicitly requests **push**. Restore the missing BTC/USDC market,
include it in all three combined lending metrics, and collapse every market's
charts.

- [x] Identify the cause: portfolio discovery already includes BTC, while the
  separate Lending reader/registry supports only the three KAT markets.
- [x] Add canonical vbWBTC/vbUSDC market
  `0xcd2dc555dced7422a3144a4126286675449019366f83e9717be7c2deb3daae3e`.
  Keep actual token addresses, **8/6 decimals**, **86% LLTV**, oracle valuation
  and accrued-debt rounding distinct from the KAT-backed markets.
- [x] Include BTC in Oracle collateral, Borrowed and weighted Average LTV.
  Missing/unread BTC readings cannot silently become zero or leave an apparently
  complete total. Verified empty positions hide and reopen automatically.
- [x] Show the BTC oracle liquidation boundary, never a KAT price forecast.
  Agent helpers support the new collateral without changing saved policy.
- [x] Add native independently collapsible Market history sections, initially
  closed, with the existing 7D default and per-visit 70%/35% target behavior.
- [x] Preserve all **284** existing recorded samples unchanged; add the verified
  BTC first-Borrow observation and current four-market observation. Registry and
  Borrow metadata are additive; history stays version **1**. Unknown older BTC
  observations remain gaps rather than invented zero balances or current prices.
- [x] Verify real on-chain market/receipt data in
  [read-only source run 44662223307](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44662223307).
- [x] Run **41** BTC reader/accounting/actual-receipt checks, **130** existing
  Morpho math checks, **56** view checks and **64** chart-start/history checks.
- [x] **324** Chromium checks at 320/375/1366 px, both themes/languages: actual
  wallet totals, BTC units and boundary, independent chart toggles/periods,
  refresh/failure/recovery, inactive/reopened positions and per-visit settings.
- [x] `npm run check` passes all **90** suites. Syntax, final diff checks and
  identical Portfolio copies pass. Existing samples remain unchanged.
- [x] Published [`bd07220`](https://github.com/fung93/tiger-foundation-dashboard/commit/bd07220)
  to main as requested.
- [x] [Production verification run 44663941032](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44663941032)
  succeeds: fresh complete **four-market** API, BTC **8/6** units and **86%** LLTV,
  BTC Borrow-opening provenance, collapsed-chart JS and app cache **182**.
  At **20 November, 10:53 MYT**, the API reports Oracle collateral **$1,517.01**,
  Borrowed **$871.64**, Average LTV **57.46%**, including BTC oracle collateral
  **$193.2842** and BTC borrowed **$150.020884**. Values move with new readings.

Actual source evidence, **20 November at 10:38 MYT**:

| Reading | Value |
|---|---:|
| BTC collateral | 0.00312861 vbWBTC |
| BTC oracle collateral | $192.224086 |
| BTC borrowed | $150.020776 |
| BTC market health | 1.1019321284 |
| Combined oracle collateral | $1,507.9729962309339 |
| Combined borrowed | $868.5272875335831 |
| Combined LTV | 57.5956790808% |

These are dated verification readings, not fixed current balances. The first BTC
Borrow is **18 November 2026, 11:50:10 MYT**, block **48,230,999**, transaction
[`0xfb1de7e7…80a42d1`](https://katanascan.com/tx/0xfb1de7e73c1c3e9355a2a68af6ea786191a843689c3cb6b54e7c2634780a42d1).
Its receipt, block hash and actual opening debt were checked before adding it.

`scripts/fixtures/morpho-btc-recorded.json` freezes the actual current observation
and Borrow provenance; `morpho-legacy.json` freezes an original three-market
observation for migration regression. New snapshots declare market coverage;
legacy samples keep their original scope without being rewritten.

The extra market also expands the existing monitor test's hypothetical alarm
batch. Its test now drains the retained queue over enough bounded ticks rather
than assuming only three markets. Production delivery limits stay unchanged;
**29** monitor assertions pass with at most **43** D1 calls per invocation.

App cache, Lending CSS/JS, browser Morpho import and shared translation URLs use
**182**. Other page edits update translation URLs only; Portfolio copies stay
identical. No new key, wallet connection, signature, paid provider, public API
function, Cloudflare/D1 migration or Lending preference persistence is required.
