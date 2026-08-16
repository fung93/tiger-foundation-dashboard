# Money math

Turning chain state into numbers you can defend. The failure mode here is not a crash — it is a
plausible-looking figure that is wrong by multiples.

## Contents

- [Concentrated liquidity is not a balance](#concentrated-liquidity-is-not-a-balance)
- [Out of range](#out-of-range)
- [Pricing history at the block](#pricing-history-at-the-block)
- [Position lifecycle and realised P&L](#position-lifecycle-and-realised-pl)
- [Unrealised P&L](#unrealised-pl)
- [Currency as a display layer](#currency-as-a-display-layer)

## Concentrated liquidity is not a balance

A V3 position holds no tokens you can read with `balanceOf`. Reconstruct the amounts from
liquidity, the position's tick range, and the pool's current tick — three cases:

```js
// sqrtP = sqrtPriceX96 / 2^96 ; sqrtLower/sqrtUpper from the position's ticks
if (tick < tickLower)        amount0 = L * (1/sqrtLower - 1/sqrtUpper);
else if (tick >= tickUpper)  amount1 = L * (sqrtUpper - sqrtLower);
else { amount0 = L * (1/sqrtCurrent - 1/sqrtUpper);
       amount1 = L * (sqrtCurrent  - sqrtLower); }
```

Then add the uncollected fees, which come back from `positions()` as separate `tokensOwed`
fields. Forgetting them understates every open position.

Do the tick maths in `BigInt` where you can and convert to `Number` only at the end. Ticks are
signed — see `toSigned` in `chain-engine.md`.

## Out of range

The third case above is also what tells you a position has drifted outside its band and stopped
earning. Surface it — it is the one thing on a portfolio dashboard that needs acting on rather
than reading.

Distinguish the two directions, because they mean opposite things:

- Price **below** the band → you are holding the volatile side. Usually the bad one.
- Price **above** the band → the position has converted to the stable side.

Emit a three-value status (`in` / `above` / `below`) rather than a boolean, and **test for the
two out-of-range values rather than for "not in"**. `status !== 'in'` reports an unknown or
missing status as a problem; testing for `below || above` treats it as fine. When the
alternative is a false alarm on healthy positions, take the reading that fails safe.

Watch the case. A comparison against `'IN'` when the producer emits `'in'` marks every healthy
position as broken, and it looks like a data problem rather than a string problem.

## Pricing history at the block

**This is the most expensive mistake available in this kind of project.**

The obvious implementation values every historical event at the current price. On a volatile
reward token that is not slightly wrong — in the project this skill came from, it understated
realised losses by roughly **3×**.

**A free diagnostic before you change anything:** realised P&L on a *closed* position can never
change — it is settled history. Load the page, note the number, reload it tomorrow. If it moved,
you are pricing at read time and this is your bug. That test costs nothing and is conclusive.

Two ways to get a historical price, in order of preference:

**1. Read the pool at the block** — if the RPC serves archive state (probe it):

```js
rpc('eth_call', [{to: pool, data: '0x3850c7bd'}, '0x'+block.toString(16)])   // slot0()
```

**2. Index the pool's own `Swap` events** — no archive node required. Each `Swap` log carries the
post-swap `sqrtPriceX96`, so a scan of the pool's swap history gives you a price series you can
look up by block, using the `eth_getLogs` tooling you already have. This is the better route when
your provider prunes state, and it is worth knowing before paying for an archive endpoint.

If neither is available, label the figure approximate rather than quietly shipping it.

Two conversions that produce wrong-but-plausible numbers if you skip them:

- **`sqrtPriceX96` needs a decimals adjustment.** `price = (sqrtPriceX96 / 2**96)**2` is the raw
  token1-per-token0 ratio; multiply by `10**(decimals0 - decimals1)` to get a human price. A
  USDC pair is off by 10^12 without it — large enough to notice, but a WETH/DAI pair is off by
  1, which is how the bug survives into production.
- **token0/token1 are ordered by address, not by which one you think of first.** Assuming your
  quote token is token1 silently inverts the price for half of all pools.

The same principle governs a daily ledger: **once a day's value is booked, it is history.** When
merging a live scan over a stored record, keep the stored price for days already recorded and
use the live price only for new days — otherwise yesterday's total silently changes every time
someone opens the page, and the history chart rewrites itself.

Fix the day boundary to one timezone rather than the viewer's:

```js
// days run 00:00–23:59 in UTC+8, wherever the reader is
function dayKey(ms){ return new Date(ms + 8*3600000).toISOString().slice(0,10); }
```

## Position lifecycle and realised P&L

Reconstruct each position's life from the NFT manager's events:

- `IncreaseLiquidity` — principal going in. First one is the open.
- `DecreaseLiquidity` — principal coming out.
- `Collect` — principal and fees actually withdrawn. Value the close here, not at Decrease.
- `Transfer` — ownership moves. Watch these: a position sitting in a staking contract is still
  yours, and a naive "do I own this NFT" check will miss it. Check the staker's holdings too.

Realised P&L is `close value − open value`, each priced at **its own** block. Store closed
positions permanently; they never change again.

## Unrealised P&L

For open positions, mark to market: current value (from the tick maths above, at the current
price) minus the open value (at its historical block). Label it clearly as unrealised — it is a
different kind of number from a booked one and readers conflate them.

A combined figure is usually what the user actually wants:

```
total P&L = value of all rewards claimed + realised P&L on closed positions
```

with unrealised shown separately rather than folded in.

## Currency as a display layer

Keep everything upstream in one base currency — the JSON files, the chain reads, the ledgers,
the chart's dataset. Apply the rate at format time only. Nothing needs re-fetching to switch,
and a stale rate can never corrupt a stored value.

Three details that bite:

- **Apply abbreviation thresholds after converting**, or the same amount reads `23,265` in one
  place and `23.27K` in another.
- **Use the exact formatter for P&L, the abbreviating one for headlines.** An abbreviating
  formatter that switches to four decimals under a dollar renders a P&L of `$0.9535` next to a
  headline of `$4.95K`, which reads as two different units.
- **On a cold start with a saved non-base currency and no cached rate, open in the base
  currency** and switch when the rate lands. A foreign symbol against unconverted numbers is a
  wrong number on screen, which is worse than a right one arriving a moment late.

Free FX sources that work from a browser with no key: `api.frankfurter.app` (ECB reference
rates, no weekend fixes) with `open.er-api.com` behind it. Cache the rate in `localStorage` so a
cold offline start still honours the choice.
