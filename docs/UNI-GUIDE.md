# UNI liquidity guide — review and release, 14 November 2026

The owner requested a new UNI page, reviewed the local implementation and then
explicitly requested **push**. Publication of this update is authorized.

## Progress

- [x] Add UNI to all full-page menus; preserve both themes with their switches hidden.
- [x] Match Strategy's pool cards, masthead and content frame.
- [x] Discover Uniswap V3 pools for supported UNI/stablecoin pairs on Base/BNB Chain.
- [x] Verify factory, pool tokens, decimals, fee tier and pinned block identity.
- [x] Expand Step 1 (UNI only / stablecoin only / Balance), then reveal Step 2.
- [x] Add amount, minimum/maximum price, current price and tick-rounded actual range.
- [x] Calculate deposit mix, edge P&L, conditional fees/day and simple APR in code.
- [x] Copy the exact network/pool URL and open Uniswap from one action.
- [x] Retain readings/form inputs after failures; make stale/missing data explicit.
- [x] Validate math and the real UI using closed chain responses.
- [x] Run `npm run check`; all portable checks pass.
- [ ] Verify live pool inventory and displayed values against Base and BNB RPCs.
  Every attempted public RPC is blocked here by the outbound proxy; the real local
  endpoint correctly reports both networks unavailable rather than inventing pools.
- [ ] Verify external Uniswap pages against the actual discovered pools.
  Closed-browser tests verify network/address routing and clipboard behavior only.
- [x] Receive the owner's explicit instruction to publish this update.
- [ ] Confirm the production deployment after pushing. Vercel access remains
  blocked by this workspace's outbound proxy.

## What the page does

Pool cards show network, fee tier, UNI price in the paired stablecoin, TVL,
24-hour volume and pool fee APR. The network selector filters Base/BNB/both.
Opening a card reveals the deposit options. Choosing one reveals the amount and
range inputs, then the results and copy/open link.

- **UNI only:** the entire usable band must be above spot. It gradually sells UNI
  as price enters/rises through the range; it earns no fees while waiting.
- **Stablecoin only:** the usable band must be below spot. It gradually buys UNI as
  price enters/falls through the range; it earns no fees while waiting.
- **Balance:** the band must include spot. The calculator gives the required mix,
  which need not be 50/50 by value. The editable starting illustration is $1,000.

Edge P&L marks the position at each tick-rounded boundary against its starting
value, excluding fees and transaction costs. Below the lower edge the position is
all UNI and losses can continue. A single-sided edge is not falsely forced to be
a profit or loss when its actual P&L differs from that label.

## Sources and scope

- Uniswap SDK deployment addresses at commit
  `8ae0425c57e1699b0ae48ebb3077a2f526ae3818`:
  <https://github.com/Uniswap/sdks/blob/8ae0425c57e1699b0ae48ebb3077a2f526ae3818/sdks/sdk-core/src/addresses.ts>.
- Base UNI, USDC, DAI and USDbC identities from Uniswap's token list at
  `0ae664438dd43d428c5cbef2726af1ba6378a17c`:
  <https://github.com/Uniswap/default-token-list/blob/0ae664438dd43d428c5cbef2726af1ba6378a17c/src/tokens/base.json>.
- BNB Binance-Peg UNI, USDT, USDC and DAI, plus Base bridged USDT, from Trust
  Wallet's contract-specific asset records at
  `50d6fd574843da19cdd5fded102b5d6b951c72d2`:
  <https://github.com/trustwallet/assets/tree/50d6fd574843da19cdd5fded102b5d6b951c72d2/blockchains>.
  On-chain token decimals and pool identities must still match before showing data.
- Free RPC endpoints only; no keys, subscriptions, wallet connection or signatures.
- Swap and protocol-change events use the official Uniswap V3 ABI:
  <https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol>.
  Protocol-change values are ordered old0, old1, new0, new1.
