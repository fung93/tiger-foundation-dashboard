# UNI strategy capital and realized results — local review

Requested 21 November 2026. Initially local-only; the owner subsequently
explicitly authorized **push** after reviewing the local result.

The approved behavior is net external funding, returned strategy cash retained
in current value, and permanent realized results alongside the current cycle.
Reusing proceeds is an internal movement; adding fresh funds increases capital.

- [x] Inspect trade/LP readers, existing immutable close records and source gaps.
- [x] Fast-forward to the owner's latest automated data; no local edits existed.
- [x] Confirm actual RPC limitation: direct Base PublicNode POST returns proxy
  CONNECT HTTP 403. Do not publish a helper branch or fabricate real readings.
- [x] Implement an independent deterministic strategy replay: actual token
  quantities, external contributions/withdrawals, earmarked stablecoin cash,
  carryover cost, settled LP closes and realized/current-cycle reconciliation.
- [x] Add bounded receipt-backed token history and balances, isolated from
  existing price/history refresh; persist its own resumable checkpoint.
- [x] Integrate local cards and record view, both languages/themes; keep the
  existing LP Book, trade ledger, portfolio/agent accounting and wallet access.
- [x] Provide a clearly marked development-only review scenario for the
  $250 → $240 exit, reused $240 and $10 top-up examples. Production data never
  silently falls back to example figures.
- [x] Validate financial identities, same-wallet/multi-wallet recycling,
  unrelated cash, claims, partial/pending/full exits, source failures/recovery,
  reorg/coverage limits, local browser presentation and `npm run check`.
- [x] Receive the owner's explicit authorization to commit and push.
- [x] Publish the reviewed change to main and verify the remote source commit.
- [ ] Verify the deployed page/API and fully completed owner history.

Accounting policy: strategy operations consume previously returned cash first;
unrelated wallet spending consumes unrelated cash first. Internal transfers
carry the attributed cash/cost between the two owned wallets. All attribution
is receipt-backed and reconciles against actual token balances. Unsupported
events or missing historical costs/prices remain unavailable. Native network
fees remain separately reported, following the existing dashboard convention.

An upper-edge position alone is not a completed strategy cycle. Realized
cycle results are finalized only against confirmed withdrawals/collections;
pending principal remains a receivable until collected. Current value includes
wallet UNI, open LP value, related wallet stablecoins and pending receivables.

No production credentials, paid model/provider, wallet signature or transaction
is required. Real-account verification remains blocked by the workspace proxy.

## Review locally

Run `npm run dev` and open
<http://127.0.0.1:4200/__review/uni-strategy?scenario=reuse>.
The server is running on port 4200 in this workspace for this review.

The banner says **Local review · Example figures**. Its scenario links show:

| Scenario | Capital | Value now | Realized | Current | Total P&L |
|---|---:|---:|---:|---:|---:|
| At upper edge, still open | $250 | $240 | $0 | −$10 | −$10 |
| Fully collected, cash in wallet | $250 | $240 | −$10 | $0 | −$10 |
| Reinvest the returned $240 | $250 | $240 | −$10 | $0 | −$10 |
| Add $10 and invest $250 | $260 | $250 | −$10 | $0 | −$10 |
| Principal not collected yet | $250 | $240 | $0 | −$10 | −$10 |
| 40% settled, 60% open | $250 | $240 | −$4 | −$6 | −$10 |

Use the P&L record icon to inspect current cycle costs, settled LP results and
actual funding entries. These examples use the real renderer and deterministic
accounting. Only the development server serves their data, and only to requests
from that explicit same-origin review page. `/uni-trade.html` and ordinary API
requests always use real sources; failure never switches them to examples.

## Implementation and configuration

- `uni-strategy-core.mjs`: receipt replay and valuation; capital = contributions
  minus withdrawals; total P&L = value minus capital = realized plus current.
  Historical claim/settlement values never follow current quotes. Sale rows use
  the carried strategy cost; average buy price remains weighted recorded buys.
- `api/_uni-strategy-reader.mjs`: fixed read-only Base/BNB token/NFT logs, full
  receipt/block proofs, hash checkpoints, exact wallet balances, NPM liquidity
  and outstanding principal/fee reconciliation. A false empty result cannot
  erase known trade/LP activity. Final intervals commit only after these proofs;
  incomplete work resumes, with explicit warnings and original source times.
- `api/_uni-strategy.mjs` adds `?view=strategy` to the existing `/api/uni` route.
  Existing quotes/history keep their own cache and reading schedule. Strategy
  reads reuse already verified warm fills or saved trades without starting or
  waiting for another trade backfill. A new unverified fill waits for evidence.
  Current holdings must match the independent trade/LP readings before valuation.
