# AGENTS.md: Tiger Foundation dashboard

Handover for a coding agent taking over this repository (written 24 Oct 2026, at the
hand-off from Claude Code to Codex). Read all of it before changing anything. It records
what the code cannot tell you: who it is for, the rules he has set, and the traps that
have already cost days.

---

## 1. The owner, and how to work with him

The owner is **Alex**: a Malaysian, self-taught investor. **He does not code.** He directs by
outcome, not implementation, and checks results on the live site.

- **Never push unless he says "push".** He says it explicitly when he wants something live.
  Do not commit, push or deploy on your own initiative. Approval for one push is not
  approval for the next. If his wording is ambiguous ("ok", "looks good"), ask.
- **Talk in plain language.** No code in explanations unless he asks. When something needs
  his judgement, say what it does and what he must decide, with a recommendation.
- **Show measured numbers, not guesses.** He asks "why" about discrepancies. Decompose them
  and measure them against the chain; do not theorise.
- **End every answer with a short direct verdict.** One or two plain sentences answering the
  question as asked. This is a summary at the end, never a replacement for the analysis.
- Be concise; no filler. He is thoughtful, not in a hurry.
- Report outcomes faithfully. If something failed or was skipped, say so.
- Analysis of strategies is information, not financial advice; frame it that way.

---

## 2. What the project is

A personal crypto portfolio dashboard. It reads balances, liquidity positions, lending and
rewards straight from chain RPCs without API keys. The optional personal agent (built locally
5 Nov 2026) uses Cloudflare Workers Free, included Workers AI, D1 private state and
Telegram credentials; the financial readers and public ledgers remain independent of it.

- **Live site:** https://tiger-foundation-dashboard.vercel.app. Vercel auto-deploys every
  push to `main` of https://github.com/fung93/tiger-foundation-dashboard.
- **Local clone:** `C:\Users\User\Desktop\tiger-foundation-dashboard` (Windows; Git Bash
  and PowerShell both available).

### Wallets (all his)

| Wallet | Address | Notes |
|---|---|---|
| Main | `0xb378207ab46aa2105eb1cb94ae8a5bab57316de1` | Katana, Robinhood Chain, Arc |
| Second, "Tiger Vault" | `0x4da1d0d5f7b123364d7580f19b716de2ed4e9770` | Counted like any wallet in the chain breakdown; holds the WETH/USDG LP #1458357 |
| Solana | `GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B` | |

### Chains

- **Katana** (747474): Sushi V3 LPs (some staked), Morpho Blue loans, avKAT/vKAT, Merkl KAT rewards.
- **Robinhood Chain** (4663): Uniswap V3 LPs, Fables (a Uniswap V4 hook) and veFABLES.
- **Arc** (5042, Circle; gas is USDC): Uniswap V3 and V4.
- **Solana**: Meteora DLMM.

Chains with less than $5 and no LP show as INACTIVE.

---

## 3. Architecture: two clocks

1. **Scheduled job, every 6 hours** (`.github/workflows/update-data.yml`, Node 20, zero
   dependencies). Since 3 Nov 2026 it wakes every hour at :17 and its first step ("Is the data
   due") goes on only when `data.json`'s `last_updated` is 5.5 hours old (19,800 s); a run by
   hand (`workflow_dispatch`) always goes on. GitHub delays and drops scheduled runs, worst on
   the hour: `0 */6` ran 10 to 13 hours apart from 31 Oct to 3 Nov, and the KAT page said "The
   six-hourly ledger is 13 hours behind" (its note shows past 12 hours). A skipped hour costs a
   checkout and commits nothing, so Vercel still deploys about four times a day. It runs `scripts/update-data.mjs`, which reads everything server-side and,
   at its end, calls `scripts/lpbook.mjs` and `scripts/morpho.mjs` in separate error
   boundaries. It commits these files as `github-actions[bot]`:
   - `data.json`: the snapshot and discovery state (meteora_refs, morpho_markets, fables, ...)
   - `history.json`: daily totals, one entry per UTC date
   - `claims.json`: the claim record, including `lp_fees`
   - `positions.json`: LP ledgers per chain
   - `lpbook.json`: the LP Book ledger
   - `morpho-history.json`: Katana lending observations at six-hour intervals
   - `strategy-ranges.json`: each KAT-paying pool's hourly low/high tick for 31 days, and
     each pool without KAT the Strategy page shows (`FEE_POOLS`)
     (`scripts/strategy-ranges.mjs`, its own error boundary; added 1 Nov 2026)
   - `kat-trades.json`: Alex's KAT trades since 27 Oct 2026, deposits waiting to be paid back,
     and the KAT/vbUSDC pool's hourly closing tick (`scripts/kat-trades.mjs`, its own error
     boundary; added 1 Nov 2026)
   - `vkat-votes.json`: Alex's gauge vote events, the vote rewards Merkl paid with their
     campaign dates and payout prices, and KAT's price when each vote week closed
     (`scripts/vkat-votes.mjs`, its own error boundary; added 1 Nov 2026)
2. **Browser live overlay, every 15 seconds.** The pages read the chain and the `/api/*`
   functions directly. The Portfolio starts from the saved snapshot. The LP Book and
   widget can show their shared last full browser reading immediately; refresh failures
   follow the rules in §4 below.

**Vercel serverless functions** live in `api/` (Node ESM, zero dependencies):

| Function | What it does |
|---|---|
| `api/_core.mjs` | Shared chain code. The underscore means it is not served, only bundled. ~2,200 lines. |
| `api/lpbook.mjs` | Carries `lpbook.json` to chain head in memory, then returns the finished view. `s-maxage=10, swr=5`. |
| `api/vault.mjs` | The second wallet's live value. |
| `api/fables.mjs` | Fables LP ranges and veFABLES locks. |
| `api/morpho.mjs` | Current Katana Morpho positions, including accrued debt and oracle values. |
| `api/strategy.mjs` | The Strategy page's reading: the epoch, the live KAT staking campaigns and each pool's eligible in-range liquidity. `s-maxage=30, swr=30`. |
| `api/lp.mjs` | Legacy widget endpoint; no longer used by the widget. |
| `api/agent.mjs` | Private owner login, shared chat/preferences and Telegram pairing. Private status uses POST, never GET. |
| `api/agent-telegram.mjs` | Secret-verified private Telegram webhook; approved owner only. |
| `api/agent-monitor.mjs` | Bearer-authenticated background health/data checks, MYT daily reports and notification retries. |

### Pages and shared assets

