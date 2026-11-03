/* strategy.js: lays out /api/strategy and runs each pool's estimate with strategy-core.mjs.
   Inputs and open pools survive every refresh: the cards are built once and updated in
   place, never rebuilt under the cursor. */
import { estimateReward, estimateFees, edgeOutcome, byApr, RANGE_DAYS, hedgePlan, rehedgeStep } from './strategy-core.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MYT = 'Asia/Kuala_Lumpur';
const fmt = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
const money = (v) => (Number.isFinite(v) ? (v < 0 ? '-$' : '$') + fmt(Math.abs(v), 2) : '—');
const kat = (v) => (Number.isFinite(v) ? fmt(v, v < 100 ? 2 : 0) + ' KAT' : '—');
const dollars = (v) => (Number.isFinite(v) ? '$' + fmt(v, 0) : '—');
const pct = (v) => (Number.isFinite(v) ? fmt(v * 100, Math.abs(v) >= 1 ? 0 : 2) + '%' : '—');
const priceDp = (p) => (p >= 1000 ? 2 : p >= 1 ? 4 : 6);
const price = (p) => (Number.isFinite(p) ? fmt(p, priceDp(p)) : '—');
const tokens = (v) => (Number.isFinite(v) ? fmt(v, v >= 100 ? 2 : v >= 1 ? 4 : 6) : '—');
/* a token amount, with its dollar value in brackets unless it is a stablecoin (already dollars) */
const held = (amount, token) => `${tokens(amount)} ${esc(token.symbol)}`
  + (token.usd > 0 && !(token.usd > 0.95 && token.usd < 1.05) ? ` (${money(amount * token.usd)})` : '');
const when = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short' });
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', hour12: false });
const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/* a calendar day in Malaysia time, as the date input reads it */
const isoDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: MYT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
const dayStart = (iso) => Date.parse(iso + 'T00:00:00+08:00') / 1000;
const nowS = () => Date.now() / 1000;
const left = (s) => (s <= 0 ? 'ended' : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h left` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left`);

const KEY = 'tf_strategy', FEES_KEY = 'tf_strategy_fees', POLL = 60000, FRESH = 150;
let view = null, readAt = 0, lastOk = false, busy = false, failure = '';
const state = new Map();   /* pool → the inputs and whether it is open */
const cards = new Map();   /* pool → its card */

/* a pool without KAT (view.fee_pools) earns trading fees only; its card reads the same otherwise */
const isFees = (p) => p.kind === 'fees';
const FIGS = { kat: ['Staked TVL', 'APR', 'KAT per day', 'Value per day'], fees: ['Pool TVL', 'Fee APR', 'Volume per day', 'Fees per day'] };

