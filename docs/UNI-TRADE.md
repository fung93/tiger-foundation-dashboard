# UNI Trade

## Average buy price with current-price remark — 20 November 2026

The owner asks for average buy price as the primary value and current price
as a smaller remark, then explicitly requests **change and push**.

- [x] Replace the first card label/value with **Average buy price**; show
  **Current price: $…** below it in the existing smaller help-text style.
  Keep network names, timestamps and the secondary BNB quote out of this card.
- [x] Use the weighted average of recorded verified buys: actual USD spent /
  actual UNI bought, including partial 1inch fills. LP inventory changes, fees,
  transfers, sales and today's market price do not rewrite buy execution prices.
  Missing buys, quantities or costs keep the average unavailable.
- [x] Preserve Capital, actual holdings, Value now, value-minus-capital P&L,
  the record icon, both networks/themes/languages and immutable financial data.
- [x] Bump app/changed UNI assets and accounting module to **188**. Existing
  translations already cover both labels and stay **186**; LP cards stay **183**.
- [x] **143** UNI accounting/overview checks; **51** real-receipt 1inch checks,
  including the new dashboard average against the three recorded partial fills.
- [x] **276** Chromium assertions at 320/375/1366 px, both themes/languages:
  weighted average primary value; smaller, independently refreshing market
  quote; aligned wrapped headings; missing cost/price/buys and recovery; unchanged
  Capital/holdings/Value now/P&L and record. Inspect the desktop card screenshot.
- [x] `npm run check` passes all **91** suites. Final syntax/diff checks and
  identical Portfolio copies pass; no financial history JSON is edited.
