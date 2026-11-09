/* Real deterministic range arithmetic, chat routing and on-demand context. All
   prices and identities are synthetic; no model, RPC, bot or provider is contacted. */
import assert from 'node:assert/strict';
import { tickAtPrice, priceAtTick, snapRange, liquidityForCapital } from '../strategy-core.mjs';
import { runAgentTool, renderAgentToolResult } from '../api/_agent-tools.mjs';
import { isLPRangeQuestion, requestedLPReviewDays } from '../api/_agent-lp-range.mjs';
import { respondAgent } from '../api/_agent-brain.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { loadAgentSupplementalContext } from '../api/_agent-context.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';

let count = 0;
const check = (a, b, note) => { assert.deepEqual(a, b, note); count++; };
const at = Date.now(), stamp = new Date(at - 1000).toISOString();
const address = n => '0x' + String(n).padStart(40, '0');
const owner = address(10);
function fixture(reverse = false) {
  const btc = { address: address(1), symbol: 'vbWBTC', decimals: 8, usd: 100000 };
  const usdc = { address: address(2), symbol: 'vbUSDC', decimals: 6, usd: 1 };
  const pool = { pool: address(3), status: 'fresh', ts: stamp, token0: reverse ? usdc : btc, token1: reverse ? btc : usdc,
    baseIndex: reverse ? 1 : 0, base: 'vbWBTC', quote: 'vbUSDC', price: 100000, tickSpacing: 10,
    kind: 'rewards', fee: 500, katPerDay: 1000, activeLiquidity: 100000, recent: {} };
  pool.tick = Math.floor(tickAtPrice(pool.price, pool));
  const p10 = pool.baseIndex === 0 ? pool.price : 1 / pool.price;
  pool.sqrtPrice = Math.sqrt(p10 / 10 ** (pool.token0.decimals - pool.token1.decimals));
  for (const [days, low, high] of [[7, 90000, 110000], [14, 85000, 120000], [30, 80000, 125000]]) {
    const a = tickAtPrice(low, pool), b = tickAtPrice(high, pool);
    pool.recent[days] = { lowTick: Math.floor(Math.min(a, b)), highTick: Math.ceil(Math.max(a, b)), swaps: days * 100, complete: true };
  }
  const ownRange = snapRange(95000, 105000, pool), liquidity = liquidityForCapital(500, ownRange.tickLower, ownRange.tickUpper, pool);
  const position = { id: '1001', positionId: '1001', chain: 'katana', owner, pool: pool.pool, contract: address(4), protocol: 'SushiSwap V3',
    status: 'observed', observedAt: stamp, principalUsd: 500, feesMine: false, staked: true, inRange: true, block: null,
    raw: { lowerTick: ownRange.tickLower, upperTick: ownRange.tickUpper, liquidity: String(Math.round(liquidity.liquidity)),
      token0: { ...pool.token0 }, token1: { ...pool.token1 } } };
  return { asOf: stamp, timezone: 'Asia/Kuala_Lumpur', snapshot: { snapshotId: 'portfolio:fixture', status: 'partial', allocationBlocked: true },
    lp: { status: 'fresh', ts: stamp, positions: [{ id: '1001', pair: 'vbWBTC / vbUSDC', chain: 'katana', canonical: position }] },
    strategy: { status: 'fresh', ts: stamp, pools: [pool], fee_pools: [] }, sources: [{ name: 'lp', status: 'fresh', ts: stamp }] };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('LP range tests must never contact a provider'); };
