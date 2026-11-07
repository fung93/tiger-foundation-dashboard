/* Bounded read-only views for the conversational agent. Calculations come from
   the same Morpho functions as Lending; failed sources never become zeroes. */
import { MARKETS, WALLET, targetMetrics, liquidationMetrics } from '../morpho-core.mjs';
import { buildPortfolioSnapshot, comparablePortfolioPerformance } from '../portfolio-core.mjs';
import { summary as katTradeSummary, reconcile as reconcileKatTrades } from '../kat-core.mjs';
import { agentMoney, agentNumber, agentReadingTime } from '../agent-language.mjs';

const numeric = value => Number.isFinite(value) ? value : null;
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, limit) : null;
const iso = value => {
  const ts = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ts) && ts > 0 && Number.isFinite(new Date(ts).getTime()) ? new Date(ts).toISOString() : null;
};
const clockValue = now => typeof now === 'function' ? now() : now;
const freshAt = (ts, now) => ts && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) <= 90000;
const defaults = { 'avkat-kat': .70, 'avkat-usdc': .35, 'kat-usdc': .35 };
export const AGENT_OPTIONAL_CONTEXT_SCHEMA = 'agent-optional-context-v1';
const optionalPaths = Object.freeze({ strategy: '/api/strategy', kat: '/api/kat-trades', vkat: '/api/vkat' });
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const boundedIso = value => {
  const at = typeof value === 'number' ? value < 1e12 ? value * 1000 : value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 && at < 8640000000000000 ? new Date(at).toISOString() : null;
};
function requestedNeeds(needs) {
  if (!Array.isArray(needs) || needs.length > 3 || needs.some(name => typeof name !== 'string' || !Object.hasOwn(optionalPaths, name)))
    throw new Error('Choose only supported optional agent sources.');
  return [...new Set(needs)];
}
function validOrigin(origin) {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('A valid dashboard origin is required.');
  return url.origin;
}
function optionalBase(name, sample, now, freshForMs = 90000) {
  const ts = boundedIso(sample?.at), headTs = boundedIso(sample?.head_ts);
  const recent = stamp => !!stamp && now - Date.parse(stamp) >= -30000 && now - Date.parse(stamp) < freshForMs;
  const valid = record(sample) && !sample.error && !!ts && record(sample.health) && Array.isArray(sample.health.notes);
  const current = valid && recent(ts) && (name === 'strategy' || (integer(sample.head) !== null && recent(headTs)));
  const notesIncomplete = valid && (sample.health.notes.length > 10 || sample.health.notes.some(note => typeof note !== 'string'));
  return { schemaVersion: AGENT_OPTIONAL_CONTEXT_SCHEMA, source: optionalPaths[name], ts,
    status: valid ? current ? 'fresh' : 'stale' : 'unavailable', freshForMs,
    validUntil: valid && ts ? new Date(Math.min(Date.parse(ts), headTs ? Date.parse(headTs) : Infinity) + freshForMs).toISOString() : null,
    block: null, headBlock: name === 'strategy' ? null : integer(sample?.head), headTs,
    valuationBlockStatus: 'not_pinned_by_source', ledgerTo: boundedIso(sample?.ledger_to),
    notes: valid ? sample.health.notes.slice(0, 10).map(note => text(note, 240)).filter(Boolean) : [],
    coverage: { complete: false, omitted: notesIncomplete }, limitations: !valid ? ['The optional source schema or reading time is unavailable.']
      : notesIncomplete ? ['Some source health notes exceeded the compact context or could not be represented.'] : [] };
}
const pickNumbers = (value, keys) => Object.fromEntries(keys.map(key => [key, numeric(value?.[key])]));
function compactStrategyPool(row, kind, ts, sourceCurrent, now) {
  const token = value => ({ address: address(value?.address), symbol: text(value?.symbol, 40),
    decimals: integer(value?.decimals) !== null && value.decimals <= 36 ? value.decimals : null, usd: positive(value?.usd) });
  const token0 = token(row?.token0), token1 = token(row?.token1), limitations = [];
  const valid = record(row) && address(row.pool) && token0.address && token1.address
    && token0.decimals !== null && token1.decimals !== null && token0.symbol && token1.symbol
    && Number.isInteger(row.tick) && Math.abs(row.tick) <= 887272 && Number.isInteger(row.tickSpacing) && row.tickSpacing > 0 && row.tickSpacing <= 32767
    && positive(row.sqrtPrice) !== null && nonnegative(row.activeLiquidity) !== null && integer(row.fee) !== null && row.fee <= 1000000;
  if (!valid) return null;
  const rules = { ...pickNumbers(row.rules, ['weightFees', 'weightToken0', 'weightToken1']),
    outOfRange: typeof row.rules?.outOfRange === 'boolean' ? row.rules.outOfRange : null };
  const campaign = kind === 'rewards' ? { start: integer(row.campaign?.start), end: integer(row.campaign?.end) } : null;
  if (campaign) campaign.active = !!(campaign.start && campaign.end && campaign.start * 1000 <= now && campaign.end * 1000 > now);
  const eligible = kind === 'rewards' ? pickNumbers(row.eligible, ['liquidity', 'amount0', 'amount1', 'positions', 'inRange', 'vaults', 'holders']) : null;
  const fees = kind === 'fees' ? pickNumbers(row.fees, ['usd_per_day', 'volume_usd_per_day', 'window_days', 'usd_24h', 'volume_usd_24h']) : null;
  if (token0.usd === null || token1.usd === null || positive(row.price) === null) limitations.push('Token valuation is incomplete.');
  if (kind === 'rewards' && (!campaign.start || !campaign.end || campaign.end <= campaign.start
    || nonnegative(row.katPerDay) === null || nonnegative(eligible.liquidity) === null || integer(eligible.holders) === null
    || [rules.weightFees, rules.weightToken0, rules.weightToken1].some(weight => weight === null || weight < 0 || weight > 10000)
    || rules.outOfRange === null)) limitations.push('Campaign eligibility or reward-rate inputs are incomplete.');
  if (campaign && !campaign.active) limitations.push('The reported reward period is not active at this reading.');
  if (kind === 'fees' && (nonnegative(fees.usd_per_day) === null || positive(fees.window_days) === null)) limitations.push('Observed trading fee inputs are incomplete.');
  const recent = Object.fromEntries([7, 14, 21, 30].map(days => [days, record(row.recent?.[days]) ? {
    ...pickNumbers(row.recent[days], ['low', 'high', 'lowTick', 'highTick', 'swaps']), complete: row.recent[days].complete === true,
  } : null]));
  return { pool: address(row.pool), kind, status: sourceCurrent ? limitations.length ? 'partial' : 'fresh' : 'stale', ts,
    token0, token1, tick: row.tick, tickSpacing: row.tickSpacing, sqrtPrice: row.sqrtPrice, activeLiquidity: row.activeLiquidity,
    fee: row.fee, fee_tier: numeric(row.fee_tier), fee_protocol: integer(row.fee_protocol),
    baseIndex: [0, 1].includes(row.baseIndex) ? row.baseIndex : null, base: text(row.base, 40), quote: text(row.quote, 40), price: positive(row.price),
    apr: numeric(row.apr), tvl: nonnegative(row.tvl), tvl_usd: nonnegative(row.tvl_usd),
    campaign, kat: nonnegative(row.kat), katPerDay: nonnegative(row.katPerDay), rules, eligible, fees,
    balances: kind === 'fees' ? pickNumbers(row.balances, ['amount0', 'amount1']) : null,
    staked_usd: pickNumbers(row.staked_usd, ['in_range', 'all']), recent,
    accounting: { projectedRewardsAreAssumptions: true, carryExcludedFromApr: true,
      stakedTradingFeesToDao: kind === 'rewards', independentValuationBlockUnavailable: true }, limitations };
}
function strategyView(sample, now) {
  const out = optionalBase('strategy', sample, now);
  out.scope = 'configured_strategy_pools';
  out.pools = []; out.fee_pools = [];
  if (out.status === 'unavailable' || !Array.isArray(sample?.pools) || !Array.isArray(sample?.fee_pools)) {
    out.status = 'unavailable'; out.limitations.push('Current strategy pool collections are unavailable.'); return out;
  }
  for (const [field, kind, limit] of [['pools', 'rewards', 12], ['fee_pools', 'fees', 8]]) {
    out[field] = sample[field].slice(0, limit).map(row => compactStrategyPool(row, kind, out.ts, out.status === 'fresh', now)).filter(Boolean);
    if (sample[field].length > limit) { out.coverage.omitted = true; out.limitations.push('Additional configured pools were omitted from the bounded context.'); }
    if (out[field].length !== Math.min(sample[field].length, limit)) out.limitations.push('Some pool identities or numeric state could not be validated.');
  }
  out.notes = out.notes.filter(note => !/^Katana Perps could not be read/i.test(note));
  out.epoch = boundedMetric(sample.epoch); out.reward = pickNumbers(sample.reward, ['start', 'end']);
  out.total = pickNumbers(sample.total, ['kat', 'katPerDay']); out.kat_usd = positive(sample.kat_usd);
  out.coverage.complete = !out.coverage.omitted && !out.limitations.length && !out.notes.length
    && [...out.pools, ...out.fee_pools].every(pool => pool.status === 'fresh');
  if (out.status === 'fresh' && !out.coverage.complete) out.status = 'partial';
  return out;
}
function katView(sample, now) {
  const out = optionalBase('kat', sample, now, 75000);
  out.scope = 'both_wallets_trading_book_and_observed_wallet_balance';
  out.price_usd = positive(sample?.price_usd); out.wallet_kat = nonnegative(sample?.wallet_kat);
  out.priceCoverage = { status: out.price_usd === null ? 'unavailable' : out.status === 'fresh' ? 'observed' : 'stale',
    basis: 'Latest KAT/vbUSDC pool quote; no pinned price block is supplied.', block: null };
  out.walletCoverage = { complete: false, balanceObserved: out.status === 'fresh' && out.wallet_kat !== null,
    rawAmountsAvailable: false, valuationBlockPinned: false, scope: 'combined_wallets',
    basis: 'Latest aggregate wallet balance; separate from the tracked trade-book quantity.',
    reason: 'The producer exposes no per-wallet raw balance or full return-data attestation.' };
  out.trades = []; out.waiting = []; out.summary = null; out.reconciliation = null;
  if (out.status === 'unavailable' || !Array.isArray(sample?.trades) || !Array.isArray(sample?.waiting)) {
    out.status = 'unavailable'; out.limitations.push('Current KAT trade and pending-deposit collections are unavailable.'); return out;
  }
  const validTrade = trade => record(trade) && ['buy', 'sell'].includes(trade.side) && positive(trade.kat) !== null
    && positive(trade.usd) !== null && integer(trade.block) !== null && integer(trade.ts) !== null
    && typeof trade.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(trade.hash)
    && (!trade.fees || nonnegative(trade.fees.usd) !== null);
  const startValid = record(sample.start) && integer(sample.start.block) !== null && boundedIso(sample.start.ts) !== null;
  const completeTrades = startValid && sample.trades.length <= 500 && sample.trades.every(validTrade)
    && new Set(sample.trades.map(trade => trade.hash.toLowerCase())).size === sample.trades.length;
  out.trades = sample.trades.slice(-12).filter(validTrade).map(trade => ({ side: trade.side, kat: trade.kat, usd: trade.usd,
    block: trade.block, ts: boundedIso(trade.ts), hash: text(trade.hash, 66), wallet: address(trade.wallet), fees_usd: numeric(trade.fees?.usd) }));
  out.waiting = sample.waiting.slice(0, 8).map(item => ({ kat: nonnegative(item?.kat), ts: boundedIso(item?.ts), hash: text(item?.hash, 66) }));
  out.start = record(sample.start) ? { block: integer(sample.start.block), ts: boundedIso(sample.start.ts) } : null;
  out.flows = pickNumbers(sample.flows, ['rewards', 'avkat', 'morpho', 'vkat']); out.start_kat = nonnegative(sample.start_kat);
  out.historyCoverage = { complete: completeTrades, totalTrades: sample.trades.length, shownTrades: out.trades.length,
    basis: 'Trades since the producer tracking start; historical entries retain booked prices and fees.' };
  if (completeTrades && out.price_usd !== null) {
    const summary = katTradeSummary(sample.trades, out.price_usd);
    out.summary = { ...pickNumbers(summary, ['qty', 'cost', 'realized', 'avg', 'value', 'unrealized', 'total', 'fees']),
      bought: pickNumbers(summary.bought, ['n', 'kat', 'usd']), sold: pickNumbers(summary.sold, ['n', 'kat', 'usd']) };
    if (['qty', 'cost', 'realized', 'value', 'unrealized', 'total', 'fees'].some(key => !Number.isFinite(summary[key]))) {
      out.summary = null; out.limitations.push('Trade-book arithmetic could not be represented safely.');
    } else if (out.wallet_kat !== null && out.start_kat !== null && Object.values(out.flows).every(Number.isFinite)) {
      const reconciliation = reconcileKatTrades(sample.trades, out.flows, out.start_kat, out.wallet_kat);
      if (Object.values(reconciliation).every(Number.isFinite)) out.reconciliation = reconciliation;
    }
  }
  if (!completeTrades) out.limitations.push('The full trade history cannot be validated within the compact adapter budget; no all-time totals were calculated from a truncated history.');
  if (out.price_usd === null) out.limitations.push('A current KAT market price is unavailable.');
  if (out.wallet_kat === null) out.limitations.push('One or both wallet balances could not be read; unknown holdings are not zero.');
  else out.limitations.push(out.walletCoverage.reason);
  if (!out.reconciliation) out.limitations.push('Wallet-versus-trade-book reconciliation is unavailable.');
  if (sample.waiting.length > 8) { out.coverage.omitted = true; out.limitations.push('Additional pending deposits were omitted from the bounded context.'); }
  out.coverage.complete = out.status === 'fresh' && !out.limitations.length && !out.notes.length && completeTrades && out.walletCoverage.complete;
  if (out.status === 'fresh' && !out.coverage.complete) out.status = 'partial';
  return out;
}
function vkatView(sample, now) {
  const out = optionalBase('vkat', sample, now);
  out.scope = 'observed_locks_votes_and_historical_vote_rewards'; out.locks = []; out.standing = []; out.epochs = [];
  out.locksCoverage = { complete: false, confirmedEmpty: false, reason: 'The producer does not attest complete wallet enumeration; failed reads may omit a lock.' };
  if (out.status === 'unavailable' || !Array.isArray(sample?.locks) || !Array.isArray(sample?.standing)
    || !record(sample?.book) || !Array.isArray(sample.book.epochs)) {
    out.status = 'unavailable'; out.limitations.push('The current lock/vote response schema is unavailable.'); return out;
  }
  out.kat_usd = positive(sample.kat_usd); out.epoch = integer(sample.epoch); out.vote_week = boundedMetric(sample.vote_week);
  out.locks = sample.locks.slice(0, 20).filter(lock => record(lock) && address(lock.wallet) && integer(lock.id) !== null)
    .map(lock => ({ wallet: address(lock.wallet), id: lock.id, kat: nonnegative(lock.kat), power: nonnegative(lock.power), since: boundedIso(lock.since) }));
  out.standing = sample.standing.slice(0, 12).filter(vote => address(vote?.gauge) && nonnegative(vote.votes) !== null)
    .map(vote => ({ gauge: address(vote.gauge), votes: vote.votes, poolLabel: text(sample.pools?.[vote.gauge], 100) }));
  out.book = { ...pickNumbers(sample.book, ['total_usd', 'voted', 'rate', 'apr']), claimed: typeof sample.book.claimed === 'boolean' ? sample.book.claimed : null,
    tokens: boundedMetric(sample.book.tokens), tokens_usd: boundedMetric(sample.book.tokens_usd),
    status: out.notes.length || out.coverage.omitted || nonnegative(sample.book.total_usd) === null ? 'partial' : 'historical',
    basis: 'Historical vote rewards retain their recorded payout prices; this is not current unclaimed wealth.' };
  out.epochs = sample.book.epochs.slice(-8).map(epoch => ({ ...pickNumbers(epoch, ['epoch', 'at', 'total', 'usd', 'kat_usd', 'value_usd', 'apr', 'cumulative']),
    settled: epoch?.settled === true, rewards: boundedMetric(epoch?.rewards),
    pools: Array.isArray(epoch?.pools) ? epoch.pools.slice(0, 6).map(pool => ({ gauge: address(pool?.gauge), votes: nonnegative(pool?.votes) })) : [] }));
  out.network = record(sample.network) ? { ...pickNumbers(sample.network, ['locked', 'locks', 'kat_supply', 'avkat_supply', 'avkat_kat', 'avkat_rate', 'avkat_rate_7d']),
    block: out.headBlock, ts: out.headTs, basis: 'Network totals and avKAT redemption read at the reported chain head.',
    status: out.status === 'fresh' ? 'observed' : 'stale',
    inclusionBasis: 'avkat_kat is already part of locked KAT; it is not an additional asset.' } : null;
  if (!out.network) out.limitations.push('Current Katana network totals are unavailable.');
  else if (['locked', 'locks', 'kat_supply', 'avkat_supply', 'avkat_kat'].some(key => nonnegative(out.network[key]) === null)
    || positive(out.network.avkat_rate) === null || out.network.avkat_kat > out.network.locked) {
    out.network.status = 'partial'; out.limitations.push('Some network totals or the avKAT redemption ratio are unavailable or inconsistent.'); }
  out.limitations.push(out.locksCoverage.reason);
  if (sample.locks.length > 20 || sample.standing.length > 12 || sample.book.epochs.length > 8) out.coverage.omitted = true;
  out.coverage.complete = false;
  if (out.status === 'fresh') out.status = 'partial';
  return out;
}

