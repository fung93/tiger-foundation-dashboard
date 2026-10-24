# CRCL LP Hedge Desk

> **In Tiger Foundation** the desk is [`/hedge.html`](../../hedge.html), ported on 22 Oct 2026 from
> `Minara/lp-hedge-desk` (kept there as an archive). Only the skin, header and menu bar
> changed; where this guide says `index.html`, read `hedge.html`. Changes go here from now on.

A single-page dashboard for providing liquidity to the Uniswap v3 **USDG / CRCL 0.30%** pool on Robinhood Chain while hedging with a **1x CRCL short on Hyperliquid** (`xyz:CRCL`).

## What it does

**Planner.** Enter a price range and your capital. It shows:

- **USDG needed**, **CRCL needed** and **USDC needed to hedge**
- Fee APR and net APR after hedging
- Break-even time vs typical time in range
- The CRCL price range over the past and expected 7 days, 14 days and 1 month, with the APR for each
- A both-edges check, a profit/loss chart, exit orders for each edge, a re-hedge ladder and scenarios
- **Expected return** over 24 hours, 7, 14, 21 days and 1 month: the chance of never leaving the range and of being in range at the end, expected days in range, expected fees, hedging cost, funding and costs, the expected net, and the typical swing with and without the short
- Holding-period buttons (24H / 7D / 14D / 21D / 1M) on the both-edges check, the P&L chart, the exit plan and the scenarios, each card set on its own

**Simulated positions.** "Deploy as simulated position" opens a paper position at the live pool and perp prices. Each position gets its own tab, and you can run several ranges side by side. Each tab shows two results for the same position:

| Unhedged (LP only) | Hedged (LP + short) |
|---|---|
| LP value at the live pool price | the LP result |
| impermanent loss vs holding the tokens | short P&L at the live Hyperliquid mark |
| fees earned | real hourly funding |
| 0.30% swap fee to buy the CRCL side | perp taker fees to open and close (0.009% on xyz:CRCL) |

A **With swap / Without swap** switch shows every result both ways: with the 0.30% fee paid to buy the CRCL half, or without it for when the CRCL was already held. It applies to the result cards, the chart, the tab labels and History, and the CSV export carries both.

Below its results, each position tab repeats the Planner for that position (everything except the to-do list). It uses the position's own range, liquidity and short from entry, with today's market data. The real price movement is drawn in: entry and now markers, the price band actually traded since entry, a price-over-time chart, and the real result at each recorded price plotted against the plan.

Close a position at any time. It is valued at the live prices and moved to **History**, which can be exported as CSV or backed up and restored as JSON.

## How the simulation matches a real position

- **Fees** come from the pool's real swaps, credited swap by swap the way Uniswap v3 pays LPs:
  - paid in the token that came in
  - only for the part of each price move inside the range
  - split by your liquidity against the pool's active liquidity at that swap
  - less the pool's protocol fee. `slot0.feeProtocol` is on for this pool and keeps 1/6, so LPs get 0.25% of each trade.
- **Token balances and impermanent loss** follow the real pool price through the concentrated-liquidity formulas.
- **Ranges are rounded the way Uniswap rounds them.** This pool only allows range edges every 60 ticks (about 0.6% apart), so a typed 75–95 becomes 74.90–95.22. Every amount uses the rounded range, and the inputs show it.
- **The short** is marked to Hyperliquid's live mark price. It receives or pays the real hourly funding, priced at the close of the hourly candle when each payment landed. A 1x isolated short liquidates at about +90%. The taker fee is read live from the market: xyz:CRCL is a builder market in "growth mode", so it charges 0.009% per trade, not the 0.09% the dashboard assumed before 19 Sep.
- **Time the page was closed** is filled in from the chain's swap history when it reopens (the endpoint keeps at least 14 days). Anything older than that is flagged as a gap on the position.

Checked on 19 Sep 2026:

- Over 30 minutes, the fees the replay credited matched the pool's own fee accounting (fee growth inside the range) for 6 real LP ranges, to within rounding. That window had only 5 swaps, all inside every range, so the partial-range case has not yet been checked against the chain.
- The browser replay matched a separate Python implementation to 10 significant digits.
- The deposit formulas reproduced six real Uniswap deposits in this pool exactly, and the pool address was confirmed with the Uniswap v3 factory.
- Simulated funding matched Hyperliquid's payment history exactly.

## Open it

Open `index.html` in a browser. There is nothing to install or build. Positions and history are saved in that browser's storage, so back them up from the History tab.

| Data | Source | Refresh |
|---|---|---|
| Pool price, liquidity, protocol fee | Robinhood Chain RPC, falling back to PublicNode, then Ordofi | 20 s |
| Pool swaps (fees, volume) | official Robinhood Chain RPC (the only public one that serves logs) | 30 s |
| Perp mark price | Hyperliquid `metaAndAssetCtxs` (dex `xyz`) | 20 s |
| Funding, volatility, price history | Hyperliquid `fundingHistory`, `candleSnapshot` | 10–30 min |

The public chain endpoints rate-limit hard:
- Each endpoint backs off for 5–30 s when refused, and price reads switch to the next endpoint.
- Tabs in the background stop polling.
- For a dedicated connection, paste your own RPC URL (for example Alchemy) under *Market & assumptions → Connection*. It is used first and stored only in your browser.

## How the planner's numbers are made

