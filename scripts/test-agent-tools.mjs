/* Financial tools use the actual pinned Morpho fixture/shared arithmetic and
   explicit canonical economic assets. No inference, bot or network call. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARKETS, WALLET, targetMetrics } from '../morpho-core.mjs';
import { loadAgentContext } from '../api/_agent-context.mjs';
import { runAgentTool, renderAgentToolResult, AGENT_TOOL_NAMES } from '../api/_agent-tools.mjs';

let checks = 0;
const check = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const rejects = async (call, note) => { await assert.rejects(call, error => error.status === 400, note); checks++; };
const source = JSON.parse(readFileSync(new URL('../morpho-history.json', import.meta.url))).samples.at(-1);
const NOW = source.ts * 1000 + 10000, STAMP = new Date(NOW - 5000).toISOString(), TTL = 90000;
const snapshot = JSON.parse(readFileSync(new URL('../data.json', import.meta.url)));
const history = JSON.parse(readFileSync(new URL('../history.json', import.meta.url)));
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Financial tool tests must never contact any provider'); };
try {
  const context = await loadAgentContext({ origin: 'https://tool.fixture.test', now: NOW,
    fetcher: async url => response(new URL(url).pathname === '/api/morpho' ? { ...source, full: true }
      : new URL(url).pathname === '/api/lpbook' ? { generated: STAMP, health: { errors: {}, behind: {}, unread: [], unpriced: [] },
        cards: { value_usd: 0, pnl_usd: 0, fees_usd: 0, net_usd: 0, unclaimed_usd: 0, open: 0 }, live: [], position_data: [] }
        : new URL(url).pathname === '/data.json' ? snapshot : history) });
  const call = (name, args = {}, opts = {}) => runAgentTool(name, args, { context, now: NOW, ...opts });
  check(AGENT_TOOL_NAMES.length, 5, 'Only the implemented read-only financial tools are exposed');
  await rejects(() => call('eval', { code: 'transfer()' }), 'Arbitrary code cannot become a financial tool');
  await rejects(() => call('calculateTargetHealth', { market: 'avkat-kat', targetHealth: 2, formula: 'custom' }), 'Caller formulas and unknown arguments are rejected');
  await rejects(() => call('getPortfolioSnapshot', []), 'Tool inputs require a bounded named object');
  for (const invalid of [.99, 101, Infinity, NaN, '2']) await rejects(() => call('calculateTargetHealth', { market: 'avkat-kat', targetHealth: invalid }), 'Invalid health targets cannot reach arithmetic');
  const row = context.lending.markets.find(m => m.key === 'avkat-kat');
  check(row.interest_accrued, true, 'Context preserves the producer interest-accrual provenance');
  const expected = targetMetrics(row, 2.3);
  const calculated = await call('calculateTargetHealth', { market: row.key, targetHealth: 2.3 });
  check(calculated.status, 'ready', 'A verified market remains calculable even when the total portfolio is partial');
  for (const [key, v] of Object.entries(expected)) check(calculated.data[key], v, 'Agent result reuses shared targetMetrics ' + key);
  check(calculated.data.loan_token, 'KAT', 'Repayment keeps the actual loan token, not a USD proxy');
  check(calculated.policyVersion, 0, 'Unknown strategy preferences remain unconfirmed version zero');
  check(calculated.data.policyCheck.status, 'unconfirmed', 'Alert defaults are not interpreted as an investment policy');
  check(calculated.snapshotId, context.snapshot.snapshotId, 'The numeric result names the canonical source snapshot');
  check(Date.parse(calculated.validUntil), Date.parse(row.ts) + TTL, 'Calculation validity is tied to the original observation');
  check((await call('calculateTargetHealth', { market: row.id, targetHealth: 2.3 })).data.repay_raw, expected.repay_raw, 'An exact market ID resolves to the same shared calculation as its key');
  check((await call('calculateTargetHealth', { market: row.key, targetHealth: 2.3 })).calculationId, calculated.calculationId, 'Repeated equal inputs do not invent a new calculation identity');
  check(renderAgentToolResult(calculated).includes('Calculation ' + calculated.calculationId), true, 'The trusted rendering carries its calculation reference');
  const stale = await runAgentTool('calculateTargetHealth', { market: row.key, targetHealth: 2 }, { context, now: Date.parse(row.ts) + TTL });
  check(stale.status, 'blocked', 'A market expires at the freshness boundary');
  check(stale.data.repay_raw, undefined, 'A stale result does not carry a hidden actionable repayment');
  check(renderAgentToolResult(stale).includes('Required repayment:'), false, 'The stale renderer never quotes an amount');
  const corrupted = structuredClone(context); corrupted.lending.markets[0].raw.debt = String(BigInt(row.raw.debt) + 1n);
  check((await runAgentTool('calculateTargetHealth', { market: row.key, targetHealth: 2 }, { context: corrupted, now: NOW })).status, 'blocked', 'Debt inconsistent with accrued shares is rejected');
  for (const change of [m => { m.interest_accrued = false; }, m => { delete m.raw; }, m => { m.loan_decimals = 6; }, m => { m.raw.oracle_price = '0'; }]) {
    const broken = structuredClone(context); change(broken.lending.markets[0]);
    check((await runAgentTool('calculateTargetHealth', { market: row.key, targetHealth: 2 }, { context: broken, now: NOW })).status, 'blocked', 'Missing accrual, raw values, identity or oracle blocks an actionable calculation');
  }
  const oneMissing = structuredClone(context); oneMissing.lending.markets[1].status = 'unavailable';
  const partial = await runAgentTool('getLendingRisk', {}, { context: oneMissing, now: NOW });
  check(partial.status, 'partial', 'An unrelated failed market is shown explicitly');
  check(partial.data.markets[0].status, 'ready', 'Verified markets are not erased by an unrelated failure');
  const baseRisk = await call('getLendingRisk', { market: row.key });
  const commonMove = structuredClone(context);
  for (const m of commonMove.lending.markets) for (const key of ['loan_usd', 'collateral_price_usd', 'debt_usd', 'collateral_usd', 'oracle_collateral_usd']) if (Number.isFinite(m[key])) m[key] *= .5;
  const movedRisk = await runAgentTool('getLendingRisk', { market: row.key }, { context: commonMove, now: NOW });
  check(movedRisk.data.markets[0].health, baseRisk.data.markets[0].health, 'A common USD move does not change fixed-ratio avKAT/KAT health');
  check(movedRisk.data.markets[0].sensitivity.oracleMoveToBoundaryPct, baseRisk.data.markets[0].sensitivity.oracleMoveToBoundaryPct, 'Oracle-ratio sensitivity is independent of a common USD repricing');
  check(baseRisk.data.markets[0].sensitivity.conditionalKatUsdBoundary, null, 'avKAT/KAT is never given a fictitious KAT/USD liquidation price');
  check(renderAgentToolResult(baseRisk).includes('not a KAT/USD forecast'), true, 'The sensitivity variable is described accurately');
  const policy = { version: 7, status: 'confirmed', constraints: { marketLimits: { 'avkat-kat': { targetHealth: 3, maxLtvPct: 25 } } } };
  const outside = await call('calculateTargetHealth', { market: row.key, targetHealth: 2 }, { policy });
  check(outside.policyVersion, 7, 'The result records the exact confirmed policy version');
  check(outside.status, 'partial', 'A hypothetical outside policy is not presented as a recommendation');
  check(outside.data.policyCheck.checks.map(c => c.passes), [false, false], 'Both independent market policy limits apply');
  check((await call('getKATExposure', {}, { policy: { ...policy, constraints: { allowedAnalysisTypes: ['lending'] } } })).status, 'blocked', 'The confirmed allowed-analysis policy is enforced');

  // Smallest-unit boundary: use a full-owner borrow market whose shares accrue
  // exactly to A. Health can round to 1 in Number while one raw unit is unhealthy.
  const W = 10n ** 18n, debt = 770n * W + 1n;
  const boundaryRow = { ...MARKETS[0], status: 'fresh', ts: STAMP, block: 123, interest_accrued: true,
    no_position: false, loan_usd: .004, collateral_price_usd: .0056, kat_price_usd: .004, avkat_rate: 1.4,
    raw: { collateral: String(1000n * W), debt: String(debt), borrow_shares: String(debt * 1000000n),
      total_borrow_assets: String(debt), total_borrow_shares: String(debt * 1000000n), total_supply_assets: String(debt + 200n * W),
      liquidity: String(200n * W), oracle_price: String(10n ** 36n), lltv: String(77n * 10n ** 16n), liquidation_debt: String(770n * W) } };
  const boundary = { asOf: STAMP, lending: { block: 123, markets: [boundaryRow] } };
  const boundaryRisk = await runAgentTool('getLendingRisk', {}, { context: boundary, now: NOW });
  check(boundaryRisk.data.markets[0].health, 1, 'The display-sized floating health rounds at the raw boundary');
  check(boundaryRisk.data.markets[0].liquidatable, true, 'The raw check still detects one smallest unit above the boundary');
  const repayment = await runAgentTool('calculateTargetHealth', { market: 'avkat-kat', targetHealth: 1 }, { context: boundary, now: NOW });
  check(repayment.data.repay_raw, '1', 'Required repayment rounds conservatively to one raw loan unit');
  check(renderAgentToolResult(repayment).includes('0.000000000000000001 KAT'), true, 'The renderer does not round a required smallest-unit repayment down to zero');
  const healthyBoundary = structuredClone(boundary); const m = healthyBoundary.lending.markets[0];
  m.raw.debt = String(770n * W); m.raw.total_borrow_assets = m.raw.debt; m.raw.borrow_shares = String(770n * W * 1000000n);
  m.raw.total_borrow_shares = m.raw.borrow_shares; m.raw.total_supply_assets = String(970n * W);
  check((await runAgentTool('getLendingRisk', {}, { context: healthyBoundary, now: NOW })).data.markets[0].liquidatable, false, 'Exactly health one remains healthy under the repository protocol semantics');

  const KAT = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d', AVKAT = '0x7231dbacdfc968e07656d12389ab20de82fbfceb';
  const makeAsset = (id, symbol, n, kind = 'wallet', extra = {}) => ({ id, symbol, amount: n, rawAmount: String(BigInt(n) * W), decimals: 18,
    kind, chain: 'katana', owner: WALLET, scope: 'main', status: 'fresh', observedAt: STAMP, block: 123, valueUsd: n,
    tokenAddress: symbol === 'KAT' ? KAT : symbol === 'avKAT' ? AVKAT : null, ...extra });
  const lp = makeAsset('lp', null, 0, 'lp', { metadata: { chain: 'katana', id: '123', positionId: '123', owner: WALLET,
    contract: '0x0000000000000000000000000000000000000001', status: 'observed', block: 123, observedAt: STAMP,
    principalUsd: 40, feesMine: false, staked: true, inRange: true, amounts: { KAT: 20, vbUSDC: 20 },
    raw: { liquidity: '10', lowerTick: -10, upperTick: 10, token0: { address: KAT, symbol: 'KAT', decimals: 18 },
      token1: { address: '0x0000000000000000000000000000000000000002', symbol: 'vbUSDC', decimals: 6 } } } });
  const exposureContext = { asOf: STAMP, lending: { markets: [{ status: 'fresh', ts: STAMP, avkat_rate: 1.4, oracle_price: 99 }] },
    snapshot: { snapshotId: 'portfolio:exposure-fixture', status: 'complete', allocationBlocked: false, coverage: [{ basis: 'live', ts: STAMP }],
      assets: [makeAsset('wallet', 'KAT', 100), makeAsset('receipt', 'avKAT', 10), lp,
        makeAsset('yield', 'yieldKAT', 0, 'other_defi'), makeAsset('locked', 'vKAT', 5, 'locked', { metadata: { backingVerified: true, katBackingPerUnit: 1 } }),
        makeAsset('reward', 'KAT', 3, 'reward'), makeAsset('stable', 'vbUSDC', 1000)],
      exposures: [makeAsset('underlying', 'KAT', 50, 'exposure', { representationOf: 'yield' })],
      liabilities: [makeAsset('loan', 'KAT', 7, 'debt', { metadata: { interestAccrued: true } }), makeAsset('usd-loan', 'vbUSDC', 10, 'debt')],
      scopes: { main: { verifiedSubtotalUsd: 0 }, vault: { verifiedSubtotalUsd: 0 } }, verifiedSubtotalUsd: 0, navUsd: 0 } };
  const exposure = await runAgentTool('getKATExposure', {}, { context: exposureContext, now: NOW });
  check(exposure.status, 'ready', 'Fully verified asset representations produce a complete scoped exposure');
  check(exposure.data.verifiedGrossKat, 192, 'Wallet, receipt conversion, LP, represented asset, lock and reward are counted once');
  check(exposure.data.verifiedNetKat, 185, 'Only accrued KAT debt reduces KAT units');
  check(exposure.data.liquidKat, 100, 'Receipt look-through and rewards are not silently spendable wallet KAT');
  check(exposure.data.claimableKat, 3, 'Claimable rewards remain separate from liquid holdings');
  check(exposure.data.encumberedKat, 84, 'avKAT conversion uses redemption 1.4, LP20 and represented50 without double counting');
  check(exposure.data.lockedKat, 5, 'Verified locked capital is separate');
  const duplicate = structuredClone(exposureContext); duplicate.snapshot.exposures.push(structuredClone(duplicate.snapshot.exposures[0]));
  check((await runAgentTool('getKATExposure', {}, { context: duplicate, now: NOW })).data.verifiedNetKat, 185, 'Duplicate look-through cannot inflate the economic parent exposure');
  duplicate.snapshot.exposures[1].amount = 60; duplicate.snapshot.exposures[1].rawAmount = String(60n * W);
  const conflict = await runAgentTool('getKATExposure', {}, { context: duplicate, now: NOW });
  check(conflict.status, 'partial', 'Conflicting representations do not become a verified full total');
  check(conflict.data.verifiedNetKat, 135, 'A conflicting parent is omitted from the verified subtotal');
  const historic = structuredClone(exposureContext); historic.snapshot.assets.push(makeAsset('old-wallet', 'KAT', 500, 'wallet', { status: 'stale', observedAt: new Date(NOW - TTL - 1).toISOString() }));
  const historyExposure = await runAgentTool('getKATExposure', {}, { context: historic, now: NOW });
  check(historyExposure.data.verifiedNetKat, 185, 'Stale wallet observations are not added to current exposure');
  check(historyExposure.status, 'partial', 'Missing historical wallet coverage remains visible');
  check(historyExposure.data.historical.length, 1, 'Historical quantities remain available as dated observations');
  const missingRate = structuredClone(exposureContext); missingRate.lending.markets[0].status = 'stale';
  check((await runAgentTool('getKATExposure', {}, { context: missingRate, now: NOW })).data.verifiedNetKat, 171, 'An unavailable redemption rate is not replaced by the oracle ratio or 1:1');
  const aggregateReward = structuredClone(exposureContext); aggregateReward.snapshot.assets.push(makeAsset('aggregate', null, 0, 'reward', { rawAmount: null, amount: null, valueUsd: 50 }));
  check((await runAgentTool('getKATExposure', {}, { context: aggregateReward, now: NOW })).status, 'partial', 'An aggregate dollar reward cannot prove a KAT token quantity');
  const avkatLp = structuredClone(exposureContext); avkatLp.snapshot.assets[2].metadata.raw.token0 = { symbol: 'avKAT', address: AVKAT, decimals: 18 };
  avkatLp.snapshot.assets[2].metadata.amounts = { avKAT: 10, vbUSDC: 20 };
  check((await runAgentTool('getKATExposure', {}, { context: avkatLp, now: NOW })).data.verifiedNetKat, 179, 'LP receipt-token amounts convert to underlying economic KAT too');

  const lpContext = structuredClone(exposureContext); lpContext.lp = { status: 'fresh', ts: STAMP, positions: [] };
  const lpResult = await runAgentTool('getLPPosition', { positionId: '123', chain: 'katana' }, { context: lpContext, now: NOW });
  check(lpResult.status, 'ready', 'A positively identified fresh LP exposes raw range and accounting metadata');
  check(renderAgentToolResult(lpResult).includes('fees go to the DAO'), true, 'Staked Sushi fee routing is preserved in the trusted answer');
  const lpUnknown = structuredClone(lpContext); lpUnknown.snapshot.assets[2].metadata.block = null;
  check((await runAgentTool('getLPPosition', { positionId: '123' }, { context: lpUnknown, now: NOW })).status, 'partial', 'A ledger cursor is never substituted for a missing valuation block');
  const lpAmbiguous = structuredClone(lpContext); const secondLp = structuredClone(lpAmbiguous.snapshot.assets[2]);
  secondLp.id = 'lp2'; secondLp.metadata.chain = 'robinhood'; lpAmbiguous.snapshot.assets.push(secondLp);
  check((await runAgentTool('getLPPosition', { positionId: '123' }, { context: lpAmbiguous, now: NOW })).status, 'blocked', 'Position IDs are not globally unique across chains');
  const portfolio = await call('getPortfolioSnapshot');
  check(portfolio.status, 'partial', 'Saved wallet coverage cannot become a complete live NAV');
  check(portfolio.data.allocationBlocked, true, 'Portfolio-wide allocation remains blocked with missing coverage');
  const expiredPortfolio = await runAgentTool('getPortfolioSnapshot', {}, { context: exposureContext, now: NOW + TTL });
  check(expiredPortfolio.data.navUsd, null, 'Expired asset data cannot retain a current NAV');
  check(expiredPortfolio.data.verifiedSubtotalUsd, 0, 'Expired originally-fresh assets are not counted in a current verified subtotal');
  check(expiredPortfolio.data.assets.every(a => a.status === 'stale'), true, 'Expiry is visible on every retained asset');
  check(JSON.stringify(exposureContext).includes('"status":"stale"'), false, 'Read-only tools never mutate source observations');
  console.log('Verified agent financial tools: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = originalFetch; }
