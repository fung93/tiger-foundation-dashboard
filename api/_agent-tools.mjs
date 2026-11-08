/* Closed read-only financial tools. Numbers and units are produced here from
   verified source objects, never by the language model or a submitted formula. */
import { createHash } from 'node:crypto';
import { MARKETS, debtAssets, targetMetrics, liquidationMetrics } from '../morpho-core.mjs';
import { positionIdentity } from '../portfolio-core.mjs';
import { httpError } from './_agent-http.mjs';
import { agentNumber, agentMoney, agentPrice, agentReadingTime, friendlyAgentNotes } from '../agent-language.mjs';
import { analyzeLPRange, renderLPRangeAnalysis } from './_agent-lp-range.mjs';
import { LP_ADVICE_FOCUSES } from './_agent-lp-advice.mjs';

export const AGENT_TOOL_SCHEMA_VERSION = 'agent-tool-v1';
export const AGENT_TOOL_NAMES = Object.freeze(['getPortfolioSnapshot', 'getLendingRisk', 'calculateTargetHealth', 'getLPPosition', 'getKATExposure', 'analyzeLPRange']);
export const AGENT_TOOL_SCHEMAS = Object.freeze({
  getPortfolioSnapshot: { required: [], optional: [] },
  getLendingRisk: { required: [], optional: ['market'] },
  calculateTargetHealth: { required: ['market', 'targetHealth'], optional: [] },
  getLPPosition: { required: ['positionId'], optional: ['chain', 'owner'] },
  getKATExposure: { required: [], optional: [] },
  analyzeLPRange: { required: [], optional: ['pair', 'positionId', 'chain', 'owner', 'reviewFrequencyDays', 'dailyRewardTargetUsd', 'analysisFocus', 'dailyRewardFloorUsd','priceCase','dailyRewardPeriodAssumed'] },
});
const TTL = 90000, WAD = 10n ** 18n, ORACLE = 10n ** 36n, UINT_MAX = (1n << 256n) - 1n;
const KAT_TOKEN = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d';
const value = n => Number.isFinite(n) ? n : null;
const nonnegative = n => Number.isFinite(n) && n >= 0 ? n : null;
const atTime = input => {
  const n = typeof input === 'number' ? input < 1e12 ? input * 1000 : input : Date.parse(input);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const fresh = (stamp, now) => atTime(stamp) !== null && now - atTime(stamp) >= -30000 && now - atTime(stamp) < TTL;
const iso = n => Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
const fingerprint = item => createHash('sha256').update(JSON.stringify(stable(item))).digest('hex');
const badInput = message => httpError(400, message);
const policyVersion = policy => Number.isSafeInteger(policy?.version) && policy.version >= 0 ? policy.version : 0;

function argsFor(name, args) {
  if (!Object.hasOwn(AGENT_TOOL_SCHEMAS, name)) throw badInput('Choose an available read-only agent tool.');
  const schema = AGENT_TOOL_SCHEMAS[name];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > (name === 'analyzeLPRange' ? 10 : 4)
    || Object.keys(args).some(key => !schema.required.includes(key) && !schema.optional.includes(key))
    || schema.required.some(key => !Object.hasOwn(args, key))) throw badInput('Choose valid inputs for this agent tool.');
  for (const key of ['market', 'positionId', 'chain', 'owner', 'pair']) if (Object.hasOwn(args, key)
    && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (key === 'positionId' ? 500 : 200)))
    throw badInput('Choose a specific market or position.');
  if (name === 'analyzeLPRange' && !args.pair && !args.positionId) throw badInput('Choose a token pair or LP position for the range analysis.');
  if (Object.hasOwn(args, 'reviewFrequencyDays') && (!Number.isInteger(args.reviewFrequencyDays) || args.reviewFrequencyDays < 1 || args.reviewFrequencyDays > 365)) throw badInput('Choose a review interval from 1 to 365 days.');
  if(Object.hasOwn(args,'dailyRewardTargetUsd')&&(!Number.isFinite(args.dailyRewardTargetUsd)||args.dailyRewardTargetUsd<.000001||args.dailyRewardTargetUsd>1e9))
    throw badInput('Choose one positive daily reward target in USD.');
  if(Object.hasOwn(args,'dailyRewardFloorUsd')&&(!Number.isFinite(args.dailyRewardFloorUsd)||args.dailyRewardFloorUsd<.000001||args.dailyRewardFloorUsd>1e9))
    throw badInput('Choose one positive daily reward floor in USD.');
  if(Object.hasOwn(args,'analysisFocus')&&!LP_ADVICE_FOCUSES.includes(args.analysisFocus))throw badInput('Choose a supported LP analysis focus.');
  if(Object.hasOwn(args,'dailyRewardPeriodAssumed')&&(args.dailyRewardPeriodAssumed!==true||!Object.hasOwn(args,'dailyRewardTargetUsd')))throw badInput('Choose a labelled daily reward scenario.');
  if(Object.hasOwn(args,'priceCase')){
    const c=args.priceCase;
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(key=>!['symbol','changePct','priceUsd'].includes(key))
      ||!['KAT','BTC','ETH'].includes(c.symbol)||Object.hasOwn(c,'changePct')===Object.hasOwn(c,'priceUsd')
      ||Object.hasOwn(c,'changePct')&&(!Number.isFinite(c.changePct)||c.changePct<=-100||c.changePct>1000)
      ||Object.hasOwn(c,'priceUsd')&&(c.symbol!=='KAT'||!Number.isFinite(c.priceUsd)||c.priceUsd<=0||c.priceUsd>1e6))throw badInput('Choose one supported price scenario.');
  }
  if (Object.hasOwn(args, 'targetHealth') && (!Number.isFinite(args.targetHealth) || args.targetHealth < 1 || args.targetHealth > 100))
    throw badInput('Choose a target health between 1 and 100.');
  if (args.chain && !['katana', 'robinhood', 'arc', 'solana'].includes(args.chain)) throw badInput('Choose a supported position chain.');
  return args;
}
export const validateAgentToolInput = argsFor;
function sourceSnapshot(context) {
  return typeof context?.snapshot?.snapshotId === 'string' ? context.snapshot.snapshotId
    : 'source-snapshot:' + fingerprint({ asOf: context?.asOf || null, sources: context?.sources || [],
      lending: (context?.lending?.markets || []).slice(0, 6).map(row => ({ id: row.id, ts: row.ts, block: row.block, raw: row.raw })) });
}
function result(name, args, context, policy, detail) {
  const stamps = (detail.stamps || []).map(atTime).filter(n => n !== null);
  const observed = stamps.length ? Math.min(...stamps) : null;
  const body = { schemaVersion: AGENT_TOOL_SCHEMA_VERSION, toolName: name, snapshotId: sourceSnapshot(context),
    policyVersion: policyVersion(policy), status: detail.status, observedAt: iso(observed),
    validUntil: detail.status === 'blocked' || !stamps.length ? null : iso(Math.min(Math.min(...stamps) + TTL,
      atTime(detail.validUntil)??Infinity)),
    units: detail.units || {}, assumptions: detail.assumptions || [],
    roundingPolicy: detail.roundingPolicy || 'Source raw units retained; display values are not transaction instructions.',
    data: detail.data || {}, limitations: [...new Set(detail.limitations || [])] };
  return { ...body, calculationId: 'calc:' + fingerprint({ args, ...body }) };
}
const blocked = (reason, data = {}) => ({ status: 'blocked', data, limitations: [reason] });
function findMarket(context, name) {
  const key = String(name || '').trim().toLowerCase().replace(/\s/g, '');
  const matches = (context?.lending?.markets || []).filter(row => [row.id, row.key, row.label]
    .some(item => typeof item === 'string' && item.toLowerCase().replace(/\s/g, '') === key));
  return matches.length === 1 ? matches[0] : null;
}
function marketValidation(row, context, now) {
  if (!row) return 'The selected lending market could not be identified.';
  const known = MARKETS.find(m => m.id === row.id && m.key === row.key);
  if (!known || known.loan_token !== row.loan_token || known.collateral_token !== row.collateral_token
    || known.loan_decimals !== row.loan_decimals || known.collateral_decimals !== row.collateral_decimals)
    return 'The market token identity or units could not be verified.';
  if (row.error || row.status !== 'fresh' || !fresh(row.ts, now)) return 'A fresh complete market reading is required; no actionable amount is available.';
  const block = row.block ?? context?.lending?.block;
  if (!Number.isSafeInteger(block) || block < 0) return 'The market observation block could not be verified.';
  if (row.no_position === true) return row.collateral_amount === 0 && row.debt_amount === 0 ? null : 'An empty market reading is inconsistent.';
  if (row.interest_accrued !== true) return 'Accrued interest at the observation block has not been verified.';
  const names = ['collateral', 'debt', 'borrow_shares', 'oracle_price', 'lltv', 'liquidation_debt',
    'total_borrow_assets', 'total_borrow_shares', 'liquidity'];
  const raw = row.raw;
  if (!raw || names.some(name => typeof raw[name] !== 'string' || !/^\d{1,78}$/.test(raw[name])))
    return 'The market raw token and oracle amounts could not be verified.';
  try {
    const r = Object.fromEntries(names.map(name => [name, BigInt(raw[name])]));
    if (Object.values(r).some(n => n > UINT_MAX) || r.lltv <= 0n || r.lltv > WAD || r.oracle_price <= 0n
      || !Number.isFinite(row.lltv) || Math.abs(row.lltv - Number(r.lltv) / 1e18) > 1e-12)
      return 'The market oracle or liquidation threshold is invalid.';
    if (debtAssets(r.borrow_shares, r.total_borrow_assets, r.total_borrow_shares) !== r.debt
      || r.collateral * r.oracle_price / ORACLE * r.lltv / WAD !== r.liquidation_debt)
      return 'The raw accrued debt or oracle calculation is inconsistent.';
    if (raw.total_supply_assets !== undefined && (/^\d{1,78}$/.test(raw.total_supply_assets) === false
      || r.liquidity !== (BigInt(raw.total_supply_assets) > r.total_borrow_assets ? BigInt(raw.total_supply_assets) - r.total_borrow_assets : 0n)))
      return 'The market liquidity reading is inconsistent.';
  } catch { return 'The market arithmetic could not be verified.'; }
  return null;
}
function marketPolicy(row, target, policy) {
  const confirmed = policy?.status === 'confirmed';
  const constraint = confirmed ? policy.constraints?.marketLimits?.[row.key] : null;
  const checks = [];
  if (Number.isFinite(constraint?.targetHealth)) checks.push({ field: 'targetHealth', limit: constraint.targetHealth, passes: target >= constraint.targetHealth });
  if (Number.isFinite(constraint?.maxLtvPct)) checks.push({ field: 'maxLtvPct', limit: constraint.maxLtvPct, passes: row.lltv / target * 100 <= constraint.maxLtvPct + 1e-10 });
  return { status: confirmed ? checks.every(check => check.passes) ? 'within_market_limits' : 'outside_market_limits' : 'unconfirmed',
    scope: 'Market target only; this is not a portfolio allocation or trade recommendation.', checks };
}
function riskRow(row, context, now) {
  const problem = marketValidation(row, context, now);
  if (problem) return { marketId: row?.id || null, marketKey: row?.key || null, market: row?.label || null,
    status: 'blocked', observedAt: row?.ts || null, limitation: problem };
  if (row.no_position) return { marketId: row.id, marketKey: row.key, market: row.label, status: 'ready',
    observedAt: row.ts, noPosition: true, loanToken: row.loan_token, debtRaw: '0', debtAmount: 0, health: null, liquidatable: false };
  const raw = row.raw, debt = BigInt(raw.debt), collateralLoan = BigInt(raw.collateral) * BigInt(raw.oracle_price) / ORACLE;
  const liquidation = liquidationMetrics(row);
  return { marketId: row.id, marketKey: row.key, market: row.label, status: 'ready', observedAt: row.ts,
    block: row.block ?? context.lending.block, loanToken: row.loan_token, loanDecimals: row.loan_decimals,
    collateralToken: row.collateral_token, debtRaw: raw.debt, collateralRaw: raw.collateral,
    debtAmount: Number(debt) / 10 ** row.loan_decimals,
    health: debt === 0n ? null : Number(BigInt(raw.liquidation_debt)) / Number(debt),
    ltv: collateralLoan === 0n ? null : Number(debt) / Number(collateralLoan), lltv: row.lltv,
    liquidatable: debt > BigInt(raw.liquidation_debt), interestAccrued: true,
    sensitivity: { status: liquidation.status, variable: liquidation.kind === 'kat-ratio' ? 'avKAT/KAT collateral-to-debt oracle ratio' : 'collateral oracle price',
      kind: liquidation.kind, oracleCurrentPrice: liquidation.oracle_current_price,
      oracleLiquidationPrice: liquidation.oracle_liquidation_price, oracleMoveToBoundaryPct: liquidation.ratio_headroom_pct,
      conditionalKatUsdBoundary: liquidation.kind === 'kat-ratio' ? null : liquidation.estimated_kat_liquidation_usd,
      katPriceBasis: liquidation.kat_price_basis, katQuoteObservedAt: liquidation.kat_price_basis === 'oracle' ? row.kat_oracle_updated_at ?? null : row.ts,
      isForecast: false, assumptions: 'Debt, collateral amounts and all other oracle inputs remain fixed. Exactly health 1 is the boundary; liquidation is permitted below it.' } };
}
function lendingRisk(args, context, now) {
  const markets = args.market ? [findMarket(context, args.market)] : (context?.lending?.markets || []).slice(0, MARKETS.length);
  if (!markets.length) return blocked('Current lending readings are unavailable.');
  const rows = markets.map(row => riskRow(row, context, now)), ready = rows.filter(row => row.status === 'ready');
  return { status: !ready.length ? 'blocked' : ready.length === rows.length ? 'ready' : 'partial', data: { markets: rows },
    stamps: ready.map(row => row.observedAt), units: { health: 'dimensionless', ltv: 'fraction of oracle collateral value', debt: 'loan token units' },
    assumptions: ['Every market is evaluated independently; another market failure does not erase a verified reading.',
      'Oracle health uses pinned raw debt after interest accrual, not collateral redemption value.'],
    limitations: rows.filter(row => row.status !== 'ready').map(row => row.limitation),
    roundingPolicy: 'Accrued debt rounded up by debtAssets; liquidation follows the existing Morpho integer floors and exact boundary semantics.' };
}
function targetHealth(args, context, policy, now) {
  const row = findMarket(context, args.market), problem = marketValidation(row, context, now);
  if (problem) return blocked(problem, { market: row?.label || args.market });
  if (row.no_position) return blocked('The market has no active position; there is no repayment or existing-position borrowing amount.', { market: row.label });
  const metrics = targetMetrics({ ...row, loan_usd: nonnegative(row.loan_usd) }, args.targetHealth), check = marketPolicy(row, metrics.target_health, policy);
  if (metrics.status === 'unavailable') return blocked('A verified lending calculation is unavailable.', { market: row.label });
  return { status: check.status === 'outside_market_limits' ? 'partial' : 'ready', stamps: [row.ts],
    data: { ...metrics, market: row.label, marketId: row.id, marketKey: row.key, loan_token: row.loan_token,
      loan_decimals: row.loan_decimals, collateral_token: row.collateral_token,
      current_health: BigInt(row.raw.debt) === 0n ? null : Number(BigInt(row.raw.liquidation_debt)) / Number(BigInt(row.raw.debt)),
      current_ltv: BigInt(row.raw.collateral) * BigInt(row.raw.oracle_price) / ORACLE === 0n ? null
        : Number(BigInt(row.raw.debt)) / Number(BigInt(row.raw.collateral) * BigInt(row.raw.oracle_price) / ORACLE), lltv: row.lltv, policyCheck: check,
      raw_units: { repay: metrics.repay_raw, maxBorrow: metrics.max_borrow_raw, targetDebt: metrics.target_debt_raw } },
    units: { repayment: row.loan_token, borrowing: row.loan_token, raw: 'integer smallest loan-token units', loanDecimals: row.loan_decimals, targetHealth: 'dimensionless' },
    assumptions: ['Read-only estimate at this pinned observation; it does not execute a repayment or borrow.',
      'Debt includes accrued interest; market liquidity and protocol LLTV cap actual borrowing.',
      'A hypothetical amount does not imply the owner has spare liquid capital or an approved portfolio strategy.'],
    limitations: check.status === 'outside_market_limits' ? ['The requested target is outside the confirmed market policy; this is an informational calculation, not a recommendation.'] : [],
    roundingPolicy: 'Shared targetMetrics: target health rounded up at six decimals, debt and required repayment rounded up, borrow headroom rounded down and capped by liquidity.' };
}
function lpCandidates(context) {
  const entries = new Map();
  for (const asset of (context?.snapshot?.assets || []).filter(row => row?.kind === 'lp').slice(0, 60)) {
    if (!asset.metadata) continue;
    const p = asset.metadata;
    entries.set([p.chain || asset.chain, p.owner || asset.owner, String(p.positionId || p.id || asset.positionId)].join(':'),
      { ...p, chain: p.chain || asset.chain, owner: p.owner || asset.owner, positionId: String(p.positionId || p.id || asset.positionId),
        assetId: asset.id, observedAt: p.observedAt || asset.observedAt, principalUsd: p.principalUsd ?? asset.valueUsd });
  }
  for (const row of (context?.lp?.positions || []).slice(0, 60)) if (row?.canonical) {
    const p = row.canonical;
    const key = [p.chain, p.owner, String(p.positionId || p.id)].join(':');
    if (!entries.has(key)) entries.set(key, { ...p, pair: row.pair, positionId: String(p.positionId || p.id), observedAt: p.observedAt || context.lp.ts });
  }
  return [...entries.values()];
}
function lpPosition(args, context, now) {
  const id = args.positionId.replace(/^#/, ''), matches = lpCandidates(context).filter(p => [p.id, p.positionId, p.assetId].some(candidate => String(candidate) === id)
    && (!args.chain || p.chain === args.chain) && (!args.owner || (p.chain === 'solana' ? p.owner === args.owner : p.owner?.toLowerCase() === args.owner.toLowerCase())));
  if (matches.length !== 1) return blocked(matches.length ? 'The position ID is ambiguous. Specify its chain and owner.' : 'The selected LP position could not be verified.');
  const p = matches[0];
  if (!positionIdentity({ chain: p.chain, protocolContract: p.contract, positionId: p.positionId, owner: p.owner }))
    return blocked('The LP chain, contract, position and owner identity could not be verified.');
  if (context?.lp?.status !== 'fresh' || !fresh(p.observedAt, now) || p.status !== 'observed' || nonnegative(p.principalUsd) === null)
    return blocked('A complete fresh LP reading is required; retained LP values are not current.', { positionId: p.positionId, chain: p.chain });
  const limitations = [];
  if (!Number.isSafeInteger(p.block)) limitations.push('The producer does not supply a pinned valuation block; the event-ledger cursor is not substituted for it.');
  if (!p.raw) limitations.push('Exact liquidity and token-range metadata are unavailable.');
  else if (!Number.isInteger(p.raw.lowerTick) || !Number.isInteger(p.raw.upperTick) || p.raw.lowerTick >= p.raw.upperTick)
    limitations.push('The LP tick range is unavailable or inconsistent.');
  if (p.feesMine === null || p.staked === null) limitations.push('Fee routing or staking eligibility is not fully verified.');
  return { status: limitations.length ? 'partial' : 'ready', stamps: [p.observedAt], data: { ...p,
    accounting: { ...p.accounting, principalExcludesFeesAndRewards: true, carriedRewardsExcludedFromApr: true,
      stakedTradingFeesToDao: p.chain === 'katana' && p.feesMine === false } },
    units: { principal: 'USD at observation', liquidity: 'raw liquidity integer', range: 'pool ticks with explicit token decimals' },
    assumptions: ['LP ownership and staking metadata come from the existing LP Book producer.',
      'Unclaimed carried rewards may affect wealth but never become newly earned APR.'], limitations };
}
function portfolio(context, now) {
  const snapshot = context?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.liabilities)) return blocked('A canonical portfolio snapshot is unavailable.');
  const expired = [...snapshot.assets, ...snapshot.liabilities].some(row => row.status === 'fresh' && !fresh(row.observedAt, now));
  const limitation = [...(snapshot.reasons || []), ...(snapshot.accountingLimitations || [])];
  if (expired) limitation.push('Some initially fresh observations have expired; no current complete NAV is available.');
  const currentRows = rows => rows.map(row => row.status === 'fresh' && !fresh(row.observedAt, now) ? { ...row, status: 'stale' } : row);
  const assets = currentRows(snapshot.assets), liabilities = currentRows(snapshot.liabilities);
  const incomplete = expired || [...assets, ...liabilities].some(row => row.status !== 'fresh') || snapshot.allocationBlocked !== false;
  const subtotal = scope => assets.filter(row => row.status === 'fresh' && Number.isFinite(row.valueUsd) && (scope === 'combined' || row.scope === scope)).reduce((n, row) => n + row.valueUsd, 0)
    - liabilities.filter(row => row.status === 'fresh' && Number.isFinite(row.valueUsd) && (scope === 'combined' || row.scope === scope)).reduce((n, row) => n + row.valueUsd, 0);
  const cards = context.lp?.status === 'fresh' && fresh(context.lp.ts, now) ? context.lp.cards : null;
  const data = { ...snapshot, assets, liabilities, verifiedSubtotalUsd: subtotal('combined'),
    lpSummary: cards ? { open: cards.open, valueUsd: cards.value_usd, netUsd: cards.net_usd, unclaimedUsd: cards.unclaimed_usd } : null,
    scopes: Object.fromEntries(['main', 'vault', 'combined'].map(scope => [scope, { ...snapshot.scopes?.[scope], verifiedSubtotalUsd: subtotal(scope) }])),
    navUsd: incomplete ? null : snapshot.navUsd, allocationBlocked: incomplete,
    status: expired ? 'stale' : incomplete && snapshot.status === 'complete' ? 'partial' : snapshot.status };
  return { status: !incomplete && snapshot.status === 'complete' ? 'ready' : 'partial',
    data, stamps: snapshot.coverage?.filter(row => row.basis === 'live' && fresh(row.ts, now)).map(row => row.ts) || [],
    units: { value: 'USD', rawAmounts: 'integer smallest token units, with per-asset decimals' },
    assumptions: [snapshot.inclusionBasis || 'Each economic asset is counted once; look-through is not extra wealth.'], limitations: limitation };
}
function tokenAmount(row) {
  if (typeof row?.rawAmount === 'string' && /^\d{1,78}$/.test(row.rawAmount) && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36)
    return Number(BigInt(row.rawAmount)) / 10 ** row.decimals;
  return nonnegative(row?.amount);
}
function katExposure(context, now) {
  const snapshot = context?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.liabilities)) return blocked('Canonical holdings are required before measuring KAT exposure.');
  const limitations = [], components = [], historical = [], stamps = [], seen = new Set();
  const rates = (context?.lending?.markets || []).filter(row => row?.status === 'fresh' && fresh(row.ts, now) && Number.isFinite(row.avkat_rate) && row.avkat_rate > 0);
  const rate = rates.length && rates.every(row => Math.abs(row.avkat_rate - rates[0].avkat_rate) <= rates[0].avkat_rate * 1e-10) ? rates[0] : null;
  const representations = Array.isArray(snapshot.exposures) ? snapshot.exposures.filter(row => row?.symbol === 'KAT' && row.representationOf) : [];
  const add = (asset, kat, bucket, source) => {
    if (!Number.isFinite(kat) || kat < 0) { limitations.push('KAT amount unavailable for ' + asset.id); return; }
    components.push({ assetId: asset.id, symbol: asset.symbol, kind: asset.kind, bucket, katAmount: kat, observedAt: asset.observedAt, source });
    stamps.push(asset.observedAt);
  };
  for (const asset of snapshot.assets.slice(0, 250)) {
    if (!asset?.id) continue;
    if (seen.has(asset.id)) { limitations.push('Duplicate economic asset omitted: ' + asset.id); continue; }
    seen.add(asset.id);
    if (asset.representationOf) continue;
    const direct = ['KAT', 'avKAT', 'vKAT'].includes(asset.symbol), lp = asset.kind === 'lp';
    const look = representations.filter(row => row.representationOf === asset.id);
    const possiblyKatReward = asset.kind === 'reward' && (!asset.symbol || asset.symbol === 'KAT');
    if (!direct && !lp && !look.length && !possiblyKatReward) continue;
    if (asset.status !== 'fresh' || !fresh(asset.observedAt, now)) {
      historical.push({ assetId: asset.id, symbol: asset.symbol || null, observedAt: asset.observedAt, amount: tokenAmount(asset), reason: 'not_current' });
      limitations.push('Historical or unavailable KAT-related holding: ' + asset.id); continue;
    }
    const bucket = asset.kind === 'wallet' && asset.symbol === 'KAT' && !asset.restriction ? 'liquid' : asset.kind === 'reward' ? 'claimable'
      : asset.kind === 'locked' || asset.symbol === 'vKAT' ? 'locked' : 'encumbered';
    if (asset.symbol === 'KAT') { const n = tokenAmount(asset);
      if (asset.chain !== 'katana' || (asset.tokenAddress && asset.tokenAddress.toLowerCase() !== KAT_TOKEN)
        || (asset.kind === 'wallet' && !asset.tokenAddress)) { limitations.push('KAT token identity is unavailable for ' + asset.id); continue; }
      if (n !== null) add(asset, n, bucket, 'direct KAT units');
      else limitations.push('KAT units unavailable for ' + asset.id); continue; }
    if (look.length) {
      const freshLook = look.filter(row => row.status === 'fresh' && fresh(row.observedAt, now) && row.observedAt === asset.observedAt);
      const amounts = freshLook.map(tokenAmount);
      if (amounts.length && amounts.every(n => n !== null && n === amounts[0])) add(asset, amounts[0], bucket, 'verified KAT representation of this economic asset');
      else limitations.push('KAT look-through is incomplete or conflicting for ' + asset.id);
      continue;
    }
    if (asset.symbol === 'avKAT') {
      const n = tokenAmount(asset);
      if (rate && n !== null) { add(asset, n * rate.avkat_rate, bucket, 'fresh avKAT vault redemption rate'); stamps.push(rate.ts); }
      else limitations.push('A fresh verified avKAT redemption rate and token units are required for ' + asset.id);
      continue;
    }
    if (asset.symbol === 'vKAT') {
      const n = tokenAmount(asset);
      if (asset.metadata?.backingVerified === true && asset.metadata?.katBackingPerUnit === 1 && n !== null) add(asset, n, 'locked', 'verified locked KAT backing');
      else limitations.push('Verified KAT backing is unavailable for ' + asset.id);
      continue;
    }
    if (lp) {
      const p = asset.metadata, token0 = p?.raw?.token0, token1 = p?.raw?.token1;
      const katLegs = [token0, token1].filter(token => ['KAT', 'avKAT', 'vKAT'].includes(token?.symbol));
      if (!p?.amounts || !katLegs.length) {
        // A positively identified non-KAT pair contributes no KAT; unknown
        // metadata cannot prove the same zero exposure.
        if (!token0?.symbol || !token1?.symbol || katLegs.length) limitations.push('LP KAT look-through is unavailable for ' + asset.id);
      } else {
        let kat = 0, valid = asset.chain === 'katana';
        for (const leg of katLegs) {
          const n = nonnegative(p.amounts[leg.symbol]);
          if (n === null || !/^0x[0-9a-f]{40}$/i.test(leg.address || '')) valid = false;
          else if (leg.symbol === 'KAT' && leg.address.toLowerCase() === KAT_TOKEN) kat += n;
          else if (leg.symbol === 'avKAT' && rate) { kat += n * rate.avkat_rate; stamps.push(rate.ts); }
          else valid = false;
        }
        if (valid) add(asset, kat, 'encumbered', 'LP Book numeric underlying KAT amount; no extra NAV asset');
        else limitations.push('LP KAT token amount or redemption backing is unavailable for ' + asset.id);
      }
      continue;
    }
    if (possiblyKatReward) limitations.push('Aggregate claimable rewards cannot establish a KAT token amount.');
  }
  for (const debt of snapshot.liabilities.slice(0, 100)) {
    if (debt?.symbol !== 'KAT') continue;
    if (!debt.id || seen.has(debt.id)) { limitations.push('Duplicate KAT liability omitted.'); continue; }
    seen.add(debt.id);
    const n = tokenAmount(debt);
    if (debt.status !== 'fresh' || !fresh(debt.observedAt, now) || debt.metadata?.interestAccrued !== true || n === null) {
      limitations.push('Fresh accrued KAT debt is unavailable for ' + debt.id); continue;
    }
    add(debt, n, 'debt', 'accrued KAT loan units');
  }
  if (snapshot.status !== 'complete' || snapshot.allocationBlocked !== false) limitations.push('Portfolio coverage is incomplete; only a verified KAT subtotal is available.');
  const sum = bucket => components.filter(row => row.bucket === bucket).reduce((n, row) => n + row.katAmount, 0);
  const liquidKat = sum('liquid'), lockedKat = sum('locked'), encumberedKat = sum('encumbered'), claimableKat = sum('claimable'), debtKat = sum('debt');
  const verifiedGrossKat = liquidKat + lockedKat + encumberedKat + claimableKat;
  return { status: limitations.length ? 'partial' : 'ready', stamps, data: { verifiedGrossKat, verifiedDebtKat: debtKat,
    verifiedNetKat: verifiedGrossKat - debtKat, liquidKat, lockedKat, encumberedKat, claimableKat,
    completeExposureKat: limitations.length ? null : verifiedGrossKat - debtKat, allocationBlocked: limitations.length > 0,
    verifiedComponentCount: components.length, components, historical },
    units: { exposure: 'KAT-equivalent token units, not USD', liquid: 'unrestricted wallet KAT only' },
    assumptions: ['Each economic asset contributes once; receipt look-through replaces its parent representation.',
      'avKAT uses an observed vault redemption rate; the lending oracle ratio is not that conversion.',
      'Only KAT-denominated debt reduces KAT units; stablecoin debt is a separate liability.'],
    roundingPolicy: 'Raw token units preferred. LP/redemption exposure uses producer numeric amounts; these are exposure estimates, not transaction quantities.', limitations };
}

