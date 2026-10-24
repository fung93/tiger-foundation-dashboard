# Building a hedged Uniswap v3 LP desk

> **In Tiger Foundation** the desk is [`/hedge.html`](../../hedge.html), ported on 22 Oct 2026 from
> `Minara/lp-hedge-desk` (kept there as an archive). Only the skin, header and menu bar
> changed; where this guide says `index.html`, read `hedge.html`. Changes go here from now on.

A guide for an agent asked to build, port or extend this thing. Everything here
was measured against the live chain and checked against independent replays;
where a number is an estimate rather than a measurement, it says so.

The deliverable it describes is `index.html` — one self-contained file, no build
step, no backend, no API keys. It reads a Uniswap v3 pool straight from an RPC
and a perp venue over HTTPS, and it runs from `file://`.

### How to use this

**If `index.html` is sitting next to this file, read it before writing anything.**
It is a working implementation of everything described here, already verified
against the chain. Port it; do not rebuild it from this prose. The guide exists
to tell you *why* the code is shaped the way it is — which constants were
measured, which were assumed, and which eight things will break if you
reorganise it carelessly (§8).

If you have only this guide, build from §2 → §4 → §5 in that order, and run the
verification checklist in §10 as you go rather than at the end.

Either way: **verify, do not trust.** Every pool-specific number in here was
true for one pool on one chain on one day. The reads in §2 take four RPC calls
and will tell you which ones still hold.

---

## 1. What the desk does

Provide liquidity to a Uniswap v3 pool, short the risk asset on a perp to
cancel the directional exposure, and work out whether the fees beat the cost.

It answers four questions:

1. **Sizing** — for a given range and capital: how much of each token to
   deposit, and how much collateral the hedge needs.
2. **Economics** — what the pool actually pays an LP in that range, against
   what volatility costs, with both measured rather than assumed.
3. **Exits** — the price at each edge where you act, and what to do there.
4. **Truth** — what a real on-chain position has actually earned, read from the
   position itself rather than reconstructed.

The fourth matters more than it sounds. A simulated ledger and the chain
disagreed by 20% for days in this codebase's history, and the chain was right.

---

## 2. Start here

Before writing any code, verify these against the live chain, because every
formula downstream depends on them and three of the four differ between pools:

```
pool.token0()      0x0dfe1681   which side is the risk asset?
pool.token1()      0xd21220a7
pool.fee()         0xddca3f43   fee tier, in hundredths of a bip (3000 = 0.30%)
pool.tickSpacing() 0xd0c93a7c   60 at 0.30%, 10 at 0.05%
pool.slot0()       0x3850c7bd   sqrtPriceX96, tick, ..., feeProtocol
```

`slot0.feeProtocol` is the one people hard-code and get wrong. It is two nibbles,
low for token0 and high for token1; a value of `n` means **1/n to the protocol**,
and `0` means the LP keeps everything. Read it; do not assume.

| pool | tier | spacing | feeProtocol | LP keeps |
|---|---|---|---|---|
| CRCL/USDG `0x654e4143…acd95a8` | 0.30% | 60 | 102 = 0x66 | 5/6 = 83.33% |
| ETH/USDG `0x69bfaf19…1a8d9a` | 0.05% | 10 | 68 = 0x44 | 3/4 = 75% |

Confirm the cut is really being taken with `pool.protocolFees()` (`0x1ad8b03b`).
On the CRCL pool it had accrued 223 USDG, so the 1/6 is real.

---

## 3. Chain and venue reference

### Robinhood Chain

```
RPC            https://rpc.mainnet.chain.robinhood.com
fallbacks      https://robinhood-rpc.publicnode.com
               https://rpc.ordofi.network        (reads only; CORS *)
block rate     ~9.91 blocks/second  (measure it; everything time-based uses it)
v3 factory     0x1f7d7550b1b028f7571e69a784071f0205fd2efa
position mgr   0x73991a25c818bf1f1128deaab1492d45638de0d3   (one for the chain)
```

Only the first endpoint reliably serves `eth_getLogs`. The others are fine for
`eth_call`. A 429 breaks CORS, so in a browser a rate limit surfaces as
"Failed to fetch" rather than an HTTP status — budget for that in error handling.

### Tokens

```
USDG  0x5fc5360d0400a0fd4f2af552add042d716f1d168   6 dp   "Global Dollar"
CRCL  0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5  18 dp   tokenised equity
WETH  0x0bd7d308f8e1639fab988df18a8011f41eacad73  18 dp
```