/* a pair of stablecoins wants a range in tenths of a percent, not whole percents */
const stable = (p) => Math.abs(p.price - 1) < 0.02 && [p.token0.usd, p.token1.usd].every((u) => u > 0.95 && u < 1.05);
const widths = (p) => (stable(p) ? [0.0005, 0.001, 0.0025, 0.005] : [0.01, 0.025, 0.05, 0.1]);
const widthLabel = (w) => '±' + (w * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
const roundPrice = (p) => Number(p.toFixed(priceDp(p)));
/* a recent low rounds down and a high rounds up, so the range still covers both */
const floorPrice = (p) => { const k = 10 ** priceDp(p); return Math.floor(p * k) / k; };
const ceilPrice = (p) => { const k = 10 ** priceDp(p); return Math.ceil(p * k) / k; };

function defaults(p) {
  const w = stable(p) ? 0.001 : 0.025;
  return { lower: roundPrice(p.price * (1 - w)), upper: roundPrice(p.price * (1 + w)), capital: 1000, start: isoDay(nowS()), open: false };
}

function build(p) {
  const id = 'pool-' + p.pool.slice(2, 12);
  const el = document.createElement('article');
  el.className = 'card pool-card'; el.id = id;
  const F = FIGS[isFees(p) ? 'fees' : 'kat'];
  /* the head is a clickable row rather than a button, so the pool's "!" can sit in it beside
     the fee tier (Alex, 3 Nov: it used to sit at the card's top corner) */
  el.innerHTML = `<div class="pool-head" role="button" tabindex="0" aria-expanded="false" aria-controls="${id}-body">
      <div class="pool-name"><h3></h3><span class="tag fee"></span><span class="pool-info"><button type="button" class="info-btn" aria-label="About this pool" aria-expanded="false">!</button><span class="info-tip" role="tooltip"></span></span></div>
      <div class="pool-figs"><div><div class="metric-label">${F[0]}</div><div class="pool-fig tvl"></div></div><div><div class="metric-label">${F[1]}</div><div class="pool-fig apr"></div></div><div><div class="metric-label">${F[2]}</div><div class="pool-fig kat"></div></div><div><div class="metric-label">${F[3]}</div><div class="pool-fig usd"></div></div></div>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div class="pool-body" id="${id}-body" hidden>
      <div class="pool-context"></div>
      <div class="calc">
        <div class="calc-inputs">
          <label><span class="lo-label">Lower price</span><input type="number" inputmode="decimal" step="any" min="0" data-f="lower"></label>
          <label><span class="hi-label">Upper price</span><input type="number" inputmode="decimal" step="any" min="0" data-f="upper"></label>
          <label class="wide-phone">Capital · USD<input type="number" inputmode="decimal" step="any" min="0" data-f="capital"></label>
          <label class="wide-phone">Start day<input type="date" data-f="start"></label>
          <div class="edge-box" aria-live="polite"></div>
          <div class="preset-row"><span class="presets-label">Around now</span><div class="presets around" role="group" aria-label="Range around the current price"></div></div>
          <div class="preset-row"><span class="presets-label">Recent</span><div class="presets recent" role="group" aria-label="The price's recent low and high"></div></div>
        </div>
        <div class="calc-out" aria-live="polite"></div>
      </div>
      <div class="hedge">
        <label class="hedge-toggle"><input type="checkbox" class="hedge-on"><span class="hedge-name">Hedge this position</span><span class="hedge-hint">a short on Katana Perps at 1x, delta neutral at today's price</span></label>
        <div class="hedge-body" hidden aria-live="polite"></div>
      </div>
    </div>`;
  const s = state.get(p.pool);
  el.querySelectorAll('input[data-f]').forEach((input) => {
    input.value = s[input.dataset.f];
    input.addEventListener('input', () => { s[input.dataset.f] = input.value; estimate(p.pool); });
  });
  const hedgeOn = el.querySelector('.hedge-on');
  hedgeOn.checked = !!s.hedge;
  hedgeOn.addEventListener('change', () => { s.hedge = hedgeOn.checked; estimate(p.pool); });
  const head = el.querySelector('.pool-head');
  const toggle = () => {
    s.open = !s.open;
    el.classList.toggle('open', s.open);
    head.setAttribute('aria-expanded', String(s.open));
    el.querySelector('.pool-body').hidden = !s.open;
    if (s.open) estimate(p.pool);
  };
  head.addEventListener('click', (ev) => { if (!ev.target.closest('.pool-info')) toggle(); });
  head.addEventListener('keydown', (ev) => { if (ev.target === head && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggle(); } });
  const setRange = (lower, upper, picked) => {
    s.lower = lower; s.upper = upper; s.picked = picked;
    el.querySelector('[data-f=lower]').value = s.lower; el.querySelector('[data-f=upper]').value = s.upper;
    estimate(p.pool);
  };
  el.querySelector('.around').innerHTML = widths(p).map((w) => `<button type="button" data-w="${w}">${widthLabel(w)}</button>`).join('');
  el.querySelector('.around').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-w]'); if (!b) return;
    const pool = current(p.pool), w = Number(b.dataset.w);
    setRange(roundPrice(pool.price * (1 - w)), roundPrice(pool.price * (1 + w)), null);
  });
  /* the lowest and highest price the pool actually traded at over the last 7 to 30 days */
  el.querySelector('.recent').innerHTML = RANGE_DAYS.map((d) => `<button type="button" data-days="${d}" disabled>${d}D</button>`).join('');
  el.querySelector('.recent').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-days]'); if (!b || b.disabled) return;
    const r = (current(p.pool).recent || {})[b.dataset.days]; if (!r) return;
    const lower = floorPrice(r.low), upper = ceilPrice(r.high);
    setRange(lower, upper, { days: Number(b.dataset.days), lower, upper, swaps: r.swaps, complete: r.complete });
  });
  cards.set(p.pool, el);
  return el;
}

