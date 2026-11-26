# Fast, simple UNI buy/sell history

The owner reports that UNI trade history remains syncing and explicitly requests
**Push**. Simplify the table and make verified trades available without waiting
for unrelated wallet activity, prices or older inventory backfills.

- [x] Inspect the saved ledger, foreground reader and scheduled collector.
- [x] Separate the visible trade feed from wallet-wide sender/nonce searches.
- [x] Read Base and BNB concurrently with bounded recent UNI Transfer intervals.
- [x] Recover when a chain-verified provider rejects JSON-RPC batch requests.
- [x] Preserve actual receipt verification, source hashes and execution prices.
- [x] Show saved confirmed rows immediately; poll for newer trades every 10 seconds.
- [x] Show only time/network, buy/sell, UNI amount, unit price and total.
- [x] Retain partial verified progress without hiding Base behind a BNB failure.
- [x] Validate response reduction, failures/recovery, immutable costs and accounting.
- [x] Browser verification on mobile/desktop, both themes and languages.
- [x] Complete the full `npm run check` release gate (99 suites).
- [x] Commit the tested release and rebase onto the latest main.
- [ ] Verify the actual Vercel deployment and both public-chain recent cursors.

## What was keeping history open

The saved reading contained ten trades and a BNB `Incomplete UNI transfer batch`
error. BNB's recent Transfer cursor was 68,557 blocks behind its saved head.
The older inventory backfill was independent and much further behind. The
foreground view nevertheless ran a sequential Base/BNB pass with current quote
discovery and wallet-wide transaction nonce searches, with up to 22 seconds per
chain. Rendering also replayed trade accounting and calculated per-sale results.
The generic syncing message did not distinguish current trade checks from an
unfinished archive. Partial responses could be hidden by an older full response.

## Result

`/api/uni?view=history` shares in-flight work and reads fixed canonical UNI
Transfer queries for both tracked wallets. Each network has a 6.5-second budget,
fast provider fallback and a separate recent checkpoint. The default pass covers
at most four 50,000-block windows per network. Each interval still needs complete
logs, successful receipts, matching blocks and verified pool/1inch order identity.
An incomplete interval stays retryable. Warm passes resume without skipping a
gap. Historical sender/inventory checkpoints remain untouched.

The table response contains only eight fields per trade. Full receipt evidence,
raw amounts, gas and source blocks stay in the original ledger and warm backend
checkpoint. Current wallet/LP values and receipt-backed strategy capital retain
their independent readers. No financial formula or saved history is rewritten.
The lightweight path does not value LP returns; unknown historical prices remain
unknown for the existing dedicated reader to verify later.

The shared transfer transport falls back to individual requests when batches are
unsupported or incomplete. Block-range failures split into exact adjacent ranges.
Wrong-chain peers, incomplete results, caps and rate/request budgets still fail;
none become empty successful history. This also benefits the existing scheduled
collector and its durable backfill.

The browser paints cached/saved confirmed trades first, then checks every ten
seconds while visible. A stalled request has a nine-second deadline. A partial
response merges verified rows by immutable identity; it cannot erase fills or
reprice executions. BNB errors do not block the selected Base view. Older archive
coverage and last actual check times remain in the existing method detail. A
failed current check stays visible; an archive gap alone does not block the table.

The five columns are **Time, Side, UNI, Trade price, Paid / received**. The time
cell also names the network. Wallet addresses, route notes, gas, transaction links
and realized P&L have been removed from table rows. The separate P&L record and
its receipt evidence remain available. Amounts keep two decimal places.

App cache is **191**, with matching changed trade/history and translation
references. Unchanged fee/LP/accounting assets keep their own versions. Both
Portfolio copies remain identical. No new function, secret, paid service,
database, wallet permission or dependency is needed.

## Verification

- `test-uni-trade-feed.mjs`: 58 assertions, including concurrent chains, no
  nonce/balance/quote work, bounded verified progress, receipt failures, reorgs,
  partial source recovery, API caches, strategy reuse and immutable costs.
- `test-uni-transfer-fallback.mjs`: 60 assertions for unsupported envelopes,
  HTTP batch rejection, malformed rows, remembered working capability, exact
  range splits, incomplete responses, chain identity and bounded requests.
- Existing transfer tests also exercise actual recorded 1inch maker fills,
  raw costs and LP exclusion through the new short-pass reader.
- The controlled feed is **760 bytes vs 5,365 bytes** for the legacy full view
  (86% smaller). Projecting the current saved owner ledger is **2,469 bytes vs
  35,922 bytes** (93% smaller). These are payload measurements, not claims about
  real public-RPC latency or verified current holdings.
- Browser checks: **186 assertions** at 320, 375 and 1366 px, both themes/languages:
  immediate saved rows during a pending request, new Base fills while BNB fails,
  filtering, independent ten-second updates, timeout/recovery, no table links or
  settlement/gas details, unchanged capital/closed losses and modal disclosures.
- Logs and screenshots: `/workspace/tiger-agent-validation/uni-simple-history/`.

Production deployment and actual public RPC behavior still need a live check.
This workspace has previously received HTTP 403 from the production site and
public RPC POSTs. A provider outage can still prevent a new reading; confirmed
history remains visible with its actual check time and automatic retries.

Release gate passed all 99 project suites. The updated maker-fill reader passed
71 assertions, and the 58 feed / 54 legacy API / 60 fallback assertions passed
with the final bounded-pass settings. After rebasing the latest bot-only trade
snapshot, focused trade, strategy, accounting and fallback checks passed again.
