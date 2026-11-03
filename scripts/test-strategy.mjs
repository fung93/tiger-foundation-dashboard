/* The Strategy page's maths, offline: the same strategy-core.mjs functions the page and
   /api/strategy run, against figures measured on chain on 1 Nov 2026. No network. */
import assert from 'node:assert/strict';
import { orientation, priceAtTick, tickAtPrice, snapRange, amountsPerLiquidity, liquidityForCapital,
  epochOf, scoreWeights, estimateReward, byApr, SECONDS_PER_DAY } from '../strategy-core.mjs';

let checks = 0;
const ok = (cond, note) => { assert.ok(cond, note); checks++; };
const near = (a, b, tol, note) => { assert.ok(Math.abs(a - b) <= tol, `${note}: ${a} vs ${b}`); checks++; };
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };

/* vbWBTC/vbUSDC 0.05% as /api/strategy read it on 1 Nov 2026: vbWBTC is token0 */
const tick = 66581;
const btc = {
  pool: '0x744676b3ced942d78f9b8e9cd22246db5c32395c', baseIndex: 0, tickSpacing: 10, tick, sqrtPrice: Math.pow(1.0001, tick / 2),
  token0: { symbol: 'vbWBTC', decimals: 8, usd: 77865.43 }, token1: { symbol: 'vbUSDC', decimals: 6, usd: 1 },
  katPerDay: 16559.6, apr: 0.5495, eligible: { liquidity: 8255423900, amount0: 0, amount1: 0 },
  rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
};
/* vbUSDC/vbETH 0.05%: vbUSDC is token0, so the page quotes it the other way up */
const eth = {
  pool: '0x2a2c512beaa8eb15495726c235472d82effb7a6b', baseIndex: 1, tickSpacing: 10, tick: 199052, sqrtPrice: Math.pow(1.0001, 199052 / 2),
  token0: { symbol: 'vbUSDC', decimals: 6, usd: 1 }, token1: { symbol: 'vbETH', decimals: 18, usd: 2267.24 },
  katPerDay: 7855.5, apr: 0.0474, eligible: { liquidity: 2.7431e16, amount0: 0, amount1: 0 },
  rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
};

/* quoting: vbUSDC per vbWBTC, vbUSDC per vbETH, and back again */
eq(orientation(btc), { base: 0, quote: 1 }, 'WBTC is the base');
eq(orientation(eth), { base: 1, quote: 0 }, 'ETH is the base though it is token1');
near(priceAtTick(tick, btc), 77882.3, 25, 'BTC price at the pool tick reads in dollars');
near(priceAtTick(199052, eth), 2268, 3, 'ETH price at the pool tick reads in dollars, not ETH per dollar');
for (const t of [-887000, -198600, 0, 66240, 66760, 199052]) {
  near(tickAtPrice(priceAtTick(t, btc), btc), t, 1e-6, 'tick → price → tick, token0 base ' + t);
  near(tickAtPrice(priceAtTick(t, eth), eth), t, 1e-6, 'tick → price → tick, token1 base ' + t);
}
eq(orientation({ ...btc, baseIndex: undefined, token0: { ...btc.token0, usd: 1 }, token1: { ...btc.token1, usd: 2 } }).base, 1,
  'without a fixed base the dearer token is the base');

/* rounding a typed range the way Sushi does: #492808's $75,270–$79,288 is ticks 66240–66760 */
const r = snapRange(75270, 79288, btc);
eq([r.tickLower, r.tickUpper], [66240, 66760], 'the real position\'s typed range snaps to its real ticks');
ok(r.lowerPrice < r.upperPrice, 'snapped prices stay in order');
const re = snapRange(2200, 2350, eth);
ok(re.tickLower < re.tickUpper && re.lowerPrice < re.upperPrice, 'an inverted pair still gives lower < upper');
near(re.lowerPrice, 2200, 2200 * 0.0006, 'inverted lower edge lands within one tick step');
eq(snapRange(80000, 70000, btc).error, 'Enter a lower price below the upper price.', 'a reversed range is refused');
eq(snapRange(0, 70000, btc).error, 'Enter a lower price below the upper price.', 'a zero price is refused');
const thin = snapRange(77880, 77881, btc);
eq(thin.tickUpper - thin.tickLower, 10, 'a range thinner than a step widens to one step');