export async function runAgentTool(name, input = {}, { context = {}, policy = context.policy, now = Date.now } = {}) {
  const args = argsFor(name, input), at = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(at) || at <= 0) throw badInput('The calculation time could not be verified.');
  const type = ({ getPortfolioSnapshot: 'portfolio', getLendingRisk: 'lending', calculateTargetHealth: 'lending', getLPPosition: 'lp', getKATExposure: 'kat', analyzeLPRange: 'lp' })[name];
  const allowed = policy?.status === 'confirmed' ? policy.constraints?.allowedAnalysisTypes : null;
  if (Array.isArray(allowed) && !allowed.includes(type)) return result(name, args, context, policy, blocked('This analysis type is excluded by the confirmed agent policy.'));
  const detail = name === 'getPortfolioSnapshot' ? portfolio(context, at) : name === 'getLendingRisk' ? lendingRisk(args, context, at)
    : name === 'calculateTargetHealth' ? targetHealth(args, context, policy, at) : name === 'getLPPosition' ? lpPosition(args, context, at)
      : name === 'analyzeLPRange' ? analyzeLPRange(args, context, policy, at, lpCandidates(context).filter(p => positionIdentity({
        chain: p.chain, protocolContract: p.contract, positionId: p.positionId, owner: p.owner }))) : katExposure(context, at);
  return result(name, args, context, policy, detail);
}