- **Fees per day** = fees one unit of liquidity earned over the last 7 days, measured swap by swap with the liquidity active at each swap, × 5/6 × your liquidity (diluted by your own share). Until that is measured it falls back to 7-day volume × 0.30% × 5/6 ÷ active liquidity. Checked 19 Sep: the dashboard measured $0.009657 per unit a day, an independent Python run $0.009647.
- **Hedging cost per day** = σ² · L · √P ÷ 4. This is the loss a continuously re-hedged LP realises: the impermanent loss a hedge cannot remove. Over the week to 19 Sep it matched the realised cost of re-hedging every hour within 1% (same σ). In Expected return it is priced at the price the position is likely to be at while in range, which matched 20,000 simulated paths within 0.3–1.5%.
- **The hedging cost is real, but it assumes no trend.** Checked 23 Sept by replaying the real swaps: over 48 windows of 72h at ±2.7%, realised impermanent loss against holding the entry delta was −$6.07 while the formula said −$8.07 — about 25% overstated, right sign, right size. What it cannot know is drift. Over the same windows CRCL rose 5.77%, so "fees minus hedging cost" read −$5.08 against a real average of +$0.17; the gap is the trend, not a broken model. Net APR therefore says "if price has no trend", and on a running position it shows what the position actually returned beside it.
- **Balanced short** = the short that gives the same result at both range edges.
- **One rule at both edges: make the short equal the CRCL the LP is holding, at the edge, on the perp.** Above the top edge the LP is all USDG, so the short goes to zero (at the edge plus 0.25%). Below the bottom edge the LP is all CRCL, so the short grows to cover the whole bag (at the edge). The LP itself is never touched and no swap fee is ever paid.
- **Exit rules, chosen by backtest on the real path.** Replayed over the 25,533 actual swaps of the week to 19 Sept — real prices and real per-swap fees, so fee timing stays correlated with price moves — $250 at ±2.7%, held 72h from 48 start points: upper 0% / lower 1% was the best pair at 60% of starts in profit, mean +$3.45, worst −$4.60. Upper 0% beat 0.25%, 0.5%, 1% and 2%. Lower 1% beat 0% (stopped out by noise sitting on the edge), 2%, 3%, 5% and never cutting (worst −$15.52). Both rules free margin rather than needing more, which is what a fixed pot of collateral allows.
- **Covering the CRCL bag on the perp measured better but is not the default.** Adding to the short below the edge instead of leaving freezes the position for a 0.009% fee rather than a 0.30% swap, and kept the LP earning. It needs roughly double the margin standing by before the edge is reached, so it stays as option B in the exit plan with the required USDC printed on it.
- **No buffer setting secures a profit.** The best pair was in profit at 60% of 72-hour starts. What moved the odds was holding time: over the same week, 120-hour holds at ±1.5% to ±2.7% were profitable at almost every start point, because fees accumulate while price mean-reverts — though a 7-day sample only contains about two independent 120-hour windows, so treat that as a direction, not a probability.
- **The fee rate is measured inside your range, not pool-wide.** A range only earns from swaps that happen inside it, and price sits inside a narrow range precisely when the market is quiet — the busy hours are the ones that carry it out. Multiplying a pool-wide average by your liquidity therefore reads far too high. Measured over the real 14,242 swaps of the week to 23 Sept, fee per unit of liquidity per day counted only inside a range over the time price spent inside it, against the pool-wide 0.004870: ±1.5% → 0.002575 (53%), ±2.7% → 0.003471 (71%), 90.21–95.22 → 0.003350 (69%), ±10% → 0.004371 (90%). Fees and dwell time are now kept in bins of 0.1% of price per hour, checked against an independent Python replay to within 1.8%, and the tile prints what the pool-wide average would have claimed alongside.
- **Fees arrive in bursts.** Over that week the busiest 10% of hours carried 50% of all fees and the quietest half carried 10%. Being in range half the time does not earn half the fees, so time-in-range percentages flatter a position that misses the busy hours.
- **The band above the edge is a cost, not a cushion.** The short is bought back at pb·(1+buffer) and re-sold at pb, so every pop over the top and back costs short × pb × buffer — $2.48 on a $124 short at 2%, $0.31 at 0.25%. It saves only two taker fees, 0.018%, so it pays for itself only up to about that width. Measured 21 Sep over 6,000 simulated paths (7 days, $250, ±2.7%, 83% annual vol from 45 days of hourly candles, fees included): mean +$8.89 at a 2% buffer, +$10.96 at 0.25%, +$11.80 at 0%, with the 5% tail unchanged near −$14. Closing and *not* re-arming the short for the way back in is the worst rule tested, +$7.55.
- **An unwind ladder was tested and rejected.** Reducing the short in 8 steps as the LP sells its CRCL beats closing once at the edge by $0.57 a week, for 55 trades instead of 6. Almost the whole upside problem is the short still being open above the top edge, and one stop order fixes that.
- **Typical time in range** = ln(P/Pa) · ln(Pb/P) ÷ σ², the average first-exit time for a driftless random walk.
- **Expected range** = P · e^(±σ√t), about a 2-in-3 chance of ending inside.
- **Chance of never leaving the range** by day H is the standard series solution for a driftless random walk between two walls; it matched a 6,000-path simulation (73% vs 74% at 1 day, 21% vs 22% at 7 days). **Expected days in range** integrates the chance of being inside at each moment, since a passive LP earns again when price comes back.

## Limits

- The planner's fee estimate uses the active liquidity at one instant. A market-making bot that repositions tight liquidity every few minutes can swing it. The simulation does not have this problem, because it uses the liquidity recorded at each swap.
- Simulated positions do not move the pool. A very large real position would earn a little less than simulated.
- Swaps to enter and exit are charged the 0.30% fee but no price impact.

This is a calculator and paper-trading tool, not financial advice.