/* deposits: in range takes both tokens, above the price only the base, below only the quote */
const inR = amountsPerLiquidity(66240, 66760, btc.sqrtPrice, 8, 6);
ok(inR.amount0 > 0 && inR.amount1 > 0, 'in range holds both tokens');
const above = amountsPerLiquidity(67000, 67500, btc.sqrtPrice, 8, 6);
ok(above.amount0 > 0 && above.amount1 === 0, 'a range above the price holds only token0');
const below = amountsPerLiquidity(65000, 66000, btc.sqrtPrice, 8, 6);
ok(below.amount0 === 0 && below.amount1 > 0, 'a range below the price holds only token1');
const pos = liquidityForCapital(910.51, 66240, 66760, btc);
near(pos.amount0 * btc.token0.usd + pos.amount1 * btc.token1.usd, 910.51, 1e-6, 'the deposit is worth exactly the capital');
near(pos.liquidity, 1.26386e9, 1.26386e9 * 0.002, '$910.51 in #492808\'s range buys its real liquidity (1.26386e9)');
eq(liquidityForCapital(0, 66240, 66760, btc), null, 'no capital, no position');

/* the epoch: Katana counts 14-day epochs from Unix zero, and votes close 1 h before week one ends */
const clock = { duration: 1209600, voteDuration: 604800, voteBuffer: 3600 };
const ep = epochOf(1793228401, clock);   /* the campaigns' start, 28 Oct 23:00:01 UTC */
eq(ep.number, 1482, 'the running campaigns were funded by epoch 1482');
eq(ep.start, 1792627200, 'epoch 1482 starts 22 Oct 00:00 UTC');
eq(ep.end, 1793836800, 'and ends 5 Nov 00:00 UTC');
eq(ep.voteEnd, 1793228400, 'its vote closed one second before the campaigns began');
eq(epochOf(1793836800, clock).number, 1483, 'the next epoch begins at the boundary');

eq(scoreWeights({ weightFees: 10000, weightToken0: 0, weightToken1: 0 }), { fees: 1, token0: 0, token1: 0 }, 'fees only');
eq(scoreWeights({ weightFees: 4000, weightToken0: 3000, weightToken1: 3000 }), { fees: 0.4, token0: 0.3, token1: 0.3 }, 'mixed weights normalise');
eq(scoreWeights({}), { fees: 1, token0: 0, token1: 0 }, 'missing weights fall back to fees');

/* the estimate */
const now = 1793516273, end = 1794438000, start = 1793228401;
const ctx = { now, katUsd: 0.004014, rewardStart: start, rewardEnd: end };
const e = estimateReward(btc, { capitalUsd: 910.51, lowerPrice: 75270, upperPrice: 79288, startTs: now }, ctx);
near(e.share, e.liquidity / (8255423900 + e.liquidity), 1e-12, 'share is my liquidity over eligible-plus-mine');
near(e.katPerDay, 16559.6 * e.share, 1e-9, 'KAT a day is the pool\'s rate times my share');
near(e.katPerDay, 2199, 3, 'a new #492808-sized position: ~2,199 KAT a day (the page read the same)');
near(e.usdPerDay, e.katPerDay * 0.004014, 1e-9, 'value a day at the KAT price');
near(e.days, (end - now) / SECONDS_PER_DAY, 1e-9, 'from now to the period end');
near(e.totalKat, e.katPerDay * e.days, 1e-9, 'the total is the rate over the days left');
near(e.apr, e.usdPerDay * 365 / 910.51, 1e-12, 'APR on the capital');
/* checked against the real position, which is already inside the eligible total */
near(16559.6 * 1263859165 / 8255423900, 2535, 1, 'its own share predicts ~2,535 KAT a day (earned ~2,588)');

const later = estimateReward(btc, { capitalUsd: 910.51, lowerPrice: 75270, upperPrice: 79288, startTs: 1793808000 }, ctx);
near(later.days, (end - 1793808000) / SECONDS_PER_DAY, 1e-9, 'a later start day counts from that day');
const past = estimateReward(btc, { capitalUsd: 910.51, lowerPrice: 75270, upperPrice: 79288, startTs: now - 5 * 86400 }, ctx);
near(past.days, (end - now) / SECONDS_PER_DAY, 1e-9, 'a past start day counts from now, never backwards');
const afterEnd = estimateReward(btc, { capitalUsd: 910.51, lowerPrice: 75270, upperPrice: 79288, startTs: end + 86400 }, ctx);
eq([afterEnd.days, afterEnd.totalKat], [0, 0], 'after the period ends there is nothing left to earn');

