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

console.log(`Strategy maths: ${checks} assertions passed.`);