| File | What it is |
|---|---|
| `index.html` | The main **Portfolio** dashboard, ~5,000 lines inline. Classy theme by default; the cute tiger is the alternative theme (localStorage `tf_theme2`='tiger'). `vercel/index.html` must stay **byte-identical**: copy it after every edit. |
| `lp.html` | LP Book, **Live**: open positions at live prices. |
| `lp-all.html` | LP Book, **All-time**: closed positions, every figure fixed at close. |
| `lending.html`, `lending.css`, `lending.js` | Katana Morpho markets, personal lending limits and historical value/health charts. |
| `morpho-core.mjs` | Browser-safe shared Morpho reader and target maths used by the page, API and history job. |
| `strategy.html`, `strategy.css`, `strategy.js` | **Strategy**: Katana's KAT emissions for staked Sushi LPs, every paying pool by APR, and a per-pool range estimate. See §4. |
| `strategy-core.mjs` | The Strategy estimate's maths and the recent-range maths, with no network: used by the page, `api/strategy.mjs`, `scripts/strategy-ranges.mjs` and `scripts/test-strategy.mjs`. |
| `scripts/strategy-ranges.mjs`, `strategy-ranges.json` | Hourly `[hour, low tick, high tick, swaps, close tick]` per KAT-paying pool and per `FEE_POOLS` pool, 31 days, from its Swap logs (read with `swapLogs`, which halves a window over Katana's 10,000-log cap: the KAT/vbUSDC pool had 59,758 swaps in the 31 days to 3 Nov 2026). The job reads only blocks since `last_block`; a new pool gets 31 days (~73 s for five pools; ~3 s incremental). Validated before any network read; saved after each pool. |
| `kat.html`, `kat.css`, `kat.js` | **KAT Trades**: KAT price, average buy price, unrealised and realised P&L, the P&L chart and the trade table, from 27 Oct 2026. See §4. |
| `kat-core.mjs` | The KAT page's trade finder (from wallet transfers and receipts), the average-cost book, the P&L series and the ledger's validation, with no network: used by the page, `api/kat-trades.mjs`, `scripts/kat-trades.mjs` and `scripts/test-kat-trades.mjs`. |
| `vkat.html`, `vkat.css`, `vkat.js` | **vKAT Votes**, the KAT section's second tab: vKAT held, epochs voted, total vote reward, average APY, the reward chart and the vote history. See §4. |
| `vkat-core.mjs`, `api/vkat.mjs`, `scripts/vkat-votes.mjs`, `vkat-votes.json` | Its maths (votes per epoch, rewards per epoch, APY, ledger validation), the API (ledger + anything newer + live locks, ~4 s) and the six-hourly job (first run ~37 s; then only new blocks and new campaigns). |
| `api/kat-trades.mjs`, `scripts/kat-trades.mjs`, `kat-trades.json` | The ledger the job keeps (only blocks since `last_block`; ~2 s incremental), and the API that adds everything since it plus the KAT and ETH prices now (~1.8 s, ~5 KB on 1 Nov 2026). |
| `scripts/morpho.mjs`, `morpho-history.json` | Daily older archive observations and six-hour recent observations, valued at their own pinned blocks. |
| `lpbook.css`, `lpbook.js` | Shared by the two LP Book pages: styles, chart, 15 s poll, modal. |
| `lpcards.css`, `lpcards.js` | The live position card and LIVE stamp, shared by `lp.html` and `widget.html`. Change the card here, never in one page. |
| `widget.html`, `widget.webmanifest` | A separately installable phone shortcut showing the LP cards, with a small warning when a chain cannot be read. It has its own LP-range icon. |
| `docs/hedge-desk/` | Historical Hedge Desk guides. The page has been withdrawn from the website; see §7. |
| `sw.js` | Service worker. **Bump `CACHE_VERSION` on every page or asset change**, or returning visitors keep the old shell. |
| `agent.html`, `agent.css`, `agent.js`, `agent-launcher.js` | Personal assistant page and floating dashboard drawer; both themes, private login, shared history/settings and Telegram pairing. |
| `manifest.webmanifest`, `icons/` | PWA files. The site icon is a white metallic tiger: `icons/tiger.svg`, drawn by `scripts/tiger-icon.py`. |

Portfolio, both LP Book pages, Lending and Strategy have a menu bar under the header:
**Portfolio · LP Book · Lending · Strategy**, with the open page lit. The standalone widget has no menu;
tapping its Tiger Foundation masthead opens the full LP Book.

The menu buttons must keep the same position and size when switching between
Portfolio, either LP Book page, Lending, Strategy and KAT. Match the 1200 px menu frame, side padding (28 px
desktop, 16 px at 768 px and below), gap below the masthead (14 px desktop, 12 px phone)
and subtitle line height. The menu stays outside the LP Book's content wrapper; the full
pages reserve a stable scrollbar gutter to avoid a sideways jump on shorter pages.
At 540 px and below, use a 5 px gap, 8 px pill side padding, 10 px labels with .06em
letter spacing and 14 px icons; at 420 px and below also hide the icons. With the fifth item
(KAT, 1 Nov 2026) the pills tighten at 400 px and below (4 px gap, 6 px padding, .03em) and at
359 px and below (3 px gap, 5 px padding, 9 px labels, .02em), so all five labels fit on one
line down to 320 px (measured 1 Nov 2026 on all six pages at 320, 340, 359, 360, 375, 390, 401,
420 and 540 px: one row, no sideways scroll; 11 px spare at 320). `lpbook.css` carries the
rules for every page but the Portfolio, which has them inline in both copies.

The cards' outside edges must also match between Portfolio, both LP Book pages, Lending, Strategy and KAT.
Portfolio's `.wrap` and the LP Book's `.book-content` use a 1200 px outer frame with
28 px inside padding on each side at every screen width. Keep the view controls,
warnings and every row of cards inside that same frame; fixed modals remain outside it.

These look legacy; ask before deleting: `dashboard.html`, `dashboard.js`, `local.html`,
`server.py`, `ChatGPT Image Jul 16, 2026, 08_05_14 PM.png`. `serve.ps1` is the local server
(see §8).

---

## 4. Standing decisions (Alex's rules; do not change without asking)

### Display

- **On Portfolio, one card per DeFi type, never one per position.** All LPs roll into one "Liquidity
  Pools" card and Morpho into one card. Each card has a record icon that opens the detail.
- **Classy look.** Black background, Instrument Serif titles, Inter text, gold `#d6b97b` for
  what is selected. Values are off-white; only signed gains and losses are coloured. He
  said "don't want colourful".
- **Headers** use the same *Tiger* Foundation masthead and subtitle as Portfolio on
  Portfolio, both LP Book pages and the widget: serif, italic gold Tiger, upright off-white
  Foundation. There is no extra LP Book title on the LP Book pages or widget; the
  Portfolio/LP Book menu labels remain on the full pages (Alex, 24 Oct 2026).
- **Chain Breakdown order:** active chains first, then inactive, each sorted by total value
  from largest down.
- **Asset cards:** On-chain · DeFi Positions · Tiger Vault · **LP Fees** (every LP's
  unclaimed fees, all chains, both wallets). The cards sum to the total.

### LP Book fee rules (book version 9)

- **Live page, Fees claimed card:** fees actually claimed by the open positions since each
  opened. Under it: "$X still to claim" (the last-claim date was removed 3 Nov 2026, Alex). There is a claim-record icon
  and no token list.
- **Live position cards:** each position's own fees since it opened, claimed or not.
  - On Katana, that is the position's own Merkl KAT.
  - Alex's Katana rollover rule (updated 30 Oct 2026): when a Katana LP closes, its unclaimed
    KAT follows a verified replacement in the **same wallet, with any token pair**,
    including KAT inherited from earlier LPs. Match the latest eligible mint within the
    24 hours before closing, otherwise the first mint after closing (without an expiry).
    Prefer the same pool only for simultaneous matching mints. Preserve intermediate
    replacements even if they have already closed by the next read, so a cold restart
    reconstructs the same chain. Equally matching replacements retain the closed LP's
    allocation with a warning until the match is clear. New rules apply prospectively.
  - The original #492291 → #492626 transfer remains seeded: the 1,338.1368961866224 KAT
    already claimed stays with #492291. Saved rollover relationships and raw native reward
    observations live in `lpbook.json`; `api/_reward-attribution.mjs` supplies the API and
    scheduled writer with the same allocation. Prior claims keep their dates and prices.
  - The API anchors new relationships to the committed claim ledger so server restarts
    cannot change ownership. If an earlier wallet claim makes that boundary ambiguous,
    the API waits for the scheduled writer to commit a complete allocation. Never persist
    a warm API claim anchor. Failed/incomplete lifecycle or reward reads keep the previous
    allocation. Rolled-over balances count in Rewards, Net and LP versus holding; they
    are excluded from the replacement's APR so reassignment cannot masquerade as accrual.
    Saved APR observations are normalized by their recorded carry basis without rewriting
    their token balances or historical prices.
  - A complete fully claimed reward reading establishes a zero-carry replacement
    boundary immediately, even when its wallet claim is newer than the committed
    anchor. Keep settled rewards and their dated claims with the closed LP; the
    replacement's rewards and APR contain only its native earnings. Preserve that
    boundary so later genuine unclaimed accrual cannot reassign settled history.
    Partial unclaimed balances still require the existing durable claim checks.
  - On Robinhood, that is its trading fees, plus Fables fees not yet collected by the hook,
    split by the hook's own rules.
- **Live page:**
  - Cards: Value · PnL (IL + price) · Fees claimed · Net (fees + PnL). PnL by chain opens
    from a record icon on the PnL card.
  - Chart: fees claimed plus a Net line.
- **All-time page:**
  - Money row: average LP value · realised PnL · total fees · net. Rate row: APR, average
    days open, average time in range.
  - APR = fees ÷ Σ(value × days) × 365.
  - Time in range is time-weighted.
  - Realised PnL by chain opens from a record icon.
- **Tracking start:** the mint of the positions that were open when tracking began
  (Robinhood 16 Oct, Katana 19 Oct). **Bumping `BOOK_VERSION` makes the job rebuild the
  book; never do it without Alex's say.**
- **Staked Katana Sushi trading fees go to the Katana DAO, not to him.** His reward there
  is the Merkl KAT.
- **Rebalance:** a close and a mint by the same wallet within 24 hours, on any chain.

### P&L at the range edges (Alex, 1 Nov 2026)

- Each live LP card (LP Book and widget, `lpcards.js`) has a small "!" beside **P&L**. Hover,
  keyboard focus or a tap opens a box with the P&L (IL + price, **no fees or rewards**) if the
  price were at each edge of the range: upper edge = all stablecoin, the most it can be worth;
  lower edge = all the volatile token, and below it the loss keeps growing. A tapped box stays
  open across the 15-second rebuild until a tap elsewhere or Escape.
- Server side: `edgePnl(P, row)` in `api/_core.mjs` values the whole liquidity in one token at
  each edge tick (`row.raw` liq/lo/hi), stable leg at $1, and applies the card's own P&L: value
  there + withdrawn − cost. A pair with no stable leg gets no box. The view carries it as
  `edge_pnl {lower, upper: {price, pnl, up, holds}}`.
- Checked 1 Nov 2026: #492808 −$19.74 / +$3.70 and #1458357 −$509.21 / +$50.30, each with the
  current P&L between them; the same formula at today's price reproduced each card's value to
  the cent. `node scripts/test-edge-pnl.mjs` (20 assertions).

### Refresh and resilience

- Portfolio Katana reads must finish every required LP ownership, enumeration, position,
  pool and price read before replacing the displayed total. A failed subcall never proves
  an LP closed or a balance zero. Keep the previous figures, show STALE with the original
  reading time and a quiet warning; a complete recovery can restore LIVE. Verified empty
  positions and successful ownership transfers still remove closed or transferred LPs.
  Count a position once if wallet enumeration and staked discovery overlap. Wait for the
  saved position ledger before the first live read so it can supply staked candidates.
- Portfolio source fallbacks are labelled STALE, including when currency or vault updates
  repaint the retained data. LIVE expires after 90 seconds without a complete fresh read;
  its running clock must not hide a failed or stalled refresh. Retain vKAT and wallet
  values on read failure too. Staked Katana trading fees remain excluded from his wealth.
- The LP Book, widget and vault refresh every 15 s.
- Robinhood reads share `rpc-reader.js`: one paced queue per RPC endpoint, in-flight
  request sharing, bounded network/body timeouts and rate-limit backoff that respects
  `Retry-After`. Foreground state reads take priority over queued log scans. Do not
  replace failed balances or LP subcalls with zeros. Portfolio keeps its last complete
  Robinhood wallet/LP and Fables readings with their original source times.
  Oversized log queries split into disjoint inclusive block ranges, including a successful
  response at the 10,000-result cap. Children rejoin the same paced queue and share the
  original scan deadline and query budget. A failed child or saturated single block fails
  the whole query; never advance a ledger cursor with a partial result (30 Oct 2026).
- The scheduled LP writer saves verified per-position APR readings to `lpbook.json`
  `apr_series` when an unrelated chain prevents a full `fee_series` point. Exclude the
  failed chain, scan backlog, stale/missing principal or fees and unverified Merkl rewards.
  Retain reward carry metadata so inherited KAT remains excluded from APR. Aggregate fee
  and PnL history still requires every chain to be complete. Date new observations after
  the read finishes; APR needs a post-deposit baseline between 3 and 26 hours old.
- Serverless LP reads resume a warm ledger checkpoint instead of scanning the saved
  six-hour backlog on every request. An exact change to the committed snapshot resets
  that checkpoint. Concurrent endpoint requests share one pass; only complete answers
  are cached briefly, preserving their source timestamp. Failed/incomplete answers use
  `no-store`. These caches are per warm function instance, not a database.
- LP Book/widget LIVE status uses the API's `generated` time and expires after 90 seconds.
  A service-worker/edge-cache hit must never acquire the browser's current time. Errors,
  positive scan backlog, unread positions and nonzero unpriced fees are incomplete reads.
- If a chain cannot be read on a refresh (usually a Robinhood rate limit), the LP Book
  and widget keep the currently displayed reading only if it is full and less than
  5 minutes old. Both show a quiet warning naming the failed chain and a STALE stamp.
- After that hold expires, or if no full reading is available, they display the incomplete
  answer with the warning. An incomplete reading never restarts the hold, is never called
  the "last full reading", and is never saved as the last good one (`lpbook.js` `HOLD`;
  the widget follows the same rule). A full read clears the warning and restores LIVE.
- A request that fails entirely leaves the displayed figures in place with a STALE stamp;
  this is separate from the five-minute hold for an incomplete answer.

### Katana Lending (Alex, 25 Oct 2026)

- The Lending page shows avKAT/KAT and KAT/USDC separately. avKAT/USDC is hidden while
  inactive and returns if a position opens again (Alex, 26 Oct 2026). A successful
  `no_position` reading confirms no collateral, lending or borrowing; a failed read must
  never imply inactivity. KAT/USDC remains visible with an Inactive badge when empty.
  Keep all three markets in the reader, API and history. The actual USDC loan token is
  vbUSDC; keep that token identity visible. Portfolio still rolls them into one Morpho card.
- Personal maximum LTV starts at **70% for avKAT/KAT, 35% for avKAT/USDC and 35% for
  KAT/USDC on every page opening or reload** (Alex, 25 Oct 2026). Minimum health follows
  from each market's LLTV. Edits apply only for the current visit, never from a previous
  browser setting. They must never change the on-chain LLTV.
  Alex chooses Edit, then changes minimum health or maximum LTV; the other field follows.
  Only Save applies the new target for this visit and adjusts the graph. Cancel discards the
  draft. Live polling must not overwrite unsaved inputs. Personal maximum LTV = market
  LLTV ÷ chosen minimum health. Invalid inputs keep the last saved setting.
  Minimum health must be at least **1**, and max LTV must be positive and no higher than
  that market's LLTV: **77% for avKAT/KAT, 62.5% for both USDC markets** (Alex, 29 Oct
  2026). Exact boundary values are allowed. Reject values outside these bounds before
  rounding the linked field; keep the 70% / 35% opening defaults.
- Edit, Save and Cancel sit beside the My max LTV % label, with no extra button row
  below the inputs. The figures run: collateral, My debt limit, Borrowed with current
  LTV beside its label, then borrow/repay amount. Keep interest in the debt calculation,
  but omit "with interest" from the label. Market LLTV sits beside the collateral/borrowed
  description under each market name (Alex, 26 Oct 2026).
  Do not restore the removed introductory subtitle or the
  separate "Why is health 1 the liquidation boundary?" explanation (Alex, 25 Oct 2026).
- Each market shows collateral, debt, the personal debt limit and the amount that can
  still be borrowed or must be repaid. Keep repayment needs separate from other markets'
  headroom; do not net them into an apparent available-to-borrow total.
- **Health = oracle collateral value × LLTV ÷ debt.** Health 1 is the liquidation
  boundary; exactly 1 is still healthy, and below 1 permits liquidation. Health 2 permits
  debt at half the liquidation boundary, not automatically
  50% of collateral. Use each market's own oracle, never avKAT redemption value for this.
- There is no **Tiger borrowing room** heading or **3 of 3 markets shown** count.
  KAT price, avKAT price, Oracle collateral, Borrowed and Average LTV are five separate
  summary cards at the top, with avKAT beside KAT (Alex, 31 Oct 2026). KAT uses the pinned
  market pool quote; avKAT uses its vault redemption rate multiplied by that same KAT quote,
  already available as `collateral_price_usd` on avKAT market rows. Both refresh with the
  lending reading every 15 seconds. Keep each quote's original price/time on failure,
  mark it stale, and show an unavailable value before its first valid price. Never
  substitute zero, assume avKAT is 1:1 with KAT or use an oracle price as the market quote.
  Desktop shows five columns; at 1200 px and below show the prices together in the first
  two-column row and Average LTV across the final row.
  Average LTV = total debt USD ÷ total oracle collateral USD, so empty markets do not
  dilute it. Missing readings or zero total collateral show an unavailable percentage.
  Each market has its own 7D / 14D / All controls at the top right of its chart section,
  controlling both its charts independently from other markets (Alex, 26 Oct 2026).
  Mobile health charts have the same
  height as the value charts, with the SVG drawn at its measured size to avoid distortion.
  Each USDC market shows an estimated KAT
  dollar price at the liquidation boundary, using Morpho's own KAT/USD feed at the pinned
  block and assuming current debt/collateral and the oracle's other inputs stay unchanged.
  A pool-price fallback must be explicitly labelled. The oracle remains the actual trigger.
  avKAT/KAT has no single KAT dollar liquidation price: collateral and debt both move
  with KAT. Show its avKAT-to-KAT oracle boundary and current ratio instead.
- Show collateral at the market's oracle value and label the chart's value basis so its
  debt-limit lines and health agree. Beneath the collateral and personal debt-limit
  values, show the token amounts only: omit the secondary "Market value" and
  "Health … · LTV …" lines (Alex, 30 Oct 2026).
- Debt includes interest accrued to the observation's block, using a read-only
  `eth_call` simulation of Morpho's `accrueInterest` followed by its position/market reads.
  Round debt up, borrow headroom down and required repayment up; cap available borrowing
  by market liquidity. No wallet connection, signature, loan or repayment transaction.
- Historical observations use the prices, oracle and balances at their own pinned blocks.
  Never reprice saved history at today's prices or substitute zeros for failed reads.
  Each market's two charts start at its first actual Borrow event, never at the global
  file's first date or a collateral-only deposit. Exception requested 30 Oct 2026: both
  KAT / USDC charts have a fixed display cutoff at **30 Oct 2026, 00:00 MYT**, applying to
  7D, 14D and All. Preserve saved observations; the display grows forward from this date
  rather than resetting each day. Other markets retain their original first-borrow start.
  **7D is the default range** for each
  market (Alex, 29 Oct 2026); 14D and All remain available. Trim only the prefix before
  borrowing, preserving later repayments and unreadable gaps. `borrow_starts` records
  the receipt-verified opening block/time.
  Initial history includes daily archive readings from 18 May 2026, with exact opening
  observations for avKAT/KAT (18 May), avKAT/USDC (17 Oct) and KAT/USDC (20 Oct), all MYT.
  Sample `interval_seconds` distinguishes daily archive points from recent six-hour points.
  The scheduled job appends six-hour observations; the browser refreshes current values
  every 15 seconds. Failed reads retain the last reading with a visible stale warning.
  Hide borrow/repay amounts when that market's reading is over five minutes old. A full
  recovery clears the warning. The browser reloads saved history every ten minutes.
  An invalid existing history file must fail before any network request or write.

### Strategy (Alex, 1 Nov 2026)

Alex's spec: a page that uses the Katana MCP as its primary source (other sources where
appropriate) to show the current epoch number, the KAT allocated to it, KAT a day and its
start and end dates; then every pool whose **staked** LPs earn KAT emissions, sorted by APR,
each with APR, KAT a day and value a day; each pool expands to take his range and capital and
show his expected KAT a day with its value, and the total KAT and value from a start day to
the end of the epoch's rewards. Built locally on 1 Nov 2026, not pushed.

- **The page cannot call the MCP** (it is a tool for the agent, not the website). The page
  reads the sources the MCP itself points to; the MCP's figures were used to find and
  cross-check them. Where they disagreed the chain wins: on 1 Nov the MCP's `get_kat_gauges`
  reported 0 votes for vbWBTC/vbETH 0.3% and vbWBTC/vbUSDC 0.3%, but `gaugeVotes` on chain
  read 35.6M and 22.7M, and both pools have live campaigns.