const out = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 80000, upperPrice: 82000, startTs: now }, ctx);
eq([out.inRange, out.share, out.katPerDay, out.totalKat], [false, 0, 0, 0], 'out of range earns nothing');
const outPaid = estimateReward({ ...btc, rules: { ...btc.rules, outOfRange: true } }, { capitalUsd: 1000, lowerPrice: 80000, upperPrice: 82000, startTs: now }, ctx);
ok(outPaid.share > 0, 'a campaign that pays out of range still pays');

const narrow = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 77000, upperPrice: 78800, startTs: now }, ctx);
const wide = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 70000, upperPrice: 86000, startTs: now }, ctx);
ok(narrow.katPerDay > wide.katPerDay * 3, 'a narrower range earns more per dollar while in range');
const more = estimateReward(btc, { capitalUsd: 100000, lowerPrice: 75270, upperPrice: 79288, startTs: now }, ctx);
ok(more.share < 1 && more.katPerDay < 16559.6, 'even a large position cannot take more than the pool pays');
ok(more.katPerDay / 100000 < e.katPerDay / 910.51, 'a large position dilutes itself');

/* a campaign that also scores tokens held */
const mixed = { ...btc, rules: { weightFees: 5000, weightToken0: 2500, weightToken1: 2500 }, eligible: { liquidity: 8255423900, amount0: 0.5, amount1: 40000 } };
const em = estimateReward(mixed, { capitalUsd: 910.51, lowerPrice: 75270, upperPrice: 79288, startTs: now }, ctx);
near(em.share, 0.5 * e.share + 0.25 * (em.deposit.amount0 / (0.5 + em.deposit.amount0)) + 0.25 * (em.deposit.amount1 / (40000 + em.deposit.amount1)), 1e-12, 'token-weighted campaigns mix the three shares');

eq(estimateReward(btc, { capitalUsd: 0, lowerPrice: 75270, upperPrice: 79288 }, ctx).error, 'Enter the capital in dollars.', 'no capital is refused');
eq(estimateReward(btc, { capitalUsd: 1000, lowerPrice: 79288, upperPrice: 75270 }, ctx).error, 'Enter a lower price below the upper price.', 'a reversed range is refused');
eq(estimateReward(eth, { capitalUsd: 1000, lowerPrice: 2210, upperPrice: 2325, startTs: now }, ctx).inRange, true, 'the inverted ETH pool finds its range around the price');
eq(estimateReward({ ...btc, katPerDay: 16559.6 }, { capitalUsd: 1000, lowerPrice: 75270, upperPrice: 79288, startTs: now }, { ...ctx, katUsd: null }).usdPerDay, null, 'without a KAT price the value is unknown, not zero');

/* the listing: highest APR first, missing APR last */
eq(byApr([{ apr: 0.0456, katPerDay: 1 }, { apr: 0.5495, katPerDay: 1 }, { apr: null, katPerDay: 9 }, { apr: 0.2695, katPerDay: 1 }]).map((p) => p.apr),
  [0.5495, 0.2695, 0.0456, null], 'pools sort by APR, highest first');

/* ---------- recent ranges ---------- */
const { mergeSwapHours, pruneHours, recentRanges, rangePrices, swapFromLog, HOUR } = await import('../strategy-core.mjs');
const { advanceRanges, validateRanges, formatRanges, emptyRanges } = await import('./strategy-ranges.mjs');
const H = 1793516400 - (1793516400 % HOUR);   /* an hour boundary on 1 Nov 2026 */

const rows = mergeSwapHours([], [{ ts: H + 10, tick: 100 }, { ts: H + 20, tick: 90 }, { ts: H + 30, tick: 95 }, { ts: H + HOUR + 5, tick: 120 }]);
eq(rows, [[H, 90, 100, 3, 95], [H + HOUR, 120, 120, 1, 120]], 'swaps fold into hourly low, high, count and close');
eq(mergeSwapHours(rows, [{ ts: H + 40, tick: 80 }]), [[H, 80, 100, 4, 80], [H + HOUR, 120, 120, 1, 120]], 'a later swap in the same hour extends it and sets its close');
eq(mergeSwapHours(rows, [{ ts: NaN, tick: 1 }, { ts: H, tick: 1.5 }]), rows, 'malformed swaps are ignored');
eq(pruneHours(rows, H + HOUR), [[H + HOUR, 120, 120, 1, 120]], 'hours that ended before the cutoff go');