WETH is **not** at any of the usual addresses (`0x4200…06`, Arbitrum's, mainnet's).
Find it from a pool that uses it, or from `PoolCreated` events.

### Selectors

```
slot0                      0x3850c7bd    liquidity              0x1a686502
fee                        0xddca3f43    tickSpacing            0xd0c93a7c
feeGrowthGlobal0X128       0xf3058399    feeGrowthGlobal1X128   0x46141319
ticks(int24)               0xf30dba93    protocolFees           0x1ad8b03b
token0 / token1            0x0dfe1681 / 0xd21220a7
factory                    0xc45a0155    getPool                0x1698ee82
positions(uint256)         0x99fbab88    ownerOf                0x6352211e
balanceOf                  0x70a08231    tokenOfOwnerByIndex    0x2f745c59
symbol / decimals          0x95d89b41 / 0x313ce567
```

### Event topics

```
pool  Swap               0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
pool  Mint               0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
pool  Burn               0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c
pool  Collect            0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0
NPM   Collect            0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01
NPM   IncreaseLiquidity  0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f
NPM   DecreaseLiquidity  0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4
fcty  PoolCreated        0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118
```

Mint's last hex digits are `d0bde`. Getting that wrong returns zero logs with no
error, which costs an hour.

### `eth_getLogs` limits — read this before designing any reader

Two separate caps, and the first is not documented anywhere obvious:

- **A topic position holding more than one value caps the range at 100,000
  blocks** and *rejects* anything wider with `-32602`. One value per position
  and the same node serves 3,000,000-block ranges happily.
- **10,000 logs per response**, regardless of range.

So: never use an OR-list of topics on a wide range. Issue one query per topic
value instead. If a loop treats a thrown request as `break`, a rejection becomes
a silent no-op — this exact combination froze the fee scanner for days.

### Hyperliquid

```
POST https://api.hyperliquid.xyz/info
  {"type":"metaAndAssetCtxs"}                 main dex
  {"type":"metaAndAssetCtxs","dex":"xyz"}     a builder (HIP-3) dex
  {"type":"fundingHistory","coin":"<coin>","startTime":ms}
  {"type":"candleSnapshot","req":{"coin":"<coin>","interval":"1h",...}}
```

`fundingHistory` and `candleSnapshot` key off the coin name, which carries its
own dex prefix (`xyz:CRCL`), so they need no `dex` field. `metaAndAssetCtxs`
does. Asking the `xyz` universe for `ETH` returns nothing.

Taker fees differ by venue and this is not cosmetic — it sets the whole
exit-buffer economics:

| market | base | deployer scale | growth mode | taker | max lev | maintenance |
|---|---|---|---|---|---|---|
| `xyz:CRCL` | 0.045% | 1.0 (×2) | enabled (×0.1) | **0.009%** | 10 | 5% |
| `ETH` (main) | 0.045% | n/a | n/a | **0.045%** | 25 | 2% |

`deployerFeeScale` and `growthMode` exist only on builder markets. The rule is
`0.045 × mult × (growthMode ? 0.1 : 1)`, where `mult = scale < 1 ? scale + 1 :
scale * 2`. On the main dex, just use the base rate.

---

## 4. The market config pattern

Do not hard-code one pool. The orientation of the pair changes the sign of
almost everything, and you will find that out late. One table, one flag:

```js
const MARKETS = {
  crcl: {pool:"0x654e…", tier:0.30, spacing:60,
    risk:{sym:"CRCL", dec:18, token0:false},   // risk is token1
    cash:{sym:"USDG", dec:6},
    perp:{coin:"xyz:CRCL", dex:"xyz"}},
  eth:  {pool:"0x69bf…", tier:0.05, spacing:10,
    risk:{sym:"ETH",  dec:18, token0:true},    // risk is token0
    cash:{sym:"USDG", dec:6},
    perp:{coin:"ETH", dex:null}},
};
const SCALE   = 10 ** (MKT.risk.dec - MKT.cash.dec);   // 1e12 for both of these
const RISK_T1 = !MKT.risk.token0;
```

Price is always **cash per unit of risk**. `sqrtPriceX96²` is `token1/token0` in
raw units, so:

```js
priceFromSqrt = sq => RISK_T1 ? SCALE/(sq*sq) : (sq*sq)*SCALE;
priceOf = t    => RISK_T1 ? SCALE/1.0001**t  : 1.0001**t * SCALE;
tickOf  = p    => RISK_T1 ? log(SCALE/p)/log(1.0001) : log(p/SCALE)/log(1.0001);
```