- **Epoch:** clock `0x17049d374a2bcda70f8939c21ad92bcf6b2a95ab` (`currentEpoch` 0x76671808,
  `epochDuration` 0x4ff0876a = 14 days, `elapsedInEpoch` 0xc8f3e13f, `voteDuration` 7 days,
  `voteWindowBuffer` 1 h). Epochs are counted from Unix zero (`n × 1,209,600 s`). The first
  week is the gauge vote (gauge voter `0x5e755a3c5dc81a79de7a7cef192ffa60964c9352`,
  `gaugeVotes(address)` 0x9ef13a41, `votingActive` 0x408e2727); when it closes, each voted pool's
  Merkl campaign pays for 14 days. The page's epoch is the one that funded the running
  campaigns: `floor(campaignStart / 14 days)`. Epoch 1482 = 22 Oct → 5 Nov UTC, vote closed
  28 Oct 23:00, rewards 28 Oct 23:00 → 11 Nov 23:00 UTC (shown in MYT).
- **KAT per pool:** Merkl `GET /v4/opportunities?chainId=747474&action=POOL&status=LIVE`, rows
  whose identifier ends `SUSHI_STAKER`, then `/v4/opportunities/{id}?campaigns=true` for the live
  KAT campaign (amount, start, end, rules). On 1 Nov: five pools, 494,900 KAT, 35,350 KAT a day;
  every campaign was exactly 0.001288 KAT per gauge vote. "KAT this epoch" is the sum of these
  live staking campaigns. Vault incentives (Yearn, Morpho, Charm, Steer opportunities) are not
  staked LPs and stay off the page. APR is Merkl's.
- **Staked TVL (Alex, 1 Nov 2026):** each pool row reads Staked TVL · APR · KAT per day ·
  Value per day (two by two at 600 px and below). Staked TVL is `staked_usd.in_range` from
  `api/strategy`: the Sushi staker's positions and the whitelisted vault ranges in range now,
  valued on chain at today's token prices, the same liquidity a new position's share is of.
  Merkl's `tvl` counts the same thing (vbUSDC/vbUSDT 1 Nov: $178,808 Merkl vs $178,812 on
  chain, with $1,165,567 staked in all and $986,756 of it out of range) but lags: vbETH/vbUSDC
  read $242,771 on Merkl against $222,877 on chain. Merkl's figure is the fallback when the
  chain gives none (no whitelist, a missing price, an old cached reading) and is named in the
  pool's context line as the base of its APR; `staked_usd.all` adds the out-of-range staked
  value, shown there only when it is more than 1% above the in-range figure.
- **The estimate:** every campaign scores 100% by fees earned in range (`weightFees` 10000,
  out of range not paid), and only positions held by the campaign's whitelist count: the Sushi
  staker (`CFG.lpStaker`, enumerated through the NPM: 78 NFTs on 1 Nov) and the Charm
  (`baseLower/baseUpper/limitLower/limitUpper`) and Steer (`getPositions()`) vaults it names,
  whose ranges are read from `pool.positions(keccak(owner, lower, upper))`. A new position's
  share = its liquidity ÷ (eligible in-range liquidity + its liquidity); KAT a day = the pool's
  rate × share; total = rate × days from max(start day, now) to the campaign end. Token-weighted
  campaigns, an empty whitelist (all LPs) and out-of-range pay are handled though none run now.
  **Validated:** #492808 (vbWBTC/vbUSDC) predicted 2,535 KAT/day from its share, earned ~2,588
  over 38 h; $910.51 in its typed range rebuilt its exact ticks and its liquidity to 0.01%.
- **KAT price:** the KAT/vbUSDC pool's `slot0`, exactly as the Lending page prices it.
- **Display:** four epoch cards (Epoch · KAT this epoch · KAT per day · Reward period), then the
  pools. Each pool quotes its price in the cheaper token (vbUSDC per vbWBTC, vbUSDC per vbETH),
  fixed by `baseIndex` so it never flips. The deposit line shows each non-stablecoin amount's
  dollar value at today's price in brackets, e.g. "0.006341 vbWBTC ($494.90) + 505.10 vbUSDC". Defaults per pool: $1,000 and ±2.5% (stable pairs
  ±0.1%, presets in tenths of a percent); the start day defaults to today; inputs are kept for
  the visit only. The page polls every 60 s; LIVE lasts 150 s after a full reading, and the last
  reading paints at once from `localStorage` `tf_strategy`, marked STALE.
- **P&L at the range edges (Alex, 1 Nov 2026):** in each pool's estimate, above "Around now",
  a box with the simulated deposit's P&L (no KAT) if the price reaches the upper edge (all quote
  token, the most it can be worth) and the lower edge (all base token; the loss grows below).
  `edgeOutcome(pool, range, liquidity, capital)` in `strategy-core.mjs`; cost = the capital at
  today's prices; the quote token keeps today's dollar price (exact for stablecoins, and said on
  the page for a pair without one, e.g. vbWBTC/vbETH). It is the same maths as the LP Book's "!"
  (`edgePnl`): fed #492808's own liquidity and cost it gives the same −$19.74 / +$3.70.
- **Accuracy, measured 1 Nov 2026 (Alex asked):** reward estimate vs #492808's real Merkl KAT
  over 43.5 h fully in range: predicted 2,535 KAT/day, earned 2,611 on average (page 3% low);
  single 4–8 h windows ranged 2,161–2,865 (other stakers moving, Merkl's ~2 h batches). Epoch,
  campaign KAT, edge P&L, deposit split and recent ranges are exact; the total to period end
  assumes 100% time in range, so it is a best case.
- **Recent ranges (Alex, 1 Nov 2026):** under the "Around now ±%" buttons each pool has
  "Recent · 7D 14D 21D 30D": the lowest and highest price the pool actually traded at over that
  window, clicked to fill the range and recalculate. Source: every Swap log's tick (5th data
  word; Katana logs carry `blockTimestamp`). The job keeps hourly rows in
  `strategy-ranges.json`; `/api/strategy` adds the swaps since `last_block` (at most 400,000
  blocks, ~4.6 days; beyond that the windows are marked incomplete) and the price now. A window
  also counts the price it opened at (the close of the hour before it). Prices follow each
  pool's quoting; the low rounds down and the high rounds up. Hourly rows mean a window can
  reach up to an hour further back than exactly N days. Katana runs at 1 block a second
  (86,400 a day; measured 1 Nov 2026). **Validated:** 7D low/high matched a raw scan of every
  swap to the tick for vbWBTC/vbUSDC (5,837 swaps) and vbETH/vbUSDC (10,172).

### KAT Trades (Alex, 1 Nov 2026)

Alex's spec: a page for KAT trading P&L with the KAT price, average buy price, unrealised and
realised P&L, a line chart of unrealised and realised, and a trade history table (cost basis,
units bought or sold, fees). He chose to **start on 27 Oct 2026 at 16:02 MYT** (block 46,345,344,
the first buy after the 26 Oct sales) over 12 Oct, after seeing a month of his history.

- **What a trade is:** KAT swapped against vbUSDC or vbUSDT by either wallet. Found from the
  wallets' ERC-20 transfers in two shapes, both in his history: (1) one transaction moving KAT
  and a stablecoin opposite ways (a router swap; a keeper-filled limit order via
  `0x000642a0...`, whose surplus KAT is a second transfer and is summed); (2) the swap service:
  the wallet sends the token to a **one-time deposit address** (a 33-byte proxy), and a later
  transaction, sent by a relayer through `0x0000000000006ac72e...` and settled by
  `0x42ef97fa...`, moves that address's tokens into pools and pays the wallet. A deposit pairs
  with a payout only if that address passes on 98-100% of what the wallet sent, in the payout
  transaction: an LP add (the wallet "sends" vbUSDC to a pool) never matches. Deposits wait in
  `pending` for three days, so a trade split across two job runs is still found; a KAT deposit
  waiting more than 10 minutes is said on the page. A service filling one deposit in parts would
  not match (none seen); the waiting note shows it.
- **Never trades:** any transfer with Morpho Blue, Bundler3 or its adapter, the avKAT vault, the
  Merkl distributor, the Sushi NPM or the LP staker (`NOT_TRADES` in `kat-core.mjs`). On 20 and
  26 Oct KAT and vbUSDC crossed in Morpho collateral and borrowing transactions; these rules
  keep them out (tested).
- **The book:** average cost, long only. A sale takes KAT out at the average cost then; the
  rest is realised. Average buy price = cost of KAT held / KAT held (the footer also gives all
  buys' average). A sale bigger than the book would come partly from outside it (rewards or
  borrowing): that part is left out of the P&L and marked in its row.
- **Prices:** each trade is priced by what left and reached the wallet, so fees are inside it.
  The fees column adds them up anyway: transfers to the known fee takers (`FEE_TAKERS`: service,
  relayer, order and router cuts read off his trades), KAT ones at the trade's own price, plus
  the wallet's own gas at the ETH price when the trade was recorded (booked, never re-valued).
  KAT now is the KAT/vbUSDC pool's slot0; the chart values the KAT held at each hour's closing
  tick (carried through hours without a swap), at each trade's own price, and now.
- **Display:** four cards (KAT price with 24 h change, average buy price with KAT held and cost,
  unrealised with value and %, realised with sales and total), the chart (Total gold, Realised
  text, Unrealised grey dashed, one dollar axis, trades ringed on the total, crosshair tooltip,
  Malaysian-midnight day marks, 7D/30D/All, opening on 7D), the holding line, then the trades newest first; on
  a phone each trade is a small labelled card. The page polls every 30 s; LIVE lasts 75 s; the
  last reading paints at once from `localStorage` `tf_kat`, marked STALE. Colours checked with
  the dataviz validator: the three lines pass the colour-blind and normal-vision separation
  checks in both themes and fail only the chroma/lightness bands, as the site's gold-on-greys
  does, so the third line is dashed.
- **Trade simulator (Alex, 1 Nov 2026):** a card between the chart and the trade table. Up to
  six planned steps, each Buy (spend USD) or Sell (KAT) at a price that follows today's until it
  is typed or moved with the -10% -5% Now +5% +10% chips; switching side keeps the size (dollars
  to KAT at the step's price). `simulate(trades, plan, priceNow)` in `kat-core.mjs` runs the steps
  after every real trade on the same average-cost book and returns before/after summaries,
  each step's fill (with what a sale realises and any part sold from outside the book) and the
  break-even price, (cost - realised) / KAT held, where total P&L is zero. Six results: KAT held,
  average buy price, realised, unrealised and total P&L (at today's price) and break-even, each
  with today's figure beside it. The note gives the fee range his real trades paid (0.01-0.21%
  on 1 Nov), since the typed price should be the one he would actually get. Steps are kept for
  the visit only; nothing is saved or sent.
- **Checked 1 Nov 2026:** the four trades since the start: 27 Oct buy 5,978.847409 KAT for 25
  vbUSDC; 29 Oct sell 5,600 for 25.864268; 30 Oct buy 7,299.830781 for 30; 1 Nov buy
  6,260.979832 for 25. Holding 13,939.66 KAT at $0.0040592, cost $56.58, realised +$2.45; fees
  $0.12 in all.

### vKAT Votes (Alex, 1 Nov 2026)

Alex's spec: a page about his vKAT vote: on top the total vKAT, the number of votes, the total
reward and the average APY (shown as APR since 1 Nov, his choice); a line chart of total reward against epoch with each epoch's
reward labelled on the line; then the vote history: pool voted, vKAT used, reward type and
amount, APY. It is the **KAT section's second tab** (`vkat.html`, linked from a bar on
`kat.html` and back), not a sixth menu item: five already fill a 320 px phone. The menu's KAT
item is lit on both.

- **Sources:** gauge voter `0x5e755a3c…` events with the wallet as `topics[1]`: vote
  `0x9597ca1d…` and reset `0xe87470fc…`, topics `[event, voter, gauge (= pool), epoch]`, data
  `[votes, gauge total, all votes, time]` (no lock id). vKAT NFT `0x106f7d67…` and escrow
  `0x4d6fc15c…` (`locked(id)` → amount and start; `votingPower(id)`, equal to the amount on
  1 Nov). NFTs sent to or from `0x60233d1c…` (avKAT's compound strategy) are avKAT deposits
  and withdrawals. Vote rewards are Merkl breakdowns named `AragonBribes_<pool>_<vKAT id>`;
  campaign dates from `/v4/campaigns?campaignId=`. The Katana MCP's `get_kat_locks` reverted on
  `isVoting(22712)` on 1 Nov; the chain is read directly.
- **An epoch's vote:** votes add to a pool, resets take off (several locks can stack on one
  pool); a vote stands into later epochs until changed (on 22 Oct his 1481 vote was still on
  vbUSDC/vbETH until he moved it). Each epoch takes the standing allocation with the most vKAT
  in it, the latest if equal: from May to August he voted in the vote week and then moved the
  lock into avKAT, and in 1474 he switched pool four times; the max-then-latest rule gives the
  pool each epoch's reward actually came from, for all ten epochs (tested).
- **Rewards:** each belongs to the epoch its campaign ends in (the main campaign runs the
  vote week, a one-hour tail follows; the 1474 weETH/vbETH campaign began 3 hours before the
  epoch, so the start would misfile it). Valued at its token's price when the campaign ended
  (vbUSDC $1; KAT, vbETH and vbWBTC from their vbUSDC pools at that block, archive reads), once,
  then never re-valued.
- **APR, not APY (Alex, 1 Nov 2026):** an epoch's reward over its vKAT valued at KAT's price
  when its vote week closed, times 365/14 epochs a year, not compounded. 96% of the reward is
  vbUSDC that stays in the wallet, the lock grew by a merge rather than by reinvested rewards,
  and the epoch rate swings 12-115%, so a compounded APY (40.7% average, 208.9% for 1474)
  described a strategy he does not run; it also matches Merkl, Strategy and the LP Book, which
  quote APR. The average is all rewards over all vKAT value, for the epochs whose vote week has
  closed. The 60-day exit and its 2.5-25% fee
  are not in the rates, and the page says so.