/* a window opens at the price left by the last hour before it, and ends at the price now */
const day = 86400, nowH = H + 10 * day;
const hist = [[H, 50, 60, 2, 55], [H + 2 * day, 70, 75, 3, 72], [H + 9 * day, 65, 68, 4, 66]];
const rr = recentRanges(hist, nowH, 67, [7, 14], H);
eq([rr[7].lowTick, rr[7].highTick, rr[7].swaps], [65, 72, 4], '7D: its swaps plus the opening price (the close before it)');
eq([rr[14].lowTick, rr[14].highTick, rr[14].swaps], [50, 75, 9], '14D: every row inside it');
eq([rr[7].complete, rr[14].complete], [true, false], 'a window is complete only when the history reaches its start');
eq(recentRanges([], nowH, 67, [7])[7], { lowTick: 67, highTick: 67, swaps: 0, complete: false }, 'no history: the range is the price now, marked incomplete');
eq(recentRanges([], nowH, null, [7])[7], null, 'no swaps and no price: nothing');
const quiet = recentRanges([[H, 40, 40, 1, 40]], nowH, 41, [7], H);
eq([quiet[7].lowTick, quiet[7].highTick], [40, 41], 'a quiet week still counts the price it opened at');

/* the ranges quoted as the page quotes each pool */
const pb = rangePrices({ lowTick: 66354, highTick: 67050 }, btc);
ok(pb.low < pb.high && Math.abs(pb.low - priceAtTick(66354, btc)) < 1e-6, 'a token0-based pool: low tick is the low price');
const pe = rangePrices({ lowTick: 198543, highTick: 199418 }, eth);
ok(pe.low < pe.high && Math.abs(pe.high - priceAtTick(198543, eth)) < 1e-6, 'an inverted pool: the low tick is the high price');
near(pb.low, 76133.1, 0.2, 'measured 7D low of vbWBTC/vbUSDC, 1 Nov');
near(pe.low, 2186.85, 0.01, 'measured 7D low of vbETH/vbUSDC, 1 Nov');

/* a swap log: time from the log, tick from the fifth data word, negative ticks included */
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const log = (ts, tick) => ({ blockTimestamp: '0x' + ts.toString(16), data: '0x' + [1, -2, 3, 4, tick].map(word).join('') });
eq(swapFromLog(log(H, 66581)), { ts: H, tick: 66581 }, 'a positive tick');
eq(swapFromLog(log(H, -198600)), { ts: H, tick: -198600 }, 'a negative tick decodes from 256 bits');
assert.throws(() => swapFromLog({ blockTimestamp: '0x0', data: log(H, 1).data }), /block time/); checks++;

/* the job: a first run reads 31 days, the next only what is new, and the file round-trips */
const pool = '0x744676b3ced942d78f9b8e9cd22246db5c32395c';
const fake = new Map();   /* block → [ts, tick] */
for (let b = 0; b < 3000000; b += 3600) fake.set(b, [1790000000 + b, 66000 + (b / 3600) % 700]);
const asked = [];
const getLogs = async (p, a, z) => { asked.push([a, z]); return [...fake].filter(([b]) => b >= a && b <= z).map(([, [ts, t]]) => log(ts, t)); };
const head = 2999999, headTs = 1790000000 + head;
const first = await advanceRanges(emptyRanges(), { pools: [pool], head, headTs, blocksPerSecond: 1, getLogs });
const e1 = first.pools[pool];
ok(asked[0][0] < head - 31 * day && asked[0][0] >= head - 31 * day * 1.03, 'a new pool starts about 31 days back');
ok(e1.hours.length >= 740 && e1.hours.length <= 745 && e1.hours[0][0] + HOUR > headTs - 31 * day, 'it keeps 31 days of hours');
eq(e1.last_block, head, 'and remembers how far it read');
validateRanges(first); checks++;
eq(JSON.parse(formatRanges(first)), first, 'the one-hour-a-line file reads back exactly');
asked.length = 0;
const second = await advanceRanges(first, { pools: [pool], head: head + 7200, headTs: headTs + 7200, blocksPerSecond: 1, getLogs: async (p, a, z) => { asked.push([a, z]); return [log(headTs + 3600, 60000)]; } });
eq(asked, [[head + 1, head + 7200]], 'the next run reads only the new blocks');
eq(second.pools[pool].hours.at(-1).slice(1, 4), [60000, 60000, 1], 'and adds what it found');
const gone = await advanceRanges(second, { pools: [], head: head + 40 * day, headTs: headTs + 40 * day, blocksPerSecond: 1, getLogs });
eq(gone.pools[pool], undefined, 'a pool that stopped paying drops out once its rows age out');
assert.throws(() => validateRanges({ ...first, version: 2 }), /not changed/); checks++;
assert.throws(() => validateRanges({ ...first, pools: { [pool]: { ...e1, hours: [[H, 5, 4, 1, 4]] } } }), /bad hour row/); checks++;

