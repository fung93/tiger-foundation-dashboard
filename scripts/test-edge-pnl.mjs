/* The LP card's "!" box: each live position's P&L with the price at each edge of its range,
   checked offline against the two positions open on 1 Nov 2026 and a few made-up ones.
   No network: edgePnl only reads the row it is given. */
import assert from 'node:assert/strict';
import { edgePnl } from '../api/_core.mjs';

let checks = 0;
const near = (a, b, tol, note) => { assert.ok(Math.abs(a - b) <= tol, `${note}: ${a} vs ${b}`); checks++; };
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const row = (liq, lo, hi, t0, t1) => ({ raw: { liq, lo, hi, t0, t1 } });
const WBTC = { s: 'vbWBTC', d: 8, stable: false }, USDC = { s: 'vbUSDC', d: 6, stable: true };
const WETH = { s: 'WETH', d: 18, stable: false }, USDG = { s: 'USDG', d: 6, stable: true };

/* vbWBTC/vbUSDC #492808: cost $909.61, range 66240-66760 */
const btc = edgePnl({ cost_usd: 909.61, out_usd: 0 }, row('1263859165', 66240, 66760, WBTC, USDC));
near(btc.lower.price, 75270.16, 0.01, '#492808 lower edge price');
near(btc.upper.price, 79287.55, 0.01, '#492808 upper edge price');
eq([btc.lower.pnl_usd, btc.upper.pnl_usd], [-19.74, 3.7], '#492808 P&L at its edges');
eq([btc.lower.token, btc.upper.token], ['vbWBTC', 'vbUSDC'], 'all the volatile token below, all stablecoin above');
near(btc.lower.amount, 0.011822, 0.000001, 'the vbWBTC it would hold at the lower edge');
near(btc.lower.value_usd, btc.lower.amount * btc.lower.price, 0.01, 'its value there is that amount at that price');

/* WETH/USDG #1458357: negative ticks, 18/6 decimals */
const eth = edgePnl({ cost_usd: 3064.61, out_usd: 0 }, row('330746285063218', -201090, -197130, WETH, USDG));
near(eth.lower.price, 1850.16, 0.01, '#1458357 lower edge price');
near(eth.upper.price, 2749.04, 0.01, '#1458357 upper edge price');
eq([eth.lower.pnl_usd, eth.upper.pnl_usd], [-509.21, 50.3], '#1458357 P&L at its edges');
near(eth.lower.amount, 1.3812, 0.0001, 'the WETH it would hold at the lower edge');

/* withdrawals count, as in the card's own P&L */
const paid = edgePnl({ cost_usd: 909.61, out_usd: 100 }, row('1263859165', 66240, 66760, WBTC, USDC));
near(paid.upper.pnl_usd - btc.upper.pnl_usd, 100, 0.011, 'money already taken out adds to both edges');

/* the stablecoin as token0: the edges swap ends, and the quote stays the volatile token's price */
const flipped = edgePnl({ cost_usd: 1000, out_usd: 0 }, row('2000000000000000', 197000, 199000,
  { s: 'vbUSDC', d: 6, stable: true }, { s: 'vbETH', d: 18, stable: false }));
assert.ok(flipped.lower.price < flipped.upper.price, 'lower edge is the lower price'); checks++;
eq([flipped.lower.token, flipped.upper.token], ['vbETH', 'vbUSDC'], 'all ETH at the low ETH price, all USDC at the high one');
near(flipped.upper.price, 1 / (Math.pow(1.0001, 197000) * 1e-12), 0.01, 'the upper ETH price comes from the lower tick');
assert.ok(flipped.upper.value_usd > flipped.lower.value_usd, 'the stablecoin end is worth more'); checks++;

/* nothing to say without a stablecoin, a range, liquidity or a cost */
eq(edgePnl({ cost_usd: 1, out_usd: 0 }, row('1', 0, 10, WBTC, WETH)), null, 'no stable leg: no single dollar answer');
eq(edgePnl({ cost_usd: 1, out_usd: 0 }, row('0', 0, 10, WBTC, USDC)), null, 'no liquidity');
eq(edgePnl({ cost_usd: 1, out_usd: 0 }, row('1', 10, 10, WBTC, USDC)), null, 'an empty range');
eq(edgePnl({ out_usd: 0 }, row('1', 0, 10, WBTC, USDC)), null, 'no cost');
eq(edgePnl({ cost_usd: 1 }, null), null, 'no row');

console.log(`Edge P&L: ${checks} assertions passed.`);