/** Explicit optional reads only. This stage runs after the four base reads and
 * performs at most three requests, keeping outgoing concurrency below six. */
export async function loadAgentSupplementalContext({ origin, needs = [], context = {}, fetcher = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  const selected = requestedNeeds(needs), base = validOrigin(origin), at = clockValue(now);
  if (!Number.isFinite(at)) throw new Error('A valid agent reading time is required.');
  const results = await Promise.allSettled(selected.map(name => readAgentJSON(base + optionalPaths[name],
    { fetcher, timeoutMs, maxBytes: 350000, init: { redirect: 'manual' } })));
  const views = {};
  for (let i = 0; i < selected.length; i++) {
    const sample = results[i].status === 'fulfilled' ? results[i].value : null, name = selected[i];
    views[name] = ({ strategy: strategyView, kat: katView, vkat: vkatView })[name](sample, at);
  }
  // Drop whole optional records, never text or partial numeric facts, when their
  // aggregate representation exceeds the explicit compact-context byte budget.
  const bytes = () => new TextEncoder().encode(JSON.stringify(views)).byteLength;
  while (bytes() > 40000) {
    const arrays = Object.values(views).flatMap(view => ['pools', 'fee_pools', 'trades', 'waiting', 'locks', 'standing', 'epochs']
      .filter(key => Array.isArray(view[key]) && view[key].length).map(key => ({ view, key })));
    if (!arrays.length) throw new Error('Optional agent context exceeds its compact budget.');
    arrays.sort((a, b) => JSON.stringify(b.view[b.key]).length - JSON.stringify(a.view[a.key]).length);
    const { view, key } = arrays[0]; view[key].pop(); view.coverage.complete = false; view.coverage.omitted = true;
    if (view.status === 'fresh') view.status = 'partial';
    const reason = 'Additional records were omitted from the bounded optional context.';
    if (!view.limitations.includes(reason)) view.limitations.push(reason);
  }
  const sources = (context.sources || []).filter(source => !selected.includes(source?.name));
  sources.push(...selected.map(name => ({ name, status: views[name].status, ts: views[name].ts,
    validUntil: views[name].validUntil, coverageComplete: views[name].coverage.complete })));
  return { ...context, ...views, sources };
}

export async function readAgentJSON(url, { fetcher = fetch, timeoutMs = 15000, maxBytes = 1000000, init = {} } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('The agent data request timed out.')); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(url, { ...init, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('The agent data source is unavailable.');
      const length = Number(response.headers?.get?.('content-length'));
      if (length > maxBytes) throw new Error('The agent data response is too large.');
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) { await reader.cancel(); throw new Error('The agent data response is too large.'); }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(bytes));
      }
      const value = await response.json();
      if (JSON.stringify(value).length > maxBytes) throw new Error('The agent data response is too large.');
      return value;
    })()]);
  } finally { clearTimeout(timer); controller.abort(); }
}