/* ---------- P&L at the range edges, as the LP Book's "!" ---------- */
const { edgeOutcome } = await import('../strategy-core.mjs');
const { edgePnl } = await import('../api/_core.mjs');
const mine = edgeOutcome(btc, { tickLower: 66240, tickUpper: 66760 }, 1263859165, 909.61);
const book = edgePnl({ cost_usd: 909.61, out_usd: 0 }, { raw: { liq: '1263859165', lo: 66240, hi: 66760,
  t0: { s: 'vbWBTC', d: 8, stable: false }, t1: { s: 'vbUSDC', d: 6, stable: true } } });
near(mine.lower.pnlUsd, book.lower.pnl_usd, 0.006, '#492808 lower edge: Strategy agrees with the LP Book');
near(mine.upper.pnlUsd, book.upper.pnl_usd, 0.006, '#492808 upper edge: Strategy agrees with the LP Book');
eq([mine.lower.token, mine.upper.token], ['vbWBTC', 'vbUSDC'], 'all base below, all quote above');

/* a fresh deposit is worth its capital today, so its P&L today (0) lies between its edges */
const fresh = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 75270, upperPrice: 79288, startTs: now }, ctx);
const fe = edgeOutcome(btc, fresh.range, fresh.liquidity, 1000);
ok(fe.lower.pnlUsd < 0 && fe.upper.pnlUsd > 0, 'in range: a loss at the lower edge, a gain at the upper');
near(fe.lower.valueUsd, fe.lower.amount * fe.lower.price, 1e-6, 'lower edge value is its base tokens at that price');
near(fe.upper.valueUsd, fe.upper.amount, 1e-9, 'upper edge value is its stablecoins');
const wider = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 70000, upperPrice: 86000, startTs: now }, ctx);
const we = edgeOutcome(btc, wider.range, wider.liquidity, 1000);
ok(we.lower.pnlUsd < fe.lower.pnlUsd && we.upper.pnlUsd > fe.upper.pnlUsd, 'a wider range reaches a bigger gain and a bigger loss');

/* the inverted pool: vbUSDC is token0, prices read vbUSDC per vbETH */
const er = estimateReward(eth, { capitalUsd: 1000, lowerPrice: 2210, upperPrice: 2325, startTs: now }, ctx);
const ee = edgeOutcome(eth, er.range, er.liquidity, 1000);
ok(ee.lower.price < ee.upper.price, 'inverted pool: edges ordered by price');
eq([ee.lower.token, ee.upper.token], ['vbETH', 'vbUSDC'], 'inverted pool: all ETH at the low price, all USDC at the high');
ok(ee.lower.pnlUsd < 0 && ee.upper.pnlUsd > 0, 'inverted pool: loss below, gain above');

/* above today's price the deposit is all base token: reaching the lower edge is a gain */
const up = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 80000, upperPrice: 82000, startTs: now }, ctx);
const ue = edgeOutcome(btc, up.range, up.liquidity, 1000);
ok(ue.lower.pnlUsd > 0 && ue.upper.pnlUsd > ue.lower.pnlUsd, 'a range above the price gains at either edge');
eq(edgeOutcome(btc, { tickLower: 10, tickUpper: 10 }, 1, 1), null, 'an empty range has no edges');
eq(edgeOutcome(btc, fresh.range, 0, 1000), null, 'no liquidity, nothing to show');

