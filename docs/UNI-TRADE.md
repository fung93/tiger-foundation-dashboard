# UNI Trade

Current follow-up: 1inch resolver fills are now included. Two actual orders
filled in three transactions: **19.09969908869371 UNI** for **99.982335 USDC**,
with weighted average **$5.2347596962501735**. Earlier nonce-only observations
below describe the original release and are superseded by this follow-up.

Requested 19 November 2026. The owner explicitly requests **push**, and confirms
both Base and BNB Chain. Add a UNI-guide link to swap history, average cost and
unrealised trade-book P&L, actual wallet balances and current UNI LP Book cards.

- [x] Verify free history sources and actual receipts before selecting an adapter.
- [x] Read both configured wallets on both networks automatically.
- [x] Track confirmed UNI swaps; never invent buys from claims or LP operations.
- [x] Keep trade-book inventory, current wallet units and LP accounting separate.
- [x] Save dated immutable trade amounts/prices and resumable history cursors.
- [x] Add the page, link, language/theme support and shared live LP cards.
- [x] Validate maths, history completeness, retry/recovery, real receipts and phone UI.
- [x] Run `npm run check` (**86** suites), finish final syntax/copy checks and
  prepare the release for the explicitly approved push.
- [x] Verify real Base/BNB collection through the bounded public-chain runner.
- [ ] Verify the deployed page directly: the workspace proxy blocks Vercel (403).

Initial source checks: Base Blockscout returns HTTP 403 from the runner; Routescan
does not support these two networks. Use verified on-chain receipts rather than
those indexers. Quote USD stablecoins use the existing explicit $1 assumption.
Average cost and P&L are for the swap book, as on KAT Trades; current wallet and
LP balances do not become additional trades or get added to that trade-book value.

Verified implementation and evidence (19 November 2026):

- [x] Both tracked wallets, Base and BNB Chain, automatically scanned to verified
  heads. Base through **59,452,656** (nonces 2/8); BNB through **134,480,217**
  (nonces 7/7). Real public reads found **no wallet-initiated UNI swaps**.
  Current Base UNI LP activity is correctly excluded from buys/sells. The seed
  `uni-trades.json` contains this real completed backfill, not synthetic fills.
- [x] Find outgoing transactions through historical wallet nonces and complete
  transaction blocks, with nonce-count reconciliation, receipts and block hashes.
  Avoid scanning millions of blocks through unsupported indexers. The BNB Blast
  public endpoint provides the required free archive reads; paced calls and bounded
  retries handle temporary capacity errors. Neither API keys nor paid services are
  required. Unsupported contract-wallet history fails explicitly.
- [x] Pure `uni-trade-core.mjs` uses per-network weighted average cost and actual
  stablecoin consideration. Detected unsupported swaps remain listed with dollar
  cost unavailable; no use of today's price to invent an old execution price.
  Net gas is reported in native units and excluded from trade P&L.
- [x] `/api/uni?view=trades` is a separate cache/view within the existing function;
  the project still has **12** public Vercel functions. Saved ledger validation
  precedes RPC reads. Block failures preserve earlier committed checkpoints;
  reorg/missing receipt/incomplete block errors never silently advance history.
- [x] New `uni-trade.html`/CSS/module, UNI-guide link, filterable buy/sell table,
  shared UNI LP Book cards selected by actual token contract in canonical metadata,
  both themes, English/Chinese, independent trade/LP refresh and retained timestamps.
  Service worker and shared translation assets use cache **178**.
- [x] **96** deterministic classification/accounting/history assertions and
  **51** API/recovery/recorded-receipt/read-only assertions pass. Ten actual Base
  receipts are included as regression evidence; LP changes and collections do not
  become swaps. Existing UNI guide checks also pass (292 + 45 + 2,264 assertions).
- [x] **230** browser assertions pass at 320/375/1366 px, both themes/languages:
  quantities, average cost, mark value, P&L, network filter, current LP cards,
  source failure/partial recovery, missing basis, invalid response, navigation,
  no horizontal overflow and shared header on one row.
- [x] Final complete `npm run check` passes all **86** suites, including the
  current hypothetical agent-campaign regression; final changed-file syntax and
  byte-identical Portfolio copies pass. Release is ready for the authorized push.
- [x] Main-branch collector [run 44499457355](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44499457355)
  succeeded after publication, with complete coverage and no errors: Base through
  **59,456,062** and BNB through **134,481,731**, saved in `39e5248`.
- [ ] Direct Vercel page verification remains blocked by the workspace proxy
  (HTTP 403); no live-browser verification is claimed.

One existing agent test used a November 8 hypothetical campaign in a conversation
executed against the actual clock; the campaign expired before this release.
The conversation portion now builds a current hypothetical campaign. Fixed-date
financial scenarios and all production agent logic are unchanged (123 assertions).

