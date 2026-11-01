/* strategy-core.mjs: the Strategy page's maths. No network and no imports, so the page,
   /api/strategy and the offline tests all run exactly the same functions.

   How a staked Katana LP earns KAT, as measured on 1 Nov 2026:
   - Katana's clock runs 14-day epochs aligned to Unix time (epoch n starts at n × 14 days).
     The first week is the gauge vote; when it closes, each voted pool's Merkl campaign pays
     its KAT over the next 14 days.
   - Every live staking campaign scores positions 100% by trading fees earned in range
     (weightFees 10000, out-of-range not incentivised). At any moment that is each in-range
     position's share of the eligible in-range liquidity: positions held by the Sushi staker
     and by the campaign's whitelisted vaults.
   - Checked against #492808: predicted 2,535 KAT/day from its liquidity share, against
     ~2,588 KAT/day it actually earned over 38 hours. */

export const SECONDS_PER_DAY = 86400;
const MAX_TICK = 887272;

/* The page quotes each pair in its cheaper token, a stablecoin where there is one, so a
   price reads "vbUSDC per vbWBTC" rather than "vbWBTC per vbUSDC". base is 0 or 1; the
   API fixes it as baseIndex, so it never flips when two prices sit close together. */
export function orientation(pool) {
  if (pool.baseIndex === 0 || pool.baseIndex === 1) return { base: pool.baseIndex, quote: 1 - pool.baseIndex };
  const u0 = Number(pool.token0.usd) || 0, u1 = Number(pool.token1.usd) || 0;
  const base = u0 >= u1 ? 0 : 1;
  return { base, quote: 1 - base };
}

/* whole token1 per whole token0 at a tick */
export const token1PerToken0 = (tick, d0, d1) => Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);

/* the pair's price as the page quotes it: quote tokens per base token */
export function priceAtTick(tick, pool) {
  const p = token1PerToken0(tick, pool.token0.decimals, pool.token1.decimals);
  return orientation(pool).base === 0 ? p : 1 / p;
}

/* the exact (unrounded) tick of a quoted price */
export function tickAtPrice(price, pool) {
  const p10 = orientation(pool).base === 0 ? price : 1 / price;
  return Math.log(p10 / Math.pow(10, pool.token0.decimals - pool.token1.decimals)) / Math.log(1.0001);
}

/* A typed range rounded the way Sushi rounds it: each edge to the nearest usable tick, at
   least one tick spacing wide. Returns the ticks and the prices they really stand for. */
export function snapRange(lowerPrice, upperPrice, pool) {
  if (!(lowerPrice > 0) || !(upperPrice > 0) || !(upperPrice > lowerPrice)) return { error: 'Enter a lower price below the upper price.' };
  const s = pool.tickSpacing, edge = Math.floor(MAX_TICK / s) * s;
  const a = tickAtPrice(lowerPrice, pool), b = tickAtPrice(upperPrice, pool);
  let lo = Math.round(Math.min(a, b) / s) * s, hi = Math.round(Math.max(a, b) / s) * s;
  lo = Math.max(-edge, Math.min(edge - s, lo));
  hi = Math.min(edge, Math.max(lo + s, hi));
  const pa = priceAtTick(lo, pool), pb = priceAtTick(hi, pool);
  return { tickLower: lo, tickUpper: hi, lowerPrice: Math.min(pa, pb), upperPrice: Math.max(pa, pb) };
}

/* Whole tokens one unit of liquidity holds in [tickLower, tickUpper) at the pool's price.
   sqrtPrice is sqrtPriceX96 / 2^96: the square root of raw token1 per raw token0. */
export function amountsPerLiquidity(tickLower, tickUpper, sqrtPrice, d0, d1) {
  const sa = Math.pow(1.0001, tickLower / 2), sb = Math.pow(1.0001, tickUpper / 2);
  const s = Math.min(Math.max(sqrtPrice, sa), sb);
  return { amount0: (sb - s) / (s * sb) / Math.pow(10, d0), amount1: (s - sa) / Math.pow(10, d1) };
}

/* the liquidity a dollar amount buys in a range today, and the deposit it takes */
export function liquidityForCapital(capitalUsd, tickLower, tickUpper, pool) {
  const per = amountsPerLiquidity(tickLower, tickUpper, pool.sqrtPrice, pool.token0.decimals, pool.token1.decimals);
  const usdPerL = per.amount0 * pool.token0.usd + per.amount1 * pool.token1.usd;
  if (!(capitalUsd > 0) || !(usdPerL > 0) || !Number.isFinite(usdPerL)) return null;
  const liquidity = capitalUsd / usdPerL;
  return { liquidity, amount0: liquidity * per.amount0, amount1: liquidity * per.amount1 };
}

/* The epoch that funded a campaign, and its voting week. Katana's clock counts epochs from
   Unix time zero, so the number follows from any timestamp inside it. */
export function epochOf(ts, clock) {
  const number = Math.floor(ts / clock.duration), start = number * clock.duration;
  return {
    number, start, end: start + clock.duration,
    voteStart: start + clock.voteBuffer, voteEnd: start + clock.voteDuration - clock.voteBuffer,
  };
}

/* Merkl's score weights as fractions: fees, token0 held, token1 held */
export function scoreWeights(rules) {
  const f = Number(rules.weightFees) || 0, t0 = Number(rules.weightToken0) || 0, t1 = Number(rules.weightToken1) || 0;
  const sum = f + t0 + t1;
  return sum > 0 ? { fees: f / sum, token0: t0 / sum, token1: t1 / sum } : { fees: 1, token0: 0, token1: 0 };
}

