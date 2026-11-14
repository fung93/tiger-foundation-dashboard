# Dashboard update — 14 November 2026 (MYT)

- [x] Diagnose missing/stale Katana LP reads against current ownership and liquidity;
  preserve earlier accounting, reward claims and genuinely unavailable readings.
- [x] Remove theme buttons from **every dashboard page**, retaining the implementation
  and saved preference (owner clarified the scope).
- [x] Replace the Strategy page's emission-led view with USDT/USDC, avKAT/KAT,
  avKAT/USDC, vbETH/USDC and vbWBTC/USDC fee pools; sort by volume, fees or APR.
  Preserve daily range estimates and the hedge calculator with explicit assumptions.
- [x] Make vKAT/avKAT the main KAT destination. Keep the network row and show personal
  vKAT and avKAT holdings, without the voting/epoch/reward-history interface.
- [x] Archive the old KAT trade ledger and start a fresh swap-only book at a verified
  reset block. Claims, staking, lending and LP transfers must not become trades.
- [x] Run financial regressions, page/browser checks and `npm run check`.
- [x] Rebase onto current main, preserve scheduled data updates and push.

All wallet access remains read-only. No signing, transfers or account actions were
performed. The original agent implementation plan remains unchanged.

## Measured findings

- At 13:43 MYT, the complete LP reader caught up both chains with `errors: {}`,
  zero backlog, no unread positions and no unpriced amounts. Katana #495384
  (avKAT/KAT, unstaked) and #495640 (vbWBTC/vbUSDC, unstaked) were both present.
  All 12 earlier closed records were byte-for-byte unchanged in that read.
- #495384 previously had no USD valuation because neither token is a stablecoin.
  Its original deposit was recovered as $25.87 at block 47,792,295; a later top-up
  was $30.21 at block 47,879,825. Total cost was $56.08, rather than zero or just
  the original mint. Same-block KAT/USD anchoring now values the live pair. A
  failed dollar bridge remains unavailable and cannot erase the peer BTC LP.
- Katana was also treated as reward-only throughout its LP book. Actual unstaked
  positions now include owner fees; principal withdrawals and staked DAO collections
  remain excluded. Merkl reward claims and owner trading-fee claims stay separate.
  Existing APR samples before owner-fee migration are not used as a false accrual
  baseline. Book version stays 9 and no full ledger rebuild is introduced.
- Factory reads at block 47,890,383 verified deployed fee tiers for all five pairs.
  The final live Strategy read returned 10 funded/best-available tiers across those
  five pairs. avKAT/USDC had zero active liquidity; its estimator stays unavailable.
  Empty pools are valued with independent reference quotes, avoiding an empty
  pool's arbitrary starting price. Actual 24-hour swaps drive volume/fees/APR;
  the conditional range estimate still uses seven-day fee growth.
- Personal holdings were independently read at block 47,891,454: about
  257,871.86 wallet-held vKAT and 169,451.85 avKAT (wallet plus Morpho collateral).
  LP token exposure is separate. All personal amounts, current network totals and
  conversion prices share one block. Failed required reads return no-store errors
  and the page keeps its dated reading.
- KAT's reset is block **47,890,384**, **14 November 2026, 13:13:15 MYT**.
  Verified opening wallet raw KAT was `6951984870` (dust, not a purchase). The
  archived book is `docs/archive/kat-trades-before-2026-11-14.json`. Only supported,
  positively verified buy/sell swaps enter the new version-2 book; claims and
  non-trade wallet movements cannot enter its trade history or P&L.

## Validation evidence

- `npm run check`: all **77** portable suites pass; syntax and byte-identical
  Portfolio copies pass. This does not run collectors or backfills.
- Financial checks include captured real Katana RPC responses plus an injected
  quote failure, principal/owner/DAO fee separation, pool ranking, avKAT hedge
  conversion and swap-only buy/sell/claim/reset cases (**61** assertions).
- New holdings endpoint checks (**160** assertions) cover both wallets, Morpho
  collateral, block identity, unavailable subcalls, failed prices, dated recovery
  and no-store failure responses. Existing rollover (**467**) and reward
  attribution (**147**) checks retain their full scopes with explicitly staked
  reward-only fixtures.
- Existing Strategy (**159**), LP performance (**526**), core reads (**91**) and
  Portfolio Katana (**50**) checks pass.
- Chromium: **516** checks across classy/tiger at **320, 360 and 1366 px**.
  Sorting retains inputs/open cards, daily earnings and hedges render, inactive
  pools refuse estimates, stale values keep their timestamp and recover, the old
  KAT cache cannot reappear, all switches are absent and navigation fits.
  Screenshots were inspected; personal holdings use one column on phones.
- Native local Cloudflare: Telegram **241**, automatic workflow **50**, recurring
  review **24** checks pass; no real AI/Telegram/provider contacted. Worker bundle
  dry-run passes. No production Worker or D1 state was changed.
- Detailed logs/screenshots and live-read artifacts are outside the repository at
  `/workspace/tiger-agent-validation/2026-11-14/`. The compact captured LP RPC
  regression fixture is committed under `scripts/fixtures/`.

## Changed files and configuration

- LP calculation/valuation: `api/_core.mjs`, `api/_katana-config.mjs`,
  `agent-performance.mjs` and financial regression fixtures/tests.
- Strategy: `api/strategy.mjs`, `strategy-core.mjs`, `strategy.html`,
  `strategy.js`, `strategy.css`, `scripts/strategy-ranges.mjs`.
- Holdings/navigation: `api/vkat.mjs`, `vkat.html`, `vkat.js`, `vkat.css`, all
  dashboard HTML headers/menus and shared `lpbook.css`. Portfolio copies match.
- Swap book: `kat-core.mjs`, `kat-tracking-config.mjs`, `api/kat-trades.mjs`,
  `kat-trades.json`, `kat.html`, `kat.js` and the historical archive.
- Cache/config/docs: `sw.js` (166), `vercel.json`, `scripts/check-project.mjs`,
  `AGENTS.md` and this checklist. The changed financial Vercel functions have
  a 60-second duration ceiling. Existing free-plan Workers AI settings, private
  authentication and Lending's per-visit settings reset remain unchanged.
- No new secret, D1 migration, package installation or manual setting is required.
  Normal production deployment must include both frontend assets and API modules.

## Remaining production verification

- [ ] Confirm the pushed commit becomes Ready in Vercel, then confirm live cache
  `tiger-v166` and the changed LP/Strategy/holdings/trades pages. This workspace's
  proxy blocks the production site and deployment-status API with 403 responses.
- [ ] Verify actual Katana Perps quotes from the deployed environment. Its REST
  host is blocked by this workspace's proxy; the live RPC fee reads succeeded.
  Browser hedge acceptance uses explicit closed venue fixtures. Missing venue
  data leaves hedge estimates unavailable instead of making up a price.
- No new real Cloudflare-account capability or credential was needed or tested;
  existing account-side AI, D1, schedules and Telegram configuration is unchanged.
