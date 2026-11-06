/* Optional agent adapters use fixed first-party APIs and local response fixtures.
   No chain scan, model, Telegram call or stored financial mutation occurs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadAgentContext, loadAgentSupplementalContext } from '../api/_agent-context.mjs';
import { summary, reconcile } from '../kat-core.mjs';

let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const rejects = async (work, pattern, label) => { await assert.rejects(work, pattern, label); checks++; };
const NOW = Date.parse('2026-11-06T00:00:00Z'), SECONDS = NOW / 1000, ORIGIN = 'https://context.fixture.test';
const wallet = '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1';
const address = number => '0x' + String(number).padStart(40, '0');
const hash = number => '0x' + String(number).padStart(64, '0');
const success = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function rewardPool(index = 1) {
  return { pool: address(index), token0: { address: address(10), symbol: 'vbWBTC', decimals: 8, usd: 100000 },
    token1: { address: address(11), symbol: 'vbUSDC', decimals: 6, usd: 1 }, tick: 100, tickSpacing: 10,
    sqrtPrice: 1.005, activeLiquidity: 10000, price: 100000, fee: 500, fee_tier: .0005, baseIndex: 0,
    base: 'vbWBTC', quote: 'vbUSDC', apr: .1, tvl: 10000, kat: 14000, katPerDay: 1000,
    campaign: { start: SECONDS - 86400, end: SECONDS + 13 * 86400 },
    rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
    eligible: { liquidity: 5000, amount0: null, amount1: null, positions: 4, inRange: 3, vaults: 1, holders: 0 },
    staked_usd: { in_range: 10000, all: 12000 }, recent: { 7: { low: 90000, high: 110000, lowTick: 90, highTick: 110, swaps: 100, complete: true } } };
}
function strategy() {
  const fee = { ...rewardPool(2), kind: 'fees', campaign: undefined, kat: undefined, katPerDay: undefined,
    eligible: undefined, fee_protocol: 34, fees: { usd_per_day: 2, volume_usd_per_day: 8000, window_days: 7, usd_24h: 3, volume_usd_24h: 12000 },
    balances: { amount0: .01, amount1: 1000 }, tvl_usd: 2000 };
  return { at: SECONDS, epoch: { n: 1483, start: SECONDS - 86400, end: SECONDS + 13 * 86400 },
    reward: { start: SECONDS - 86400, end: SECONDS + 13 * 86400 }, total: { kat: 14000, katPerDay: 1000 }, kat_usd: .004,
    pools: [rewardPool()], fee_pools: [fee], health: { notes: [] },
    perps: { unsupported: 'DERIVATIVES_MUST_NOT_ENTER_CONTEXT' } };
}
function kat() {
  return { at: SECONDS, head: 50000000, head_ts: SECONDS - 1, ledger_to: SECONDS - 21600,
    start: { block: 46345344, ts: SECONDS - 86400 }, price_usd: .005, wallet_kat: 150, start_kat: 20,
    flows: { rewards: 5, avkat: 0, morpho: 0, vkat: 0 },
    trades: [{ side: 'buy', kat: 100, usd: .4, block: 49990000, ts: SECONDS - 1000, hash: hash(1), wallet, fees: { usd: .001 } },
      { side: 'sell', kat: 20, usd: .1, block: 49995000, ts: SECONDS - 500, hash: hash(2), wallet, fees: { usd: .001 } }],
    waiting: [{ kat: 10, ts: SECONDS - 60, hash: hash(3) }], hours: [[SECONDS - 3600, 100, 110, 90]], health: { notes: [] } };
}
function vkat() {
  return { at: SECONDS, head: 50000000, head_ts: SECONDS - 1, ledger_to: SECONDS - 21600, kat_usd: .005, epoch: 1483,
    vote_week: { open: true, opens: SECONDS - 86400, closes: SECONDS + 6 * 86400 },
    locks: [{ wallet, id: 12, kat: 100, power: 100, since: SECONDS - 86400 }],
    standing: [{ gauge: address(1), votes: 100 }], pools: { [address(1)]: 'vbWBTC/vbUSDC' },
    book: { epochs: [{ epoch: 1482, at: SECONDS - 14 * 86400, total: 100, usd: 1, kat_usd: .004, value_usd: .4,
      apr: 1, cumulative: 1, settled: true, rewards: { vbUSDC: 1 }, pools: [{ gauge: address(1), votes: 100 }] }],
      total_usd: 1, tokens: { vbUSDC: 1 }, tokens_usd: { vbUSDC: 1 }, voted: 1, claimed: true, rate: .1, apr: 1 },
    network: { locked: 900, locks: 20, kat_supply: 10000, avkat_supply: 400, avkat_kat: 600, avkat_rate: 1.5, avkat_rate_7d: 1.4 },
    health: { notes: [] } };
}
const lending = JSON.parse(readFileSync(new URL('../morpho-history.json', import.meta.url))).samples.at(-1);
function allSources() {
  return { '/api/morpho': { ...structuredClone(lending), ts: SECONDS, full: true }, '/api/lpbook': {}, '/data.json': {}, '/history.json': {},
    '/api/strategy': strategy(), '/api/kat-trades': kat(), '/api/vkat': vkat() };
}
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Adapter tests must never contact a real source'); };
try {
  const data = allSources(), calls = []; let active = 0, maximum = 0;
  const reader = async (url, options) => {
    const parsed = new URL(url); check(parsed.origin, ORIGIN, 'Optional reads remain on the configured first-party origin');
    calls.push({ path: parsed.pathname, options }); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return success(data[parsed.pathname]);
  };
  let result = await loadAgentContext({ origin: ORIGIN, fetcher: reader, now: NOW });
  check(calls.map(call => call.path).sort(), ['/api/lpbook', '/api/morpho', '/data.json', '/history.json'].sort(), 'Ordinary questions still fetch exactly four existing sources');
  check(Object.hasOwn(result, 'strategy'), false, 'Strategy is absent until requested');
  check(result.lending.markets.every(row => row.interest_accrued === true), true, 'Accrued-interest provenance survives optional adapter changes');
  check(result.lending.markets[0].block, lending.markets[0].block, 'Pinned per-market block provenance remains intact');
  calls.length = 0; maximum = 0;
  result = await loadAgentContext({ origin: ORIGIN, fetcher: reader, now: NOW, needs: ['strategy', 'kat', 'vkat'] });
  check(calls.length, 7, 'Three explicit optional requests add only three existing API reads');
  check(maximum <= 4, true, 'Base and optional phases stay below the six-connection limit');
  check(calls.slice(4).every(call => call.options.redirect === 'manual'), true, 'Optional API reads use Workers-compatible redirect rejection');
  check(result.strategy.status, 'fresh', 'A complete recent strategy reading remains fresh');
  check(result.strategy.pools[0].pool, address(1), 'Pool identity is preserved');
  check(result.strategy.pools[0].eligible.amount0, null, 'All-holder campaigns retain their intentional unknown token totals');
  check(result.strategy.pools[0].campaign.start, SECONDS - 86400, 'Campaign start is never invented');
  check(result.strategy.pools[0].campaign.active, true, 'Current reward eligibility is explicit');
  check(result.strategy.pools[0].rules.outOfRange, false, 'Out-of-range reward routing is retained');
  check(result.strategy.pools[0].recent[7].lowTick, 90, 'Historical range ticks survive the compact view');
  check(result.strategy.fee_pools[0].fees.usd_per_day, 2, 'Observed fee-pool earnings remain distinct from KAT rewards');
  check(result.strategy.fee_pools[0].fee_protocol, 34, 'Protocol fee routing remains available for deterministic scenarios');
  check(result.strategy.block, null, 'An unpinned strategy API never acquires a fabricated valuation block');
  check(JSON.stringify(result.strategy).includes('DERIVATIVES_MUST_NOT_ENTER_CONTEXT'), false, 'Perpetual-futures fields are outside this adapter');
  const expectedSummary = summary(kat().trades, .005), expectedReconciliation = reconcile(kat().trades, kat().flows, 20, 150);
  check(result.kat.summary.qty, expectedSummary.qty, 'Trade-book holdings use the existing deterministic shared book');
  check(result.kat.summary.total, expectedSummary.total, 'Trade P&L uses the existing shared arithmetic');
  check(result.kat.wallet_kat, 150, 'Actual wallet KAT remains separate from the tracked trade quantity');
  check(result.kat.walletCoverage.balanceObserved, true, 'A successful aggregate wallet observation remains available');
  check(result.kat.walletCoverage.complete, false, 'Absent per-wallet raw proofs cannot become complete exposure coverage');
  check(result.kat.reconciliation, expectedReconciliation, 'Reconciliation uses the existing shared flow conventions');
  check(result.kat.ledgerTo, new Date(NOW - 21600000).toISOString(), 'Saved ledger coverage retains its historical timestamp');
  check(result.kat.ts, new Date(NOW).toISOString(), 'The original producer time is retained');
  check(result.kat.headTs, new Date(NOW - 1000).toISOString(), 'Chain observation time remains distinct from request time');
  check(result.vkat.status, 'partial', 'The lock producer cannot attest complete wallet enumeration');
  check(result.vkat.network.locked, 900, 'Network locked value is not inflated by the included avKAT backing');
  check(result.vkat.network.block, 50000000, 'The explicitly pinned network read retains its actual head block');
  check(result.vkat.book.total_usd, 1, 'Historical vote reward value is not repriced at the current KAT quote');
  check(result.vkat.epochs[0].kat_usd, .004, 'Each historical epoch retains its recorded price');
  check(result.vkat.locksCoverage.confirmedEmpty, false, 'Missing locks never prove successful empty ownership');

  const isolated = async (name, sample, time = NOW) => loadAgentSupplementalContext({ origin: ORIGIN, now: time,
    needs: [name], context: { lending: { marker: 'independent' }, sources: [{ name: 'lending', status: 'fresh' }] },
    fetcher: async () => success(sample) });
  let input = strategy(); input.at = SECONDS - 1000;
  check((await isolated('strategy', input)).strategy.status, 'stale', 'HTTP 200 does not make an old strategy reading current');
  check((await isolated('strategy', { at: SECONDS, pools: [] })).strategy.status, 'unavailable', 'A partial unknown strategy schema is not a verified empty response');
  input = strategy(); input.at = undefined;
  check((await isolated('strategy', input)).strategy.ts, null, 'Missing observation time cannot acquire fetch time');
  input = strategy(); input.pools[0].token0.usd = null;
  result = await isolated('strategy', input);
  check(result.strategy.pools[0].token0.usd, null, 'Missing prices remain unavailable rather than zero');
  check(result.strategy.status, 'partial', 'A missing price blocks a complete strategy reading');
  input = strategy(); input.pools[0].campaign.end = SECONDS - 1;
  check((await isolated('strategy', input)).strategy.pools[0].campaign.active, false, 'An ended campaign is never represented as current eligibility');
  input = strategy(); input.pools[0].eligible = undefined;
  check((await isolated('strategy', input)).strategy.status, 'partial', 'Unknown competing liquidity cannot support a complete estimate');
  input = strategy(); input.health.notes = ['Katana Perps could not be read this time (fixture); the hedge cannot be simulated.'];
  check((await isolated('strategy', input)).strategy.status, 'fresh', 'An unrelated derivatives failure does not invalidate supported LP inputs');
  input = strategy(); input.health.notes = Array.from({ length: 10 }, () => 'Katana Perps could not be read this time.').concat('A pool was unread.');
  check((await isolated('strategy', input)).strategy.status, 'partial', 'A warning omitted by the compact note cap cannot disappear into a complete reading');
  input = strategy(); input.health.notes = [{}];
  check((await isolated('strategy', input)).strategy.status, 'partial', 'Malformed health notes never establish full source coverage');
  input = strategy(); input.pools = Array.from({ length: 20 }, (_, i) => rewardPool(i + 1));
  result = await isolated('strategy', input);
  check(result.strategy.pools.length <= 12, true, 'Configured pool records are bounded');
  check(result.strategy.coverage.omitted, true, 'Omitted pools are visible as incomplete coverage');
  check(new TextEncoder().encode(JSON.stringify(result.strategy)).byteLength <= 40000, true, 'The compact optional data has an explicit byte ceiling');
  result = await isolated('strategy', strategy(), NOW + 10000);
  check(result.strategy.ts, new Date(NOW).toISOString(), 'Repeated reads preserve the original strategy time');
  check(result.strategy.validUntil, new Date(NOW + 90000).toISOString(), 'Repeated reads cannot extend source validity');

  input = kat(); input.wallet_kat = null;
  result = await isolated('kat', input);
  check(result.kat.wallet_kat, null, 'Failed wallet reads are not converted to zero holdings');
  check(result.kat.walletCoverage.complete, false, 'Incomplete wallet coverage remains visible');
  check(result.kat.summary.qty, 80, 'An independent verified trade book remains available after wallet failure');
  check(result.kat.reconciliation, null, 'A failed wallet balance cannot support reconciliation');
  input = kat(); input.trades = Array.from({ length: 501 }, (_, i) => ({ ...kat().trades[0], hash: hash(i), block: i, ts: SECONDS - 1000 + i }));
  result = await isolated('kat', input);
  check(result.kat.trades.length, 12, 'Only bounded recent trades enter the context');
  check(result.kat.summary, null, 'All-time P&L is never calculated from a truncated trade collection');
  check(result.kat.historyCoverage.complete, false, 'Oversized trade history is explicitly incomplete');
  input = kat(); input.head_ts = SECONDS - 1000;
  check((await isolated('kat', input)).kat.status, 'stale', 'A current request time cannot refresh an old chain observation');
  input = kat(); input.trades[0].kat = -100;
  check((await isolated('kat', input)).kat.summary, null, 'Malformed trade amounts cannot enter the shared summary arithmetic');
  input = kat(); input.trades[1].hash = input.trades[0].hash;
  check((await isolated('kat', input)).kat.summary, null, 'Duplicate trade identities cannot inflate all-time results');
  input = kat(); delete input.start;
  check((await isolated('kat', input)).kat.summary, null, 'Unidentified tracking scope cannot support an all-time trade result');
  input = kat(); input.trades = [1, 2].map(number => ({ ...kat().trades[0], kat: 1e308, hash: hash(number) }));
  check((await isolated('kat', input)).kat.summary, null, 'Overflowed book arithmetic is unavailable rather than a verified aggregate');
  check((await isolated('kat', { version: 1, last_ts: SECONDS, trades: [], pending: [] })).kat.status, 'unavailable', 'A saved trade ledger is not a live API reading');
  input = kat(); input.at = NOW; input.head_ts = NOW - 1000;
  check((await isolated('kat', input)).kat.ts, new Date(NOW).toISOString(), 'Explicit millisecond timestamps are normalized without a unit error');

  input = vkat(); input.locks = [];
  result = await isolated('vkat', input);
  check(result.vkat.locksCoverage.confirmedEmpty, false, 'A producer that can hide enumeration failures cannot establish zero locks');
  check(result.vkat.status, 'partial', 'An empty observed-lock list retains the producer coverage limitation');
  input = vkat(); input.network = null;
  check((await isolated('vkat', input)).vkat.network, null, 'Failed network totals are not fabricated');
  input = vkat(); input.health.notes = ['Merkl could not be read this time; showing the rewards saved before'];
  check((await isolated('vkat', input)).vkat.book.status, 'partial', 'Retained historical rewards are not disguised as a current complete reward reading');
  input = vkat(); input.network = {};
  check((await isolated('vkat', input)).vkat.network.status, 'partial', 'Missing network numbers cannot acquire a complete observed state');
  input = vkat(); input.network.avkat_kat = 901;
  check((await isolated('vkat', input)).vkat.network.status, 'partial', 'Included avKAT backing cannot exceed the stated network locked total');
  input = vkat(); input.book.epochs = Array.from({ length: 100 }, (_, i) => ({ ...vkat().book.epochs[0], epoch: i }));
  result = await isolated('vkat', input);
  check(result.vkat.epochs.length, 8, 'Vote history included in the prompt is bounded');
  check(result.vkat.book.total_usd, 1, 'A bounded history view preserves the source aggregate rather than resumming a truncated list');

  let attempted = 0;
  await rejects(() => loadAgentContext({ origin: ORIGIN, needs: ['https://internal.invalid'], fetcher: async () => { attempted++; } }), /supported optional/, 'Arbitrary destinations cannot become optional sources');
  check(attempted, 0, 'Invalid source selection is rejected before any network call');
  await rejects(() => loadAgentSupplementalContext({ origin: ORIGIN + '/path', needs: ['kat'] }), /valid dashboard origin/, 'Optional reads retain exact-origin configuration requirements');
  const failed = await loadAgentSupplementalContext({ origin: ORIGIN, needs: ['strategy'], now: NOW,
    context: { lending: { marker: 'kept' }, sources: [{ name: 'lending', status: 'fresh' }] }, fetcher: async () => { throw Error('source private failure'); } });
  check(failed.strategy.status, 'unavailable', 'Optional source failure remains unavailable');
  check(failed.lending.marker, 'kept', 'An optional failure preserves independent verified sources');
  check(JSON.stringify(failed.strategy).includes('private failure'), false, 'Raw source exceptions do not enter context');
  const duplicateCalls = [];
  await loadAgentSupplementalContext({ origin: ORIGIN, now: NOW, needs: ['kat', 'kat'], fetcher: async url => { duplicateCalls.push(url); return success(kat()); } });
  check(duplicateCalls.length, 1, 'Repeated source names do not duplicate a request');
  const oversized = await loadAgentSupplementalContext({ origin: ORIGIN, now: NOW, needs: ['strategy'],
    fetcher: async () => success({ ...strategy(), untrusted: 'x'.repeat(350001) }) });
  check(oversized.strategy.status, 'unavailable', 'Oversized optional API responses are rejected before model context');
  console.log('On-demand agent context: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = realFetch; }