- `uni-strategy.json` starts **uninitialized**, with no invented amounts. The
  separate `scripts/uni-strategy.mjs` writer updates only this checkpoint.
  `.github/workflows/update-uni-strategy.yml` is prepared for hourly `:53`
  collection and manual runs. Publication activates its first automatic run;
  no manual run has been dispatched. Existing financial collectors stay independent.
- `uni-trade.html/js/css`: the five cards, retained-cash value, realized/current
  split and contribution record. No new manual financial input is required.
  `i18n-zh.js` and page/worker asset references use app/translation cache **189**.
  `uni-accounting.mjs` and shared LP cards retain their existing versions.
- `scripts/dev-server.mjs` and development fixtures provide the explicit review
  route. New regression suites are part of `npm run check`.

No secret, database migration, wallet connection or extra public function is
needed. Existing LP Book v9, UNI trades, other ledgers, Lending per-visit reset,
authentication and agent policy are unchanged. The two Portfolio copies remain
identical; their only edits are shared translation asset references.

Only chains with established UNI activity are in the verified strategy scope.
The record lists that scope. Earlier unverified activity on another network is
not silently included as zero; new ownership without a starting-cost proof,
unsupported quote tokens or unproven compound swaps remain unavailable.
In-kind UNI funding/withdrawals use verified transaction-time prices. Dollar
stablecoins retain the existing explicit $1 anchor.

## Test evidence and remaining blockers

- Deterministic accounting: **93 assertions** covering cash reuse, exact top-ups,
  unrelated cash, internal transfers, partial/full/pending exits, two-token
  settlements, fee-claim neutrality, sale cost and immutable settled prices.
- ABI-shaped reader: **64 assertions** covering new NFTs, stablecoin-only
  collections, missing trade/LP evidence, false empty logs, changed hashes,
  proof failures, provisional cursors and successful recovery.
- Strategy API/writer/development separation: **20 assertions**. Existing trade
  API regression: **54 assertions**, including warm-fill reuse with no RPC pass.
- Chromium: **1,098** scenario/layout checks at 320/375/1366 px in both themes
  and languages, plus **40** failure/recovery and **6** carried-sale-basis checks.
  Records stay open while updating, values retain source times, and no sideways
  overflow occurs. Screenshots/scripts are in
  `/workspace/tiger-agent-validation/uni-strategy-*`, outside the repository.
- `npm run check`: **94 suites**, syntax and identical Portfolio copies pass.
  Final logs: `/workspace/tiger-agent-validation/uni-strategy-final-check.log`.

- [ ] Verify the first full strategy backfill and current totals against actual
  Base/BNB RPC responses. The workspace's direct RPC POST is proxy-blocked (403).
  Ordinary local API failures remain visible and do not fabricate an empty book.
- [ ] Check cold serverless instances, persistent hourly progress and real owner
  cash/LP reconciliation after publication. No wallet transaction is needed.

Publication preflight: main matched local base `2e0072f`; all existing financial
JSON histories remain unchanged. Targeted accounting/reader/API checks passed
again. Event topics independently match the Keccak hashes of Uniswap's actual
IncreaseLiquidity, DecreaseLiquidity and Collect ABI signatures. Direct Vercel
and GitHub REST API requests still return HTTP 403 from this workspace.

## Publication evidence — 21 November 2026

- Source commit [`2fa1758`](https://github.com/fung93/tiger-foundation-dashboard/commit/2fa17584e815908727a23d5f084ede56420163a1)
  was pushed to main after `git pull --rebase origin main`; `git ls-remote`
  confirmed the exact remote commit. No existing ledger was reset or rewritten
  by that implementation commit.
- The automatic [first strategy run](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44908797287)
  saved checkpoint `69699b9`: **52 receipts**, **18 UNI LP identities**, Base
  cursor **60,238,015** toward observed head **60,385,866**. It explicitly reports
  **incomplete**, awaiting trade verification. Opening/current balance proofs
  are not complete; do not treat its cash or capital as verified totals.
- The independent trade run subsequently saved **9 verified trades**, including
  the newer 1inch fill at Base block **60,283,875**. A fresh strategy read can
  use that saved fill and resume from its existing checkpoint. No reader reset
  or guessed trade cost is needed.
- Production Vercel requests still return HTTP 403 in this workspace. App cache
  **189**, the deployed UI/API, complete current totals and hourly persistence
  remain unverified against the actual deployment. The development examples and
  passing tests are not evidence of those live results.