const share = (mine, others) => (mine > 0 ? mine / (Math.max(0, others) + mine) : 0);

/* What a new staked position would earn, if price stays in its range and everyone else's
   liquidity stays as it is now. Adding it dilutes the pool, so it counts in the total.
     pool    one row of /api/strategy's pools
     input   { capitalUsd, lowerPrice, upperPrice, startTs }
     ctx     { now, katUsd, rewardStart, rewardEnd } */
export function estimateReward(pool, input, ctx) {
  if (!(input.capitalUsd > 0)) return { error: 'Enter the capital in dollars.' };
  const range = snapRange(input.lowerPrice, input.upperPrice, pool);
  if (range.error) return range;
  const pos = liquidityForCapital(input.capitalUsd, range.tickLower, range.tickUpper, pool);
  if (!pos) return { error: 'This range cannot be valued at the current price.', range };
  const inRange = pool.tick >= range.tickLower && pool.tick < range.tickUpper;
  const earns = inRange || !!pool.rules.outOfRange;
  const w = scoreWeights(pool.rules);
  const myShare = earns ? w.fees * share(pos.liquidity, pool.eligible.liquidity)
    + w.token0 * share(pos.amount0, pool.eligible.amount0)
    + w.token1 * share(pos.amount1, pool.eligible.amount1) : 0;
  const katPerDay = pool.katPerDay * myShare;
  const usdPerDay = Number.isFinite(ctx.katUsd) ? katPerDay * ctx.katUsd : null;
  /* nothing is earned before now, nor after the campaign ends */
  const from = Math.min(Math.max(Number(input.startTs) || ctx.now, ctx.now, ctx.rewardStart), ctx.rewardEnd);
  const days = Math.max(0, ctx.rewardEnd - from) / SECONDS_PER_DAY;
  return {
    range, inRange, earns, deposit: { amount0: pos.amount0, amount1: pos.amount1 }, liquidity: pos.liquidity,
    share: myShare, katPerDay, usdPerDay, from, days,
    totalKat: katPerDay * days, totalUsd: usdPerDay === null ? null : usdPerDay * days,
    apr: usdPerDay === null ? null : usdPerDay * 365 / input.capitalUsd,
  };
}

/* the pools ordered as the page lists them: highest reward APR first */
export const byApr = (pools) => [...pools].sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1) || b.katPerDay - a.katPerDay);

/* ---------- recent ranges: the lowest and highest price a pool traded at ----------
   Every swap logs the tick it left the pool at, so the lowest and highest swap tick over a
   window is the range the price actually travelled. The six-hourly job keeps one row per
   hour per pool, [hour start, low tick, high tick, swaps, closing tick], for RANGE_KEEP_DAYS;
   the API adds the swaps since the job's last run and the price now. */
export const HOUR = 3600;
export const RANGE_DAYS = [7, 14, 21, 30];
export const RANGE_KEEP_DAYS = 31;

/* fold swaps ({ ts, tick }, in chain order) into the hourly rows; returns new rows, oldest first */
export function mergeSwapHours(hours, swaps) {
  const map = new Map((hours || []).map((h) => [h[0], [...h]]));
  for (const s of swaps) {
    if (!Number.isFinite(s.ts) || !Number.isInteger(s.tick)) continue;
    const at = Math.floor(s.ts / HOUR) * HOUR, h = map.get(at);
    if (h) { h[1] = Math.min(h[1], s.tick); h[2] = Math.max(h[2], s.tick); h[3] += 1; h[4] = s.tick; }
    else map.set(at, [at, s.tick, s.tick, 1, s.tick]);
  }
  return [...map.values()].sort((a, b) => a[0] - b[0]);
}

export const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
/* a swap log's time and the tick it left the pool at (the event's fifth data word) */
export function swapFromLog(log) {
  if (!log.blockTimestamp || log.blockTimestamp === '0x0') throw new Error('A swap log came without its block time');
  const v = BigInt('0x' + log.data.slice(2 + 4 * 64, 2 + 5 * 64));
  return { ts: Number(BigInt(log.blockTimestamp)), tick: Number(v >= 2n ** 255n ? v - 2n ** 256n : v) };
}

/* drop hours that ended before the cutoff */
export const pruneHours = (hours, cutoffTs) => hours.filter((h) => h[0] + HOUR > cutoffTs);

/* The low and high tick over the last N days: every swap in the window, the price the
   window opened at (the close of the last hour before it) and the price now. A window counts
   as complete only when the recorded hours reach back to its start. */
export function recentRanges(hours, now, currentTick, days = RANGE_DAYS, recordedFrom = null) {
  const first = recordedFrom ?? (hours.length ? hours[0][0] : now);
  const out = {};
  for (const d of days) {
    const from = now - d * 86400;
    let lo = Infinity, hi = -Infinity, swaps = 0, opening = null;
    const take = (t) => { if (Number.isInteger(t)) { lo = Math.min(lo, t); hi = Math.max(hi, t); } };
    for (const h of hours) {
      if (h[0] + HOUR <= from) opening = h[4];
      else if (h[0] <= now) { take(h[1]); take(h[2]); swaps += h[3]; }
    }
    take(opening); take(currentTick);
    out[d] = Number.isFinite(lo) ? { lowTick: lo, highTick: hi, swaps, complete: first <= from } : null;
  }
  return out;
}

/* a tick range as the page quotes the pool: its low and high price */
export function rangePrices(r, pool) {
  const a = priceAtTick(r.lowTick, pool), b = priceAtTick(r.highTick, pool);
  return { low: Math.min(a, b), high: Math.max(a, b) };
}