const current = (pool) => view.pools.find((p) => p.pool === pool) || (view.fee_pools || []).find((p) => p.pool === pool);

function estimate(pool) {
  const p = current(pool), el = cards.get(pool), s = state.get(pool);
  if (!p || !el || !s.open) return;
  const out = el.querySelector('.calc-out'), t = nowS();
  const startTs = s.start && s.start !== isoDay(t) ? dayStart(s.start) : t, fees = isFees(p);
  const e = (fees ? estimateFees : estimateReward)(p, { capitalUsd: Number(s.capital), lowerPrice: Number(s.lower), upperPrice: Number(s.upper), startTs },
    { now: t, katUsd: view.kat_usd, rewardStart: view.reward.start, rewardEnd: view.reward.end });
  el.querySelector('[data-f=lower]').setAttribute('aria-invalid', String(!!e.error && !(Number(s.lower) > 0)));
  el.querySelector('[data-f=capital]').setAttribute('aria-invalid', String(!(Number(s.capital) > 0)));
  const edgeBox = el.querySelector('.edge-box');
  if (e.error) { out.innerHTML = `<div class="calc-error">${esc(e.error)}</div>`; edgeBox.innerHTML = ''; el.querySelector('.hedge-body').hidden = true; return; }
  /* the deposit's P&L if the price reaches either edge, rewards left out (as the LP Book's "!") */
  const x = edgeOutcome(p, e.range, e.liquidity, Number(s.capital));
  const quoteToken = p.baseIndex === 0 ? p.token1 : p.token0, stableQuote = quoteToken.usd > 0.95 && quoteToken.usd < 1.05;
  const edgeRow = (label, r, note) => `<div class="edge-row"><span class="edge-at">${label} · ${price(r.price)}</span>`
    + `<span class="edge-pnl ${r.pnlUsd >= 0 ? 'up' : 'down'}">${r.pnlUsd >= 0 ? '+' : '-'}${money(Math.abs(r.pnlUsd))}</span>`
    + `<span class="edge-note">All ${tokens(r.amount)} ${esc(r.token)}. ${note}</span></div>`;
  edgeBox.innerHTML = x ? `<div class="edge-title">P&amp;L at the range edges · excludes ${fees ? 'fees' : 'KAT'}</div>`
    + edgeRow('Upper edge', x.upper, stableQuote ? 'The most it can be worth.' : `The most it can be worth in ${esc(quoteToken.symbol)}.`)
    + edgeRow('Lower edge', x.lower, 'Below it, the loss keeps growing.')
    + (stableQuote ? '' : `<div class="edge-foot">Valued with ${esc(quoteToken.symbol)} at today's dollar price.</div>`) : '';
  const [base, quote] = p.baseIndex === 0 ? [p.token0, p.token1] : [p.token1, p.token0];
  const [dBase, dQuote] = p.baseIndex === 0 ? [e.deposit.amount0, e.deposit.amount1] : [e.deposit.amount1, e.deposit.amount0];
  const notes = [`Range rounds to ${price(e.range.lowerPrice)} – ${price(e.range.upperPrice)} ${esc(quote.symbol)} per ${esc(base.symbol)}, Sushi's nearest price steps. Deposit about ${held(dBase, base)} + ${held(dQuote, quote)} at today's price` + (fees
    ? `; no staking, the fees collect in the position. Fees at the last ${fmt(p.fees.window_days, 0)} days' rate.` : ', then stake it.')];
  const pick = s.picked;
  if (pick && Number(s.lower) === pick.lower && Number(s.upper) === pick.upper)
    notes.unshift(`Range set from the last ${pick.days} days' lowest and highest traded price (${fmt(pick.swaps)} swaps${pick.complete ? '' : ', history incomplete'}).`);
  let warn = false;
  if (!e.inRange) { notes.push('The price is outside this range now, so it earns nothing until the price moves into it.'); warn = true; }
  if (e.days <= 0) { notes.push(fees ? 'This period has ended by that start day.' : 'This reward period has ended by that start day; the next epoch’s KAT is set by its vote.'); warn = true; }
  out.innerHTML = fees ? `
    <div><div class="metric-label">My fees per day</div><div class="metric-value big">${money(e.usdPerDay)}</div><div class="metric-sub">${tokens(e.fees0PerDay)} ${esc(p.token0.symbol)} + ${tokens(e.fees1PerDay)} ${esc(p.token1.symbol)}</div></div>
    <div><div class="metric-label">From ${esc(day(e.from))} to the period's end</div><div class="metric-value">${money(e.totalUsd)}</div><div class="metric-sub">over ${fmt(e.days, 1)} days, to ${esc(when(view.reward.end))}</div></div>
    <div><div class="metric-label">My share of the pool's fees</div><div class="metric-value">${pct(e.share)}</div><div class="metric-sub">of ${money(p.fees.usd_per_day)} a day</div></div>
    <div><div class="metric-label">APR on my capital</div><div class="metric-value">${pct(e.apr)}</div><div class="metric-sub">on ${money(Number(s.capital))}, fees only</div></div>
    <div class="calc-note${warn ? ' warn' : ''}">${notes.join(' ')}</div>` : `
    <div><div class="metric-label">My KAT per day</div><div class="metric-value big">${kat(e.katPerDay)}</div><div class="metric-sub">${money(e.usdPerDay)} a day</div></div>
    <div><div class="metric-label">From ${esc(day(e.from))} to the period's end</div><div class="metric-value">${kat(e.totalKat)}</div><div class="metric-sub">${money(e.totalUsd)} over ${fmt(e.days, 1)} days, to ${esc(when(view.reward.end))}</div></div>
    <div><div class="metric-label">My share of the pool's KAT</div><div class="metric-value">${pct(e.share)}</div><div class="metric-sub">of ${kat(p.katPerDay)} a day</div></div>
    <div><div class="metric-label">APR on my capital</div><div class="metric-value">${pct(e.apr)}</div><div class="metric-sub">on ${money(Number(s.capital))}, KAT only</div></div>
    <div class="calc-note${warn ? ' warn' : ''}">${notes.join(' ')}</div>`;
  renderHedge(el, p, e, x, s);
}