const sqlite = createAgentSQLiteFixture(), store = createAgentStore({ AGENT_DB: sqlite.db });
try {
  const context = fixture();
  const call = (args = { pair: 'BTC/USDC' }, opts = {}) => runAgentTool('analyzeLPRange', args, { context, now: at, ...opts });
  const before = JSON.stringify(context), result = await call(), d = result.data;
  check(result.status, 'ready', 'Range geometry remains calculable when complete portfolio allocation is unavailable');
  check(d.windows.length, 3, 'The comparison uses three verified lookbacks');
  check(d.pair, 'vbWBTC/vbUSDC', 'A BTC alias resolves to the actual wrapped pool tokens without hiding them');
  check(d.startingPoint.days, 14, 'An unspecified cadence offers an explicitly conditional middle starting comparison');
  check(d.reviewFrequencyDays, null, 'No personal management preference is invented');
  check(d.historicalOnly, true, 'Historical range observations are explicitly distinguished from a forecast');
  check(d.profitRankingAvailable, false, 'Unknown costs and future rewards cannot create a net-profit winner');
  check(result.validUntil, new Date(Date.parse(stamp) + 90000).toISOString(), 'Validity is tied to the original pool and position readings');
  check(result.calculationId.startsWith('calc:'), true, 'Structured deterministic calculation provenance remains available');
  check(JSON.stringify(context), before, 'Analysis never edits snapshots, LPs or policy');
  for (const row of d.windows) {
    const raw = context.strategy.pools[0].recent[row.days];
    check(row.tickLower <= raw.lowTick && row.tickUpper > raw.highTick, true, 'Tick rounding encloses both observed extremes with an exclusive upper edge');
    check(row.lowerPrice < d.price && row.upperPrice > d.price, true, 'Each candidate encloses the current quote');
    check(row.tickLower % 10 === 0 && row.tickUpper % 10 === 0, true, 'The candidate respects the pool tick spacing');
  }
  const reply = renderAgentToolResult(result);
  check(d.poolObservation.reportedPrice, context.strategy.pools[0].price, 'The original source quote remains in private calculation inputs');
  check(d.windows[0].historyLowTick, context.strategy.pools[0].recent[7].lowTick, 'Raw observed extrema remain available to reproduce tick rounding');
  for (const reverse of [false, true]) {
    const fromAPI = fixture(reverse), pool = fromAPI.strategy.pools[0];
    pool.price = priceAtTick(pool.tick, pool);
    check((await call(undefined, { context: fromAPI })).status, 'ready', 'The real Strategy producer integer-tick quote is compatible with its precise sqrtPrice');
  }
  for (const text of ['7-day history:', '14-day history:', '30-day history:', 'Your current range', 'My starting point', 'KAT rewards', 'not a forecast', 'How often'])
    check(reply.includes(text), true, 'The reply contains useful position-specific range analysis: ' + text);
  check(reply.includes('calc:') || reply.includes('Limitation:') || reply.includes('partial total'), false, 'Unrelated portfolio warnings and internal IDs do not obscure range analysis');
  const depeg = fixture(); depeg.strategy.pools[0].token1.usd = .98;
  check(renderAgentToolResult(await call(undefined, { context: depeg })).includes('vbUSDC–'), true, 'A quote token valued away from one dollar keeps explicit token units');
  check(renderAgentToolResult(await call(undefined, { context: depeg })).includes('$100,000.00'), false, 'A token quote is not falsely presented as a dollar value during a depeg');
  check((await call({ positionId: '1001' })).data.pool, d.pool, 'An exact existing LP resolves the same pool');
  check((await call({ pair: 'USDC/WBTC' })).data.pool, d.pool, 'An inverse user pair still quotes prices in the configured base/quote direction');
  const reversed = await call({ pair: 'BTC/USDC' }, { context: fixture(true) });
  check(reversed.status, 'ready', 'Opposite on-chain token order works with different token decimals');
  check(Math.abs(reversed.data.price / d.price - 1) < 1e-10, true, 'Inverse on-chain token order preserves quote units');
  for (let i = 0; i < 3; i++) check(Math.abs(reversed.data.windows[i].lowerPrice / d.windows[i].lowerPrice - 1) < .003, true, 'Quote orientation and outward tick rounding remain consistent');
  const policy = { status: 'confirmed', version: 3, constraints: { reviewFrequencyDays: 1, horizonDays: 14, allowedAnalysisTypes: ['lp'] } };
  check((await call(undefined, { policy })).data.startingPoint.days, 7, 'A confirmed daily review cadence changes the comparison heuristic');
  check((await call(undefined, { policy: { ...policy, constraints: { ...policy.constraints, reviewFrequencyDays: 14 } } })).data.startingPoint.days, 30, 'Less frequent review uses a longer observed lookback');
  check((await call({ pair: 'BTC/USDC', reviewFrequencyDays: 7 }, { policy })).data.reviewBasis, 'request', 'Explicit one-question cadence does not masquerade as saved policy');
  check(policy.constraints.reviewFrequencyDays, 1, 'A one-question assumption cannot change saved strategy preferences');
  check((await call(undefined, { policy: { ...policy, constraints: { allowedAnalysisTypes: ['lending'] } } })).status, 'blocked', 'An excluded analysis type cannot produce a recommendation');
  const excluded = await call(undefined, { policy: { ...policy, constraints: { eligibleProtocols: ['Morpho'] } } });
  check(excluded.data.startingPoint, null, 'Protocol exclusions suppress the starting suggestion while retaining factual geometry');
  check(renderAgentToolResult(excluded).includes('outside your saved eligible list'), true, 'A meaningful saved constraint remains clear');
  for (const mutate of [c => { c.strategy.pools[0].ts = new Date(at - 90000).toISOString(); },
    c => { c.strategy.status = 'stale'; }, c => { c.strategy.pools[0].price *= 2; },
    c => { c.strategy.pools[0].token0.decimals = 18; }, c => { c.strategy.pools[0].base = 'ETH'; },
    c => { for (const r of Object.values(c.strategy.pools[0].recent)) r.complete = false; },
    c => { for (const r of Object.values(c.strategy.pools[0].recent)) r.swaps = null; }]) {
    const broken = fixture(); mutate(broken);
    const output = await call(undefined, { context: broken });
    check(output.status, 'blocked', 'Stale, inconsistent, incomplete or incorrectly unitized history cannot produce numeric suggestions');
    check(output.data.windows, undefined, 'Blocked analyses never retain hidden candidate amounts');
  }
  const shorter = fixture(); delete shorter.strategy.pools[0].recent[14];
  const limited = await call(undefined, { context: shorter });
  check(limited.data.startingPoint, null, 'Missing preferred history never silently becomes a shorter recommended sample');
  check(renderAgentToolResult(limited).includes('would not choose'), true, 'Missing relevant history is explained in ordinary language');
  const mismatch = fixture(); mismatch.strategy.pools[0].recent[14] = { ...mismatch.strategy.pools[0].recent[7], lowTick: mismatch.strategy.pools[0].tick - 1, highTick: mismatch.strategy.pools[0].tick + 1 };
  check((await call(undefined, { context: mismatch })).status, 'blocked', 'A longer window cannot exclude extremes verified in a shorter window');
  const duplicate = fixture(); duplicate.strategy.pools.push({ ...structuredClone(duplicate.strategy.pools[0]), pool: address(5), fee: 3000 });
  check((await call(undefined, { context: duplicate })).data.pool, d.pool, 'One uniquely owned pool resolves multiple fee tiers transparently');
  duplicate.lp.positions = [];
  check((await call(undefined, { context: duplicate })).data.reason, 'choose_pool', 'Several unowned fee tiers require clarification');
  check((await call({ pair: 'ETH/USDC' })).status, 'blocked', 'Unavailable pairs never borrow BTC history');
  check((await call({ pair: 'BTC/USDC', chain: 'robinhood' })).data.reason, 'history_unavailable', 'Katana history cannot be reused as Robinhood evidence');
  const noPosition = fixture(); noPosition.lp.positions = [];
  check((await call(undefined, { context: noPosition })).status, 'ready', 'A pair analysis does not require a currently open LP');
  for (const args of [{}, { pair: 'BTC/USDC', reviewFrequencyDays: 0 }, { pair: 'BTC/USDC', reviewFrequencyDays: '7' }, { pair: 'BTC/USDC', formula: 'eval' }]) {
    await assert.rejects(() => call(args), error => error.status === 400); count++;
  }
  check(isLPRangeQuestion('what is the suitable LP range for btc/usdc'), true, 'The reported question is recognized as selection rather than status');
  check(isLPRangeQuestion('Is my LP in range?'), false, 'Ordinary range-status questions are not converted into recommendations');
  check(isLPRangeQuestion('Why is my LP out of range?'), false, 'An out-of-range status question keeps its factual purpose');
  check(isLPRangeQuestion('Suggest a wider range for my LP'), true, 'Range adjustment questions request analysis');
  check(isLPRangeQuestion('BTC/USDC 适合什么区间'), true, 'Common Chinese range wording reaches analysis');
  for (const [text, days] of [['weekly', 7], ['I can check my LP daily', 1], ['I review every 3 days', 3], ['What is the weekly volume?', null], ['I will review monthly', 30]])
    check(requestedLPReviewDays(text), days, 'Only a clear request establishes a one-question review assumption');

  let optionalReads = 0, modelCalls = 0;
  const base = fixture(); delete base.strategy;
  const env = { AGENT_ORIGIN: 'https://range.fixture.test', AI: { run: async () => { modelCalls++; return {
    response: { tool: { name: 'getLPPosition', args: { positionId: '1001', chain: 'katana' } } } }; } } };
  const loadToolContext = async (_tool, value) => { optionalReads++; return { ...value, strategy: fixture().strategy }; };
  const routed = await respondAgent({ message: 'what is the suitable LP range for btc/usdc', context: base, env, loadToolContext });
  check(routed.toolResults[0].toolName, 'analyzeLPRange', 'The old model choice is corrected to the requested range analysis');
  check(routed.reply.includes('My starting point'), true, 'The reported question receives analysis instead of repeating LP value');
  check(optionalReads, 1, 'Only the selected analysis loads extra pool/history data');
  check(modelCalls, 1, 'A range analysis uses one bounded inference, without a prose repair loop');
  check(routed.action, null, 'Advice does not execute a transaction or change preferences');
  await respondAgent({ message: 'Is my LP in range?', context: base, env, loadToolContext });
  check(optionalReads, 1, 'Ordinary LP status does not trigger strategy reads');
  const off = await respondAgent({ message: 'Suggest an LP range for BTC/USDC', context: base,
    env: { ...env, AGENT_STRATEGY_ENABLED: 'false' }, loadToolContext });
  check(off.status, 'blocked', 'The strategy feature flag stops range suggestions');
  check(optionalReads, 1, 'A disabled feature does not retrieve optional strategy data');
  const analyst = { ...env, AI: { run: async () => ({ response: { tool: { name: 'analyzeLPRange', args: { pair: 'ETH/USDC', reviewFrequencyDays: 1 } } } }) } };
  const corrected = await respondAgent({ message: 'Suitable LP range for BTC/USDC', context, env: analyst });
  check(corrected.toolResults[0].data.pair, 'vbWBTC/vbUSDC', 'An explicit requested pair takes priority over an invented model pair');
  check(corrected.toolResults[0].data.reviewFrequencyDays, null, 'The model cannot invent an owner cadence');
  const wrongChain = await respondAgent({ message: 'Suitable LP range for BTC/USDC on Robinhood', context, env: analyst });
  check(wrongChain.status, 'blocked', 'An explicit requested chain takes priority over a model-selected Katana pool');
  analyst.AI.run = async () => ({ response: { tool: { name: 'analyzeLPRange', args: { pair: 'BTC/USDC' } } } });
  const followup = await respondAgent({ message: 'weekly', messages: [{ role: 'assistant', content: routed.reply }], context, env: analyst });
  check(followup.toolResults[0].data.reviewFrequencyDays, 7, 'A free-word cadence follow-up changes the analysis without a template form');
  check(followup.reply.includes('interval you gave for this question'), true, 'The response distinguishes a requested assumption from persistent policy');
  check(followup.reply.includes('How often'), false, 'A supplied cadence does not produce a repeated follow-up question');

  const request = { store, message: 'Suitable LP range for BTC/USDC', requestId: 'range:dashboard', source: 'dashboard', env,
    loadContext: async () => base, loadSupplementalContext: async args => {
      check(args.needs, ['strategy'], 'The shared chat service requests only the selected optional first-party source');
      return { ...args.context, strategy: fixture().strategy };
    }, budgetFactory: () => ({ reserve: async () => ({}), settle: async () => {} }) };
  const shared = await processAgentMessage(request);
  check(shared.reply.includes('14-day history'), true, 'The authenticated shared service returns actual analysis');
  check(shared.result.toolName, 'analyzeLPRange', 'Private response metadata retains the deterministic result');
  check((await processAgentMessage(request)).reply, shared.reply, 'A same-reference retry reuses the dated answer');
  const tg = await processAgentMessage({ ...request, requestId: 'range:telegram', source: 'telegram' });
  check(tg.reply, shared.reply, 'Dashboard and Telegram use identical analysis and arithmetic');
  check((await store.get('messages')).at(-1).source, 'telegram', 'Telegram analysis remains part of the shared private conversation');
  check(await store.get('policy:current'), null, 'The complete conversation never creates or edits strategy policy');

  const sourcePool = fixture().strategy.pools[0];
  const compact = await loadAgentSupplementalContext({ origin: 'https://range.fixture.test', context: base, needs: ['strategy'], now: at,
    fetcher: async url => {
      check(new URL(url).pathname, '/api/strategy', 'Supplemental analysis can only retrieve the configured first-party API');
      return new Response(JSON.stringify({ at: at / 1000, health: { notes: [] }, pools: [{ ...sourcePool,
        rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
        campaign: { start: at / 1000 - 86400, end: at / 1000 + 86400 }, eligible: { liquidity: 100000, holders: 1 } }], fee_pools: [] }),
      { headers: { 'content-type': 'application/json' } });
    } });
  check((await call(undefined, { context: compact })).status, 'ready', 'The production optional adapter retains all required history and range units');
  console.log('LP range analysis and chat routing: ' + count + ' assertions passed.');
} finally { sqlite.close(); globalThis.fetch = originalFetch; }