function rawText(raw, decimals) {
  if (typeof raw !== 'string' || !/^\d{1,78}$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return 'unavailable';
  const digits = raw.padStart(decimals + 1, '0');
  return decimals ? (digits.slice(0, -decimals) + '.' + digits.slice(-decimals)).replace(/\.?0+$/, '') || '0' : digits;
}
export function renderAgentToolResult(output) {
  if (!output || output.schemaVersion !== AGENT_TOOL_SCHEMA_VERSION || !AGENT_TOOL_NAMES.includes(output.toolName))
    throw httpError(503, 'The verified tool result could not be rendered.', 'invalid_model_output');
  if (output.toolName === 'analyzeLPRange') return renderLPRangeAnalysis(output);
  const d = output.data || {}, lines = [];
  if (output.status === 'blocked') lines.push('I could not complete this check.');
  else if (output.toolName === 'calculateTargetHealth') {
    lines.push('For your ' + d.market + ' loan, your chosen target health is ' + agentNumber(d.target_health) + '.');
    if (d.status === 'repay') lines.push('To reach it, repay at least ' + rawText(d.repay_raw, d.loan_decimals) + ' ' + d.loan_token + '.');
    else if (d.status === 'borrow') lines.push('At that target, you could borrow up to ' + rawText(d.max_borrow_raw, d.loan_decimals) + ' more ' + d.loan_token + ', subject to the available market liquidity.');
    else lines.push('Your position is already at that target.');
    lines.push('Your current health is ' + agentNumber(d.current_health) + '.');
    if (d.policyCheck?.status === 'outside_market_limits') lines.push('This target falls outside your saved lending limits.');
  } else if (output.toolName === 'getLendingRisk') {
    for (const row of d.markets || []) {
      if (row.status !== 'ready') lines.push((row.market || 'This market') + ': I could not get a reliable current reading.');
      else if (row.noPosition) lines.push(row.market + ': no open loan.');
      else {
        const exactDebt = rawText(row.debtRaw, row.loanDecimals), debt = Number(exactDebt);
        lines.push(row.market + ': health ' + agentNumber(row.health) + ', LTV ' + agentNumber(row.ltv * 100, 2) + '%, with ' + (debt >= 0.000001 ? agentNumber(debt) : exactDebt) + ' ' + row.loanToken + ' borrowed.');
        if (row.liquidatable) lines.push('This loan is below its liquidation boundary at this reading. The exact on-chain calculation takes priority over the rounded health number.');
        if (row.sensitivity?.kind === 'kat-ratio' && Number.isFinite(row.sensitivity.oracleLiquidationPrice)) lines.push('With your balances unchanged, the liquidation boundary is an avKAT/KAT oracle ratio of ' + agentNumber(row.sensitivity.oracleLiquidationPrice, 6) + '. This is not a KAT dollar-price forecast.');
        else if (Number.isFinite(row.sensitivity?.conditionalKatUsdBoundary)) {
          lines.push('With your balances and other oracle inputs unchanged, the estimated KAT price at liquidation is ' + agentPrice(row.sensitivity.conditionalKatUsdBoundary) + '.');
          if (row.sensitivity.katPriceBasis === 'pool') lines.push('That estimate uses the pool price as a proxy. Morpho’s oracle controls actual liquidation.');
        }
      }
    }
  } else if (output.toolName === 'getPortfolioSnapshot') {
    const hasReading = output.status === 'ready' || [...(d.assets || []), ...(d.liabilities || [])].some(row => row.status === 'fresh' && Number.isFinite(row.valueUsd));
    lines.push(!hasReading ? 'I could not verify your current portfolio value.' : output.status === 'ready' ? 'Your portfolio is worth ' + agentMoney(d.navUsd) + '.' : 'I can currently account for ' + agentMoney(d.verifiedSubtotalUsd) + ' in your portfolio.');
    if (hasReading) for (const [scope, label] of [['main', 'Main wallet'], ['vault', 'Tiger Vault']]) {
      const verified = output.status === 'ready' || [...(d.assets || []), ...(d.liabilities || [])].some(row => row.scope === scope && row.status === 'fresh' && Number.isFinite(row.valueUsd));
      lines.push(label + ': ' + (verified ? agentMoney(d.scopes?.[scope]?.verifiedSubtotalUsd) : 'not available in this reading') + '.');
    }
    if (d.lpSummary && Number.isSafeInteger(d.lpSummary.open)) lines.push('You have ' + d.lpSummary.open + ' open LP position' + (d.lpSummary.open === 1 ? '' : 's')
      + (Number.isFinite(d.lpSummary.netUsd) ? ', with a net result of ' + agentMoney(d.lpSummary.netUsd) : '')
      + (Number.isFinite(d.lpSummary.unclaimedUsd) ? ' and ' + agentMoney(d.lpSummary.unclaimedUsd) + ' still to claim' : '') + '.');
  } else if (output.toolName === 'getLPPosition') {
    const label = String(d.id || d.positionId || '');
    lines.push('Your ' + (d.chain || '') + ' LP' + (label.length <= 80 ? ' #' + label : '') + ' is worth ' + agentMoney(d.principalUsd) + ' before fees and rewards.');
    if (typeof d.inRange === 'boolean') lines.push(d.inRange ? 'The price is inside your chosen range.' : 'The price is outside your chosen range.');
    if (d.accounting?.stakedTradingFeesToDao) lines.push('Staked Sushi trading fees go to the DAO; they are not owner earnings.');
  } else if (output.toolName === 'getKATExposure') {
    if (!d.verifiedComponentCount && output.status !== 'ready') lines.push('I could not verify your current KAT holdings.');
    else {
      lines.push('Your ' + (output.status === 'ready' ? '' : 'currently verified ') + 'net exposure is ' + agentNumber(d.verifiedNetKat) + ' KAT after subtracting ' + agentNumber(d.verifiedDebtKat) + ' KAT of debt.');
      lines.push('Available in your wallet: ' + agentNumber(d.liquidKat) + ' KAT.\nLocked: ' + agentNumber(d.lockedKat) + ' KAT.\nCommitted to positions: ' + agentNumber(d.encumberedKat) + ' KAT.\nRewards to claim: ' + agentNumber(d.claimableKat) + ' KAT.');
    }
  }
  lines.push(...friendlyAgentNotes(output.limitations, { partial: output.status === 'partial', blocked: output.status === 'blocked',
    kind: ({ getPortfolioSnapshot: 'portfolio', getKATExposure: 'kat' })[output.toolName] || '' }));
  const stamp = agentReadingTime(output.observedAt); if (stamp) lines.push('\nReading: ' + stamp + '.');
  return lines.join('\n');
}