- **Display:** four cards, the vote-week note (open until..., or the next one's dates and where
  his vote stands), the chart (cumulative reward, gold line, each point labelled "+$x" above
  it, crosshair tooltip with pool, that epoch, total and APY), then the history newest first.
  The Total reward card's breakdown by token (amount and dollars when paid) sits behind a "!"
  beside its label (hover, focus or tap; a tap elsewhere or Escape closes it); the card itself
  says only the epochs and whether all is claimed (Alex, 1 Nov). On a phone each epoch is three
  unlabelled lines (Alex: the labelled cards were "too complicated and messy"): epoch, dates
  and value; pool and APR; vKAT and the tokens it was paid in. The tab bar's heading drops its
  detail at 480 px and the tab link never wraps. Points keep at least 52 px apart; when the epochs outgrow the
  card the chart scrolls sideways, opening on the latest, with the dollar axis pinned and a fade
  at the left edge (measured 1 Nov 2026 at 360 px: no label overlaps, no page scroll). Polls
  every 60 s; `localStorage` `tf_vkat`.
- **Checked 1 Nov 2026:** lock #22712, 257,871.86 KAT; ten epochs voted (1473-1482); $113.62
  in vote rewards at payout prices (108.78 vbUSDC + dust in vbETH, vbWBTC and KAT), all claimed;
  average 34.4% APR; best epoch 1474 (weETH/vbETH, 115.3% APR), latest 1482 (vbWBTC/vbUSDC,
  12.1%).

### vKAT page: the Katana network row (Alex, 3 Nov 2026)

Alex: "In vKAT vote page, add 3 information: total vKAT locked in Katana network, total avKAT
minted in Katana network, ratio AVKAT/KAT". A row of three cards at the top of the page,
above the vKAT votes bar and his own four (moved there the same day: "revert the row"). Its
heading is the page's top bar, "Katana network" with the KAT trades tab on the right, where KAT
trades keeps its vKAT votes tab ("move the KAT trade button to top"); the vKAT votes bar below
has no tab. Read live by `readNetwork` in `api/vkat.mjs` at the head block (`network` in the reply; a failure
is a note and "Not read this time"):

- **vKAT locked:** the voting escrow's `totalLocked()` (`0x4d6fc15c...`), equal to its KAT
  balance; with its dollars, its share of KAT's 10B supply and the lock NFT's `totalSupply()`
  (4,096 locks on 3 Nov 2026: index 4095 is lock #19113, 4096 reverts, so earlier locks were
  withdrawn). Measured 3 Nov: 503,762,698 KAT, $1.93M, 5.0%. Not the escrow's
  `totalVotingPower()` (442.1M), which is lower.
- **avKAT minted:** the avKAT vault's `totalSupply()` (ERC-4626, `0x7231dbac...`), with its
  `totalAssets()` in KAT. Its KAT is one vKAT lock held by its compound strategy
  (`0x60233d1c...`), so it is part of the total locked: 291.28M of 503.76M (57.8%).
- **avKAT / KAT:** `convertToAssets(1e18)`, KAT per avKAT (1.3955), with the change against the
  same read 7 days back (archive, head - 604,800 blocks): +0.61% (30 days: +3.12%).

Values show as 503.76M with the unit set small (`.unit`); two across with the rate full width
at <=720px, stacked at <=359px (checked at 320, 375 and 1280 px).

### Strategy hedge on Katana Perps (Alex, 3 Nov 2026)

Alex's spec: under each pool's expected KAT, a "Hedge this position" tick box; ticked, it shows
how much to short at 1x to be delta neutral, on Katana Perps where the pair can be hedged, with
every related fee simulated. Pushed 3 Nov 2026 after review.

- **Venue:** Katana Perps, public REST `https://api-perps.katana.network/v1` (`/markets`,
  `/fundingRates?market=&limit=`, `/orderbook?market=&level=2&limit=`, `/gasFees`; IDEX-style
  fields). Exchange `0x62230CeA…`, margin in vbUSDC. Markets on 3 Nov: BTC, ETH, KAT, SOL, XRP,
  DOGE, HYPE, TAO, ZEC, PUMP (-USD). Taker 0.019%, maker 0.00475%; funding every 8 h at
  00/08/16 UTC, +0.0100% on BTC and ETH for all of the last 30 days; withdrawal to Katana 0.05
  vbUSDC. Its API sends no CORS header, so `/api/strategy` reads it server-side (`readPerps`)
  and returns `perps`; a failure costs only the hedge (a note says so). **Rate limit:** about
  five requests in a burst, then 429 `EXCEEDED_RATE_LIMIT`, refilling within half a second;
  reads go one at a time 250 ms apart with one retry (~1.6 s, beside the chain reads).
- **Maths (`hedgePlan` in `strategy-core.mjs`):** a V3 LP's value moves with a token's price by
  exactly the amount of it held now, so the hedge is a short of each volatile token's deposit
  amount (`PERP_OF`: vbWBTC -> BTC-USD, vbETH -> ETH-USD, KAT -> KAT-USD; dollar tokens need
  none; vbWBTC/vbETH shorts both), rounded to the market's step, margin = notional (1x),
  liquidation where margin plus the short's P&L meets maintenance: 2 x entry / (1 + mmf),
  about +98%. Costs to the period's end: taker fee to open and to close, the order book's cost
  in and out (walking the top 50 levels now), funding = notional x the 30-day average rate x the
  exact payments between the start and the reward end (`fundingPayments`), and the withdrawal
  fee. A positive rate has longs pay shorts (the usual convention; Katana Perps' own docs were
  not found), so the short is paid. Shown: the short(s), margin and liquidation; then four
  figures: **Hedge fees, net** (one figure; each cost and the funding item by item behind its
  "!", `.hedge-info`, opening from the figure's left edge so it stays on a phone screen; Alex,
  3 Nov: the list of fees was too many words), the income to the period's end (KAT + hedge, price moves aside), capital
  (LP + margin) and hedged APR on it, then **Profit at the period's end** (Alex, 3 Nov: the
  income and the edge results were shown apart, he read them as "never a profit"): the income
  plus the price result if the price ends where it is now, at the upper edge or at the lower
  edge (LP + short, one-token hedges only), with the KAT a day it depends on and what each
  further 1% past an edge loses (`beyond_per_pct`: the holding past the edge less the short),
  and how far a 1% move shifts the hedge (`rehedgeStep`) with its fee.
- **Checked 3 Nov 2026** ($1,000, ±2.5%, start today): vbWBTC/vbUSDC 0.05% short 0.0065 BTC
  ($500), fees -$0.26, funding +$1.25 (25 payments), net +$1.00; profit at the end +$87.61 at
  today's price, +$80.55 at the upper edge, +$80.74 at the lower; past them about -$5.13 / -$4.93
  for each further 1%;
  vbWBTC/vbETH shorts 0.0064 BTC + 0.222 ETH; vbUSDC/vbUSDT "nothing to hedge". 29 checks in
  `scripts/test-strategy.mjs` (129).

### Strategy: pools without KAT emissions (Alex, 3 Nov 2026)

Alex: "add a button, click to show non KAT emission pool, for now add USDC/KAT pool only,
feature same as KAT emission pools". Under the KAT pools, **Show pools without KAT emissions**
(`#feeToggle`, remembered per device in `tf_strategy_fees`) opens `#feeSection`: the same card,
estimate, range edges, recent ranges, hedge and "!" as a KAT pool, earning trading fees.

- **The pool:** `FEE_POOLS` in `api/strategy.mjs`: KAT/vbUSDC 0.05% (`0x10045367...f629`,
  token0 vbUSDC, token1 KAT, fee 500, spacing 10), quoted in vbUSDC per KAT (`baseIndex: 1`),
  vbUSDC at $1 as KAT's price is everywhere here. The 0.01% and 1% pools are empty and the
  0.3% holds about $11,000 (3 Nov 2026), so only the 0.05% is shown.
- **Fees, measured:** `readFeePools` reads at one block the pool's slot0, liquidity, balances
  and `feeGrowthGlobal0X128/1X128`, and the fee growth at the blocks 7 days and 24 hours back
  (archive eth_call; the blocks' own times). `feesFromGrowth` (`strategy-core.mjs`): the
  growth's rise over 2^128 is what one unit of liquidity in range throughout earned; times
  today's active liquidity, the pool's LP fees a day. **Sushi on Katana keeps 1/feeProtocol
  of each swap fee:** feeProtocol is 34 (2 on each side), so LPs keep half, checked against
  the day's 937 swaps: growth gave $6.50 to LPs against $13.18 of 0.05% fees (0.494; the 0.3%
  pool 0.500). So volume = LP fees / (fee x LP part).
- **Card:** Pool TVL (its balances), Fee APR (LP fees a year over that TVL), Volume per day
  and Fees per day, both the 7-day rate. The "!" lists those with the last 24 h, Sushi's half,
  the balances and the Sushi link.
- **Estimate (`estimateFees`):** the new liquidity's share of the in-range liquidity, its own
  included, times the pool's fees a day, while in range; nothing out of range. The period is
  the KAT pools' reward period, so the two read side by side. Measured 3 Nov 2026: $1,000 at
  +/-2.5% takes 48.7% of the in-range fees, about $4.16 a day (the pool's liquidity near the
  price is thin; its $262,674 sits mostly in wide ranges).
- **Hedge:** a short on KAT-USD (step 1 KAT, minimum 2,000, mmf 10%, so a 1x short is
  liquidated about +82%), through the same `hedgePlan`; the income reads "Fees $x + hedge".
- **The "!" beside the fee tier** (Alex, same day: "move the "!" to next to fees tier"): the
  card head is now a `div role="button" tabindex="0"` (Enter and Space toggle it; a click in
  `.pool-info` does not), since a button cannot hold the "!" button. The box opens under the
  name row from the card's left padding (`.pool-name` is its containing block), so on a phone
  it stays on screen and covers the cards below.

---

## Personal agent (Alex, 5 Nov 2026)

- Requested: build the natural-language dashboard and Telegram assistant. Work is local
  until an explicit push request. Setup and activation are in `docs/AGENT-SETUP.md`.
- Alex requires everything free: no OpenAI API/billing or paid database/scheduler. Use
  Cloudflare Workers Free with its AI/D1/Cron allowances and the existing free dashboard
  host. Quota exhaustion stops service; never add an automatic paid fallback. Current
  provider limits/model availability must be checked at activation, not guessed. The
  existing dashboard relays through a fixed HTTPS Worker origin and private gateway secret.
- It explains verified data and changes its own notification preferences only. It has no
  wallet signing, trade, repayment, voting, code-editing or Git tool. Financial observations
  and calculations come from the existing APIs and `targetMetrics`; stale data cannot
  produce actionable borrowing/repayment amounts. Never claim model/bot connectivity from
  fixture tests or a saved environment configuration.
- Private Cloudflare D1 stores owner sessions, the latest 24 shared messages, preferences, pairing
  and alert/delivery state. Nothing private belongs in tracked/public JSON or localStorage.
  Keys live only in ignored local env files or hosting secrets. The dashboard owner's
  access key, webhook secret and cron secret are distinct. Keep the main financial site
  operational when agent providers are missing or unavailable.
- Private status uses same-origin POST, because old service workers cache GET API bodies.
  GET status is public readiness only. `/api/agent*` is network-only in the new worker.
  Login uses a random HttpOnly/SameSite session cookie. Pairing codes are one-time,
  short-lived and revocable; groups and other Telegram users cannot invoke the agent.
- Shared updates use owner locks and fenced transactional D1 commits. Update IDs cache Telegram
  results so retries do not repeat AI calls or preference changes. Delivery checkpoints
  reduce duplicates; Telegram cannot guarantee exactly-once external delivery.
- Telegram setup has separate owner-authenticated Check/Connect actions. Status polling,
  AI tools and cron never register webhooks. The browser reviews bot identity and the
  actual Worker destination; replacing a foreign webhook needs explicit consent. Keep
  bounded metadata only, never raw current URLs/error prose or credentials. Setup has
  its own lease; no owner lock spans provider calls. Connection revokes pending pairing
  codes, retains any linked human/history and preserves queued updates. Registration
  is not proof of delivery; test a new invitation or an existing owner's fresh question.
- Workers Request rejects redirect error mode before network access. On Worker paths,
  use manual mode and explicitly reject non-success responses; never follow bot-token
  redirects. Node fixtures alone missed this incompatibility. The optional native
  regression is scripts/check-agent-telegram-runtime.mjs, using a separate validation
  installation of Miniflare/esbuild and closed fake outbound providers. Never assume
  a generic transport error proves the bot token is invalid.
- The monitor runs only when a deployed scheduler is configured. The Worker includes a
  five-minute free-plan Cron Trigger; daily reports use MYT, dashboard reports work without a
  linked Telegram account, and queued notifications must respect current preferences and
  fresh conditions. Monitoring never edits the public financial ledgers or deploys.
- Agent implementation plan (6 Nov 2026): Qwen is the first explicit free Workers AI
  profile; inference reserves conservative per-attempt D1 budget before calling AI.
  No paid fallback. Fixture success does not establish real account/model readiness.
  Agent policy persists separately from Lending's per-visit 70/35/35 reset. Canonical
  snapshots retain coverage gaps; unknown amounts or missing pinning never become zero.
- Agent output uses a closed Cloudflare json_schema selector for six deterministic
  tools and reviewed explanations. Do not combine it with a competing native-tool
  request or accept arbitrary generated financial prose. Metadata-only output
  diagnostics must never retain prompts, response text, reasoning or arguments.
  Rejected prose settles as failed even if its JSON syntax is valid. Qwen's /no_think
  is a documented prompt hint, not a guaranteed runtime flag. The provider catalog
  rechecked on 7 Nov lists planned Qwen deprecation on 20 Nov 2026; review it before that date.
- The two allowed model bindings have different JSON-schema contracts. Qwen takes
  the direct schema and max_tokens; GLM takes a named schema wrapper and
  max_completion_tokens, with documented chat_template_kwargs.enable_thinking=false.
  Keep the closed selector and deterministic validation. GLM remains a candidate
  until a fresh real-account response passes; no automatic model switch is permitted.