- [x] Publish [`370b283`](https://github.com/fung93/tiger-foundation-dashboard/commit/370b283)
  to main as explicitly requested.
- [x] [Production verification run 44755514219](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44755514219)
  succeeds on its first attempt: HTML/JS/CSS/accounting/service-worker files
  match the tested release exactly; primary average, independent current-price
  remark, hidden network/date metadata and cache **188** are confirmed.

At **20 November 2026, 22:39 MYT**, the real reading contains **7** verified
recorded buys: **49.19232172609907 UNI** for **$249.882534**. Their weighted
average is **$5.0797060441939745**, displayed as **$5.08**. The independent current
quote is **$4.73474641374973**, displayed below as **$4.73**. The existing older
history backfill is still incomplete; the average uses the same recorded-buy
scope as Capital. No new credential, provider, migration or wallet permission
is required, and there is no remaining deployment blocker.

## UNI price card cleanup — 20 November 2026

The owner asks to remove the network/reading time and the secondary BNB Chain
price beneath UNI price, then explicitly requests **push** after local validation.

- [x] Leave only the **UNI price** label and live primary price in that card.
  Remove the two metadata elements, their render calls and unused CSS.
- [x] Keep both network quotes and their source timestamps in the data; preserve
  freshness status, all five financial values, P&L and the record icon.
- [x] Bump the app and changed UNI JS/CSS to **187**. Accounting/translations
  stay **186**, shared LP cards stay **183** and Portfolio copies stay identical.
- [x] JS syntax/diff checks and **51** UNI API/read-only/recovery assertions pass.
- [x] **192** Chromium assertions using recorded verified inputs: price-only
  rendering persists through refreshes at 320/375/1366 px, both languages/themes;
  the five financial values, formula, LP contributions and record remain intact.
- [x] Publish [`ea907d2`](https://github.com/fung93/tiger-foundation-dashboard/commit/ea907d2)
  to main as explicitly requested.
- [x] [Production verification run 44745781623](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44745781623)
  succeeds: deployed HTML/JS/CSS/service worker match the approved local files
  exactly; price card has no network/date or secondary quote; live price
  selection and all five cards remain; app cache **187** and unchanged
  accounting module **186** are confirmed. No remaining release blocker.

## UNI price, holdings, capital, current value and P&L — 20 November 2026

The owner's latest instruction explicitly authorizes **push** and supersedes
his earlier local-only layout. Show exactly five cards in this order:
**UNI price · UNI held · Capital · Value now · P&L**.

- [x] Show separate Base/BNB UNI prices with their own source timestamps.
- [x] UNI held is actual UNI in both tracked wallets on Base/BNB, plus UNI
  principal and still-unclaimed owner UNI fees in open tracked LPs. Exclude
  closed positions and already claimed fees from LP inventory.
- [x] Capital is gross USD actually paid for verified recorded UNI buys,
  including 1inch fills. Sales, LP deposits and claims are not new purchases.
  Mark incomplete older history as recorded capital; never invent missing cost.
- [x] Value now is wallet UNI at each network's own quote plus the complete
  two-token principal of open UNI LPs and their unclaimed owner fees. Stablecoin
  inside an LP remains part of its value when UNI is swapped into that leg.
- [x] Top P&L is exactly **Value now − Capital**. This is the owner's specified
  current-holdings comparison, not the old LP lifetime-net-plus-wallet-gain rule.
  Sale proceeds and prior distributions outside those tracked holdings are not
  added. LP Book accounting/history and private agent calculations stay intact.
- [x] Keep the record icon; show wallet value and every current LP's principal,
  unclaimed fees and total value, followed by Value now, Capital and the same
  top P&L. Remove the LP fees summary card to retain the requested five cards;
  individual current LP cards still show fees and their original P&L.
- [x] Preserve both languages/themes, read-only access, source-failure recovery,
  all immutable financial histories and the UNI range gradient. Cache/assets
  use **186**; shared LP card assets stay **183**.
- [x] **130** deterministic accounting/overview checks and **73** language checks.
- [x] **396** actual Base ABI reader assertions, including canonical UNI units,
  both wallets, complete two-token LP values and unclaimed fees.
- [x] **371** Chromium assertions at 320/375/1366 px, both themes/languages:
  exact five-card order, source prices, actual held units, full LP valuation,
  value-minus-capital P&L and matching record components; fee-claim neutrality,
  missing wallets/costs/LP values, recovery, alignment and no horizontal overflow.
  Inspect the desktop card screenshot (test data, not production balances).
- [x] `npm run check` passes all **91** suites; final syntax/diff/copy checks pass.
  No financial history JSON is changed by this implementation.
- [x] Publish [`876a004`](https://github.com/fung93/tiger-foundation-dashboard/commit/876a004)
  to main as requested, preserving newer automated UNI pool readings.
- [x] [Production verification run 44739995494](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44739995494)
  succeeds: exact five-card order, changed page/JS/CSS/translation assets,
  service-worker cache **186** and fresh API inputs. Independently reconcile
  network-priced wallet UNI, whole LP principal, unclaimed owner fees,
  verified recorded buy spending and value-minus-capital P&L.
- [x] **162** further Chromium assertions using the actual production inputs:
  all five displayed values, current LP contribution/record totals, the exact
  formula, both themes/languages and 320/375/1366 px layout with no overflow.

Verified **20 November 2026, 20:58 MYT**:

| Reading | Value |
|---|---:|
| UNI held (wallet + current LP) | 49.84 UNI |
| Recorded UNI purchase capital | $249.78 |
| Wallet UNI value | $0.00 (dust) |
| Open LP principal | $236.19 |
| Unclaimed LP fees | $1.64 |
| Value now | $237.83 |
| P&L: Value now − Capital | -$11.95 |

Base/BNB quotes were approximately **4.3 / 1.3 seconds** old relative to the LP
reading. Capital is **recorded** buy spending: the existing older-history
backfill is still incomplete and is labelled as syncing in the page/record.
These dated live values change with prices, fees and subsequent confirmed buys.

Wallets cover Base and BNB Chain; LP units/value cover currently tracked LP Book
positions. This does not add BNB LP discovery to global LP Book. No new
credential, database, paid provider or wallet operation is needed.

## P&L contribution record — 20 November 2026

The owner explicitly requests **push**: a small record icon on the P&L card
that identifies which LPs contribute to the total.

- [x] Inspect the current calculation: all open and closed UNI LP net, plus
  unrealised gain/loss on actual loose wallet UNI. Preserve that calculation.
- [x] Add pair, original open/close dates, price P&L and fees to the existing
  additive per-position API record. Reuse numeric LP Book metrics and fixed
  closed figures; do not parse display strings or reprice historical earnings.
- [x] Add a native modal from the small record icon. List every position's ID,
  network, wallet, open/closed status, price P&L, fees and net contribution.
  Show LP subtotal, wallet unrealised contribution and the identical top total.
- [x] Check position net against the LP subtotal; incomplete, duplicate or
  mismatched rows cannot claim a reconciled record. Fees remain included once.
- [x] Add both languages/themes, keyboard/close behavior and app cache **184**.
- [x] Pass **66** deterministic UNI accounting/attribution assertions and
  **73** shared language assertions.
- [x] **317** Chromium assertions at 320/375/1366 px in both themes/languages:
  the controlled -$2.03 total reconciles across the original closed positions
  and a test current position; wallet gain is counted once; current LP first;
  source failure/expiry/recovery; dialog remains open across polling; icon,
  keyboard/focus, close/backdrop behavior and no horizontal overflow. Inspect
  both 375 px theme screenshots. Test current amounts are synthetic, not a
  claim about the owner's current live reading.
- [x] `npm run check` passes all **91** suites. Final changed-JS syntax, diff
  and byte-identical Portfolio checks pass. No financial history JSON is edited.
- [x] Publish [`a8cb991`](https://github.com/fung93/tiger-foundation-dashboard/commit/a8cb991)
  to main as requested, preserving the newer automated UNI trade history.
- [x] [Production verification run 44715312537](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44715312537)
  succeeds: live icon/dialog, changed assets/translations and cache **184**;
  all **nine** UNI LP records have original price P&L, fees and net, and reconcile
  to the same combined P&L. Price P&L + fees agrees with each net after the
  existing cent rounding. The first attempt waited for the new deployment;
  the second reads the new assets and fresh API observations successfully.
- [x] **24** additional mobile browser checks using those actual production
  records: both themes/languages, all nine entries, current position first,
  identical real top total and a vertically scrollable record with reachable
  total and no horizontal overflow.

Production reading at **20 November 2026, 18:00 MYT**:

| UNI/USDC LP | State | Price P&L | Fees | Net contribution |
|---|---|---:|---:|---:|
| #6617359 | Open | $3.18 | $0.97 | $4.15 |
| #6617330 | Closed | -$0.68 | $0.00 | -$0.68 |
| #6617298 | Closed | $0.00 | $0.00 | $0.00 |
| #6616840 | Closed | -$2.01 | $0.47 | -$1.54 |
| #6616136 | Closed | -$0.75 | $0.00 | -$0.75 |
| #6616041 | Closed | -$3.06 | $0.00 | -$3.06 |
| #6614022 | Closed | -$0.40 | $1.24 | $0.84 |
| #6611265 | Closed | -$0.70 | $0.15 | -$0.55 |
| #6607586 | Closed | -$0.47 | $0.03 | -$0.44 |

Closed net **-$6.18** + current net **$4.15** + wallet unrealised **$0.00** =
top P&L **-$2.03**. These dated verification readings move with subsequent live
prices/fees for the current LP; closed results keep their recorded values.

No new credential, database migration, wallet permission or paid provider is
required. The historical -$2.03 shown by the owner is a moving live total; the
record explains the same current reading rather than freezing that value.

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
- [x] Verify the deployed page through the read-only Actions runner; the local
  workspace proxy still blocks Vercel (403).

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
- [x] Published page/API verification completed through the read-only Actions
  runner during the follow-up; direct workspace requests remain blocked (403).

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
- [x] Publish and verify main-branch collection (`e07ea66`, run 44513644625).

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
- [x] Verify the published page and collector after the authorized push through
  a read-only Actions runner; direct workspace Vercel requests remain blocked.
  The live check recovered all three fills and the exact weighted average.
  On 19 November at 19:24 MYT, UNI LP net was **$0.49** (open **$0.93**,
  closed **−$0.44**), wallet unrealised was **$0**, collected fees **$0.03**.
  These are dated verification readings, not current fixed balances.

Final local browser evidence: **254** assertions pass at 320/375/1366 px in both
themes/languages. The five cards, LP/holding split and collected UNI/USDC fee
breakdown preserve their source values through refresh failures and recovery.

## All LP fees and two-decimal display — 19 November 2026

The owner explicitly requests **push** after these changes. The environment
became unavailable during implementation and has now recovered; resume the same
work and preserve the previously published 1inch history.

- [x] Replace **Collected LP fees** with **LP fees**: all current earnings,
  whether claimed or not, plus the tracked closed positions' recorded fees.
- [x] Place **LP fees** before **P&L**, including the phone layout.
- [x] P&L retains LP net (which already contains claimed and unclaimed earnings)
  plus actual wallet UNI gains. The fee card is never added a second time.
- [x] Show UNI quantities, fee quantities and execution/average prices with two
  decimal places; full stored precision and native gas precision remain.
- [x] Update English/Chinese copy and app/translation cache **180**.
- [x] Fix Base's live catch-up span so four windows can cover an ordinary
  six-hour backlog on the first request. A regression reproduces **130,000**
  blocks still behind with the previous span; the new span reaches head without
  rewriting existing deposits, fees, claims or closed outcomes.
- [x] Accounting checks: **45** assertions. Actual ABI-shaped Base checks:
  **388** assertions, including total UNI/USDC fees and claiming neutrality for
  both earnings and P&L. Missing fees, malformed data and old claimed-only
  responses stay unavailable rather than producing false totals.
- [x] `npm run check` passes all **89** suites. **305** Chromium assertions pass
  at 320/375/1366 px, both themes/languages, including actual **19.10 UNI** and
  **$5.23** average-cost display, card order, earnings/P&L, source failure and
  recovery. Portfolio copies and final diff checks also pass.
- [x] Published [`bcf53a6`](https://github.com/fung93/tiger-foundation-dashboard/commit/bcf53a63855f88a9f5d5e366a02aeb4f3b431685)
  to main. The live page, cache **180**, fee-before-P&L order, two-decimal
  formatting, actual three fills and fee/P&L components all verified in
  [read-only run 44541962049](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44541962049).
  On **19 November, 22:16 MYT**, LP fees were **$0.18** (collected **$0.03**),
  LP net/P&L **−$0.58**, wallet unrealised **$0**. Totals matched the separate
  open/closed LP Book metrics; these are dated verification readings.
- [x] A real Base probe accepts both filtered **50,000-block** query types at
  block **59,537,112**. The main-branch
  [Base verification run 44541917604](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44541917604)
  also succeeds, checking real ownership, fees and LP Book inclusion without
  modifying any ledger.

`api/lpbook.mjs` retains its additive `uni-lp-accounting-v1` summary. New
`earnedUsd` and `earnedTokens` fields reuse the existing numeric position
metrics. Open LP earnings use live token prices as in LP Book; closed earnings
keep their historical prices. Existing collected-fee fields and claim evidence
remain available to older consumers. No database migration, secret, paid
provider, wallet connection or new public function is required.

The known older BNB archive backfill remains independent of verified live
fills and inventory; the new fee/UI work does not claim that backfill is complete.

## Current UNI LP range colours — 20 November 2026

The owner explicitly requests **push** for UNI pink on the left edge and USDC
blue on the right edge of each **Current UNI LPs** range line.

- [x] Add a scoped `#uniLps .lpw .fill` gradient, `#ff007a` → `#2775ca`.
  Keep the live price marker and in/out-of-range badge behavior.
- [x] Bump the app cache and changed stylesheet to **181**. Unchanged JS and
  translation assets stay at **180**; shared LP styles and accounting stay intact.
- [x] **192** browser assertions pass at 320/375/1366 px, both themes/languages:
  exact gradient direction/colours, both current cards, in/below/above range,
  marker placement, warnings, styling scope, unchanged figures and no overflow.
- [x] `npm run check` passes all **89** suites; final diff checks pass and
  the Portfolio copies remain identical.
- [x] Published [`127f968`](https://github.com/fung93/tiger-foundation-dashboard/commit/127f968)
  to main. [Read-only production check 44657159821](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44657159821)
  succeeds: the live page references CSS **181**, the scoped gradient has UNI
  pink at the left and USDC blue at the right, and app cache **tiger-v181**
  includes the changed stylesheet. Direct workspace requests remain blocked
  by the proxy, so the production fetches ran through this read-only runner.

Changed production files are `uni-trade.css`, its two page references
(`uni-trade.html`, `uni.html`) and `sw.js`. The existing offline-asset assertion
tracks the new CSS URL. No financial reader, ledger, secret or configuration
changes are required.

## Compact P&L record — 26 November 2026

The owner explicitly requests **simplify the P&L record and push**.

- [x] Show only realized, current and total P&L at the top.
- [x] Keep compact per-LP results with pool pair, position ID and network.
  Pending/loose-token gains remain represented; non-LP settled sales and
  withdrawals group by kind/network instead of listing every transaction.
- [x] Remove the repeated funding/value breakdown, funding history, cost/return
  subrows, transaction links and long accounting paragraphs from the dialog.
- [x] Preserve raw receipts, strategy funding, fee inclusion, settlement rules,
  all financial history and the live P&L calculation. No reader/API changes.
- [x] Bump app and changed Trade JS/CSS references to **192**. Existing history,
  translation and other assets keep their own versions; Portfolio copies match.
- [x] Verify the compact record: **161 browser assertions** across six accounting
  scenarios, both languages/themes and 320/375/1366 px. Current, closed, reused,
  top-up, partially exited and uncollected positions keep their original P&L.
  The dialog stays open through refresh and closes with Escape; no sideways
  overflow. `npm run check` passes all **99 suites**, including API/accounting
  checks. Portfolio copies and `git diff --check` pass.
- [ ] Verify the deployed page; production access has been proxy blocked here.

Validation logs/screenshots: `/workspace/tiger-agent-validation/uni-simple-pnl/`.
No new configuration, service, secret or wallet permission is required.
