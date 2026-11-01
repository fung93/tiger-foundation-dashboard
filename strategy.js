/* strategy.js: lays out /api/strategy and runs each pool's estimate with strategy-core.mjs.
   Inputs and open pools survive every refresh: the cards are built once and updated in
   place, never rebuilt under the cursor. */
import { estimateReward, byApr, RANGE_DAYS } from './strategy-core.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MYT = 'Asia/Kuala_Lumpur';
const fmt = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
const money = (v) => (Number.isFinite(v) ? (v < 0 ? '-$' : '$') + fmt(Math.abs(v), 2) : '—');
const kat = (v) => (Number.isFinite(v) ? fmt(v, v < 100 ? 2 : 0) + ' KAT' : '—');
const pct = (v) => (Number.isFinite(v) ? fmt(v * 100, Math.abs(v) >= 1 ? 0 : 2) + '%' : '—');
const priceDp = (p) => (p >= 1000 ? 2 : p >= 1 ? 4 : 6);
const price = (p) => (Number.isFinite(p) ? fmt(p, priceDp(p)) : '—');
const tokens = (v) => (Number.isFinite(v) ? fmt(v, v >= 100 ? 2 : v >= 1 ? 4 : 6) : '—');
const when = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short' });
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', hour12: false });
const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/* a calendar day in Malaysia time, as the date input reads it */
const isoDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: MYT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
const dayStart = (iso) => Date.parse(iso + 'T00:00:00+08:00') / 1000;
const nowS = () => Date.now() / 1000;
const left = (s) => (s <= 0 ? 'ended' : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h left` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left`);

const KEY = 'tf_strategy', POLL = 60000, FRESH = 150;
let view = null, readAt = 0, lastOk = false, busy = false, failure = '';
const state = new Map();   /* pool → the inputs and whether it is open */
const cards = new Map();   /* pool → its card */

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
  el.innerHTML = `<button class="pool-head" type="button" aria-expanded="false" aria-controls="${id}-body">
      <div class="pool-name"><h3></h3><span class="tag fee"></span></div>
      <div class="pool-figs"><div><div class="metric-label">APR</div><div class="pool-fig apr"></div></div><div><div class="metric-label">KAT per day</div><div class="pool-fig kat"></div></div><div><div class="metric-label">Value per day</div><div class="pool-fig usd"></div></div></div>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="pool-body" id="${id}-body" hidden>
      <div class="pool-context"></div>
      <div class="calc">
        <div class="calc-inputs">
          <label><span class="lo-label">Lower price</span><input type="number" inputmode="decimal" step="any" min="0" data-f="lower"></label>
          <label><span class="hi-label">Upper price</span><input type="number" inputmode="decimal" step="any" min="0" data-f="upper"></label>
          <label>Capital · USD<input type="number" inputmode="decimal" step="any" min="0" data-f="capital"></label>
          <label>Start day<input type="date" data-f="start"></label>
          <div class="preset-row"><span class="presets-label">Around now</span><div class="presets around" role="group" aria-label="Range around the current price"></div></div>
          <div class="preset-row"><span class="presets-label">Recent</span><div class="presets recent" role="group" aria-label="The price's recent low and high"></div></div>
        </div>
        <div class="calc-out" aria-live="polite"></div>
      </div>
    </div>`;
  const s = state.get(p.pool);
  el.querySelectorAll('input[data-f]').forEach((input) => {
    input.value = s[input.dataset.f];
    input.addEventListener('input', () => { s[input.dataset.f] = input.value; estimate(p.pool); });
  });
  el.querySelector('.pool-head').addEventListener('click', () => {
    s.open = !s.open;
    el.classList.toggle('open', s.open);
    el.querySelector('.pool-head').setAttribute('aria-expanded', String(s.open));
    el.querySelector('.pool-body').hidden = !s.open;
    if (s.open) estimate(p.pool);
  });
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

const current = (pool) => view.pools.find((p) => p.pool === pool);