- Workers AI may return both choices and a legacy response alias. Accept a single
  completed selection when aliases match as bounded JSON or the legacy field is
  empty. Empty/null tool-call metadata is not a second request. Reject disagreeing
  aliases, extra actual calls, truncation and unsupported final selectors; never
  expose separate reasoning. Diagnostic format labels do not themselves imply failure.
- Research is bounded to configured sources with immutable evidence. Strategy arithmetic
  and paper marks use shared deterministic code; arbitrary model financial prose has
  no authority. Saved briefs create append-only decisions, and owner acceptance means
  review only. Actual transaction notes are explicitly owner-reported and unverified.
- Agent replies lead with a clear answer in ordinary language (Alex, 7 Nov 2026).
  Keep calculation/snapshot/evidence IDs, policy versions and raw limitation codes in
  structured private records rather than appending them to conversation. Use one short
  note for incomplete totals; preserve missing/stale data and liquidation warnings.
  Actionable lending amounts retain exact integer rounding. Sources, dates, quotations
  and assumptions remain inspectable in optional details. Reviewed research explanations
  require their configured supporting evidence; do not invent coverage or accept
  arbitrary model financial prose to make a response sound more conversational.
- LP range-selection questions use analyzeLPRange, not the position-value lookup
  (Alex, 7 Nov 2026). Load the existing first-party Strategy quote/history only when
  this tool is selected. It compares outward-rounded 7/14/30-day tick envelopes,
  the verified current band and equal-capital liquidity concentration. Review cadence
  may be a confirmed policy value or a clearly stated question-only assumption; never
  save it automatically. The starting comparison is an explicit cadence heuristic,
  not an optimal range, price forecast, profit ranking or allocation recommendation.
  Missing/inconsistent history, ambiguous pools and disabled/excluded analysis stay
  explicit. Complete cost-aware comparisons and saved decisions retain their existing flow.
- Daily KAT income goals (Alex, 8 Nov 2026) use the same tool's optional
  `dailyRewardTargetUsd`, independently parsed from the owner message. Detect
  current capital/staking and verify the KAT quote/campaign before estimating
  gross rewards. Exclude the existing eligible owner liquidity when replacing
  it; never count it twice, include carry in new earnings or count DAO fees.
  Lead with feasibility and concise current/historical/target-only comparisons.
  A tight band that reaches a spot income target is not thereby a suitable or
  safe range. Check observed coverage, total campaign budget, expiry and policy;
  required capital is a verified algebraic scenario, not an available balance or
  allocation mandate. Keep net-profit requests distinct, bounded native model
  selection/accounting and no writes/signing. See docs/AGENT-LP-INCOME.md.
- Flexible LP judgment and Katana MCP (Alex, 8 Nov 2026): normal-language
  goals/follow-ups combine deterministic range/capital math, current campaign
  share, carry-adjusted native APR reward pace, inventory/reset cost cases and
  KAT/base-price sensitivities. Answer a focused case concisely; never adopt the
  sample answer's prices, analyst support levels or personal-loss narrative as
  facts. Contextual owner goals/floors/cadence stay separate from persistent policy
  and Lending's visit reset. Label an assumed daily period explicitly. Costs
  reduce replacement capital before static incremental-reward recovery; missing
  gas/competition never becomes zero. Six closed tools and one accounted inference.
  The shared private Worker connects to the owner-supplied exact remote endpoint
  https://mcp.katana.network/mcp, gated by AGENT_KATANA_MCP_ENABLED. Only the
  reviewed no-argument get_kat_gauges read is enabled; discovered descriptions or
  readOnlyHint cannot authorize more methods. No wallet, transcript, model prompt
  or secrets go to MCP. Bound HTTP/SSE/session/protocol/body/time/request handling;
  reject redirects and preserve primary readers on failure. Retain private source
  receipts and indexed conflicts; chain/Merkl wins. The setup document and actual
  server are workspace-proxy blocked, so current catalog/schema/authentication,
  live connectivity and Free CPU remain account acceptance checks. Operational
  Check Katana MCP is owner-authenticated and separate from passive diagnostics;
  logout invalidates late results. See docs/AGENT-KATANA-MCP.md.
- MCP response formats (8 Nov 2026 follow-up): the owner reports the deployed
  Check connected but extracted no rows. This is real connection evidence, not
  proof of an empty or usable dataset. Use bounded known nested/fenced/encoded
  JSON/address-map adapters with explicit pool/chain/unit/time checks. Distinguish
  empty collections, logical tool errors and unsupported structure. Private
  responseFormat diagnostics contain only bounded keys/types/paths/counts, never
  provider values, prose, instructions, sessions or credentials. Copy MCP format
  is an explicit owner browser action; logout invalidates late results. Do not
  invent numeric parsers for unseen Markdown or claim fixture success identifies
  the live payload. The execution proxy still blocks direct provider reads.
- Slow work has per-job leases; owner/policy locks protect short fenced commits only.
  The independent five-minute monitor consumes zero AI calls. Keep outbox checkpoints and
  current recipient/preferences/policy revalidation. Synchronous chat/research records
  retain interruption state. Portfolio reviews now use a real eight-step Cloudflare
  Workflow, `PORTFOLIO_REVIEWS` / `PortfolioReviewWorkflow`, exported by runtime.mjs.
  Never run the full review inline in chat, Telegram or the risk Cron: the Free D1
  ceiling is 50 queries per invocation, and Free CPU is 10ms per Workflow step.
  Batch private reads/writes, bound each step/delivery and retain unknown inference
  reservations without replay. See docs/AGENT-REVIEW-LOOP.md. Keep 0002
  usage and 0003 storage migrations additive; never expire decision evidence as cache.
- Recurring reviews (Alex, 7 Nov 2026) use confirmed policy, at most 3 automatic and
  5 manual reviews/MYT day, one accounted selection per review, a four-hour event
  cooldown and 500-neuron automatic holdback within the shared UTC budget. Private
  revisioned review controls and up to three owner-confirmed cost/path cases remain
  separate from notification settings and Lending's intentional per-visit reset.
  Later matching source timestamps test original conditions; cached readings never
  become new outcomes. Journal rejections suppress ideas under that policy while
  independent critical facts remain visible. No policy auto-tuning/model retraining,
  trade/signing or realized-return/win-rate claims. Strategy delivery uses the existing
  monitor outbox/lease and yields to risk alerts; recheck recipient, pause, policy and
  report expiry for every chunk. Missing Workflow binding is setup-required, never
  an inline fallback. Only actual account checks establish live CPU/quota/readiness.
- LP comparison inputs are automatic (Alex, 7 Nov 2026). Detect current open LPs,
  retain chain/wallet/contract/NFT identity and reconstruct inputs at calculation
  time. Same-wallet stablecoin cash and the gas planning budget use the existing
  Strategy funding view, configured wallets/RPCs and pinned blocks; partial reads
  never become zero balances/costs. Historical band selection uses the existing
  deterministic tool. Future price/rate/slippage defaults are labelled scenarios,
  and automatic values are explicitly before financing; they do not imply verified
  zero borrowing cost or change risk policy. Preserve optional owner edits, source
  provenance, same-reference retries and saved cases. Switching LPs/modes or logging
  out must invalidate stale responses/results and clear hidden wallet/NFT fields.
  See docs/AGENT-LP-AUTOFILL.md. No model math, signing or extra paid service.
- LP comparison results are concise (Alex, 8 Nov 2026): a short takeaway, current
  LP dollar advantage interval, key risk and four-option table. Full scenario values
  stay under a collapsed disclosure; dashboard/Telegram use the same deterministic
  summary. Compare the matching calculated final values after costs, including the
  holding option's closing gas. Here holding uses the LP's current token amounts;
  the LP Book's historical accounting is unchanged. Exclude failed-policy/unpriced
  options from the lead and never turn tested cases into a probability or forecast.
  Keep unknowns, ties, financing scope and private-evidence cleanup explicit.
- Automatic portfolio/LP watch (Alex, 8 Nov 2026) is the default Agent view and
  requires no investment form or confirmed policy. Run read-only observations
  through `mode: observe` on the existing Workflow; add no D1 work to the risk
  Cron. Keep operational tracking controls separate from investment policy and
  Lending's visit reset. Fixed wallet/pool adapters must preserve native amounts,
  decimals, ownership, source blocks/dates and unavailable readings. Known
  staking/DeFi observations never become duplicate wealth. Monitor sampled range,
  volatility, liquidity/incentives and campaign endings; retain alert checkpoints,
  risk-delivery priority and current-human/preferences/policy/expiry checks.
  Ordinary observations spend zero AI calls. Default historical/cost cases are
  labelled paper assumptions before financing, never invented owner limits or a
  guaranteed-safe/optimal range. Original bands/outcomes are durable; only later,
  sufficiently covered pool/day evidence can change the comparison heuristic,
  including across replacement LPs. Journal rejection suppresses the relevant
  position idea under that policy, not critical facts. Complete ownership absence
  is not realised P&L; preserve LP Book accounting and Katana rewards/rollover.
  The short shared brief names every tracked LP that fits, with one compact
  suggestion each; never describe just the leading LP while claiming all are
  covered. Keep critical lending first and explicit shown/total counts for
  large portfolios rather than cutting off text mid-position.
  Keep the short brief first, full evidence/manual tools collapsed, explicit
  coverage/cadence limits and logout cleanup. See docs/AGENT-AUTOMATION.md.
- Run `scripts/test-agent-api.mjs`, `scripts/test-agent-brain.mjs` and
  `scripts/test-agent-telegram.mjs`, `scripts/test-agent-integration.mjs`,
  `scripts/test-agent-store.mjs`, `scripts/test-agent-worker.mjs`,
  `scripts/test-agent-gateway.mjs`, plus
  `npm run check`. The integration check exercises dashboard login/pairing, Telegram
  preferences, the real AI lending-tool protocol, retry deduplication and shared daily
  reports together. Tests inject all external
  providers; never register a bot or send real messages as part of tests.

## 5. Chain facts that bite

### Katana

- **RPCs:** `rpc.katanarpc.com`, `katana.drpc.org`, `747474.rpc.thirdweb.com`.
  `rpc.katana.network` is dead.
- They serve archive state, and their logs carry `blockTimestamp`.
- **Contracts:**
  - Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
  - Sushi V3 NPM `0x2659C6085D26144117D904C46B48B6d180393d27`
  - Morpho Blue `0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc`
  - avKAT (ERC-4626; use `convertToAssets`, never 1:1)
    `0x7231dbaCdFc968E07656D12389AB20De82FbfCeB`
- **Staked LPs** move the NFT to the staker `0xbe12e1b5c4859a3d141412748279b67458f729e9`,
  which cannot enumerate. `balanceOf(wallet)` therefore misses them. Find them from
  Transfer logs, then verify with `ownerOf`.
- **Morpho:**
  - Read every market in `CFG.morphoMarkets` ∪ data.json `morpho_markets`. New markets are
    discovered from Morpho logs where the wallet is `onBehalf`.
  - Health uses each market's **oracle** `price()` (`0xa035b1fe`), not redemption value.
- **Merkl API** (`api.merkl.xyz/v4`) allows CORS only from https origins. It fails on
  localhost; that is not a bug.

### Robinhood Chain

- **Logs:** only `rpc.mainnet.chain.robinhood.com` serves `eth_getLogs`.
- **No archive state.**
- **Rate limits** are tight (429). The job sets `CFG.patient = true` for backoff. In the
  browser, a 429 surfaces as "Failed to fetch".
- **Log limits:**
  - A topic position holding more than one value caps the range at 100,000 blocks and is
    rejected beyond that. Use one query per topic value.
  - 10,000 logs per response.
- **Timing:** `blockTimestamp` on logs is stubbed `0x0`. The chain runs at ~9.91 blocks/s
  (~839k/day).
- **Fables:**
  - FablesRamp `0x08e52564bad99e05a694b4809f397edca417a080` is a Uniswap V4 hook. LP
    holdings are ERC-6909 shares, with id = range id and shares = liquidity.
  - The pool price comes from PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`
    `extsload`.
  - veFABLES is `0xc1d5adc963a57d24adaf63aae1bfbecab95f6edd` `locks(id)`.
- **Vercel's Node has no keccak-256**, so `_core.mjs` carries a plain-JS Keccak.
- The blockscout explorer API sits behind Cloudflare: read ABIs through a real browser.

### Arc

- Native balance **is** the USDC (the ERC-20 at `0x3600…0000` is the same money): count it once.
- Logs: 10,000 blocks / 2,000 results per query; pace requests.
- The V4 PositionManager does not enumerate; V4 ids come from Transfer logs.

### Solana

- `api.mainnet-beta.solana.com` blocks browsers. `solana-rpc.publicnode.com` works in the
  browser but has no `getProgramAccounts`. It also rejects `getTokenAccountBalance`
  with HTTP 403 unless a personal token is supplied. Keep this project key-free: the
  Portfolio reads the wallet and USDC account together with `getMultipleAccounts`,
  validates the SPL token program, mint and wallet, and decodes the raw six-decimal amount.
- A temporary browser RPC failure gets a ten-second cooldown, then is retried on the
  next refresh. Never blacklist the only working endpoint for the whole page visit.
- So the job discovers Meteora position refs, and the browser reads them with
  `getMultipleAccounts`.

### Everywhere

- **Uniswap V3 unclaimed fees** use `feeGrowthInside`, where every subtraction wraps
  mod 2^256.
- **Claimed fees = Σ Collect − Σ DecreaseLiquidity.** A Collect also returns withdrawn
  principal.
- **Token ids collide across chains.** Key positions as `chain:id`.

More traps and the money maths, written for agents, are in
**`.claude/skills/onchain-portfolio-dashboard/`**: `SKILL.md` and `references/traps.md`,
`money-math.md`, `data-contracts.md`, `chain-engine.md`, `frontend.md`. Read `traps.md`
before touching a chain reader.

---

## 6. Git, deploy, and the rules around them

- **Pull before every push.** The job commits data files every 6 hours, so
  `git pull --rebase` first.
  - On a conflict in `data.json`/`claims.json`, take the job's version.
  - Keep ours where our change adds new structure.
- Commit messages: a plain summary line, then what changed and why.
- **Confirming a deploy:** after a push, Vercel deploys in ~1 minute. Confirm by fetching
  `https://tiger-foundation-dashboard.vercel.app/sw.js` and checking that its
  `CACHE_VERSION` is the new one. Then check the changed page or API on the live site.