function lendingView(sample, now) {
  if (!sample || !Array.isArray(sample.markets)) return { status: 'unavailable', ts: null, block: null, markets: [] };
  const ts = iso(sample.ts), current = freshAt(ts, now), markets = MARKETS.map(m => {
    const source = sample.markets.find(row => row && typeof row === 'object' && row.id === m.id);
    if (!source || source.error) return { ...m, status: 'unavailable', ts, error: 'This market could not be read.', health: null, ltv: null, debt_amount: null };
    const fields = ['collateral_amount', 'debt_amount', 'collateral_usd', 'debt_usd', 'oracle_collateral_usd',
      'liquidation_debt_amount', 'liquidation_usd', 'health', 'ltv', 'oracle_price', 'loan_usd', 'collateral_price_usd',
      'avkat_rate', 'kat_price_usd', 'kat_oracle_price_usd', 'kat_oracle_updated_at', 'liquidity_amount', 'lltv'];
    const row = { ...m, ...Object.fromEntries(fields.map(key => [key, numeric(source[key])])), ts,
      block: Number.isSafeInteger(source.block ?? sample.block) ? (source.block ?? sample.block) : null,
      interest_accrued: source.interest_accrued === true,
      no_position: source.no_position === true, status: current && !source.valuation_error ? 'fresh' : 'stale' };
    if (source.raw && typeof source.raw === 'object') {
      row.raw = Object.fromEntries(Object.entries(source.raw).filter(([key, value]) =>
        ['collateral', 'borrow_shares', 'debt', 'oracle_price', 'lltv', 'liquidation_debt', 'total_borrow_assets',
          'total_borrow_shares', 'total_supply_assets', 'total_supply_shares', 'liquidity'].includes(key)
        && typeof value === 'string' && /^\d{1,160}$/.test(value)));
    }
    const valid = ['collateral_amount', 'debt_amount', 'oracle_collateral_usd', 'debt_usd', 'liquidation_usd']
      .every(key => Number.isFinite(row[key]) && row[key] >= 0)
      && Number.isFinite(row.lltv) && row.lltv > 0 && row.lltv <= 1
      && (row.debt_amount === 0 || (Number.isFinite(row.health) && row.health >= 0))
      && (!row.no_position || (row.debt_amount === 0 && row.collateral_amount === 0));
    if (!valid || source.valuation_error) {
      row.status = 'unavailable'; row.error = 'The market debt, oracle or USD valuation is unavailable.';
    }
    try { row.target_metrics = targetMetrics(row, m.lltv / defaults[m.key]); }
    catch { row.target_metrics = { status: 'unavailable', borrow_amount: null, repay_amount: null }; }
    try { row.liquidation_metrics = liquidationMetrics(row); }
    catch { row.liquidation_metrics = { status: 'unavailable' }; }
    return row;
  });
  const complete = sample.full === true && markets.every(row => row.status === 'fresh');
  return { status: complete ? 'fresh' : ts ? 'stale' : 'unavailable', ts, block: numeric(sample.block), markets };
}