function estimate(pool) {
  const p = current(pool), el = cards.get(pool), s = state.get(pool);
  if (!p || !el || !s.open) return;
  const out = el.querySelector('.calc-out'), t = nowS();
  const startTs = s.start && s.start !== isoDay(t) ? dayStart(s.start) : t;
  const e = estimateReward(p, { capitalUsd: Number(s.capital), lowerPrice: Number(s.lower), upperPrice: Number(s.upper), startTs },
    { now: t, katUsd: view.kat_usd, rewardStart: view.reward.start, rewardEnd: view.reward.end });
  el.querySelector('[data-f=lower]').setAttribute('aria-invalid', String(!!e.error && !(Number(s.lower) > 0)));
  el.querySelector('[data-f=capital]').setAttribute('aria-invalid', String(!(Number(s.capital) > 0)));
  if (e.error) { out.innerHTML = `<div class="calc-error">${esc(e.error)}</div>`; return; }
  const [base, quote] = p.baseIndex === 0 ? [p.token0, p.token1] : [p.token1, p.token0];
  const [dBase, dQuote] = p.baseIndex === 0 ? [e.deposit.amount0, e.deposit.amount1] : [e.deposit.amount1, e.deposit.amount0];
  const notes = [`Range rounds to ${price(e.range.lowerPrice)} – ${price(e.range.upperPrice)} ${esc(quote.symbol)} per ${esc(base.symbol)}, Sushi's nearest price steps. Deposit about ${tokens(dBase)} ${esc(base.symbol)} + ${tokens(dQuote)} ${esc(quote.symbol)} at today's price, then stake it.`];
  const pick = s.picked;
  if (pick && Number(s.lower) === pick.lower && Number(s.upper) === pick.upper)
    notes.unshift(`Range set from the last ${pick.days} days' lowest and highest traded price (${fmt(pick.swaps)} swaps${pick.complete ? '' : ', history incomplete'}).`);
  let warn = false;
  if (!e.inRange) { notes.push('The price is outside this range now, so it earns nothing until the price moves into it.'); warn = true; }
  if (e.days <= 0) { notes.push('This reward period has ended by that start day; the next epoch’s KAT is set by its vote.'); warn = true; }
  out.innerHTML = `
    <div><div class="metric-label">My KAT per day</div><div class="metric-value big">${kat(e.katPerDay)}</div><div class="metric-sub">${money(e.usdPerDay)} a day</div></div>
    <div><div class="metric-label">From ${esc(day(e.from))} to the period's end</div><div class="metric-value">${kat(e.totalKat)}</div><div class="metric-sub">${money(e.totalUsd)} over ${fmt(e.days, 1)} days, to ${esc(when(view.reward.end))}</div></div>
    <div><div class="metric-label">My share of the pool's KAT</div><div class="metric-value">${pct(e.share)}</div><div class="metric-sub">of ${kat(p.katPerDay)} a day</div></div>
    <div><div class="metric-label">APR on my capital</div><div class="metric-value">${pct(e.apr)}</div><div class="metric-sub">on ${money(Number(s.capital))}, KAT only</div></div>
    <div class="calc-note${warn ? ' warn' : ''}">${notes.join(' ')}</div>`;
}

function renderPools() {
  const box = $('pools');
  if (!view.pools.length) { box.innerHTML = '<div class="card overview-card">No live staking campaign right now. The next one starts when the epoch vote closes.</div>'; cards.clear(); return; }
  const live = new Set(view.pools.map((p) => p.pool));
  for (const [pool, el] of cards) if (!live.has(pool)) { el.remove(); cards.delete(pool); }
  box.querySelectorAll(':scope > :not(.pool-card)').forEach((n) => n.remove());
  for (const p of byApr(view.pools)) {
    if (!state.has(p.pool)) state.set(p.pool, defaults(p));
    const el = cards.get(p.pool) || build(p);
    box.append(el);   /* re-appending keeps the APR order without rebuilding */
    el.querySelector('h3').textContent = `${p.base} / ${p.quote}`;
    el.querySelector('.fee').textContent = (p.fee_tier * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
    el.querySelector('.apr').textContent = pct(p.apr);
    el.querySelector('.kat').textContent = fmt(p.katPerDay, 0);
    el.querySelector('.usd').textContent = money(p.katPerDay * view.kat_usd);
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
    const share = p.eligible.liquidity > 0 && p.activeLiquidity > 0 ? p.eligible.liquidity / p.activeLiquidity : null;
    el.querySelector('.pool-context').innerHTML = [
      `Now ${price(p.price)} ${esc(p.quote)} per ${esc(p.base)}`,
      `${kat(p.kat)} this epoch`,
      p.voteShare !== null ? `${pct(p.voteShare)} of gauge votes` : null,
      `${fmt(p.eligible.inRange)} staked positions and vault ranges in range` + (share !== null ? `, ${pct(share)} of the pool's active liquidity` : ''),
      p.tvl !== null ? `${money(p.tvl)} staked (Merkl)` : null,
      p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Sushi pool ↗</a>` : null,
    ].filter(Boolean).join(' · ');
    estimate(p.pool);
  }
}

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