Collection runs independently at :47 each hour and on the feature publication.
The browser refreshes trade readings every 30 seconds and shared LP cards every
15 seconds. GitHub cron delivery can be delayed; the source clocks remain visible.
The UNI writer modifies only `uni-trades.json`, keeping LP/KAT ledgers and NAV
accounting independent. Current LP cards follow LP Book's supported chains; the
current UNI position is on Base. This change does not add BNB to global NAV/LP Book.

Release `5f8d387` was rebased and pushed to main as explicitly requested. No new
production secrets, Cloudflare/D1 configuration or paid services are needed.
GitHub Actions must retain the existing contents-write permission for its ledger.
The live page is [UNI Trade](https://tiger-foundation-dashboard.vercel.app/uni-trade.html).

## 1inch limit fills, combined P&L and collected fees — 19 November 2026

Owner explicitly requests **push** for this follow-up.

- [x] Identify the original gap: maker orders are filled by resolver transactions,
  so outgoing wallet nonces do not discover every filled order.
- [x] Verify actual 1inch receipts, actual UNI/stablecoin consideration and cost.
- [x] Add complete UNI-transfer discovery, receipt/order verification, resumable
  checkpoints, deduplication, partial-fill handling and source failure recovery.
- [x] Combine numeric UNI LP net (open + closed) with unrealised P&L on actual
  loose UNI; prevent double counting principal, LP inventory and fee tokens.
- [x] Add collected UNI + USDC fee value, preserving the recorded claim prices.
- [x] Update both languages, app cache, source/accounting tests and mobile UI.
- [x] Run `npm run check` (**89** suites) and final source/copy checks.
- [ ] Publish and verify main-branch collection.

Implementation and validation for the follow-up:

- `api/_uni-orders.mjs` authenticates the eight-word order against the deployed
  1inch v4 `hashOrder` and the actual `OrderFilled` event. The official FeeTaker
  receiver is supported; actual owned-wallet transfers price the fill **after**
  fees. The two partial fills share an order hash and retain distinct transaction
  IDs. Resolver gas is reported as resolver-paid, never charged to the owner.
- `api/_uni-flow-reader.mjs` reads complete UNI Transfer windows in both directions;
  a transfer alone never becomes a trade. Historical and current cursors stay
  separate. `complete` means the current reading is complete; `historyComplete`
  and `historyErrors` report the older backfill independently. Never interpret
  a live success as proof that all older BNB orders have been indexed.
- Current opening inventory is proven by ERC20 balance conservation: current
  combined wallet units minus the complete interval's net UNI transfers. This
  avoids an unavailable archive balance read and preserves unknown starting cost
  when units already existed. Old and recent verified intervals can overlap;
  their union supplies complete inventory coverage without replaying duplicates.
- `uni-accounting.mjs` combines **LP Book** numeric net for tracked open/closed
  UNI LPs with actual loose UNI gains. It excludes UNI still in LPs. LP principal
  returned to the wallet takes its withdrawal-block cost; open-LP claimed fee
  appreciation already in LP net is excluded from wallet gains. Unknown costs or
  a wallet reconciliation gap remain unavailable. Already booked history is never
  repriced. Actual zero wallet exposure has zero unrealised gain.
- `api/lpbook.mjs` adds numeric `uni` accounting to the existing view, with no
  change to existing cards, ledgers, authentication or accounting. Collected fee
  USD and the UNI/USDC token breakdown reuse recorded claims, excluding withdrawn
  principal. The first recorded claim is **$0.03**, from **0.003015484484268225 UNI**
  and **0.012576 USDC**.
- Both languages and hidden themes remain supported; shared cache is **179**,
  trade cache key is `tf_uni_trades_v2`, and average/fill prices show five decimals.
  No new public function, API key, Cloudflare setting or wallet permission is needed.
- Targeted checks pass: **103** existing/new history assertions, **51** trade API
  assertions, **50** independently hashed actual 1inch-fill assertions, **67**
  batch/source recovery assertions, and **35** LP/wallet/fee accounting assertions.
  Recorded test fixtures are frozen so daily ledger updates cannot change their
  expected results. The existing LP API harness injects the new real accounting
  helper; its **144** refresh/recovery assertions pass.
- `npm run check` passes all **89** suites. Phone/desktop browser checks cover both
  themes and languages, P&L/fee source bindings, filters, missing basis, source
  failure, recovery and navigation. Final release evidence is recorded below.

Remaining verification/blockers:

- [ ] Older BNB maker-fill history is still catching up: free endpoints restrict
  archive logs or impose keyless rate limits. Current fills, inventory and P&L
  have their own verified reads and continue independently. The bounded job keeps
  partial progress; no historical absence or zero cost is fabricated.
- [ ] Verify the published page and collector after the authorized push. Direct
  Vercel requests from this workspace are blocked by its proxy.

Final local browser evidence: **254** assertions pass at 320/375/1366 px in both
themes/languages. The five cards, LP/holding split and collected UNI/USDC fee
breakdown preserve their source values through refresh failures and recovery.
