/* Actual browser Base reader and portfolio assembly: failures retain the last
   verified value/time, not an empty list or a renewed LIVE timestamp. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), start = html.indexOf('var BASE_LAST_GOOD='),
  end = html.indexOf('/* ============ rendering', start), status = html.match(/function portfolioReadState\([\s\S]*?\n}/)[0];
let checks = 0, now = Date.parse('2026-11-18T04:00:00Z'), mode = 'complete';
const owner = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), clone = value => JSON.parse(JSON.stringify(value));
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const eq = (actual, expected, note) => { assert.deepEqual(clone(actual), clone(expected), note); checks++; };
const ok = (v, note) => { assert.ok(v, note); checks++; };
const payload = () => ({ schemaVersion: 'base-portfolio-v1', chain_id: 8453, name: 'Base', owner, block: 100,
  complete: true, live: true, read_at: new Date(now).toISOString(), onchain_usd: 25, lp_total_usd: 225.7, total_usd: 250.7,
  lp_positions: [{ chain: 'base', wallet: owner, token_id: '7', type: 'LP', protocol: 'Uniswap V3',
    pair: 'UNI / USDC', value_usd: 225.7, fees_usd: 5.7 }], defi_positions: [] });
const ctx = vm.createContext({ Date: Clock, URL, AbortController, setTimeout, clearTimeout, console: { warn() {} },
  CFG: { wallet: owner, startDate: '2026-10-01', startValue: 100, target: 10000, katClaimed: 0 },
  discoverMorpho: async () => {}, morphoMarketList: () => [], getSushiAprs: async () => ({}), getMerklLive: async () => ({ total_usd: 0 }),
  getArcLive: async () => ({ walletUsd: 0, lps: [], merkl: { total_usd: 0 } }),
  getSolanaLive: async () => ({ sol: 0, solPrice: 1, usdc: 0, lps: [] }),
  getRobinhoodLive: async () => ({ walletUsd: 0, lps: [], read_at: new Date(now).toISOString() }),
  getKatanaLive: async () => ({ ethPrice: 1, ethBal: 100, katPrice: 1, avkatRate: 1, bal: {}, lps: [], morpho: [], vkat: { totalKat: 0 } }),
  fetch: async url => {
    if (url === '/api/fables') return { ok: true, json: async () => ({ complete: true, at: new Date(now).toISOString(), lps: [], locks: [] }) };
    eq(url, '/api/lpbook?view=base-portfolio', 'Base uses the independent view of an existing endpoint');
    if (mode === 'http-failed') return { ok: false, status: 503 };
    const value = payload();
    if (mode === 'empty') Object.assign(value, { onchain_usd: 0, lp_total_usd: 0, total_usd: 0, lp_positions: [] });
    if (mode === 'missing-lp') value.lp_positions = [];
    if (mode === 'negative') value.total_usd = -1;
    if (mode === 'wrong-chain') value.chain_id = 1;
    if (mode === 'wrong-wallet') value.owner = other;
    if (mode === 'mixed-wallet') value.lp_positions[0].wallet = other;
    if (mode === 'partial') value.complete = false;
    if (mode === 'stale') value.read_at = new Date(now - 91000).toISOString();
    if (mode === 'future') value.read_at = new Date(now + 31000).toISOString();
    if (mode === 'missing-time') value.read_at = null;
    return { ok: true, status: 200, json: async () => clone(value) };
  } });
vm.runInContext(html.slice(start, end) + '\n' + status + '\nthis.read=getBaseLive;this.fallback=baseFallback;this.load=loadLive;this.state=portfolioReadState;', ctx);
const first = await ctx.load([], {}), originalTime = first.chains.base.read_at;
eq(first.chains.base.lp_positions[0].token_id, '7', 'The actual portfolio assembly includes the Base position');
eq(first.summary.base_usd, 250.7, 'Base gets a separate chain contribution');
eq(first.summary.grand_total_usd, 350.7, 'Base is added to the existing chain total once');
eq(first.summary.onchain_usd, 125, 'Only loose Base tokens enter the on-chain card');
eq(first.summary.lp_usd, 225.7, 'Base principal plus owner fees enters the LP total once');
eq(first.lp_positions.length, 1, 'Base appears in the combined holdings list');
eq(first.live_health.warnings, [], 'A complete recovery has no warning');
eq(ctx.state(first, true).live, true, 'A fresh complete assembled reading qualifies for LIVE');
now += 15000; mode = 'http-failed'; const retained = await ctx.load([], {});
eq(retained.chains.base.total_usd, 250.7, 'An outage cannot erase a funded Base chain');
eq(retained.chains.base.read_at, originalTime, 'Retained Base figures keep their original time');
eq(retained.live_health.read_at, originalTime, 'The portfolio clock is no newer than retained Base data');
eq(retained.live_health.warnings.length, 1, 'Only one concise Base warning appears');
eq(ctx.state(retained, true).live, false, 'Fallback data cannot claim LIVE');
retained.chains.base.lp_positions.length = 0;
eq(ctx.fallback({}).lp_positions.length, 1, 'A consumer cannot mutate the cached complete reading');
for (mode of ['missing-lp','negative','wrong-chain','wrong-wallet','mixed-wallet','partial','stale','future','missing-time']) {
  await assert.rejects(ctx.read()); checks++;
  eq(ctx.fallback({}).read_at, originalTime, 'An invalid reply cannot renew the saved clock: ' + mode);
  eq(ctx.fallback({}).lp_positions.length, 1, 'An invalid reply cannot erase the LP: ' + mode);
}
mode = 'complete'; eq((await ctx.load([], {})).live_health.warnings, [], 'A successful refresh clears the failure');
mode = 'empty'; eq((await ctx.load([], {})).summary.base_usd, 0, 'Verified closure/empty holdings replace the previous positive value');
mode = 'http-failed'; eq((await ctx.load([], {})).chains.base.lp_positions, [], 'A later outage cannot resurrect a verified closed position');
ctx.BASE_LAST_GOOD = null;
const saved = payload(); saved.read_at = originalTime; const snapshot = { chains: { base: saved } }, before = JSON.stringify(snapshot);
eq(ctx.fallback(snapshot).read_at, originalTime, 'Cold-start fallback retains the saved source time');
eq(JSON.stringify(snapshot), before, 'Cold fallback does not mutate the committed snapshot');
const absent = await ctx.load([], {});
eq(absent.chains.base.total_usd, null, 'No first reading means unavailable rather than a fabricated zero');
eq(absent.summary.grand_total_usd, 100, 'A missing Base source cannot alter the verified other-chain subtotal');
eq(ctx.state(absent, true).live, false, 'Missing Base coverage is visible in portfolio freshness');
ok(absent.live_health.warnings[0].includes('not included'), 'The absent first reading is explained');
console.log('Portfolio Base inclusion, independent source time and failure/recovery: ' + checks + ' assertions passed.');