- V3 fee tiers checked: 0.01%, 0.02%, 0.03%, 0.04%, 0.05%, 0.3% and 1%.
  Undeployed/dust pools are excluded only after successful reads. The allowlist
  covers USDC/USDT/DAI on BNB and USDC/USDT/DAI/USDbC on Base. Other stablecoins,
  V2, V4 and other exchanges are outside this page's current discovery scope.

## Fee calculations and limits

1. Discover pool addresses through `getPool`, then verify each pool's factory,
   tokens, decimals and fee. All pool and balance calls use the same block.
2. Locate a block at/before the actual 24-hour boundary using chain timestamps,
   not an assumed block interval. Compare raw uint256 fee-growth counters at the
   two blocks and normalize to one day. A missing archive call is not zero;
   a pool with no code at that earlier block is independently verified as new.
3. Complete Swap and SetFeeProtocol logs give volume and estimated aggregate LP
   fees. Inputs count once, and protocol changes are applied in event order.
   Fee totals can differ by tiny per-step rounding units. Volume marks use the
   current UNI quote. APR accounts for the actual interval and current TVL.
4. Personal liquidity comes from deposit value and tick-rounded range. In-range
   income uses actual recent per-liquidity fee growth, scaled for dilution from
   adding the new liquidity to today's active liquidity. APR is fees/day × 365
   divided by the deposit value. Single-sided positions outside the range show 0.
5. This is a conditional estimate of future earnings, not a backtest or guarantee.
   It assumes similar trading, liquidity and price remaining inside the range.
   Dollar values assume the paired stablecoin is worth $1. No gas/swap estimate is
   silently deducted or invented. Tiny positive daily fees retain decimal precision.

Readers have request/time budgets, chain-ID checks, per-call deadlines and a
fallback RPC. Capped successful logs split into disjoint ranges; budget failures
do not recursively rescan. The closing block hash is rechecked. Chains fail
independently. The public API coalesces requests and caches 30 seconds; the page
refreshes every minute and pauses in a hidden tab. Data older than three minutes
or retained after failure keeps its original timestamp and cannot supply a live
income quote. Historical portfolio/trade/LP files are untouched.

## Validation

- `node scripts/test-uni.mjs`: **292** assertions covering full encoded contract
  reads, decimals, both token orders, three modes, capital conservation, tick
  rounding, edge P&L, dilution, missing archive state, logs/protocol changes,
  incomplete discovery, capped results, budgets, reorgs, source isolation and the
  actual API's cache, request coalescing, JSON serialization and failure responses.
- Real UNI page, closed browser sources: **280** assertions in both themes at
  320/360/768/1366 px. Checks steps, result values, copy/open action, filtering,
  preserved inputs, stale/recovery, independently failed networks, confirmed empty
  pools versus unavailable sources, and no page overflow/errors.
- All nine full pages' navigation: **288** assertions at the same themes/widths;
  six destinations fit on one row without horizontal overflow.
- `npm run check` passes, including syntax and byte-identical Portfolio copies.
  An existing automation test depended on the wall clock and crossed MYT midnight
  during its simulated updates; its test clock is now anchored at tomorrow noon.
  No production agent behavior was changed.
- Actual preview: `/uni.html` HTTP 200; `/api/uni` HTTP 503 with truthful network
  unavailable states under the workspace's blocked RPC access. No real market
  rates, active pool list or archive-provider capability is claimed verified.
- Local preview: <http://127.0.0.1:4300/uni.html>.
- Closed-fixture screenshots and logs (not live market evidence):
  `/workspace/tiger-agent-validation/uni-guide/`.

Files: `uni.html`, `uni.css`, `uni.js`, `uni-core.mjs`, `api/uni.mjs`,
`api/_uni-config.mjs`, `api/_uni-reader.mjs`, closed fixtures/tests, all full-page
menus, shared small-screen menu styles, cache 168, preview route and Vercel's
60-second UNI function ceiling. No production credentials or migrations are needed.