function lpView(sample, now) {
  if (!sample || !sample.cards || !Array.isArray(sample.live)) return { status: 'unavailable', ts: null, cards: null, positions: [], closed: [] };
  const ts = iso(sample.generated), health = sample.health;
  const complete = health && !sample.error && !Object.keys(health.errors || {}).length
    && !(health.unread || []).length && !(health.unpriced || []).length
    && Object.values(health.behind || {}).every(n => n === 0);
  const cardFields = ['value_usd', 'pnl_usd', 'fees_usd', 'net_usd', 'unclaimed_usd', 'open'];
  const validCards = cardFields.every(key => Number.isFinite(sample.cards[key]))
    && sample.live.every(row => row && typeof row === 'object' && !Array.isArray(row));
  const status = complete && validCards && freshAt(ts, now) ? 'fresh' : ts ? 'stale' : 'unavailable';
  const positionFields = ['id', 'chain', 'wallet', 'pair', 'status', 'value_now', 'value', 'cost', 'pnl', 'net', 'il',
    'yield_label', 'yield_value', 'price', 'lower', 'upper', 'apr', 'since', 'held'];
  const positions = sample.live.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 30).map(row => ({
    ...Object.fromEntries(positionFields.map(key => [key, text(row[key])])),
    in_range: typeof row.in_range === 'boolean' ? row.in_range : null,
    apr_detail: boundedMetric(row.apr_detail), comparison: boundedMetric(row.comparison),
    canonical: (Array.isArray(sample.position_data) ? sample.position_data : []).find(position => position?.chain === row.chain
      && String(position.id) === String(row.id).replace(/^#/, '')) || null,
  }));
  return { status, ts, cards: Object.fromEntries(cardFields.map(key => [key, numeric(sample.cards[key])])),
    comparison: boundedMetric(sample.cards.comparison), positions,
    closed_cards: sample.alltime?.cards ? boundedMetric(sample.alltime.cards) : null,
    closed: (Array.isArray(sample.alltime?.history) ? sample.alltime.history : []).slice(0, 15).map(boundedMetric),
    recent_claims: (Array.isArray(sample.claims) ? sample.claims : []).slice(0, 15).map(boundedMetric),
    warnings: complete ? [] : ['Some LP readings or history are incomplete. Retained figures are not a complete current valuation.'] };
}

function boundedMetric(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 40).filter(([, v]) =>
    v === null || typeof v === 'boolean' || typeof v === 'string' || Number.isFinite(v))
    .map(([key, v]) => [key, typeof v === 'string' ? text(v, 240) : v]));
}