- **Authentication:** if a push cannot authenticate, give Alex the command to run in his
  own terminal from the repo folder. Never read credentials from the Windows credential
  vault, and never print or commit tokens. The remote is plain https with no embedded
  token.
- **No secrets belong in this repository.** The financial updater uses GitHub's built-in
  token. The optional personal agent uses Free-plan Worker bindings and private Telegram/gateway credentials;
  never print, embed in browser code or commit them. See `docs/AGENT-SETUP.md`.
- **Nothing signs or moves money.** Every reader is read-only. If something would ever
  need to sign, it needs a different safety review first.

---

## 7. The withdrawn Hedge Desk

Alex requested removal of the Hedge Desk from the website on 24 Oct 2026 and authorised
the push after reviewing the local preview. This release deletes `hedge.html`, removes
every navigation link and removes it from the service worker's precache.

The last published source is `hedge.html` in commit `4134210`. Keep the guides in
`docs/hedge-desk/` as historical documentation; do not restore the page without Alex's
instruction. The description below records the former desk.

A Uniswap v3 LP planner and paper-trading desk for Robinhood Chain, hedged with a short on
Hyperliquid. It runs two markets:

- CRCL/USDG 0.30%, hedged on `xyz:CRCL`.
- ETH/USDG 0.05%, hedged on the main ETH perp. This is the same pool as his WETH/USDG LP.

It has four views: Planner, simulated positions, My real LPs and History.

