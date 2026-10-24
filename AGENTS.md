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
   at its end, calls `scripts/lpbook.mjs`. It commits these files as `github-actions[bot]`:
   - `data.json`: the snapshot and discovery state (meteora_refs, morpho_markets, fables, ...)
   - `history.json`: daily totals, one entry per UTC date
   - `claims.json`: the claim record, including `lp_fees`
   - `positions.json`: LP ledgers per chain
   - `lpbook.json`: the LP Book ledger
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
| `api/lp.mjs` | Legacy widget endpoint; no longer used by the widget. |

### Pages and shared assets

| File | What it is |
|---|---|
| `index.html` | The main **Portfolio** dashboard, ~5,000 lines inline. Classy theme by default; the cute tiger is the alternative theme (localStorage `tf_theme2`='tiger'). `vercel/index.html` must stay **byte-identical**: copy it after every edit. |
| `lp.html` | LP Book, **Live**: open positions at live prices. |
| `lp-all.html` | LP Book, **All-time**: closed positions, every figure fixed at close. |
| `lpbook.css`, `lpbook.js` | Shared by the two LP Book pages: styles, chart, 15 s poll, modal. |
| `lpcards.css`, `lpcards.js` | The live position card and LIVE stamp, shared by `lp.html` and `widget.html`. Change the card here, never in one page. |
| `widget.html`, `widget.webmanifest` | A separately installable phone shortcut showing the LP cards, with a small warning when a chain cannot be read. It has its own LP-range icon. |
| `docs/hedge-desk/` | Historical Hedge Desk guides. The page has been withdrawn locally; see §7. |
| `sw.js` | Service worker. **Bump `CACHE_VERSION` on every page or asset change**, or returning visitors keep the old shell. |
| `manifest.webmanifest`, `icons/` | PWA files. The site icon is a white metallic tiger: `icons/tiger.svg`, drawn by `scripts/tiger-icon.py`. |

Portfolio and both LP Book pages have a menu bar under the header:
**Portfolio · LP Book**, with the open page lit. The standalone widget has no menu;
tapping its Tiger Foundation masthead opens the full LP Book.

These look legacy; ask before deleting: `dashboard.html`, `dashboard.js`, `local.html`,
`server.py`, `ChatGPT Image Jul 16, 2026, 08_05_14 PM.png`. `serve.ps1` is the local server
(see §8).

---

## 4. Standing decisions (Alex's rules; do not change without asking)

### Display

- **One card per DeFi type, never one per position.** All LPs roll into one "Liquidity
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

- The LP Book, widget and vault refresh every 15 s.
- If a chain cannot be read on a refresh (usually a Robinhood rate limit), the LP Book
  and widget keep the currently displayed reading only if it is full and less than
  5 minutes old. Both show a quiet warning naming the failed chain and a STALE stamp.
- After that hold expires, or if no full reading is available, they display the incomplete
  answer with the warning. An incomplete reading never restarts the hold, is never called
  the "last full reading", and is never saved as the last good one (`lpbook.js` `HOLD`;
  the widget follows the same rule). A full read clears the warning and restores LIVE.
- A request that fails entirely leaves the displayed figures in place with a STALE stamp;
  this is separate from the five-minute hold for an incomplete answer.

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
  browser but has no `getProgramAccounts`.
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
- **Cross-check figures** against an independent read of the same position.

---

## 9. Release contents (24 Oct 2026)

- **This release, approved after local review:** Hedge Desk removed; all current
  headers use Tiger Foundation; extra LP Book titles removed; `sw.js` → `tiger-v92`.
- **Previous release:** `4134210`, with `tiger-v90`. The list below records that release,
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