function portfolioView(sample) {
  if (!sample || !sample.summary || !iso(sample.last_updated)) return { status: 'unavailable', ts: null, total_usd: null, vault_usd: null };
  return { status: 'stale', ts: iso(sample.last_updated), basis: 'Saved dashboard snapshot; main portfolio and Tiger Vault are separate amounts, not live quotes.',
    total_usd: numeric(sample.summary.grand_total_usd), vault_usd: numeric(sample.vault?.total_usd),
    vault_ts: iso(sample.vault?.at), vault_complete: sample.vault?.complete === true,
    chains: Object.entries(sample.chains || {}).slice(0, 8).map(([key, row]) => ({ key: text(key, 30), name: text(row.name, 50),
      total_usd: numeric(row.total_usd), onchain_usd: numeric(row.onchain_usd), lp_usd: numeric(row.lp_total_usd) })),
    summary: boundedMetric(sample.summary) };
}

export async function loadAgentContext({ origin, fetcher = fetch, now = Date.now, timeoutMs = 15000, needs = [] } = {}) {
  const selected = requestedNeeds(needs), base = validOrigin(origin);
  const at = clockValue(now);
  if (!Number.isFinite(at)) throw new Error('A valid agent reading time is required.');
  const paths = ['/api/morpho', '/api/lpbook', '/data.json', '/history.json'];
  const results = await Promise.allSettled(paths.map(path => readAgentJSON(base + path, { fetcher, timeoutMs })));
  const value = index => results[index].status === 'fulfilled' ? results[index].value : null;
  const lending = lendingView(value(0), at), lp = lpView(value(1), at), portfolio = portfolioView(value(2));
  const records = Array.isArray(value(3)?.data) ? value(3).data : [];
  const history = { basis: 'Recorded daily snapshots, at their original prices. Changes in wealth are not automatically profit.',
    days: records.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(-8).map(row => ({ date: text(row.date, 10), ts: iso(row.timestamp), total_usd: numeric(row.total_usd), vault_usd: numeric(row.vault_usd),
      lp_usd: numeric(row.lp_usd), pending_usd: numeric(row.pending_usd) })) };
  const sources = [
    { name: 'lending', status: lending.status, ts: lending.ts },
    { name: 'lp', status: lp.status, ts: lp.ts },
    { name: 'portfolio', status: portfolio.status, ts: portfolio.ts },
    { name: 'history', status: history.days.length ? 'stale' : 'unavailable', ts: history.days.at(-1)?.ts || null },
  ];
  const snapshot = await buildPortfolioSnapshot({ saved: value(2), lending: value(0), lp: value(1), now: at,
    mainOwner: WALLET, expectedMarketIds: MARKETS.map(market => market.id) });
  const last = history.days.at(-1), prior = history.days.at(-2);
  history.performance = comparablePortfolioPerformance({ before: { valueUsd: prior?.total_usd }, after: { valueUsd: last?.total_usd } });
  const context = { asOf: new Date(at).toISOString(), timezone: 'Asia/Kuala_Lumpur', sources, lending, lp, portfolio, history, snapshot };
  return selected.length ? loadAgentSupplementalContext({ origin: base, needs: selected, context, fetcher, now, timeoutMs }) : context;
}