/* ---- the hedge: what to short on Katana Perps to be delta neutral at today's price, what it
   costs and earns to the period's end, and how the hedged position ends up at each edge ---- */
const signedMoney = (v) => (Number.isFinite(v) ? (v > 0.0049 ? '+' : v < -0.0049 ? '−' : '') + money(Math.abs(v)) : '—');
const rate = (r) => (r >= 0 ? '+' : '−') + fmt(Math.abs(r) * 100, 4) + '%';
function renderHedge(el, p, e, x, s) {
  const body = el.querySelector('.hedge-body');
  body.hidden = !s.hedge;
  if (!s.hedge) return;
  if (!view.perps) { body.innerHTML = '<div class="calc-note warn">Katana Perps could not be read this time, so the hedge cannot be simulated. It will try again on the next refresh.</div>'; return; }
  const plan = hedgePlan(p, e.deposit, view.perps, { days: e.days, from: e.from, to: view.reward.end, katUsdTotal: e.totalUsd, capitalUsd: Number(s.capital), edges: x });
  if (plan.nothing) { body.innerHTML = '<div class="calc-note">Nothing to hedge: both tokens are dollars, so the position has no price exposure to short.</div>'; return; }
  if (!plan.legs.length) { body.innerHTML = `<div class="calc-note warn">Katana Perps has no market for ${esc(plan.missing.join(' or '))}, so this position cannot be hedged there.</div>`; return; }
  const legs = plan.legs.map((l) => {
    const base = l.symbol.split('-')[0], up = l.liquidation / l.mark - 1;
    const warns = [];
    if (l.below_min) warns.push(`Below Katana Perps' smallest position of ${fmt(l.min, 4)} ${base}: raise the capital to hedge it.`);
    if (l.thin) warns.push('The order book is too thin for this size right now.');
    if (Math.abs(l.residual) * l.mark >= 0.01) warns.push(`Rounded to the market's step of ${fmt(l.step, 4)} ${base}; ${tokens(Math.abs(l.residual))} ${esc(l.token)} (${money(Math.abs(l.residual) * l.mark)}) stays ${l.residual > 0 ? 'unhedged' : 'over-hedged'}.`);
    return `<div class="hedge-leg">
        <div class="metric-label">Short on ${esc(l.symbol)}</div>
        <div class="metric-value big">${tokens(l.qty)} ${esc(base)}</div>
        <div class="metric-sub">${money(l.notional)} at ${price(l.mark)} · the ${tokens(l.amount)} ${esc(l.token)} in the deposit</div>
        <div class="metric-sub">Margin ${money(l.margin)} vbUSDC at 1x · liquidated if ${esc(base)} reaches ${price(l.liquidation)} (+${fmt(up * 100, 0)}%)</div>
        ${warns.length ? `<div class="metric-sub warn">${warns.join(' ')}</div>` : ''}
      </div>`;
  }).join('');
  const sum = (k) => plan.legs.reduce((t, l) => t + (l[k] || 0), 0);
  const l0 = plan.legs[0], payments = l0.funding_periods, earned = isFees(p) ? 'Fees' : 'KAT';
  const tone = (v) => (v > 0.0049 ? 'up' : v < -0.0049 ? 'down' : '');
  /* the hedge's fees and funding as one figure, item by item behind its "!" (Alex, 3 Nov: the
     list of fees was too many words) */
  const tipRow = (label, v, cls = '') => `<span class="tip-row${cls}"><span>${label}</span><span class="${tone(v)}">${signedMoney(v)}</span></span>`;
  const breakdown = `<span class="info-title">Hedge fees · ${fmt(e.days, 1)} days</span>`
    + tipRow(`Open · taker ${fmt(l0.taker * 100, 3)}%`, -sum('open_fee'))
    + tipRow(`Close · taker ${fmt(l0.taker * 100, 3)}%`, -sum('close_fee'))
    + tipRow('Order book, in and out', -sum('book_cost'))
    + tipRow(`Funding · ${payments} × ${rate(l0.funding_rate)}`, sum('funding'))
    + tipRow('Withdraw the margin', -plan.withdraw_fee)
    + tipRow('Net', plan.net, ' total')
    + `<span class="tip-foot">Funding is the last 30 days' average, paid every 8 h; a positive rate has longs pay shorts, so the short is paid. A limit order to close pays ${fmt(l0.maker * 100, 5)}%. From Katana Perps' own market data.</span>`;
  const fees = `<div class="hedge-fees"><div class="metric-label">Hedge fees, net<span class="hedge-info"><button type="button" class="info-btn" aria-label="Hedge fees, item by item" aria-expanded="false">!</button><span class="info-tip" role="tooltip">${breakdown}</span></span></div>
      <div class="metric-value ${tone(plan.net)}">${signedMoney(plan.net)}</div><div class="metric-sub">funding less fees, to the period's end</div></div>`;
  const total = `<div class="hedge-sum">${fees}` + (plan.total !== null ? `
      <div><div class="metric-label">Income to the period's end</div><div class="metric-value">${money(plan.total)}</div><div class="metric-sub">${earned} ${money(e.totalUsd)} ${plan.net >= 0 ? '+' : '−'} hedge ${money(Math.abs(plan.net))}, price moves aside</div></div>
      <div><div class="metric-label">Capital it takes</div><div class="metric-value">${money(plan.capital)}</div><div class="metric-sub">LP ${money(Number(s.capital))} + margin ${money(plan.margin)}</div></div>
      <div><div class="metric-label">Hedged APR</div><div class="metric-value">${pct(plan.apr)}</div><div class="metric-sub">the income on all of it</div></div>` : '') + '</div>';
  /* the profit at the period's end: the income above plus what the price did to the LP and
     the short, with the price ending where it is today or at either edge (Alex, 3 Nov: the
     income and the edge results were shown apart, and never added up) */
  const profitRow = (label, priceRes, note) => { const v = plan.total + priceRes; return `<div class="hedge-row"><span>${label}<span class="hedge-row-note">${note}</span></span><span class="${tone(v)}">${signedMoney(v)}</span></div>`; };
  const income = `income ${money(plan.total)}`;
  let edges = '';
  if (plan.total !== null) {
    edges = `<div class="hedge-costs"><div class="edge-title">Profit at the period's end · income and price together</div>`
      + profitRow(`Price ends where it is now · ${price(p.price)}`, 0, `${income} · price result about $0`);
    if (plan.edges) {
      const u = plan.edges.upper, d = plan.edges.lower;
      edges += profitRow(`Price ends at the upper edge · ${price(u.price)}`, u.net, `${income} · price ${signedMoney(u.net)} (LP ${signedMoney(u.lp)}, short ${signedMoney(u.short)})`)
        + profitRow(`Price ends at the lower edge · ${price(d.price)}`, d.net, `${income} · price ${signedMoney(d.net)} (LP ${signedMoney(d.lp)}, short ${signedMoney(d.short)})`)
        + `<div class="edge-foot">The income counts ${isFees(p) ? 'fees' : 'KAT'} for every day of the period, which needs the price inside the range: about ${money(e.usdPerDay)} a day, nothing while outside. Past the edges the loss keeps growing: about ${money(Math.abs(u.beyond_per_pct))} for each further 1% up and ${money(Math.abs(d.beyond_per_pct))} for each further 1% down.</div>`;
    } else {
      edges += `<div class="edge-foot">With two volatile tokens, the result at the edges depends on how both prices move, so only today's price is shown. The income counts ${isFees(p) ? 'fees' : 'KAT'} for every day, which needs the price inside the range.</div>`;
    }
    edges += '</div>';
  }
  let drift = '';
  if (plan.legs.length === 1) {
    const r = rehedgeStep(p, e.range, e.liquidity, l0.token, l0.taker, l0.mark);
    drift = ` Each 1% the price moves changes the deposit's ${esc(l0.token)} by about ${tokens(r.qty)} (${money(r.usd)}); re-hedging that costs about ${money(r.fee)} in taker fees.`;
  }
  const wasOpen = !!body.querySelector('.hedge-info.open');   /* a tapped "!" stays open through a refresh */
  body.innerHTML = `<div class="hedge-legs">${legs}</div>${total}${edges}
    <div class="calc-note">The short is the amount of each volatile token the deposit holds now, which is how much its value moves with that price.${drift}</div>`;
  if (wasOpen) { const w = body.querySelector('.hedge-info'); w.classList.add('open'); w.querySelector('.info-btn').setAttribute('aria-expanded', 'true'); }
}

