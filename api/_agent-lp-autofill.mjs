/* Automatic LP scenario inputs. Observations, derived values and illustrative
   assumptions retain separate provenance; the model supplies none of them. */
import { createHash } from 'node:crypto';
import { runAgentTool } from './_agent-tools.mjs';
import { priceAtTick } from '../strategy-core.mjs';
import { validateAgentComparison } from './_agent-scenarios.mjs';
import { readAgentJSON } from './_agent-context.mjs';
import { httpError } from './_agent-http.mjs';

const fresh = (stamp, now) => Number.isFinite(Date.parse(stamp)) && now - Date.parse(stamp) >= -30000 && now - Date.parse(stamp) < 90000;
const finite = value => Number.isFinite(value) && value >= 0 && value < 1e12;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const FIELDS = ['horizonDays', 'cashUsd', 'gasUsd', 'widenFactor', 'lowerPrice', 'upperPrice', 'paths', 'rewardEligible',
  'rewardPriceUsd', 'competingLiquidityMultiplier', 'borrowingCostUsd', 'useObservedRates', 'swapFeeBps', 'slippageBps',
  'thesis', 'catalysts', 'invalidationConditions', 'evidenceIds', 'reviewAt'];
const keyFor = p => 'lp:' + createHash('sha256').update(JSON.stringify([p.chain, p.owner?.toLowerCase(), p.contract?.toLowerCase(), String(p.positionId || p.id)])).digest('hex').slice(0, 40);

export function validateAutomaticLP(value, { optional = false } = {}) {
  if (!plain(value) || Object.keys(value).some(key => !['positionKey', 'overrides'].includes(key))
    || (!optional && typeof value.positionKey !== 'string') || (value.positionKey != null && !/^lp:[a-f0-9]{40}$/.test(value.positionKey))
    || (value.overrides != null && (!plain(value.overrides) || Object.keys(value.overrides).some(key => !FIELDS.includes(key)))))
    throw httpError(400, 'Choose a detected open LP and valid scenario adjustments.');
  // Validate override types/bounds with the existing comparison grammar, before
  // any network request. Identity always comes from the detected-position key.
  if (value.overrides) validateAgentComparison({ kind: 'lp', horizonDays: 7, ...value.overrides });
  return { ...(value.positionKey ? { positionKey: value.positionKey } : {}), overrides: value.overrides || {} };
}

export function detectedLPPositions(context, now = Date.now()) {
  const rows = [], seen = new Set(), pools = [...(context.strategy?.pools || []), ...(context.strategy?.fee_pools || [])];
  for (const row of (context.lp?.positions || []).slice(0, 30)) {
    const p = row.canonical;
    if (!p || /closed|exited/i.test(row.status || '') || p.status !== 'observed' || !finite(p.principalUsd) || p.principalUsd <= 0
      || !/^0x[0-9a-f]{40}$/i.test(p.owner || '') || !/^\d+$/.test(String(p.positionId || p.id))) continue;
    const key = keyFor(p); if (seen.has(key)) continue; seen.add(key);
    const pool = pools.find(item => item.pool?.toLowerCase() === p.pool?.toLowerCase() && (item.chain || 'katana') === p.chain);
    const available = context.lp.status === 'fresh' && fresh(p.observedAt, now) && (p.chain === 'katana' || pool?.accounting?.valuationBlockPinned === true)
      && !!pool && pool.status === 'fresh' && fresh(pool.ts, now) && !!p.raw && /^\d+$/.test(p.raw.liquidity || '') && BigInt(p.raw.liquidity) > 0n;
    rows.push({ key, positionId: String(p.positionId || p.id), chain: p.chain, owner: p.owner, pair: row.pair || p.protocol || 'LP',
      principalUsd: p.principalUsd, available, reason: available ? null : p.chain !== 'katana'
        ? 'Verified comparison pool data is currently available for configured Katana pools.' : 'Fresh LP and pool metadata are required.',
      observedAt: p.observedAt });
  }
  return rows.sort((a,b) => Number(b.available) - Number(a.available) || b.principalUsd - a.principalUsd);
}