- **Where it came from:** ported on 22 Oct 2026 from `C:\Users\User\Desktop\Minara\lp-hedge-desk\`.
  That copy is an archive; do not edit it. **This repo is its home now.**
- **What changed in the port:** only the skin, header, menu and wording. The model, the
  readers and the `crcl-*` localStorage keys are the desk's own, as verified.
- **Default wallets:** each market looks first at the wallet that holds its LP. CRCL uses
  the main wallet; ETH uses the vault wallet.
- **Layout (Alex, 22 Oct):**
  1. Inputs card on top: LP range · Capital · Hedge size side by side, with "Market &
     assumptions" folded below.
  2. Tokens and hedge needed.
  3. Fee simulation.
  4. "Do this, in order", then the rest.

  There is no left column, and no re-hedge ladder or scenarios.
- **Docs:** `docs/hedge-desk/BUILD-GUIDE.md` (why the code is shaped as it is, plus a
  verification checklist) and `docs/hedge-desk/README.md`. Its §8 "traps" apply to any
  edit.
- The browser calls Robinhood RPC and Hyperliquid directly. That works from the site
  because there is no CSP.
- Paper trades live in the browser's localStorage per site. History has JSON
  backup/restore.

---

## 8. Running and checking locally

- **Portable preview (Windows or cloud/Linux, Node 20+):** `npm run dev` serves the repo at
  http://127.0.0.1:4200 and runs the existing read-only `/api/*` handlers. No dependencies
  need installing. It never starts the scheduled collectors or writes data files.
  - `HOST=0.0.0.0` and `PORT` can be supplied by a cloud environment; keep preview
    forwarding private. API self-fetches use loopback even behind an HTTPS preview.
  - Static files refresh immediately. Restart the server after editing API modules or
    their shared imports, because Node caches them.
  - Its development-only `/sw.js` clears old Tiger caches and unregisters itself;
    production `sw.js` is unchanged.
- **Legacy Windows static server:** `powershell -ExecutionPolicy Bypass -File serve.ps1` serves the repo at
  http://localhost:4200 (`.claude/launch.json` holds the same).
  - It also accepts `POST /_save?name=<file>`, which writes a browser-rendered file (used
    for icons).
  - Any static server works too.
- **Local limits:**
  - Static servers such as `serve.ps1` do not run `/api/*`. Prefer `npm run dev` when
    testing API data. Any saved production-response fixture at `api/lpbook` must still
    be deleted before committing.
  - Merkl fails on localhost (CORS).
- **Service worker:** when using a static server, unregister it or clear caches before
  judging a change. The portable preview handles this through its development worker.
- **Combined check:** `npm run check` verifies syntax, inline scripts and identical
  Portfolio copies, then runs every `scripts/test-*.mjs` check. `npm test` runs those
  regression checks alone. Both avoid chain collectors, history writers and backfills.
- **Cloud workspace:** see `docs/CLOUD-SETUP.md`. Use the actual checkout path in the
  environment; the recorded Windows path is only the local backup. Keep the same
  explicit-push rule in every cloud chat. Publishing an environment does not authorise
  committing, pushing, merging or publishing the website.
- **Portable preview check:** `node scripts/test-dev-server.mjs` checks static files,
  API self-fetches, private-file boundaries and development caching with 52 assertions.
- **Strategy check:** `node scripts/test-strategy.mjs` checks quoting both ways round, Sushi's
  range rounding, deposits, the epoch arithmetic, shares, dilution, start-day clamping, out of
  range, token weights and the APR order against figures read on 1 Nov 2026, plus the recent
  ranges: hourly folding, window edges and opening price, negative-tick logs, the job's first
  and incremental runs with a fake chain, file validation and formatting, and the edge P&L against the LP Book's; 100 assertions.
  `node scripts/strategy-ranges.mjs` updates only `strategy-ranges.json`.
- **KAT trades check:** `node scripts/test-kat-trades.mjs` replays Alex's real transfers from
  26 Oct 18:5x to 1 Nov 11:18 MYT (`scripts/fixtures/kat-trades-2026-10.json`, recorded 1 Nov):
  the seven trades with exact amounts, the Morpho/avKAT/Merkl transactions that are not trades,
  each route's fees and gas, the same result when split between a deposit and its payout, an LP
  add that must not match, the book and chart against hand-worked figures, sales bigger than the
  book, the simulator (buys, sales, a plan selling more than is held, break-even checked by
  valuing the book at it, skipped steps), and the ledger's validation; 71 assertions. `node scripts/kat-trades.mjs` updates only
  `kat-trades.json`.
- **vKAT check:** `node scripts/test-vkat.mjs` replays the 45 vote events and Merkl's vote
  rewards recorded 1 Nov (`scripts/fixtures/vkat-2026-11.json`): each epoch's pool and vKAT,
  votes carrying over, a lock moved after its vote, stacked and split votes, the 24 rewards (LP
  ones ignored), the book's totals, APR (no APY offered), the settled-only average, the
  ledger's validation, and that the breakdown by token adds up to the total; 38 assertions.
  `node scripts/vkat-votes.mjs` updates only `vkat-votes.json`.
  In Claude Code's browser pane, the preview with APIs is the launch entry **API Preview**
  (`node scripts/dev-server.mjs`, port 4200).
- **Testing chain code:** import `api/_core.mjs` from a scratch Node script (Node 20+) and
  call the same functions the API calls. For example, `advanceBook` → `bookLiveRows` →
  `livePrices` → `bookView`.
- **Syntax checks before any push:**
  - `node --check api/_core.mjs` (and each changed `.mjs`).
  - For HTML pages, compile each inline `<script>` with `new Function(...)` in Node.
- **Phone layout:** check at 360–375 px wide, with no sideways scroll.
- **LP refresh regression check:** `node scripts/test-lp-refresh.mjs` forces incomplete
  reads, the five-minute boundary and recovery for both LP Book and widget. It uses a
  controlled clock and no network or dependencies.
- **KAT reward attribution:** `node scripts/test-reward-attribution.mjs` checks the scoped
  reassignment, unchanged totals/history, APR sample transitions, failed reads, partial/full
  claims and claiming after the destination closes, without live network access.
  `node scripts/test-automatic-reward-rollover.mjs` covers future rollovers across token pairs,
  successive replacements, native and inherited claims, cold restarts, missing readings,
  ambiguous claims/replacements and scheduled persistence.
- **Robinhood reliability:** `scripts/test-rpc-reader.mjs`, `scripts/test-core-reads.mjs`,
  `scripts/test-api-refresh.mjs` and `scripts/test-portfolio-robinhood.mjs` exercise paced
  retries, request/body deadlines, required contract reads, warm scan checkpoints and
  whole-reading retention/recovery without live network access. Run them with Node.
- **Independent APR readings:** `node scripts/test-fee-observations.mjs` checks the actual
  scheduled writer's healthy-chain persistence during unrelated errors, source validation,
  backlog rejection, saved timestamps, complete recovery and carry-adjusted APR. Run
  `scripts/test-lp-performance.mjs` too for baseline age and post-deposit selection.
- **Lending check:** `node scripts/test-morpho.mjs` checks loan rounding, liquidity,
  personal targets and history preservation without network access. At this local build,
  96 assertions pass; browser checks cover incomplete reads, full failure, five-minute
  expiry, recovery and saved settings. Phone widths 360/375 px have no sideways scroll.
- **Lending chart starts:** `node scripts/test-lending-series.mjs` tests the actual browser
  series function: 53 assertions cover each verified opening block, the KAT / USDC fixed
  MYT restart, shorter date windows, repayments, gaps and mixed archive intervals.
  The one-time, resumable archive recovery
  is `scripts/backfill-morpho-starts.mjs`; keep its checkpoint outside the repository.
- **Lending market view:** `node scripts/test-lending-view.mjs` checks weighted average
  LTV, unknown and zero values, inactive markets, reactivation and source preservation
  against the actual browser functions; 40 assertions pass.
- **Cross-check figures** against an independent read of the same position.
- **Portfolio Katana reader:** `node scripts/test-portfolio-katana.mjs` exercises the actual
  browser reader with 42 assertions covering required read failures, closures, transfers,
  discovery fallback, duplicate candidates and recovery.
- **Portfolio refresh status:** `node scripts/test-portfolio-status.mjs` exercises actual
  status, refresh failure/recovery and clock expiry with 66 assertions, including wealth
  retention and currency/vault repaints keeping a failed reading stale.
- **Portfolio Solana reader:** `node scripts/test-portfolio-solana.mjs` runs 27 assertions
  against the browser functions: raw balances, account identity, confirmed closed accounts,
  malformed reads, price failures, cooldown and recovery without a page reload.

---

## 9. Release contents

- **8 Nov 2026, MCP response-format follow-up:** the owner confirms the new
  deployed MCP check connects but its narrow JSON adapter extracts zero rows.
  Add a bounded payload interpreter for known nested collections, fenced/encoded
  JSON, explicit address aliases and address maps, preserving strict identity,
  chain, numeric units and source times. Empty, logical-error and unknown layouts
  have distinct states. Persist/share field-name/type-only diagnostics through
  the authenticated connection UI, without source values or extra provider/AI
  requests. Account-specific payload verification remains pending; direct reads
  are proxy-blocked and fixtures are not captured live responses. Cache 161;
  answer cache v8 invalidates old resource results. No new config, credential,
  binding, migration, financial calculation or wallet capability. See progress
  and docs/AGENT-KATANA-MCP.md for test and live acceptance evidence.
  All 63 portable suites, formats 166/transport 86, native private/Telegram 175
  (max 34 D1 calls / 62 batched SQL statements), Chromium 52 and Worker dry run
  pass; bundle 676.14 KiB / 175.88 KiB gzip. Actual payload compatibility remains
  an owner/account acceptance gate; use the copied diagnostic if still unsupported.

- **8 Nov 2026, flexible LP judgment and remote Katana MCP:** expand income
  analysis into a concise evidence-based keep/reset assessment, actual token-mix
  changes, current versus recorded native KAT pace, indicative reset costs and
  price-only sensitivities. Related free-word follow-ups retain owner scenarios,
  including revised goals/floors; unrelated loans/notifications do not. New one-day
  LP history and approximately 24-hour KAT trend reuse existing sources. Carry
  exclusion, accounting and source gaps remain intact. Shared dashboard/Telegram
  context can read the fixed official MCP endpoint using the reviewed
  get_kat_gauges resource; no dynamic tool authority, signing, wallet/transcript
  sharing, paid dependency or extra inference. Add a private connection check and
  bounded diagnostic metadata, preserve source receipts/conflicts and fail
  independently from the financial readers. Cache 160; Wrangler adds the regular
  AGENT_KATANA_MCP_ENABLED flag, no new secret/binding/migration. See
  TIGER_AGENT_PROGRESS.md and docs/AGENT-KATANA-MCP.md for validation and remaining
  actual-account acceptance. The original linked document and live MCP are proxy
  blocked here; a simulated server is never described as a real connection.
  All 62 portable suites, analysis 121/MCP 77, native private/Telegram 164, automatic
  Workflow 26 and Chromium 92 checks pass. Worker dry run: 666.58 KiB / 173.16 KiB
  gzip. Native private paths record max 34 D1 calls (62 batched SQL statements);
  actual account CPU, usage and remote schema/connection remain live gates.

- **8 Nov 2026, daily KAT income-goal LP analysis:** the owner's $10/day question
  was reduced to historical range geometry because the target was not an input.
  `analyzeLPRange` now accepts a server-verified `dailyRewardTargetUsd`, detects
  current LP capital and uses current campaign/KAT inputs for gross reward rates,
  historical alternatives, a clearly conditional target-only band and verified
  capital requirements. Exclude current owner liquidity before replacing it;
  test campaign-budget limits, expiry, missing/stale data, policy, token order,
  multiple positions and carried-reward exclusion. Replies lead with goal
  feasibility and a short trade-off; net-profit goals retain their separate scope.
  Owner goals cannot become invented model targets, notification settings or a
  generic portfolio review. Six tools, the same Qwen profile and one accounted
  inference remain; no policy/signing/accounting/Lending changes. All 60 portable
  suites, goal/routing 109, native chat/Telegram 95, native automatic Workflow 26
  (max 22 D1 queries), responsive Chromium 68 and Worker dry run pass. Bundle
  617.12 KiB, cache stays 159, no new migration/binding/secret/dependency. Update
  existing Worker/API code and verify a new real-account answer. See
  docs/AGENT-LP-INCOME.md and TIGER_AGENT_PROGRESS.md.

- **8 Nov 2026, include every tracked LP in automatic briefs:** the owner reported
  Katana WBTC/USDC missing. Both current LPs were in the saved roster and private
  observations, but the brief rendered only the first ranked LP. The shared brief
  now gives each LP a compact suggestion and preserves lending priority, range
  evidence, financing scope and one next-check line. Explicit shown/total counts
  replace silent truncation for large portfolios. No discovery, accounting, reward
  rollover, policy or Lending-setting change. Regression fails before the fix in
  real workerd and passes after it: 29 focused assertions, 26 native Workflow/D1
  checks (including both chains in the outgoing test Telegram body, max 22 queries),
  136 Chromium checks across both responsive themes, all 59 portable suites and
  Worker dry run pass. The full suite also passes after rebasing data update 362d15b.
  Worker bundle 596.59 KiB; cache stays 159 because browser assets are unchanged.
  No new secret, migration, binding, AI call or D1 query. Update the existing Worker;
  confirmation of the new live brief remains an account acceptance check.

- **8 Nov 2026, automatic portfolio/LP watch under the ongoing agent authorization:**
  The default Agent view detects tracked holdings, LPs, loans, claimable rewards
  and known staking references without investment forms. The existing five-minute
  Cron queues bounded observational Workflow steps; a conservative cadence estimate
  slows larger portfolios. Current range/volatility/liquidity/incentive signals,
  automatic cost-aware cases and dated proposals/outcomes are stored privately.
  Qualified prospective pool/day containment evidence can select wider historical
  comparisons across replacement NFTs; no policy/model auto-training or future
  return guarantee. Short shared dashboard/Telegram briefs keep evidence/manual
  tools collapsed. Daily handoff avoids duplicate summaries; the risk monitor
  remains the fallback and keeps priority. Original accounting, Katana fees/reward
  rollover, authentication and Lending's visit reset remain intact. All 58 portable
  suites pass, including new reader 53, risk/learning 33, workflow 199 (max 40 D1
  calls), delivery 21 and risk-Cron/handoff 23 (existing max 48). Native automatic
  Workflow/D1 23, advanced Workflow 24 and Telegram 82 checks, Chromium 128 automatic
  plus 204 existing-comparison checks across both responsive themes and Worker dry
  run pass. Cache 159, bundle 595.77 KiB. No new secret, binding, migration, dependency
  or observational AI call. Both Vercel and existing Worker need updating. Local
  Cloudflare authentication and live RPC reachability are unavailable; actual
  deployment/source freshness/Free CPU/quotas/Cron/Telegram remain account acceptance
  gates. See docs/AGENT-AUTOMATION.md and TIGER_AGENT_PROGRESS.md.

- **8 Nov 2026, concise LP analysis under the ongoing agent authorization:**
  LP ranges vs holding shows a short conditional takeaway, dollar advantage versus
  holding, a concrete risk and four-row cost/advantage table. Full original scenario
  values are collapsed by default. Dashboard and replies share deterministic summary
  code. Advantages match final values after each option's costs, including closing
  gas for holding; no financial formulas or LP Book accounting change. Unknown or
  failed-policy cases cannot supply an unqualified lead; ties and case-dependent
  choices remain explicit. Full npm check, summary 39, scenario 39, autofill 44,
  private actions 33, interface 110, native Workflow 24/Telegram 82 and Chromium 204
  checks across both themes at 360/1366 pass. Worker dry run passes. Cache 158;
  no new secret, binding, migration, dependency or AI call. Update Vercel assets and
  the existing Worker; actual account deployment/CPU/quotas remain acceptance gates.
  See docs/AGENT-LP-AUTOFILL.md and TIGER_AGENT_PROGRESS.md.

- **7 Nov 2026, automatic LP comparison inputs under the ongoing agent authorization:**
  LP ranges vs holding detects current positions, selects a supported open LP and
  fills wallet, range, same-wallet cash, pool fees and reward inputs. Observed values
  retain their sources; gas, slippage and future price/rate cases remain labelled
  estimates/assumptions. Automatic results are before financing unless the owner
  supplies borrowing costs. Submit refreshes the full position identity and funding;
  closure, stale/missing reads and switched wallets cannot reuse another LP's result.
  Explicit edits remain optional and saved reports keep immutable source details.
  Full npm check, funding/scenario 44, private actions 33, native Workflow 24 and
  Telegram 82, Chromium 136 plus recurring-review 96 assertions and Worker dry run
  pass. Cache 157; no new secret, binding, migration, AI call, public accounting or
  Lending settings change. Current comparison pool support remains configured
  Katana pools; other detected chains show why pricing is unavailable. Deploy both
  Vercel and the existing Worker. Actual account RPC latency, balances/costs, rollout
  and Free CPU/quotas remain live gates; see docs/AGENT-LP-AUTOFILL.md.

- **7 Nov 2026, recurring portfolio strategy reviews under the ongoing authorization:**
  daily/material-event and explicit dashboard/Telegram reviews use eight real
  Cloudflare Workflow steps, private controls and up to three owner-confirmed cases.
  One accounted closed AI selection references deterministic choices; original
  evidence/journal and later conditions persist without training the model or
  changing policy. Unknown inference is never replayed. D1 dispatch checkpoints
  survive Workflow history pruning. Risk alerts stay independent and new critical
  dashboard conditions survive bot outages; the shared outbox retains unsent cursors.
  Full npm check passes; review suites36/33/25/276/46/16, native Workflow17 and
  Telegram82, Chromium96 checks in both themes at360/1366 and Worker dry run pass.
  Tested native stages use at most29 D1 calls, stressed risk/dispatch48 (Free50).
  Cache156; no new secret, migration or public financial/accounting change. Deploy
  runtime.mjs with PORTFOLIO_REVIEWS from Wrangler config. Actual Free CPU/account
  quotas, Workflow provisioning, cadence and review delivery remain live gates;
  see docs/AGENT-REVIEW-LOOP.md and TIGER_AGENT_PROGRESS.md.

- **7 Nov 2026, LP range analysis under the ongoing agent authorization:**
  chat can now answer suitable-range questions with numeric historical candidates,
  current-band trade-offs and a conditional starting comparison. A known mistaken
  getLPPosition selection is corrected for range-selection questions; ordinary status
  lookups stay factual. Source retrieval is on demand, one inference per question;
  dashboard/Telegram share the same deterministic result. Full npm run check,
  108 range-analysis/routing assertions, 82 native workerd/local D1 checks and 48
  Chromium checks across both themes at 360/1366 pass. Worker dry run passes.
  No new secret, migration or browser asset; cache remains 155. Actual account routing,
  pool-history availability and new deployed replies remain owner acceptance checks.

- **7 Nov 2026, clear agent replies under the ongoing agent authorization:**
  natural summaries across dashboard/Telegram, readable lending/LP/KAT/comparison and
  journal text, one brief coverage note and optional source/check details. Structured
  provenance, exact repayment amounts and stale/critical guards remain. A fixed official
  Morpho interface source supports the isolated-market explanation. Research still
  uses zero AI calls; Qwen and existing free limits are unchanged. Full npm run check,
  47 readable-answer assertions, 63 native workerd/local D1 checks, 92 Chromium checks
  in both themes at 360/1366 and Worker dry run pass. Cache 155. No new secret or
  migration; fresh real dashboard/Telegram answers after deployment remain to verify.

- **7 Nov 2026, research/strategy acceptance under the ongoing agent authorization:**
  owner confirms Telegram and one scheduled message. Native workerd/local D1 now
  checks the policy/research/comparison/journal lifecycle and Telegram /journal (59
  assertions). Correct GLM's documented named schema, completion-token field and
  explicit thinking switch; its candidate profile is v4. Qwen stays selected with
  the same request/profile version. Rechecked catalog moves its planned retirement
  to 20 Nov. Public source checks validate Morpho/Sushi; Merkl remains partial.
  Full npm run check and Worker dry run pass. No new secrets, migrations or browser
  assets. Real policy confirmation, workflow acceptance, GLM access and CPU/quotas
  remain owner/account gates; see docs/AGENT-STRATEGY-ACCEPTANCE.md.

- **6 Nov 2026, Telegram setup runtime fix under the existing release approval:**
  native workerd reproduced the published setup check failing before Telegram access:
  redirect error mode is unsupported. Use manual mode plus status rejection in setup
  and optional strategy/KAT/vKAT context reads. Safe failure messages identify only
  the fixed method, HTTP/API code or transport category. The native Worker/local D1
  regression failed before the fix and passes 25 assertions after it; setup 257,
  context 89, full npm run check and Worker dry run pass. No new settings, secrets,
  migration or browser asset change. Real provider credentials/delivery remain pending.

- **6 Nov 2026, Telegram activation follow-up under the existing release approval:**
  the owner configured the bot secrets and generated a pairing invitation, but the bot
  stayed silent. Added owner-only Check Telegram setup / Connect webhook controls so
  registration can use saved Worker secrets without local commands or token URLs.
  Reviews expire; foreign destinations require replacement consent. Old invitations
  are revoked before connection; linked humans/history/queued messages are retained.
  Full npm run check, 207 real-SQLite setup assertions, 45 interface assertions and
  112 Chromium checks across both themes at 360/1366 pass. Worker dry run passes.
  Cache 154. Real webhook registration, pairing/reply and cron delivery remain pending;
  the dashboard's Qwen/deterministic lending path was already confirmed by the owner.

- **Publication authorized (6 Nov 2026):** after reviewing the A–F local implementation,
  Alex explicitly approved committing/pushing the agent build to main and deploying
  the existing tiger-foundation-dashboard Worker. No repeat approval is needed for
  those actions. Reuse the existing private D1 database. Complete the operator setup
  and real-account acceptance checks in docs/AGENT-SETUP.md; fixture/dry-run success
  does not establish live Qwen, migrations, scheduling, relay or Telegram delivery.

- **Built locally, not pushed (5 Nov 2026, agent activation troubleshooting):** Alex
  confirmed sign-in works, but sending a question returns the generic agent error.
  Enable JSON mode for the default Workers AI model and accept its documented object
  responses as well as JSON text, with the same action/calculation validation. Known
  connection, timeout, quota and incomplete-answer failures now have safe distinct
  messages; raw provider errors stay private. Cross-channel integration covers native
  object responses and failures passing through the Worker/dashboard relay without
  saving partial replies or settings. The actual live cause is still unconfirmed;
  Alex was asked to test the same model in Cloudflare's Workers AI Playground.
  His reported Worker URL is `https://tiger-foundation-dashboard.evalissol.workers.dev`.
  Telegram webhook registration and pairing have not been confirmed.

- **5 Nov 2026, push requested after D1 setup:** the private dashboard/Telegram agent
  described above, free-plan Worker AI/D1/Cron configuration, authenticated dashboard
  relay and pairing/setup guide. The owner supplied the D1 database ID and confirmed
  its schema was created. All project checks and a Wrangler 4 deployment dry run pass.
  `sw.js` -> `tiger-v149`. Code publication does not configure provider secrets, register
  the Telegram webhook or activate the agent; continue `docs/AGENT-SETUP.md` with Alex.

- **Pushed 3 Nov 2026 (Alex: "in kat page, move the KAT trade button to top, same
  with VKAT votes button"):** vKAT page: the KAT trades tab moved from the vKAT votes bar to the
  top bar, "Katana network · all vKAT and avKAT, read live" (the old `.net-head` is gone); the
  KAT trades page already had its vKAT votes tab at the top. Both tabs sit at the same place
  (163-164 px down at 375 px). `vkat.html`, `vkat.css`. `sw.js` -> `tiger-v148`.

- **Pushed 3 Nov 2026 (Alex: "remove last claim 3 Nov, 12:12 in fees claimed card, push"):** LP
  Book's Fees claimed card reads "$X still to claim" only; `lp.html`. `sw.js` -> `tiger-v147`.

- **Pushed 3 Nov 2026 (Alex: "revert the row "vKAT votes · Katana gauges" and "Katana network"
  push"):** the two rows swapped: Katana network first (taking the page's opening margin,
  30 px, 20 px on a phone), then the vKAT votes bar (26 px, 22 px on a phone) and his cards.
  `sw.js` -> `tiger-v146`.

- **Pushed 3 Nov 2026 (Alex: "In vKAT vote page, add 3 information ... ADD AND PUSH"):** §4 "vKAT
  page: the Katana network row": `readNetwork` in `api/vkat.mjs`, the row in `vkat.html`,
  `renderNetwork` in `vkat.js`, its layout in `vkat.css`, a paragraph in the method notes.
  `sw.js` -> `tiger-v145`.

- **Pushed 3 Nov 2026 (Alex: "in KAt PAGE: The six-hourly ledger is 13 hours behind; the trades
  since were read live. FIX AND PUSH"):** nothing was wrong with the ledger: every run had
  succeeded, but GitHub had not started the 06:00 and 12:00 UTC runs (the last was 00:11). The
  workflow now wakes hourly at :17 and runs when the data is 5.5 hours old (§3). A run was
  started by hand after the push to catch the ledgers up.

- **Pushed 3 Nov 2026 (Alex: "the ! is not aligned with "Hedge fees, net", in strategy page,
  add a button, click to show non KAT emission pool, for now add USDC/KAT pool only, feature
  same as KAT emission pools; at Pools paying KAT cards, move the "!" to next to fees tier
  0.05% etc. ADD FIX AND PUSH"):** §4 "Strategy: pools without KAT emissions". `FEE_POOLS`,
  `readFeePools`, `swapLogs` and `fee_pools` in `/api/strategy`; `feesFromGrowth` and
  `estimateFees` in `strategy-core.mjs`; the button, section and fee cards in
  `strategy.html`/`strategy.js`; the job records the KAT/vbUSDC pool (backfilled 31 days
  locally, 745 hourly rows). Each pool's "!" sits beside its fee tier, level with it (0.1 px
  at 375 and 1280 px); the hedge fees' "!" is centred on its label. 26 more checks (159).
  `sw.js` -> `tiger-v144`.

- **Pushed 3 Nov 2026 (Alex: "the hedge fees structure is too many words,
  make a single total value then add a "!" for fees breakdown"):** the hedge's costs box is now
  one figure, Hedge fees, net, first of the four in `.hedge-sum` (4 across, 2 x 2 at <=760px);
  its "!" (`.hedge-info`) lists open and close taker fees, order book, funding (payments x
  rate), withdrawal, net, and a short foot on the funding rate's source and sign and the maker
  fee. The funding and fee sentences left the note under the hedge. A tapped "!" stays open
  through a refresh. `sw.js` -> `tiger-v143`.

- **Pushed 3 Nov 2026 (Alex: "the "!" pop up window should cover the "!" of card below in phone
  view. Fix and push"):** every pool's `.pool-info` sat at `z-index:5`, so on a phone the next
  card's "!" (later in the page) showed through the open box. The open, hovered or focused one
  now rises to `z-index:30` (`strategy.css`). Checked at 375px: each of the five cards' boxes
  covers the next card's "!". `sw.js` -> `tiger-v142`.

- **Pushed 3 Nov 2026 (Alex: "add a hedge section in each KAT emission
  pools ... Add this section in review. Do not push."):** the Strategy hedge (§4 "Strategy hedge
  on Katana Perps"): `strategy-core.mjs` (`hedgePlan`, `fillPrice`, `liquidationPrice`,
  `fundingPayments`, `rehedgeStep`, `PERP_OF`), `api/strategy.mjs` (`readPerps`, `perps` in the
  reply), `strategy.js`/`strategy.css` (the tick box and its section), 33 more checks (133);
  `sw.js` -> `tiger-v141`. Then (Alex: "make changes below too ... push all the changes"): the
  hedge's Profit at the period's end; and each pool's line under its figures keeps only the price
  now, the rest (KAT this epoch, vote share, staked positions in range, share of active
  liquidity, staked in all and out of range, Merkl's base, Sushi link) is a bullet list behind
  a "!" at the card's top corner (`.pool-info`, hover, focus or tap; the card no longer clips
  with `overflow:hidden`).

- **Pushed 3 Nov 2026 (Alex: "in LP book page, in fees claim card, change the information in the
  record icon from claim record to pending fees/reward value to claim from each chain. Push"):**
  the record icon on the Live page's Fees claimed card opens "Still to claim · by chain": each
  chain with open positions, its unclaimed fees and rewards valued now, token by token, and how
  many positions owe them, then the total (equal to the card's "still to claim"). `bookView`
  keeps each open position's earned-less-claimed tokens per chain as well as in the book total
  (`cards.chains[c].unclaimed_usd`, `.unclaimed`, `.unclaimed_positions`). The past-claims list
  is no longer shown on the Live page (the API still returns `claims`; the card keeps the last
  claim's date). Checked 3 Nov: Katana $13.09 (3,438 KAT, 1 position) + Robinhood $0.29 =
  $13.38, the card's figure. 3 more checks in `scripts/test-automatic-reward-rollover.mjs`.
  `sw.js` -> `tiger-v140`.

- **Pushed 2 Nov 2026 (Alex: "In lending page, why the market line chart is broken? Fix and
  push"):** the chart lifted the pen when two readings were more than 1.75 intervals apart
  (10.5 h for the six-hourly job). GitHub starts that job late: readings from 1 Oct to 2 Nov
  landed 1-11 h apart, and 11:27 -> 22:14 on 2 Nov (10.8 h) cut every line, leaving the newest
  reading as a lone dot. `joinsLast()` in `lending.js` now joins unless the readings stopped
  for three intervals (`BREAK_AFTER = 3`: 18 h six-hourly, 3 days for the daily archive);
  missing or unread rows still lift the pen on their own. Measured on the live history: every
  line one piece at 7D, 14D and All (237 readings). 6 more checks in
  `scripts/test-lending-series.mjs` (59). `sw.js` -> `tiger-v139`.

- **Pushed 2 Nov 2026 (Alex: "check why the KAT page KAT amount is different from wallet
  holding?", then "add and push"):** the KAT page's "KAT held" is the trades' KAT (buys less
  sales), not the wallets'. Measured 2 Nov: wallets 0 KAT before the first buy and 18,682.57
  now = 19,060.11 held on the page + 11,511.46 rewards claimed - 11,889.00 moved into avKAT
  + 0 Morpho (KAT borrowed and put straight back as collateral), nothing left over. A "!"
  beside the average buy price now shows that sum, live: `kat-trades.json` keeps `start_kat`
  (the wallets' KAT just before the start, read from the archive: 0) and `flows` (KAT moved in
  or out by contract: Merkl distributor -> rewards, avKAT vault, Morpho Blue/Bundler3/adapter,
  vKAT escrow/NFT/exit queue; `FLOW_OF` in `kat-core.mjs`), backfilled from 27 Oct and carried
  forward by the job and API like the trades; `/api/kat-trades` adds `wallet_kat` (both
  wallets' `balanceOf` now); `reconcile()` adds it up and names anything left over "other" (a
  sale waiting to be paid back, a transfer, an LP). The info-box styles moved from `vkat.css`
  to `kat.css` (both KAT pages load it); a right-column card opens its box leftwards
  (`.info-wrap.right`). 11 more checks in `scripts/test-kat-trades.mjs` (82). `sw.js` ->
  `tiger-v138`.

- **Pushed 1 Nov 2026 (Alex: "remove 'voting power 257,872' on epoch card, then push"):** the
  vKAT page's Votes cast card says only where the vote stands now ("now on vbWBTC/vbUSDC 0.05%",
  or "No vote standing"); the voting power, equal to the vKAT card's figure, is gone.
  `sw.js` -> `tiger-v137`.

- **Pushed 1 Nov 2026 (Alex: "the start day input in strategy page not fit with the card size
  in phone version, fix and push"):** phone browsers (iPhone Safari above all) give a date box
  its own minimum width and ignore the width set, and the estimate's `1fr 1fr` grid let it push
  its column past the card. Now: the grid is `repeat(2, minmax(0,1fr))`, the date box is drawn
  plain (`appearance:none`, `min-width:0`, date and icon left) and, at 600 px and below, Capital
  and Start day each take a full row (`.wide-phone`), leaving the date box ~260 px. Measured at
  320, 360, 375, 414, 601 and 1280 px, also with the date box forced to want 220 px: always
  inside its card, no page scroll. `sw.js` -> `tiger-v136`.

- **Pushed 1 Nov 2026 (Alex: "WHY ALL APR now show -", then "push"):** after `baf237a`
  his browser showed a dash for every vKAT APR. The live API and page were right (a browser
  with no service worker showed 34.4%); his service worker served the cached v133 `vkat.js`,
  which read `apy`, against the new API, which no longer sends it. Pages other than the
  Portfolio never reloaded when a new worker took over. `theme.js` (loaded by every page) now
  reloads the page once on `controllerchange` when a worker already controlled it, so a release
  can never pair an old script with a new API again; `theme.js` joins `npm run check`'s syntax
  list; `sw.js` -> `tiger-v135`. **Rule:** when an API drops or renames a field, the old page
  script may still meet it once; prefer adding fields to renaming them.

- **Pushed 1 Nov 2026 (Alex: "change to APR and push"):** the vKAT page shows APR only (cards,
  chart tooltip, table, phone rows, method note); `voteBook` no longer computes APY;
  `sw.js` -> `tiger-v134`.

- **Pushed 1 Nov 2026 (Alex: "create a page about vKAT vote ... review
  first"):** the vKAT Votes tab (`vkat.html/.css/.js`, `vkat-core.mjs`, `api/vkat.mjs`,
  `scripts/vkat-votes.mjs` and its first `vkat-votes.json`, `scripts/test-vkat.mjs` with its
  fixture); the tab bar on `kat.html`; a new error boundary in `scripts/update-data.mjs` and
  `vkat-votes.json` in the workflow's `git add`; the preview server serves `/api/vkat`;
  `npm run check` covers the new files; `sw.js` -> `tiger-v133`.

- **Pushed 1 Nov 2026 (Alex: "add a trade simulator card", then "push"):** the KAT page's
  trade simulator (`kat.html/.css/.js`, `simulate` in `kat-core.mjs`, 16 more checks in
  `scripts/test-kat-trades.mjs`); `sw.js` -> `tiger-v132`.

- **Pushed 1 Nov 2026 (Alex reviewed, asked for 7D as the chart's default, then "push"):** the KAT
  Trades page (`kat.html/.css/.js`, `kat-core.mjs`, `api/kat-trades.mjs`,
  `scripts/kat-trades.mjs` and its first `kat-trades.json`, `scripts/test-kat-trades.mjs` with
  its fixture); a KAT link in every menu, with the five-item phone rules; a new error boundary
  in `scripts/update-data.mjs` and `kat-trades.json` in the workflow's `git add`; the preview
  server serves `/api/kat-trades`; `npm run check` covers the new files; `sw.js` -> `tiger-v131`.

- **Built locally, not pushed (1 Nov 2026, Alex: "make it in local, don't push"):** the Strategy
  page (`strategy.html/.css/.js`, `strategy-core.mjs`, `api/strategy.mjs`,
  `scripts/test-strategy.mjs`); a Strategy link in every menu, with the phone menu rules for
  four items; `keccakHex` exported from `api/_core.mjs`; the preview server serves
  `/api/strategy`; `npm run check` covers the new files; `sw.js` → `tiger-v126`; an
  **API Preview** launch entry. Then (same day, also unpushed) the Recent 7D/14D/21D/30D range
  buttons: `scripts/strategy-ranges.mjs` and its first `strategy-ranges.json` (built locally,
  31 days), a new error boundary in `scripts/update-data.mjs`, and `strategy-ranges.json` in the
  workflow's `git add`. `npm run check` passes.

- **This release, fix and push requested (26 Oct 2026):** Replace Solana's blocked
  indexed USDC balance request with public raw account reads and permit transient RPC
  recovery after ten seconds; `sw.js` → `tiger-v102`. The blocked request returned HTTP
  403; its raw-account replacement returned HTTP 200 in 523 ms with 890,880 lamports
  and zero USDC. No API key or historical changes.
- **Previous published release:** `acd7193`, with `tiger-v101`. Portfolio preserves Katana LP,
  wallet and vKAT values on incomplete reads; honest LIVE/STALE status and source warnings;
  `sw.js` → `tiger-v101`. Independent block 46,277,555 verified staked LP #491843 at
  $868.3962, matching the LP Book API's $868.40. No historical values are rewritten.
- **Previous published release:** `2f7cd1c`, with `tiger-v100`. Average LTV summary, LLTV beside
  market description, current LTV beside Borrowed, hidden inactive avKAT/USDC, explicit
  KAT/USDC inactivity and separate chart periods per market; `sw.js` → `tiger-v100`.
- **Previous published release:** `b998168` (25 Oct 2026). Lending opens with
  70% / 35% / 35% max LTV, edits apply for the visit, three separate summary cards,
  removed page heading/count, and undistorted mobile health charts; `sw.js` → `tiger-v99`.
- **Previous published release:** `410a9b6`, with `tiger-v98`. Lending charts begin
  at each market's actual first borrowing, with older daily archive readings recovered
  and the original 57 observations unchanged; `sw.js` → `tiger-v98`.
- **Previous published release:** `7d95712`, with `tiger-v97`. It added the Katana Lending page,
  three-market personal thresholds, shared Morpho reader, historical observations and
  scheduled-job integration; third Lending menu button; Edit/Save targets and per-market
  liquidation thresholds and compact controls; `sw.js` → `tiger-v97`.
- **Earlier published release:** `31b2dab`, with `tiger-v94`. The notes below record it and
  earlier changes.

- **That release, approved for push after local review:** LP Book card edges match
  Portfolio's content frame; `sw.js` → `tiger-v94`. Both outside edges match exactly
  at 360 px, 375 px and 1366 px; phone figures fit with no sideways scroll.
- **Previous published release:** `ec3e724`, with `tiger-v93`. The notes below record
  that release and earlier changes.

- **That release, approved after local review:** navigation buttons aligned between
  Portfolio and both LP Book pages; `sw.js` → `tiger-v93`. Position and size match at
  360 px, 375 px and 1366 px, with no sideways scroll.
- **Previous published release:** `a9c7c95`, with `tiger-v92`. The notes below record
  that change.

- **That release:** Hedge Desk removed; all current
  headers use Tiger Foundation; extra LP Book titles removed; `sw.js` → `tiger-v92`.
- **Earlier release:** `4134210`, with `tiger-v90`. The list below records that release,
  including the Hedge Desk that this release withdraws.

- **Application baseline before the previous release:** commit `243c352` (Chain Breakdown
  ordering). The scheduled job continues to publish data updates separately.
- **Included in the previous release** (24 Oct 2026):
  - `hedge.html` and `docs/hedge-desk/`, the Hedge Desk with its new layout.
  - The Hedge link in the menu bars of `index.html`, `vercel/index.html`, `lp.html` and
    `lp-all.html`.
  - In `lpbook.css` and `index.html`, menu labels kept on one line on phones.
  - LP Book/widget incomplete-read handling and the widget's quiet chain warning.
  - `scripts/test-lp-refresh.mjs`, the forced-incomplete-reading regression check.
  - `sw.js` → `tiger-v90`.
  - This `AGENTS.md`.
- **Offered to Alex, not accepted; do not do unasked:**
  - Correct `history.json` for 17–19 Oct, which under-counted the Morpho position then.
  - Extend the LP Book's start further back to include older closed positions.
- **Open positions** at hand-off, for orientation only (read the chain for current
  figures): Katana vbWBTC/vbUSDC #491037; Robinhood WETH/USDG #1458357 (vault wallet);
  Robinhood FABLES/USDG range (main wallet).