/* each pool's "!" and the hedge fees' "!": open on hover or focus, and on a tap for phones; a tap elsewhere or Escape closes them */
const POPS = '.pool-info, .hedge-info';
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.pool-info .info-btn, .hedge-info .info-btn');
  document.querySelectorAll('.pool-info.open, .hedge-info.open').forEach((w) => { if (!btn || w !== btn.parentElement) { w.classList.remove('open'); w.querySelector('.info-btn').setAttribute('aria-expanded', 'false'); } });
  if (btn) { const w = btn.parentElement, open = !w.classList.contains('open'); w.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') document.querySelectorAll(POPS).forEach((w) => w.classList.remove('open')); });

/* the pools paying KAT, then the pools without KAT behind their button; each card is built
   once and updated in place */
const EMPTY = { pools: 'No live staking campaign right now. The next one starts when the epoch vote closes.', feePools: 'The pools without KAT could not be read this time.' };
function renderPools() {
  const groups = [[$('pools'), view.pools], [$('feePools'), view.fee_pools || []]];
  const live = new Set(groups.flatMap(([, list]) => list.map((p) => p.pool)));
  for (const [pool, el] of cards) if (!live.has(pool)) { el.remove(); cards.delete(pool); }
  for (const [box, list] of groups) {
    box.querySelectorAll(':scope > :not(.pool-card)').forEach((n) => n.remove());
    if (!list.length) box.insertAdjacentHTML('beforeend', `<div class="card overview-card">${EMPTY[box.id]}</div>`);
    for (const p of byApr(list)) renderPool(box, p);
  }
}

function renderPool(box, p) {
  if (!state.has(p.pool)) state.set(p.pool, defaults(p));
  const el = cards.get(p.pool) || build(p), fees = isFees(p);
  box.append(el);   /* re-appending keeps the APR order without rebuilding */
  el.querySelector('h3').textContent = `${p.base} / ${p.quote}`;
  el.querySelector('.fee').textContent = (p.fee_tier * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
  /* staked LPs in range now: the ones sharing the KAT (Merkl's figure when the chain gives none) */
  const tvl = p.staked_usd || {}, liveTvl = Number.isFinite(tvl.in_range);
  el.querySelector('.tvl').textContent = dollars(fees ? p.tvl_usd : liveTvl ? tvl.in_range : p.tvl);
  el.querySelector('.tvl').title = fees ? 'Everything the pool holds, at its own price' : liveTvl ? 'Staked LPs in range now, on chain' : 'Staked value from Merkl';
  el.querySelector('.apr').textContent = pct(p.apr);
  el.querySelector('.kat').textContent = fees ? dollars(p.fees && p.fees.volume_usd_per_day) : fmt(p.katPerDay, 0);
  el.querySelector('.usd').textContent = fees ? money(p.fees && p.fees.usd_per_day) : money(p.katPerDay * view.kat_usd);
  el.querySelector('.lo-label').textContent = `Lower · ${p.quote} per ${p.base}`;
  el.querySelector('.hi-label').textContent = `Upper · ${p.quote} per ${p.base}`;
  /* the recent-range buttons: enabled once the pool's history is read, each titled with its range */
  el.querySelectorAll('.recent button[data-days]').forEach((b) => {
    const r = (p.recent || {})[b.dataset.days];
    b.disabled = !r;
    b.title = r ? `${b.dataset.days}-day low ${price(r.low)} – high ${price(r.high)} ${p.quote} per ${p.base}${r.complete ? '' : ' (history incomplete)'}`
      : 'Recent price history is not recorded yet';
  });
  const start = state.get(p.pool);
  const dateInput = el.querySelector('[data-f=start]');
  dateInput.min = isoDay(Math.max(nowS(), view.reward.start)); dateInput.max = isoDay(view.reward.end - 1);
  if (!start.start) dateInput.value = start.start = isoDay(nowS());
  el.querySelector('.pool-context').textContent = `Now ${price(p.price)} ${p.quote} per ${p.base}`;
  /* the rest about the pool, point by point, behind the "!" beside its fee tier (Alex, 3 Nov) */
  el.querySelector('.pool-info .info-tip').innerHTML = '<span class="info-title">About this pool</span><ul class="info-list">'
    + (fees ? feeFacts(p) : katFacts(p, tvl, liveTvl)).filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('') + '</ul>'
    + (p.link ? `<a class="info-link" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Sushi pool ↗</a>` : '');
  estimate(p.pool);
}

function katFacts(p, tvl, liveTvl) {
  const share = p.eligible.liquidity > 0 && p.activeLiquidity > 0 ? p.eligible.liquidity / p.activeLiquidity : null;
  return [
    `${kat(p.kat)} this epoch`,
    p.voteShare !== null ? `${pct(p.voteShare)} of gauge votes` : null,
    `${fmt(p.eligible.inRange)} staked positions and vault ranges in range`,
    share !== null ? `${pct(share)} of the pool's active liquidity is staked` : null,
    liveTvl && tvl.all > tvl.in_range * 1.01 ? `${dollars(tvl.all)} staked in all; ${dollars(tvl.all - tvl.in_range)} of it out of range, earning nothing` : null,
    liveTvl && p.tvl !== null ? `Merkl's APR is on ${dollars(p.tvl)} staked` : null,
  ];
}

/* a pool without KAT: what it trades and what its LPs earned, measured from its fee growth */
function feeFacts(p) {
  const f = p.fees, b = p.balances || {};
  if (!f) return ['No KAT emissions: it earns trading fees only'];
  const kept = f.lp_part0 === f.lp_part1 ? fmt((1 - f.lp_part0) * 100, 0) + '%' : `${fmt((1 - f.lp_part0) * 100, 0)}% / ${fmt((1 - f.lp_part1) * 100, 0)}%`;
  return [
    'No KAT emissions: it earns trading fees only, with no staking',
    `${dollars(f.volume_usd_per_day)} traded a day over the last ${fmt(f.window_days, 0)} days; ${dollars(f.volume_usd_24h)} in the last 24 h`,
    `LPs earned ${money(f.usd_per_day)} a day over ${fmt(f.window_days, 0)} days; ${money(f.usd_24h)} in the last 24 h`,
    `Sushi keeps ${kept} of each swap's ${fmt(p.fee_tier * 100, 2)}% fee; LPs share the rest`,
    `Pool TVL ${dollars(p.tvl_usd)}: ${tokens(b.amount0)} ${p.token0.symbol} + ${tokens(b.amount1)} ${p.token1.symbol}`,
    'Fee APR is the fees over everything the pool holds; a range near the price earns more per dollar while in range',
  ];
}

/* the button that shows the pools without KAT; remembered on this device */
const feeToggle = $('feeToggle');
const showFees = (on) => {
  $('feeSection').hidden = !on;
  feeToggle.setAttribute('aria-expanded', String(on));
  feeToggle.textContent = on ? 'Hide pools without KAT emissions' : 'Show pools without KAT emissions';
};
try { showFees(localStorage.getItem(FEES_KEY) === '1'); } catch (e) { showFees(false); }
feeToggle.addEventListener('click', () => {
  const on = $('feeSection').hidden;
  showFees(on);
  try { localStorage.setItem(FEES_KEY, on ? '1' : '0'); } catch (e) { /* a convenience */ }
});

function renderOverview() {
  const e = view.epoch, t = nowS();
  const cells = $('overview').children;
  const set = (i, value, sub) => { cells[i].querySelector('.overview-value').textContent = value; cells[i].querySelector('.metric-sub').textContent = sub; };
  if (!e) { [0, 1, 2, 3].forEach((i) => set(i, '—', 'No live campaign')); return; }
  set(0, String(e.number), `${day(e.start)} – ${day(e.end)} · vote closed ${when(e.voteEnd)}`);
  set(1, kat(view.total.kat), `${money(view.total.kat * view.kat_usd)} · ${view.pools.length} pool${view.pools.length === 1 ? '' : 's'}`);
  set(2, kat(view.total.katPerDay), `${money(view.total.katPerDay * view.kat_usd)} a day · KAT $${(view.kat_usd || 0).toFixed(6)}`);
  cells[3].querySelector('.overview-value').classList.add('dates');
  set(3, `${day(view.reward.start)} → ${day(view.reward.end)}`, `${hm(view.reward.start)} to ${hm(view.reward.end)} MYT · ${left(view.reward.end - t)}`);
  const note = $('voteNote');
  if (e.voting_open && e.next_vote_end) {
    note.hidden = false;
    note.innerHTML = `<b>Epoch ${e.clock_current} vote is open</b> until ${esc(when(e.next_vote_end))}. Its KAT starts then and is not known until the vote closes.`;
  } else note.hidden = true;
}

function renderStamp() {
  const age = nowS() - readAt, fresh = lastOk && age <= FRESH;
  $('stamp').className = 'stamp' + (fresh ? '' : ' stale');
  $('stamp').innerHTML = `<span class="dot"></span><span class="st">${fresh ? 'LIVE' : readAt ? 'STALE' : 'LOADING'}</span><br>${fresh ? clockTime(nowS()) : readAt ? clockTime(readAt) : '—'}`;
}

function render() {
  if (view) { renderOverview(); renderPools(); }
  const msgs = [failure, ...((view && view.health && view.health.notes) || [])].filter(Boolean);
  $('health').textContent = msgs.join(' ');
  $('health').classList.toggle('on', msgs.length > 0);
  renderStamp();
}

async function load(force) {
  if (busy || (!force && document.hidden)) return;
  busy = true;
  try {
    const r = await fetch('/api/strategy', { cache: 'no-store', signal: AbortSignal.timeout(25000) });
    const v = await r.json();
    if (!r.ok || v.error || !Array.isArray(v.pools)) throw new Error(v.error || 'HTTP ' + r.status);
    view = v; readAt = nowS(); lastOk = true; failure = '';
    try { localStorage.setItem(KEY, JSON.stringify({ t: readAt, v })); } catch (e) { /* storage is a convenience */ }
  } catch (e) {
    lastOk = false;
    failure = view ? `Could not refresh (${e.message}). Showing the reading from ${when(readAt)} MYT.` : `Could not read the epoch yet (${e.message}). Retrying.`;
  } finally { busy = false; render(); }
}

/* the last reading paints at once, marked STALE until a fresh one arrives */
try {
  const seed = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (seed && seed.v && Array.isArray(seed.v.pools)) { view = seed.v; readAt = seed.t; }
} catch (e) { /* no saved reading */ }
render();
load(true);
setInterval(load, POLL);
setInterval(renderStamp, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
