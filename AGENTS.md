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
rewards straight from chain RPCs. There is no database and no API keys.

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
   dependencies). It runs `scripts/update-data.mjs`, which reads everything server-side and,
   at its end, calls `scripts/lpbook.mjs` and `scripts/morpho.mjs` in separate error
   boundaries. It commits these files as `github-actions[bot]`:
   - `data.json`: the snapshot and discovery state (meteora_refs, morpho_markets, fables, ...)
   - `history.json`: daily totals, one entry per UTC date
   - `claims.json`: the claim record, including `lp_fees`
   - `positions.json`: LP ledgers per chain
   - `lpbook.json`: the LP Book ledger
   - `morpho-history.json`: Katana lending observations at six-hour intervals
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
| `api/lp.mjs` | Legacy widget endpoint; no longer used by the widget. |

### Pages and shared assets

| File | What it is |
|---|---|
| `index.html` | The main **Portfolio** dashboard, ~5,000 lines inline. Classy theme by default; the cute tiger is the alternative theme (localStorage `tf_theme2`='tiger'). `vercel/index.html` must stay **byte-identical**: copy it after every edit. |
| `lp.html` | LP Book, **Live**: open positions at live prices. |
| `lp-all.html` | LP Book, **All-time**: closed positions, every figure fixed at close. |
| `lending.html`, `lending.css`, `lending.js` | Katana Morpho markets, personal lending limits and historical value/health charts. |
| `morpho-core.mjs` | Browser-safe shared Morpho reader and target maths used by the page, API and history job. |
| `scripts/morpho.mjs`, `morpho-history.json` | Daily older archive observations and six-hour recent observations, valued at their own pinned blocks. |
| `lpbook.css`, `lpbook.js` | Shared by the two LP Book pages: styles, chart, 15 s poll, modal. |
| `lpcards.css`, `lpcards.js` | The live position card and LIVE stamp, shared by `lp.html` and `widget.html`. Change the card here, never in one page. |
| `widget.html`, `widget.webmanifest` | A separately installable phone shortcut showing the LP cards, with a small warning when a chain cannot be read. It has its own LP-range icon. |
| `docs/hedge-desk/` | Historical Hedge Desk guides. The page has been withdrawn from the website; see §7. |
| `sw.js` | Service worker. **Bump `CACHE_VERSION` on every page or asset change**, or returning visitors keep the old shell. |
| `manifest.webmanifest`, `icons/` | PWA files. The site icon is a white metallic tiger: `icons/tiger.svg`, drawn by `scripts/tiger-icon.py`. |

Portfolio, both LP Book pages and Lending have a menu bar under the header:
**Portfolio · LP Book · Lending**, with the open page lit. The standalone widget has no menu;
tapping its Tiger Foundation masthead opens the full LP Book.

The menu buttons must keep the same position and size when switching between
Portfolio, either LP Book page and Lending. Match the 1200 px menu frame, side padding (28 px
desktop, 16 px at 768 px and below), gap below the masthead (14 px desktop, 12 px phone)
and subtitle line height. The menu stays outside the LP Book's content wrapper; the full
pages reserve a stable scrollbar gutter to avoid a sideways jump on shorter pages.
At 400 px and below, use a 5 px gap, 8 px pill side padding, 10 px labels with .06em
letter spacing, and 14 px icons so all three labels fit on one line.

The cards' outside edges must also match between Portfolio, both LP Book pages and Lending.
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
  opened. Under it: "$X still to claim · last claim <date>". There is a claim-record icon
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
  KAT market price, Oracle collateral, Borrowed and Average LTV are four separate summary
  cards at the top. The KAT card uses the existing pinned pool quote and refreshes with the
  lending reading every 15 seconds. Retain its original price/time on failure, mark it
  stale, and show an unavailable value before the first valid price; never substitute zero
  or silently replace the market quote with an oracle price.
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
- Show market/redemption collateral value separately from oracle collateral value.
  Clearly label the chart's value basis so its debt-limit lines and health agree.
- Debt includes interest accrued to the observation's block, using a read-only
  `eth_call` simulation of Morpho's `accrueInterest` followed by its position/market reads.
  Round debt up, borrow headroom down and required repayment up; cap available borrowing
  by market liquidity. No wallet connection, signature, loan or repayment transaction.
- Historical observations use the prices, oracle and balances at their own pinned blocks.
  Never reprice saved history at today's prices or substitute zeros for failed reads.
  Each market's two charts start at its first actual Borrow event, never at the global
  file's first date or a collateral-only deposit. **7D is the default range** for each
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

---

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
- **No secrets exist in this project.** The workflow uses GitHub's built-in token. Keep it
  that way.
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

- **Local server:** `powershell -ExecutionPolicy Bypass -File serve.ps1` serves the repo at
  http://localhost:4200 (`.claude/launch.json` holds the same).
  - It also accepts `POST /_save?name=<file>`, which writes a browser-rendered file (used
    for icons).
  - Any static server works too.
- **Local limits:**
  - **The `/api/*` functions do not run locally.** To test a page with real API data, save
    the production response, e.g. `curl …/api/lpbook -o api/lpbook`.
    **Delete that file before committing.**
  - Merkl fails on localhost (CORS).
- **Service worker:** it caches aggressively on localhost too. Unregister it, or clear
  caches, before judging a change.
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
- **Lending check:** `node scripts/test-morpho.mjs` checks loan rounding, liquidity,
  personal targets and history preservation without network access. At this local build,
  96 assertions pass; browser checks cover incomplete reads, full failure, five-minute
  expiry, recovery and saved settings. Phone widths 360/375 px have no sideways scroll.
- **Lending chart starts:** `node scripts/test-lending-series.mjs` tests the actual browser
  series function: 35 assertions cover each verified opening block, shorter date windows,
  repayments, gaps and mixed archive intervals. The one-time, resumable archive recovery
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
