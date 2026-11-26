# UNI refresh reliability and speed

The owner reports slow, frequently stale UNI readings and asks for the fastest
practical refresh. He explicitly authorized **“Push”** after the local fix and
testing. Publication of this reviewed change is authorized.

- [x] Pull the latest automated observations without changing existing history.
- [x] Inspect both UNI guide and UNI Trade refresh paths and source failures.
- [x] Split current reads from archive/log/trade-history work.
- [x] Add bounded current requests, working-provider reuse and a short cache.
- [x] Refresh current prices and UNI LPs every 10 seconds while visible.
- [x] Preserve independently dated fee history, edits and open records.
- [x] Make UNI snapshot JSON network-first in the service worker.
- [x] Check source failures/recovery, concurrent reads and scoped LP refresh.
- [x] Check actual browser behavior in both languages/themes on mobile/desktop.
- [x] Complete `npm run check` against the latest saved data (97 suites).
- [x] Receive explicit push approval for the tested refresh fix.
- [ ] Verify cache 190 and current readings on the real deployment.

## Findings

The guide polled every 60 seconds. Each response waited for both networks'
discovery, current state, historical block searches, archive fee growth and a
complete day of swap logs. A 30-second warm cache plus a 30-second stale edge
window added more delay. A failing history source could consume its budget
before the current quote reached the browser.

UNI Trade used its full historical fill scan for current prices/balances and
required history completion for LIVE status. The latest saved trade reading
contained `bnb: Incomplete UNI transfer batch`, despite having price readings.
LP cards additionally waited for other chains and Katana's reward service.
The service worker treated `uni-pools.json` and `uni-strategy.json` as shell
assets, so their supposedly fresh fetches could return old cached snapshots.

## Resulting behavior

- `/api/uni?view=live` reads pinned current pools, prices, liquidity and TVL.
  It does not search old blocks, read archive state or scan logs. Discovery,
  token contracts/decimals, pool identity and block hashes are still verified.
- `/api/uni?view=market` reuses that current proof and reads UNI balances in
  both configured wallets at the same block. The source hash is checked again.
  Prices and balances can refresh while trade history is still unavailable.
- A healthy current guide fixture needs **6 logical RPC reads**, compared with
  **32** in its full historical pass; RPC source-chain validation is additional.
  The current budget is 5 seconds per network; wallet reads add at most 2.5
  seconds. Each network runs concurrently, and response bodies have deadlines.
  A working provider is preferred on later current requests.
- Guide and Trade current responses share in-flight work and a **3-second**
  complete-only warm/edge cache. They have no stale edge window. Failed answers
  use `no-store`; client deadlines release refresh guards after stalled reads.
  No page stacks overlapping requests or polls while hidden; returning to it
  starts a current read immediately.
- The guide updates prices every **10 seconds**. Fee history refreshes on an
  independent **5-minute** timer, with the committed snapshot shown immediately.
  A late history answer can update its fee period without overwriting a newer
  quote. The existing 8-hour fee-evidence validity limit is preserved.
- UNI Trade updates current prices and LPs every **10 seconds**. Trade history
  and the receipt-backed capital ledger keep their independent 30-second work.
  Saved trade records can display the historical average before a backfill
  finishes. Missing evidence still blocks cost-based results; no cost is guessed.
- `/api/lpbook?scope=uni` advances Base only and reads only Base positions/token
  prices. It does not wait for Katana rewards, Robinhood or Fables. Its separate
  cache/checkpoint cannot contaminate the normal full LP Book. Financial readers
  and formulas are unchanged; a Base failure still retains an explicit warning.
- Current/fee timestamps stay separate. Failed or expired readings never become
  LIVE merely because a timer or cached response ran. The last actual figures
  remain visible. Input values/focus, expanded cards, modal and funding details
  survive the faster refresh.
- App cache **190** includes changed UNI modules and `uni-refresh.mjs`.
  Existing translation, LP card and accounting asset versions are unchanged.

No extra public function, paid service, dependency, database or secret is needed.
Wallet access stays read-only. Existing financial JSON, closed LP values,
authentication, agent policy and Lending visit-only settings are untouched.

## Validation

- `test-uni-live.mjs`: **40 assertions** on current/history isolation, merging,
  source clocks, body deadlines, safe fallback, provider reuse and recovery.
  Controlled 4 ms RPC-delay comparison was about **130 ms / 32 reads** versus
  **28 ms / 6 reads**. These are fixture timings, not public-network latency.
- `test-uni-live-api.mjs`: **25 assertions** on actual public handlers, concurrent
  requests, current responses while history hangs, wallet proofs, short caches,
  failures/recovery and actual service-worker network-first behavior/cache keys.
- `test-uni-lp-scope.mjs`: **18 assertions** on Base-only work, no reward calls,
  isolated checkpoints, cache expiry, failure/recovery and unchanged source data.
- Existing Base reader/accounting regression includes explicit proof that
  omitting unrelated Katana rewards cannot change UNI earnings or performance.
- Browser scripts/screenshots are outside the repo at
  `/workspace/tiger-agent-validation/uni-fast-refresh/`. They exercise real page
  modules with controlled sources: 10-second updates, delayed/failed history,
  hung fetches, stale/recovery, per-network isolation, edits/scroll, funding
  disclosures, stable funding/closed loss and both languages/themes.
- Browser fault scenarios passed **228 assertions** at 320/375/1366 px.
- The full check exposed outdated all-time/performance tests: they summed `claims`
  but omitted existing `trading_claims`. The latest saved closed Katana position has
  $0.51 of owner trading fees. The test now independently includes both original
  claim sources and explicitly checks a fixed combined-income example. No
  production accounting or financial history was changed to make that check pass.

Direct production requests still return HTTP 403 from this workspace. Public RPC
latency/capacity, deployment cache 190 and actual user-visible live readings
remain unverified. A free public RPC outage can still make a reading stale;
the change bounds its delay, preserves evidence and retries automatically.

Final verification: `npm run check` passed all **97** suites; the latest merge/body-timeout changes also passed their focused checks. Browser verification passed **228 assertions**. Portfolio copies match, `git diff --check` passes, and no financial JSON was edited. Final logs are `/workspace/tiger-agent-validation/uni-fast-refresh-release-check.log` and the `uni-fast-refresh/` validation directory.

Publication preflight: remote main still matched base `647031f`; the 40
current-reader, 25 live-API/cache and 18 scoped-LP assertions passed again.
Existing financial histories remain unchanged by this implementation.