/* ---- the hedge on Katana Perps (Alex, 3 Nov 2026) ---- */
{
  const { hedgePlan, fillPrice, liquidationPrice, fundingPayments, rehedgeStep, FUNDING_SECONDS } = await import('../strategy-core.mjs');
  const perps = {
    withdraw_fee: 0.05,
    markets: { 'BTC-USD': { taker: 0.00019, maker: 0.0000475, mmf: 0.01, min: 0.0005, step: 0.0001, index: 77000 },
      'ETH-USD': { taker: 0.00019, maker: 0.0000475, mmf: 0.01, min: 0.01, step: 0.001, index: 2260 } },
    book: { 'BTC-USD': { mark: 77000, bids: [[76999, 0.004], [76990, 1]], asks: [[77001, 1]] },
      'ETH-USD': { mark: 2260, bids: [[2259.9, 10]], asks: [[2260.1, 10]] } },
    funding: { 'BTC-USD': { avg: 0.0001, now: 0.0001 }, 'ETH-USD': { avg: 0.0001, now: 0.0001 } },
  };
  /* the book: a short sells into the bids, level by level */
  near(fillPrice(perps.book['BTC-USD'].bids, 0.0065), (0.004 * 76999 + 0.0025 * 76990) / 0.0065, 1e-9, 'a fill walks the book');
  eq(fillPrice([[1, 1]], 2), null, 'a book too thin gives no price');
  near(liquidationPrice(77000, 0.01), 2 * 77000 / 1.01, 1e-9, 'a 1x short is liquidated near double the price');
  eq(fundingPayments(Date.UTC(2026, 10, 3, 0, 0, 1) / 1000, Date.UTC(2026, 10, 4) / 1000), 3, 'three payments a day, at 00, 08 and 16 UTC');
  eq(fundingPayments(0, FUNDING_SECONDS - 1), 0, 'none before the first');

  /* worked by hand: 0.00648 vbWBTC + 500 vbUSDC, 8.5 days, 25 payments */
  const from = Date.UTC(2026, 10, 3, 1) / 1000, to = from + 8 * 86400 + 7 * 3600;
  const plan = hedgePlan(btc, { amount0: 0.00648, amount1: 500 }, perps, { days: 8.5, from, to, katUsdTotal: 85, capitalUsd: 1000 });
  eq(plan.legs.length, 1, 'one leg: vbUSDC is already dollars');
  const leg = plan.legs[0];
  eq([leg.symbol, +leg.qty.toFixed(4)], ['BTC-USD', 0.0065], 'short the deposit\'s vbWBTC as BTC, rounded to the 0.0001 step');
  near(leg.notional, 0.0065 * 77000, 1e-9, 'at the mark');
  near(leg.margin, leg.notional, 1e-12, 'margin at 1x is the short\'s value');
  near(leg.open_fee + leg.close_fee, 2 * 0.00019 * 500.5, 1e-9, 'taker fee in and out');
  const sellAvg = (0.004 * 76999 + 0.0025 * 76990) / 0.0065;
  near(leg.book_cost, 0.0065 * (77000 - sellAvg) + 0.0065 * (77001 - 77000), 1e-9, 'what the book costs in and out');
  eq(leg.funding_periods, 25, 'the funding payments to the period\'s end');
  near(leg.funding, 500.5 * 0.0001 * 25, 1e-9, 'funding: the short is paid on its value each time');
  near(plan.net, leg.funding - (leg.open_fee + leg.close_fee + leg.book_cost + 0.05), 1e-12, 'net: funding less every fee');
  near(plan.total, 85 + plan.net, 1e-12, 'hedged total: KAT plus the hedge');
  near(plan.capital, 1000 + 500.5, 1e-9, 'capital: LP plus margin');
  near(plan.apr, plan.total / plan.capital * 365 / 8.5, 1e-12, 'hedged APR on all of it');

  /* the edges: the short offsets the LP; on a narrow range both edges still lose */
  const est = estimateReward(btc, { capitalUsd: 1000, lowerPrice: 76000, upperPrice: 79800, startTs: now }, ctx);
  const edges = edgeOutcome(btc, est.range, est.liquidity, 1000);
  const hedged = hedgePlan(btc, est.deposit, perps, { days: est.days, katUsdTotal: est.totalUsd, capitalUsd: 1000, edges });
  const h = hedged.legs[0];
  near(hedged.edges.upper.short, h.qty * (h.mark - edges.upper.price), 1e-9, 'upper edge: the short loses what BTC gained');
  near(hedged.edges.lower.net, edges.lower.pnlUsd + h.qty * (h.mark - edges.lower.price), 1e-9, 'lower edge: LP plus short');
  ok(hedged.edges.lower.lp < hedged.edges.lower.net, 'the short cushions the fall');
  /* past the edges: below, all the vbWBTC less the short; above, the short alone */
  near(hedged.edges.lower.beyond_per_pct, -(edges.lower.amount - h.qty) * edges.lower.price * 0.01, 1e-9, 'each further 1% down loses the net long');
  near(hedged.edges.upper.beyond_per_pct, -h.qty * edges.upper.price * 0.01, 1e-9, 'each further 1% up loses on the short');
  ok(hedged.edges.lower.beyond_per_pct < 0 && hedged.edges.upper.beyond_per_pct < 0, 'past either edge the hedged position loses');
  /* the profit the page shows: the income plus the price result */
  const income = hedged.total;
  ok(income + hedged.edges.upper.net > 0 && income + hedged.edges.lower.net > 0, 'with the KAT of the whole period, both edges still end in profit');

  /* vbETH is the base of a pool whose token0 is vbUSDC: the edge prices are already dollars per ETH */
  const ethEst = estimateReward(eth, { capitalUsd: 1000, lowerPrice: 2200, upperPrice: 2330, startTs: now }, ctx);
  const ethPlan = hedgePlan(eth, ethEst.deposit, perps, { days: ethEst.days, katUsdTotal: ethEst.totalUsd, capitalUsd: 1000, edges: edgeOutcome(eth, ethEst.range, ethEst.liquidity, 1000) });
  eq(ethPlan.legs.map((l) => l.symbol), ['ETH-USD'], 'vbETH hedges on ETH-USD');
  near(ethPlan.edges.upper.token_usd, ethPlan.edges.upper.price, 1e-9, 'ETH\'s edge price is its dollar price');

  /* two volatile tokens: a short on each */
  const pair = { ...btc, token1: { symbol: 'vbETH', decimals: 18, usd: 2260 } };
  eq(hedgePlan(pair, { amount0: 0.0064, amount1: 0.222 }, perps, { days: 8, capitalUsd: 1000 }).legs.map((l) => [l.symbol, +l.qty.toFixed(4)]),
    [['BTC-USD', 0.0064], ['ETH-USD', 0.222]], 'vbWBTC/vbETH shorts both');
  eq(hedgePlan({ ...btc, token0: { symbol: 'vbUSDT', decimals: 6, usd: 1 } }, { amount0: 500, amount1: 500 }, perps, { days: 8, capitalUsd: 1000 }).nothing, true, 'two dollars: nothing to hedge');
  eq(hedgePlan({ ...btc, token0: { symbol: 'LBTC', decimals: 8, usd: 77000 } }, { amount0: 0.006, amount1: 500 }, perps, { days: 8, capitalUsd: 1000 }).missing, ['LBTC'], 'no market, said so');
  eq(hedgePlan(btc, { amount0: 0.0002, amount1: 10 }, perps, { days: 8, capitalUsd: 30 }).legs[0].below_min, true, 'below the smallest position, said so');
  eq(hedgePlan(btc, est.deposit, null, { days: 8, capitalUsd: 1000 }).missing, ['vbWBTC'], 'no perps data: nothing to hedge on');

  /* the hedge drifts: a 1% move shifts the narrow LP's vbWBTC */
  const step = rehedgeStep(btc, est.range, est.liquidity, 'vbWBTC', 0.00019, 77000);
  ok(step.qty > 0 && step.qty < est.deposit.amount0, 'a 1% move shifts part of the vbWBTC');
  near(step.fee, step.qty * 77000 * 0.00019, 1e-12, 'and re-hedging it costs the taker fee');
}