A swap's legs likewise:

```js
cashLeg = (a0,a1) => (RISK_T1 ? a0 : a1) / 10**MKT.cash.dec;
riskLeg = (a0,a1) => (RISK_T1 ? a1 : a0) / 10**MKT.risk.dec;
```

Liquidity normalises by `10**((dec0+dec1)/2)`, which is `1e12` for an 18/6 pair
in either order. Both pools here share that, which is luck — do not rely on it.

**Ticks can be negative.** The ETH pool sits near tick −198,600. `int24` arrives
inside a 256-bit word, so sign-extend from 256 bits, not 24:

```js
const s24 = v => v >= 2n**255n ? v - 2n**256n
                : (v >= 2n**23n ? v - 2n**24n : v);
```

A 24-bit-only extension turns −198,600 into a 77-digit number, which then flows
into prices and produces nonsense far from where the bug is.

**Namespace all storage per market.** Pool, perp, caches and saved inputs all
change together. Keeping one market on the unsuffixed keys lets an existing
install keep its data.

---

## 5. The maths

### Position value

In range, with `L` the normalised liquidity and `pa < pb` the range in
cash-per-risk:

```
V(P) = L · (2√P − P/√pb − √pa)
x(P) = L · (1/√P − 1/√pb)      risk asset held
y(P) = L · (√P − √pa)          cash held
```

`V'(P) = x(P)` exactly — the slope of value against price *is* the risk holding.
Use that as your unit test; it caught two sign errors here.

Outside the range, `V` is linear: all cash above `pb`, all risk below `pa`.

### Hedging cost (impermanent loss)

`V'' = −L / (2P^1.5)`, strictly negative — the value curve is a dome. For any
curved payoff under a random price, Itô gives a drift of `½·V''·σ²·P²`:

```
hedging cost per day = σ² · L · √P / 4
```

Verified numerically: curvature gives −$6.6863/day where the closed form gives
−$6.6873.

**It is an estimate of impermanent loss, not a fee anyone charges, and it
assumes no drift.** Replayed against real swaps over 48 windows of 72 hours,
realised IL was −$6.07 against a predicted −$8.07 — about 25% high, right sign
and size. It runs high because it extrapolates an instantaneous rate and ignores
that the bleeding stops once price leaves the range: a one-day simulation put it
13% high, three days 25%.

A fixed short cancels `V'` and cannot touch `V''`. That is why this cost is
called a hedging cost: it is the part no hedge removes.

### Sizing the short

Two sensible choices:

- **Neutral now**: `h = x(P)`. Delta-zero this instant, drifts immediately.
- **Balanced edges**: the size giving the same P&L at both edges. Solving
  `P&L(pa) = P&L(pb)`:

```
h = [V(pb) − V(pa)] · P0 / [E · (pb − pa) · (1 + t)]
```

with `E` the perp mark and `t` the taker fee. This is *not* delta-neutral — it
is neutral at exactly one interior price and off by roughly ±50% of the LP at
the edges. Say so in the UI; it is the single most misunderstood number here.

### Collateral, closed form

At 1× the mark cancels out entirely:

```
C = c · P0 · L · (√pb − √pa) / [ √pb · (√pb + √pa) · (1 + t) ]
```

Matches the iterative solve to 0.0000% at every size tested. Because both `C`
and the deposit are linear in `L`, the ratio is fixed for a range — and it
barely moves with the range at all: **48.8%–50.8%** across ±1.5% to ±10% and
tilted ranges alike.

> Budget ~50% of the LP as hedge collateral. Total capital ≈ 1.5× the deposit.

### Expected time in range

`ln(P/pa) · ln(pb/P) / σ²` is the mean first-exit time for a driftless walk.
It is only valid **starting inside the range**. If price is outside, it and the
in-range probability series are out of domain — say so rather than printing a
number.

---

## 6. Measuring what the pool pays

This is where naive implementations are most wrong.

### Fee per unit of liquidity, per swap

Uniswap takes the fee from the input leg. From a `Swap` log, with `Lr` the
liquidity active at that moment:

```
fee per unit L = tier · (volume in cash) / Lr        then × (LP's keep share)
```

Credit it to a position only for the portion of the price move that fell inside
that position's range — the swap-level `frac`. A swap crossing your upper edge
pays you for part of itself, not all of it; one paid 62% in testing.