export function calculateAgentLending(context, { market, targetHealth }, { now = Date.now } = {}) {
  if (!Number.isFinite(targetHealth) || targetHealth < 1 || targetHealth > 1000000)
    return { available: false, reason: 'Choose a target health of at least 1.' };
  const name = typeof market === 'string' ? market.trim().toLowerCase().replace(/\s/g, '') : '';
  const matches = (context?.lending?.markets || []).filter(row => [row.id, row.key, row.label]
    .some(value => typeof value === 'string' && value.toLowerCase().replace(/\s/g, '') === name));
  if (matches.length !== 1) return { available: false, reason: 'Please specify avKAT / KAT, avKAT / USDC or KAT / USDC.' };
  const row = matches[0];
  if (row.status !== 'fresh' || !freshAt(row.ts, clockValue(now)) || row.error)
    return { available: false, market: row.label, ts: row.ts, reason: 'A fresh complete market reading is required before quoting a borrowing or repayment amount.' };
  try {
    const metrics = targetMetrics(row, targetHealth);
    return { available: metrics.status !== 'unavailable', market: row.label, ts: row.ts, loan_token: row.loan_token,
      ...metrics, assumptions: 'Read-only estimate at this observation; debt includes accrued interest. Borrowing is capped by liquidity and the market LLTV.' };
  } catch { return { available: false, market: row.label, ts: row.ts, reason: 'The market debt and oracle amounts could not be validated.' }; }
}