/* ---- pools without KAT: trading fees from fee growth (Alex, 3 Nov 2026) ----
   KAT/vbUSDC 0.05% as read on chain on 3 Nov 2026: vbUSDC is token0, KAT token1, quoted in
   vbUSDC per KAT; feeProtocol 34 (Sushi keeps half). Its fee growth rose by these amounts
   per unit of liquidity over the 7 days to block 46,965,816. */
{
  const { feesFromGrowth, estimateFees, edgeOutcome, hedgePlan } = await import('../strategy-core.mjs');
  const katTick = 331923, katUsd = 0.0038502;
  const kp = {
    kind: 'fees', pool: '0x10045367e619caae6f60cc80046c43c6cd55f629', baseIndex: 1, tickSpacing: 10, tick: katTick, sqrtPrice: Math.pow(1.0001, katTick / 2),
    activeLiquidity: 683400718117695200, fee_tier: 0.0005,
    token0: { symbol: 'vbUSDC', decimals: 6, usd: 1 }, token1: { symbol: 'KAT', decimals: 18, usd: katUsd },
    rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
  };
  eq(orientation(kp), { base: 1, quote: 0 }, 'KAT is the base though it is token1');
  near(priceAtTick(katTick, kp), katUsd, 2e-6, 'so the price reads in vbUSDC per KAT, KAT\'s dollar price');
  const before = [10n ** 30n, 10n ** 44n], grew = [4.5789936263165424e-11, 10839.977722277612].map((g) => BigInt(g * 2 ** 128));
  const f = feesFromGrowth({ before, after: [before[0] + grew[0], before[1] + grew[1]], seconds: 7 * 86400, fee: 500, feeProtocol: 34, pool: kp });
  eq([f.lp_part0, f.lp_part1], [0.5, 0.5], 'feeProtocol 34: Sushi keeps half on each side');
  near(f.pool_day0, 31.292875 / 7, 1e-4, "the pool's vbUSDC fees a day, at today's liquidity");
  near(f.pool_day1, 7408.0486 / 7, 1e-2, 'and its KAT fees');
  near(f.usd_per_day, 8.5445, 0.001, 'about $8.54 a day to LPs, as measured');
  near(f.volume_usd_per_day, f.usd_per_day / (0.0005 * 0.5), 1e-6, 'volume: the LP fees over the half of 0.05% they keep');
  near(f.per_l_day1 * kp.activeLiquidity, f.pool_day1, 1e-9, 'per unit of liquidity, times the liquidity, is the pool');
  const wrapped = feesFromGrowth({ before: [2n ** 256n - 5n, 0n], after: [10n, 0n], seconds: 86400, fee: 500, feeProtocol: 0, pool: { ...kp, activeLiquidity: 1 } });
  near(wrapped.pool_day0, 15 / 2 ** 128 / 1e6, 1e-60, 'a fee growth that wrapped past 2^256 still counts its rise');
  eq([wrapped.lp_part0, wrapped.lp_part1], [1, 1], 'feeProtocol 0: LPs keep it all');
  eq(feesFromGrowth({ before, after: before, seconds: 0, fee: 500, feeProtocol: 34, pool: kp }), null, 'no time between the readings, no rate');

  const pool = { ...kp, fees: f };
  const lo = katUsd * 0.975, hi = katUsd * 1.025;
  const e = estimateFees(pool, { capitalUsd: 1000, lowerPrice: lo, upperPrice: hi, startTs: now }, ctx);
  ok(e.inRange && e.earns, 'a range around the price earns');
  near(e.share, e.liquidity / (e.liquidity + kp.activeLiquidity), 1e-12, 'its share counts its own liquidity in the total');
  near(e.usdPerDay, f.usd_per_day * e.share, 1e-9, 'it takes that share of the pool\'s fees');
  near(e.fees0PerDay * 1 + e.fees1PerDay * katUsd, e.usdPerDay, 1e-9, 'in both tokens');
  near(e.days, (end - now) / 86400, 1e-9, "to the KAT pools' period end, so the two read side by side");
  near(e.apr, e.usdPerDay * 365 / 1000, 1e-12, 'APR on the capital');
  eq([e.katPerDay, e.totalKat], [null, null], 'no KAT figures');
  const wider = estimateFees(pool, { capitalUsd: 1000, lowerPrice: katUsd * 0.8, upperPrice: katUsd * 1.25, startTs: now }, ctx);
  ok(wider.usdPerDay < e.usdPerDay, 'a wider range earns less per dollar');
  const outside = estimateFees(pool, { capitalUsd: 1000, lowerPrice: katUsd * 1.1, upperPrice: katUsd * 1.2, startTs: now }, ctx);
  eq([outside.inRange, outside.share, outside.usdPerDay], [false, 0, 0], 'out of range it earns nothing');
  eq(estimateFees({ ...kp, fees: null }, { capitalUsd: 1000, lowerPrice: lo, upperPrice: hi }, ctx).error, 'This pool\'s fees could not be read this time.', 'unread fees are said, not zero');

  /* the same hedge, on KAT-USD: KAT is the volatile token, vbUSDC the dollar */
  const perps = { withdraw_fee: 0.05,
    markets: { 'KAT-USD': { taker: 0.00019, maker: 0.0000475, mmf: 0.1, min: 2000, step: 1, index: katUsd } },
    book: { 'KAT-USD': { mark: katUsd, bids: [[katUsd * 0.999, 1e7]], asks: [[katUsd * 1.001, 1e7]] } },
    funding: { 'KAT-USD': { avg: 0.0001, now: 0.0001 } } };
  const x = edgeOutcome(pool, e.range, e.liquidity, 1000);
  const plan = hedgePlan(pool, e.deposit, perps, { days: e.days, katUsdTotal: e.totalUsd, capitalUsd: 1000, edges: x });
  eq([plan.legs.length, plan.legs[0].symbol], [1, 'KAT-USD'], 'one leg, the KAT short');
  eq(plan.legs[0].qty, Math.round(e.deposit.amount1), 'the deposit\'s KAT, to the market\'s whole-KAT step');
  near(plan.edges.upper.token_usd, x.upper.price, 1e-15, 'the upper edge is KAT\'s dollar price, the pool being quoted in vbUSDC');
  ok(plan.edges.upper.short < 0 && plan.edges.lower.short > 0, 'the short loses as KAT rises and gains as it falls');
  near(plan.total, e.totalUsd + plan.net, 1e-9, 'the income is the fees plus the hedge net');
}

console.log(`Strategy maths: ${checks} assertions passed.`);