### Measure the rate *inside the range*, never pool-wide

A range earns only from swaps that happen inside it, and price sits inside a
narrow range precisely when the market is quiet — the busy hours are the ones
that carry price out. So a pool-wide average, multiplied by your liquidity,
systematically overstates a narrow position.

Measured over 14,242 real swaps, fee per unit of liquidity per day counted only
inside a range, over the time price spent inside it, against the pool-wide
0.004870:

| range | rate | share of pool-wide |
|---|---|---|
| ±1.5% | 0.002575 | **53%** |
| ±2.7% | 0.003471 | 71% |
| ±10% | 0.004371 | 90% |

Implementation: bucket fees **and dwell time by price bin and hour**. 0.1% log
bins are enough; 0.5% bins widened the effective range and read 15–21% high.
Then the rate inside `[pa,pb]` over the last `n` hours is
`Σ fee(bins in range, hours in window) / Σ dwell(same)`.

Dwell time: between two swaps the pool price does not move, so the gap belongs
to the earlier swap's price. Windows arrive in runs, so **stitch across window
seams** — dropping the seam gap loses the long quiet gaps, which are exactly the
in-range ones, and read 13% high.

### Fees arrive in bursts

Over one measured week the **busiest 10% of hours carried 50% of all fees**, and
the quietest half carried 10%. Being in range half the time does not earn half
the fees. Any "time in range %" flatters a position that missed the busy hours.

### Name the window you actually read

A partial read covers the most recent hours, which are the busiest. Labelling it
"past 7 days" from the first bucket showed $3.74/day against a true weekly
$2.83. Label it with what has been read, and show short windows separately: a
6-hour row showed $5.10/day while the 24-hour row showed $3.84.

---

## 7. Reading a real position

### Finding it without a wallet address

`Mint` indexes `tickLower` and `tickUpper`, so a position whose range you know
can be found by log filter; the NFT id comes from the manager's
`IncreaseLiquidity` in the same transaction. Pick the mint nearest the block you
expect and cache the id. Anchor the search window on the mint's own block, never
on a rolling window from head.

With a wallet address instead: `balanceOf` then `tokenOfOwnerByIndex`, then
filter `positions(id)` by token pair.

### Unclaimed fees

Uniswap's own `feeGrowthInside` arithmetic, which is what their page shows:

```
below = tick >= tl ? lower.feeGrowthOutside : global − lower.feeGrowthOutside
above = tick <  tu ? upper.feeGrowthOutside : global − upper.feeGrowthOutside
inside = global − below − above
owed  = tokensOwed + liquidity · (inside − feeGrowthInsideLast) / 2^128
```

Every subtraction is **mod 2^256** and intended to wrap. Inverting the `above`
branch produced a 10⁴⁶ figure — if you see an absurd number, check that branch
first.

Then map token0/token1 onto cash/risk **with the decimals that go with them**.
Dividing token0 by `1e6` is right only when the cash asset is token0; on the ETH
pool it made unclaimed fees read $187,587,988.

### Claimed fees — the trap

**Uniswap only ever shows what is unclaimed.** Collect twice and its page reads
near zero on a position that has earned for days. To get the real total you must
add back what was collected, from the manager's `Collect` events.

But **a `Collect` hands over everything the position is owed — fees *and*, after
a `decreaseLiquidity`, the principal.** Summing `Collect` alone counts the entire
LP back as fee income the moment a position closes. One position showed $683.07
of "fees" against a true $17.32: a Collect of 7.967281 of the risk asset matched
by a DecreaseLiquidity of exactly 7.967281.

```
claimed fees = Σ Collect − Σ DecreaseLiquidity
```

Read them as two separate single-topic queries (see the 100k cap above).

Verified: replaying the swaps between two Collects gave 2.623840 USDG +
0.036312 CRCL against 2.620708 + 0.036285 actually collected — **0.12%**.

### Prefer the chain over your own replay

Once a real position is paired, use its claimed + unclaimed as *the* fee figure
for that position rather than a reconstruction. A replay here sat ~20% below the
chain for days. Fall back to the replay only while the chain read is incomplete,
and do not show a part-counted total as if it were final.

---

## 8. Traps, in the order they will bite

1. **Declaration order.** A config table referenced by `DEFAULTS` must be
   declared above it. `let`/`const` hoist into a temporal dead zone, so the whole
   script throws on load and every field renders blank. This happened twice.