const dollars = value => Number.isFinite(value) ? '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'unavailable';
const readingTime = ts => ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false }) + ' MYT' : 'no verified reading';
export function summarizeAgent(context) {
  const lines = ['Here is your portfolio update.'];
  const snapshot = context?.snapshot;
  const freshRows = [...(snapshot?.assets || []), ...(snapshot?.liabilities || [])].filter(row => row.status === 'fresh');
  const current = freshRows.every(row => freshAt(row.observedAt, Date.now()));
  if (current && snapshot?.status === 'complete' && Number.isFinite(snapshot.navUsd)) lines.push('Your portfolio is worth ' + agentMoney(snapshot.navUsd) + '.');
  else if (current && freshRows.length && Number.isFinite(snapshot?.verifiedSubtotalUsd)) lines.push('I can currently verify ' + agentMoney(snapshot.verifiedSubtotalUsd) + ' of your portfolio. Some positions are not fully verified, so this is a partial total.');
  const lending = context?.lending;
  if (lending?.markets?.length) {
    lines.push('\nYour loans:');
    for (const row of lending.markets) {
      if (row.status !== 'fresh' || row.error) { lines.push(row.label + ': I could not refresh this loan.'); continue; }
      if (row.no_position) continue;
      lines.push(row.label + ': ' + (row.debt_amount === 0 ? 'no debt' : 'health ' + agentNumber(row.health))
        + ', with ' + agentMoney(row.debt_usd) + ' borrowed.');
      if (Number.isFinite(row.health) && row.health < 1) lines.push('This loan is below its liquidation boundary.');
    }
  } else lines.push('Lending: current readings unavailable. Please refresh to check your loans.');
  if (context?.lp?.status === 'fresh' && context.lp.cards) {
    const cards = context.lp.cards;
    lines.push('\nYour ' + cards.open + ' open LP position' + (cards.open === 1 ? ' is' : 's are') + ' worth ' + agentMoney(cards.value_usd)
      + ', with a net result of ' + agentMoney(cards.net_usd) + ' and ' + agentMoney(cards.unclaimed_usd) + ' still to claim.');
  } else lines.push('I could not get a complete current LP valuation.');
  if (context?.portfolio?.ts) lines.push('\nLast saved portfolio value: ' + agentMoney(context.portfolio.total_usd) + '; Tiger Vault '
    + agentMoney(context.portfolio.vault_usd) + ' (' + agentReadingTime(context.portfolio.ts) + ').');
  const stamp = agentReadingTime(context?.asOf); if (stamp) lines.push('\nChecked ' + stamp + '.');
  return lines.join('\n');
}
