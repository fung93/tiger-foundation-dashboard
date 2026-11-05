/* Bounded read-only views for the conversational agent. Calculations come from
   the same Morpho functions as Lending; failed sources never become zeroes. */
import { MARKETS, targetMetrics, liquidationMetrics } from '../morpho-core.mjs';

const numeric = value => Number.isFinite(value) ? value : null;
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, limit) : null;
const iso = value => {
  const ts = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ts) && ts > 0 && Number.isFinite(new Date(ts).getTime()) ? new Date(ts).toISOString() : null;
};
const clockValue = now => typeof now === 'function' ? now() : now;
const freshAt = (ts, now) => ts && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) <= 90000;
const defaults = { 'avkat-kat': .70, 'avkat-usdc': .35, 'kat-usdc': .35 };

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

export async function loadAgentContext({ origin, fetcher = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('A valid dashboard origin is required.');
  const at = clockValue(now);
  if (!Number.isFinite(at)) throw new Error('A valid agent reading time is required.');
  const paths = ['/api/morpho', '/api/lpbook', '/data.json', '/history.json'];
  const results = await Promise.allSettled(paths.map(path => readAgentJSON(url.origin + path, { fetcher, timeoutMs })));
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
  return { asOf: new Date(at).toISOString(), timezone: 'Asia/Kuala_Lumpur', sources, lending, lp, portfolio, history };
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
  const lines = ['Tiger Foundation summary', 'Checked ' + readingTime(context?.asOf)];
  const lending = context?.lending;
  if (lending?.markets?.length) {
    lines.push('Lending (' + lending.status + ', ' + readingTime(lending.ts) + '):');
    for (const row of lending.markets) {
      if (row.status !== 'fresh' || row.error) { lines.push(row.label + ': current reading unavailable.'); continue; }
      if (row.no_position) { lines.push(row.label + ': inactive.'); continue; }
      lines.push(row.label + ': ' + (row.debt_amount === 0 ? 'no debt' : 'health ' + (Number.isFinite(row.health) ? row.health.toFixed(3) : 'unavailable'))
        + ', borrowed ' + dollars(row.debt_usd) + '.');
    }
  } else lines.push('Lending: current readings unavailable.');
  if (context?.lp?.status === 'fresh') {
    const cards = context.lp.cards;
    lines.push('Open LPs: ' + cards.open + ', principal ' + dollars(cards.value_usd) + ', net ' + dollars(cards.net_usd)
      + ', still to claim ' + dollars(cards.unclaimed_usd) + '.');
  } else lines.push('LPs: a complete current valuation is unavailable.');
  if (context?.portfolio?.ts) lines.push('Saved portfolio ' + dollars(context.portfolio.total_usd) + '; Tiger Vault '
    + dollars(context.portfolio.vault_usd) + ' (' + readingTime(context.portfolio.ts) + ').');
  else lines.push('Saved portfolio: unavailable.');
  return lines.join('\n');
}