2. **A saved blank beats a default.** `Object.assign({}, DEFAULTS, saved)` lets
   a stored `""` override a new default. A defaulted wallet address did nothing
   for existing installs and hid a whole tab. Treat empty saved strings as unset.
3. **Per-market fallbacks.** Pre-live placeholder numbers shared between markets
   made an ETH estimate 13× low, because it used CRCL's $3.26M daily volume
   against ETH's $44.2M.
4. **Visibility gating.** Pausing readers on a hidden tab is correct for rate
   limits, but anything that depends on a value those readers set will silently
   never run. Give cheap, bounded reads their own path.
5. **Scan direction.** A cache that only extends backwards never sees new
   events. Extend forwards from the highest block read *first*, then backwards
   for history.
6. **Tick snapping.** Typed edges must snap to `tickSpacing`, and the UI should
   show the snapped value. 75–95 became 74.90–95.22.
7. **Template placeholders in plain strings.** A bulk edit that writes
   `${SYM}` into a `"…"` string prints the placeholder literally. Eleven of
   those shipped here in one pass.
8. **Don't annualise a good afternoon.** A 3.6-hour window read 281% APR where
   12h, 24h and 72h all agreed on ~165%.

---

## 9. Strategy findings

Measured, not assumed. Carry them over, but re-measure for a new venue — the
taker fee changes the first one outright.

**Exit buffers are not symmetric, and the band above the edge is a pure cost.**
Above the top edge the LP is all cash and the short is naked. A band there means
buying the short back at `pb·(1+b)` and re-selling at `pb` — a guaranteed loss of
`short × pb × b` per round trip, against a saving of only two taker fees. On
`xyz:CRCL` that breaks even at a band of **0.018%**; on the main dex, 0.09%.
Anything wider is a loss.

6,000-path Monte Carlo at measured volatility, 7 days, ±2.7%, fees included:

| upper buffer | mean | worst 5% |
|---|---|---|
| **0%** | **+$11.80** | −$13.83 |
| 0.5% | +$10.38 | −$13.95 |
| 2% | +$8.89 | −$14.24 |

Tails barely move, so tightening is not paid for with risk.

**Below the edge is a different trade**, because leaving costs the swap fee plus
slippage — about 30× a perp round trip — and is not cheaply reversible. Real-swap
backtest, 48 start points: upper 0% with lower 1% was best at 60% of starts in
profit, mean +$3.45. Lower 0% gets stopped out by noise sitting on the edge;
wider than 1% bleeds before it cuts.

**No buffer setting secures a profit.** The best pair was in profit at 60% of
three-day starts and about a coin flip over one day. What moved the odds was
holding time in a narrow range — though a 7-day sample holds only ~2 independent
5-day windows, so treat that as a direction, not a probability.

**An unwind ladder was tested and rejected.** Reducing the short in 8 steps as
the LP sells its risk asset beat closing once at the edge by $0.57 a week, for
55 trades instead of 6.

---

## 10. Porting checklist

The desk is one HTML file: inline `<style>`, static markup, then one IIFE. To
merge it into another project:

1. **Decide the integration.** It has no dependencies and no build step, so the
   cheapest path is to keep it as one file and link to it. If it must become a
   component, the natural seams are: the market config, the RPC layer
   (`rpc`/`rpcBatch`/`logsOnce`), the model (`model(inputs) → m`), and the
   renderers (which only read `m` and `LIVE`).
2. **`model()` is pure.** It takes a plain inputs object and returns everything
   derived. That is the piece worth reusing; the rendering is replaceable.
3. **Storage keys** are namespaced per market; keep that, and keep one market on
   the unsuffixed keys if an install already has data.
4. **Nothing is secret.** No keys, no wallet connection, no signing. It reads
   public state and writes nothing on chain. Keep it that way — the moment it
   can sign, it needs a completely different safety review.

### Verification checklist

Re-run these after any port. Each one has caught a real bug here:

- [ ] `V'(P) == x(P)` numerically, both orientations
- [ ] deposit split reproduces a real `Mint`'s amounts (6 mints matched to 0.0000%)
- [ ] a swap replay between two `Collect`s matches what was collected (0.12%)
- [ ] claimed + unclaimed matches an independent read of the same position
- [ ] closing a position does not inflate claimed fees by the principal
- [ ] negative ticks decode to sane prices
- [ ] the fee rate is lower for a narrow range than pool-wide
- [ ] switching market leaves the other market's saved data untouched
- [ ] no `${` appears in rendered output
- [ ] a fresh install shows no blank fields (declaration order)
```