export async function prepareAutomaticLP({ context, policy, request = {}, origin, fetcher = fetch, now = Date.now(),
  readFunding = async selected => readAgentJSON(origin + '/api/strategy?' + new URLSearchParams({ view: 'lp-funding',
    chain: selected.chain, owner: selected.owner }), { fetcher, timeoutMs: 8000, maxBytes: 32000 }) } = {}) {
  const spec = validateAutomaticLP(request, { optional: true }), positions = detectedLPPositions(context, now);
  const selected = spec.positionKey ? positions.find(row => row.key === spec.positionKey) : positions.find(row => row.available) || positions[0];
  const base = { schemaVersion: 'agent-lp-autofill-v1', positions, position: selected || null, inputs: null, fieldSources: {},
    policyVersion: policy.version, snapshotId: context.snapshot?.snapshotId || null, createdAt: new Date(now).toISOString(), notes: [] };
  if (spec.positionKey && !selected) throw httpError(409, 'This LP is no longer in the current open positions. Refresh the detected positions.');
  if (!selected) return { ...base, status: context.lp?.status === 'fresh' ? 'empty' : 'unavailable',
    notes: [context.lp?.status === 'fresh' ? 'No open LPs were found in the current reading.' : 'Open LPs could not be refreshed. Try Refresh live inputs.'] };
  if (!selected.available) return { ...base, status: 'unavailable', notes: [selected.reason] };
  const positionResult = await runAgentTool('getLPPosition', { positionId: selected.positionId, chain: selected.chain, owner: selected.owner }, { context, policy, now });
  if (positionResult.status === 'blocked') return { ...base, status: 'unavailable', notes: positionResult.limitations };
  const p = positionResult.data, pool = [...context.strategy.pools, ...(context.strategy.fee_pools || [])].find(row => row.pool?.toLowerCase() === p.pool?.toLowerCase() && (row.chain || 'katana') === p.chain);
  if (![p.raw.lowerTick,p.raw.upperTick].every(tick => Number.isInteger(tick) && Math.abs(tick) <= 887272)
    || p.raw.lowerTick >= p.raw.upperTick || ![0,1].includes(pool.baseIndex)
    || ![0,1].every(index => p.raw['token'+index]?.address?.toLowerCase() === pool['token'+index]?.address?.toLowerCase()
      && p.raw['token'+index]?.decimals === pool['token'+index]?.decimals))
    return { ...base, status: 'unavailable', notes: ['LP and pool token identities or range units do not match.'] };
  const range = await runAgentTool('analyzeLPRange', { positionId: selected.positionId, chain: selected.chain, owner: selected.owner }, { context, policy, now });
  if (['units','price_mismatch'].includes(range.data?.reason)) return { ...base, status: 'unavailable', notes: range.limitations };
  const a = priceAtTick(p.raw.lowerTick, pool), b = priceAtTick(p.raw.upperTick, pool);
  if (![a,b,pool.price].every(value => finite(value) && value > 0)) return { ...base, status: 'unavailable', notes: ['The current LP range could not be valued.'] };
  const currentRange = { lowerPrice: Math.min(a,b), upperPrice: Math.max(a,b) }, proposed = range.data?.startingPoint || currentRange;
  const horizonDays = policy.status === 'confirmed' && Number.isInteger(policy.constraints?.horizonDays) ? policy.constraints.horizonDays : 7;
  let funding = null;
  try { funding = await readFunding(selected); } catch { base.notes.push('Wallet cash and gas estimates could not be refreshed.'); }
  const fundingCurrent = funding?.schemaVersion === 'agent-lp-funding-v1' && funding.owner?.toLowerCase() === selected.owner.toLowerCase()
    && funding.chain === selected.chain && Number.isSafeInteger(funding.block) && funding.block >= 0 && fresh(funding.observedAt, now);
  const cash = fundingCurrent && funding.cashComplete === true && finite(funding.cashUsd) ? funding.cashUsd : null;
  const gas = fundingCurrent && finite(funding.gasUsd) && Number.isSafeInteger(funding.gasUnits) && funding.gasUnits > 0
    && /^\d{1,78}$/.test(funding.gasPriceWei || '') && finite(funding.nativePriceUsd) && funding.nativePriceUsd > 0
    && fresh(funding.priceObservedAt, now) ? funding.gasUsd : null;
  const eligible = pool.kind === 'rewards' ? p.staked === true && pool.campaign?.active === true : false;
  const factors = eligible ? [0, 1] : [1];
  const inputs = { kind: 'lp', horizonDays, positionId: selected.positionId, chain: selected.chain, owner: selected.owner,
    cashUsd: cash, gasUsd: gas, widenFactor: 2, lowerPrice: proposed.lowerPrice, upperPrice: proposed.upperPrice,
    rewardEligible: eligible, rewardPriceUsd: finite(context.strategy.kat_usd) ? context.strategy.kat_usd : null,
    competingLiquidityMultiplier: 1, borrowingCostUsd: 0, comparisonBasis: 'before_financing', useObservedRates: true,
    swapFeeBps: pool.fee / 100, slippageBps: 50,
    paths: [-10, 0, 10].flatMap(move => factors.map(factor => ({ label: move + '% price · incentives ×' + factor,
      points: [{ day: 0, ratio: 1 }, { day: horizonDays, ratio: 1 + move / 100 }], rewardFactor: factor }))),
    ...spec.overrides };
  if (spec.overrides.horizonDays != null && !Object.hasOwn(spec.overrides, 'paths'))
    inputs.paths.forEach(path => { path.points.at(-1).day = inputs.horizonDays; });
  if (Object.hasOwn(spec.overrides, 'borrowingCostUsd')) delete inputs.comparisonBasis;
  validateAgentComparison(inputs);
  const sources = {};
  const source = (fields, basis, label, observedAt) => { for (const field of fields) sources[field] = { basis, label, ...(observedAt ? { observedAt } : {}) }; };
  source(['positionId', 'chain', 'owner'], 'observed', 'Current LP ownership and position identity', p.observedAt);
  source(['rewardEligible'], 'scenario', 'Assume the current staking state continues under the active campaign', p.observedAt);
  source(['swapFeeBps', 'rewardPriceUsd'], 'observed', 'Current pool fee tier and KAT quote', pool.ts);
  source(['lowerPrice', 'upperPrice'], 'derived', range.data?.startingPoint ? 'Historical range comparison' : 'Current position range', pool.ts);
  source(['cashUsd'], cash === null ? 'unavailable' : 'derived', 'Observed same-wallet stablecoin balances, valued at $1', fundingCurrent ? funding.observedAt : null);
  source(['gasUsd'], gas === null ? 'unavailable' : 'estimate', '2,000,000 gas units at the observed gas price and native-token quote', fundingCurrent ? funding.observedAt : null);
  source(['horizonDays'], policy.constraints?.horizonDays ? 'policy' : 'scenario', policy.constraints?.horizonDays ? 'Saved policy horizon' : 'Illustrative seven-day comparison');
  source(['paths', 'widenFactor', 'competingLiquidityMultiplier', 'useObservedRates', 'slippageBps', 'borrowingCostUsd'], 'scenario',
    'Illustrative price cases, twice-current width, unchanged competition/rates, 0.5% slippage and values before financing');
  for (const field of Object.keys(spec.overrides)) source([field], 'owner', 'Your scenario adjustment');
  return { ...base, inputs, fieldSources: sources, status: finite(inputs.cashUsd) && finite(inputs.gasUsd) ? 'ready' : 'partial',
    currentRange, currentPrice: pool.price, priceUnit: pool.quote + ' per ' + pool.base,
    proposedRangeBasis: range.data?.startingPoint ? 'history' : 'current_range',
    validUntil: new Date(Math.min(Date.parse(p.observedAt), Date.parse(pool.ts), fundingCurrent ? Date.parse(funding.observedAt) : now) + 90000).toISOString(),
    funding: fundingCurrent ? funding : null, notes: [...base.notes, ...(fundingCurrent ? funding.notes || [] : []),
      'Price moves are illustrative scenarios; current rates and staking eligibility are carried forward as assumptions.',
      ...(inputs.comparisonBasis === 'before_financing' ? ['Automatic scenarios show values before borrowing costs. Portfolio lending is not allocated to this LP.']
        : ['Borrowing costs use your explicit scenario adjustment.']),
      ...(range.data?.startingPoint ? [] : ['Historical range selection is unavailable; the proposed band uses the current range.'])] };
}
