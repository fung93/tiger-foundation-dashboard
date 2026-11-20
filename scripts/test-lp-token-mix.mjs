/* Principal composition uses comparable values, never raw token counts or range
   distances. The same view and renderer serve LP Book, the widget and UNI Trade. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { lpTokenMix, poolPrice, widgetView } from '../api/_core.mjs';

let checks = 0;
const eq = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const near = (actual, expected, note) => { assert.ok(Math.abs(actual - expected) < 1e-10, note); checks++; };
const ok = (value, note) => { assert.ok(value, note); checks++; };
const uni = { s: 'UNI', d: 18, stable: false }, usdc = { s: 'USDC', d: 6, stable: true };
const eth = { s: 'WETH', d: 18, stable: false };

// 14 UNI at 5 USDC each versus 60 USDC: $70 / $130, not 14 / 74.
const mix = lpTokenMix(uni, usdc, 14, 60, 5);
near(mix.tokens[0].value_pct, 70 / 130 * 100, 'UNI share uses the current value of its principal');
near(mix.tokens[1].value_pct, 60 / 130 * 100, 'USDC share uses the same numeraire');
eq(mix.tokens.map(t => t.symbol), ['UNI', 'USDC'], 'Display order follows the readable pair');
eq(lpTokenMix(usdc, uni, 60, 14, 1 / 5), mix, 'Canonical token ordering cannot swap the labels or shares');

// Exercise the actual sqrt-price decimal conversion: one 18-decimal UNI is worth
// four 6-decimal USDC; 15 UNI and 40 USDC therefore have a 60/40 value mix.
const sqrt = BigInt(Math.round(2e-6 * 2 ** 96));
const price = poolPrice(sqrt, uni.d, usdc.d);
near(price, 4, 'Pool price correctly bridges 18/6 token decimals');
near(lpTokenMix(uni, usdc, 15, 40, price).tokens[0].value_pct, 60, 'Decimals do not turn raw-unit quantities into composition');
const nonStable = lpTokenMix(uni, eth, 20, 1, .1);
near(nonStable.tokens[0].value_pct, 200 / 3, 'Nonstable pairs need only their observed relative pool price');

for (const [a0, a1, expected] of [[10, 0, [100, 0]], [0, 10, [0, 100]]]) {
  eq(lpTokenMix(uni, usdc, a0, a1, 5).tokens.map(t => t.value_pct), expected, 'Single-sided inventory retains a genuine 100/0 split');
  eq(lpTokenMix(usdc, uni, a1, a0, .2).tokens.map(t => t.value_pct), expected, 'Single-sided inventory stays correctly labelled for inverted pools');
}
for (const args of [
  [uni, usdc, 0, 0, 5], [uni, usdc, -1, 10, 5], [uni, usdc, 10, -1, 5],
  [uni, usdc, 10, 20, 0], [uni, usdc, 10, 20, -1],
  [uni, usdc, null, 20, 5], [uni, usdc, '10', 20, 5],
  [uni, usdc, NaN, 20, 5], [uni, usdc, 10, Infinity, 5], [uni, usdc, 10, 20, NaN],
  [uni, usdc, Number.MAX_VALUE, 20, Number.MAX_VALUE],
  [null, usdc, 10, 20, 5], [uni, {}, 10, 20, 5],
]) eq(lpTokenMix(...args), null, 'Missing, empty or invalid state cannot invent a mix: ' + String(args));

const position = { pair: 'UNI / USDC', id: '7', chain: 'base', in_range: true,
  range: { now: 5, lower: 4, upper: 6, position_pct: 50, to_lower_pct: 25, to_upper_pct: 20, width_pct: 50 },
  token_mix: mix, value_usd: 130, fees_mine: true, fee_yield_usd: 0, pnl_usd: 0, il_usd: 0, held_days: 1 };
const view = widgetView(position, {});
eq(view.token_mix, mix, 'The shared card view carries the deterministic principal composition');
eq(widgetView({ ...position, fees_usd: 1000, fee_yield_usd: 2000 }, { earned_by_id: { 7: 3000 } }).token_mix, mix,
  'Fees and rewards cannot change principal composition');
eq(widgetView({ ...position, token_mix: undefined }, {}).token_mix, null, 'An old row does not infer inventory from its range position');
eq([view.edges, view.nearest_edge], ['25.00% · 20.00% to the edges', '20.00%'], 'Existing risk metadata remains available to other consumers');

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../lpcards.js', import.meta.url), 'utf8'), sandbox);
const render = token_mix => sandbox.window.LPCards.card({ ...view, token_mix });
const html = render(mix);
ok(html.includes('UNI</span> <span class="token-percent">53.85%'), 'UNI appears next to its value share');
ok(html.includes('USDC</span> <span class="token-percent">46.15%'), 'USDC appears next to its value share');
ok(!html.includes('to the edges'), 'Range distances are replaced on the shared card');
ok(html.includes(view.lower) && html.includes(view.upper), 'Both range price endpoints stay visible');
ok(html.includes('Excludes fees and rewards.'), 'The principal-only basis is explained without adding a form');
const rounded = render({ ...mix, tokens: [{ symbol: 'UNI', value_pct: 33.335 }, { symbol: 'USDC', value_pct: 66.665 }] });
const shares = [...rounded.matchAll(/class="token-percent">([\d.]+)%/g)].map(m => Number(m[1]));
eq(shares, [33.34, 66.66], 'Displayed shares total 100.00% despite rounding');
for (const broken of [null, {}, { ...mix, tokens: [] }, { ...mix, basis: 'raw_token_counts' },
  { ...mix, tokens: [{ symbol: 'UNI', value_pct: 90 }, { symbol: 'USDC', value_pct: 90 }] },
  { ...mix, tokens: [{ symbol: 'UNI', value_pct: NaN }, { symbol: 'USDC', value_pct: 50 }] }]) {
  const unavailable = render(broken);
  ok(unavailable.includes('Token mix unavailable') && !unavailable.includes('class="token-percent"'), 'Missing or malformed cached readings cannot show invented shares');
}
ok(render(mix).includes('53.85%'), 'A subsequent verified reading restores the token mix');
ok(!render({ ...mix, tokens: [{ symbol: '<script>', value_pct: 50 }, { symbol: 'USDC', value_pct: 50 }] }).includes('<script>'), 'Pool token labels are escaped');
console.log(`LP principal token composition, shared cards and failure/recovery: ${checks} assertions passed.`);
