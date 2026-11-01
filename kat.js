/* kat.js: lays out /api/kat-trades. The book (average cost from 27 Oct 2026), the P&L
   chart, the trade simulator and the trade table are worked out here with kat-core.mjs,
   from the trades and hourly prices the API returns. */
import { replay, summary, pnlSeries, usdAtTick, simulate } from './kat-core.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MYT = 'Asia/Kuala_Lumpur';
const fmt = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
const money = (v, dp = 2) => (Number.isFinite(v) ? (v < 0 ? '-$' : '$') + fmt(Math.abs(v), dp) : '—');
const signed = (v) => (Number.isFinite(v) ? (v > 0.0049 ? '+' : v < -0.0049 ? '-' : '') + '$' + fmt(Math.abs(v), 2) : '—');
const tone = (v) => (v > 0.0049 ? 'up' : v < -0.0049 ? 'down' : '');
const price = (v) => (Number.isFinite(v) ? '$' + fmt(v, 6) : '—');
const kat = (v) => fmt(v, 2);
const fee = (v) => (!Number.isFinite(v) ? '—' : v > 0 && v < 0.005 ? '<$0.01' : money(v));
const when = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: MYT, day: 'numeric', month: 'short' });
const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const nowS = () => Date.now() / 1000;
const TX = 'https://explorer.katana.network/tx/';

const KEY = 'tf_kat', POLL = 30000, FRESH = 75;
let view = null, readAt = 0, lastOk = false, busy = false, failure = '', days = 7;   /* the chart opens on 7D (Alex, 1 Nov) */

function renderOverview(s) {
  const cells = $('overview').children;
  const set = (i, value, sub, cls) => {
    const v = cells[i].querySelector('.overview-value');
    v.textContent = value; v.className = 'overview-value' + (cls ? ' ' + cls : '');
    cells[i].querySelector('.metric-sub').textContent = sub;
  };
  /* KAT a day ago: the closing price of the hour that held that moment */
  const dayAgo = (() => { let t = null; for (const h of view.hours) if (h[0] <= view.head_ts - 86400) t = h[1]; return t === null ? null : usdAtTick(t); })();
  const change = dayAgo ? view.price_usd / dayAgo - 1 : null;
  set(0, price(view.price_usd), (change !== null ? `${change >= 0 ? '+' : ''}${fmt(change * 100, 2)}% in 24 h · ` : '') + 'Sushi KAT/vbUSDC');
  set(1, s.avg !== null ? price(s.avg) : '—', s.qty > 0 ? `${kat(s.qty)} KAT held · cost ${money(s.cost)}` : 'No KAT held in this book');
  set(2, signed(s.unrealized), s.qty > 0 ? `worth ${money(s.value)} · ${s.unrealized >= 0 ? '+' : ''}${fmt(s.unrealized / s.cost * 100, 2)}%` : 'Nothing held', tone(s.unrealized));
  set(3, signed(s.realized), `${s.sold.n} sale${s.sold.n === 1 ? '' : 's'} · total ${signed(s.total)}`, tone(s.realized));
}

/* ---- the chart: one dollar axis, three lines, the trades marked on the total ---- */
const SERIES = [
  { key: 'total', name: 'Total', color: 'var(--gold)', width: 2 },
  { key: 'realized', name: 'Realised', color: 'var(--text)', width: 1.4 },
  { key: 'unrealized', name: 'Unrealised', color: 'var(--chart-debt)', width: 1.4, dash: '4 3' },
];
const nice = (span) => { const step = Math.pow(10, Math.floor(Math.log10(span / 3))); return [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 4) || step * 10; };

function drawChart(points, trades) {
  const box = $('plot');
  if (points.length < 2) { box.innerHTML = '<div class="plot-empty">The line starts with the first trade.</div>'; box.onpointermove = box.onkeydown = box.onpointerleave = box.onblur = null; return; }
  const W = Math.max(240, box.clientWidth), H = Math.max(120, box.clientHeight), P = { l: 50, r: 12, t: 12, b: 26 };
  const start = points[0].ts, end = points[points.length - 1].ts, span = Math.max(1, end - start);
  const vals = points.flatMap((p) => SERIES.map((d) => p[d.key])).concat(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.02) { hi += 0.01; lo -= 0.01; }
  const step = nice(hi - lo), pad = (hi - lo) * 0.08;
  lo = Math.floor((lo - pad) / step) * step; hi = Math.ceil((hi + pad) / step) * step;
  const x = (t) => P.l + (t - start) / span * (W - P.l - P.r), y = (v) => H - P.b - (v - lo) / (hi - lo) * (H - P.t - P.b);
  const dp = step < 1 ? 2 : 0, font = 'font-family="var(--chart-font, Inter, system-ui, sans-serif)" font-size="10"';
  let svg = '';
  for (let v = lo; v <= hi + step / 2; v += step) {
    const yy = y(v).toFixed(1), zero = Math.abs(v) < step / 1000;
    svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="${zero ? 'var(--chart-zero)' : 'var(--chart-grid)'}"${zero ? ' stroke-dasharray="3 4"' : ''}/>`
      + `<text x="${P.l - 8}" y="${+yy + 3}" fill="var(--faint)" ${font} text-anchor="end">${zero ? '$0' : (v > 0 ? '+' : '-') + '$' + fmt(Math.abs(v), dp)}</text>`;
  }
  for (const d of SERIES) {
    const path = points.map((p, i) => (i ? 'L' : 'M') + x(p.ts).toFixed(1) + ',' + y(p[d.key]).toFixed(1)).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${d.color}" stroke-width="${d.width}"${d.dash ? ` stroke-dasharray="${d.dash}"` : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }
  for (const p of points) if (p.trade) svg += `<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p.total).toFixed(1)}" r="4" fill="var(--card)" stroke="var(--gold)" stroke-width="1.5"/>`;
  const last = points[points.length - 1];
  svg += `<circle cx="${x(last.ts).toFixed(1)}" cy="${y(last.total).toFixed(1)}" r="3" fill="var(--gold)"/>`;
  /* the time axis: Malaysian midnights, thinned to about six, and "now" at the end */
  const MID = 8 * 3600, every = Math.max(1, Math.ceil(span / 86400 / 6)) * 86400;
  let lastX = -Infinity;
  for (let m = Math.ceil((start + MID) / 86400) * 86400 - MID; m < end; m += every) {
    const xx = x(m);
    if (xx - lastX < 44 || W - P.r - xx < 40) continue;
    svg += `<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${H - P.b}" y2="${H - P.b + 4}" stroke="var(--chart-zero)"/><text x="${xx.toFixed(1)}" y="${H - 6}" fill="var(--faint)" ${font} text-anchor="middle">${esc(day(m))}</text>`;
    lastX = xx;
  }
  svg += `<text x="${W - P.r}" y="${H - 6}" fill="var(--faint)" ${font} text-anchor="end">now</text>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${svg}<line class="crosshair" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="var(--chart-zero)" stroke-dasharray="2 3" style="display:none"/></svg><div class="plot-tooltip" hidden></div>`;

  const byTs = new Map(trades.map((t) => [t.ts, t]));
  let cursor = points.length - 1;
  const show = (i) => {
    cursor = Math.max(0, Math.min(points.length - 1, i));
    const p = points[cursor], tip = box.querySelector('.plot-tooltip'), line = box.querySelector('.crosshair'), t = p.trade && byTs.get(p.ts);
    tip.hidden = false;
    tip.innerHTML = `<strong>${esc(cursor === points.length - 1 ? 'Now' : when(p.ts))}${cursor === points.length - 1 ? '' : ' MYT'}</strong>`
      + `<div class="tip-row"><span>KAT price</span><span>${price(p.price)}</span></div>`
      + SERIES.map((d) => `<div class="tip-row"><span>${d.name}</span><span>${signed(p[d.key])}</span></div>`).join('')
      + (t ? `<div class="tip-trade">${t.side === 'buy' ? 'Bought' : 'Sold'} ${kat(t.kat)} KAT at ${price(t.usd / t.kat)}</div>` : '');
    const at = x(p.ts);
    line.style.display = ''; line.setAttribute('x1', at); line.setAttribute('x2', at);
    tip.style.left = Math.max(0, Math.min(at / W * box.clientWidth - 70, box.clientWidth - tip.offsetWidth)) + 'px'; tip.style.top = '4px';
  };
  box.onpointermove = (e) => {
    const r = box.getBoundingClientRect(), t = start + Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width * W - P.l) / (W - P.l - P.r))) * span;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].ts - t) < Math.abs(points[best].ts - t)) best = i;
    show(best);
  };
  box.onpointerleave = () => { box.querySelector('.plot-tooltip').hidden = true; box.querySelector('.crosshair').style.display = 'none'; };
  box.onkeydown = (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); show(e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : cursor + (e.key === 'ArrowRight' ? 1 : -1)); }
    if (e.key === 'Escape') box.onpointerleave();
  };
  box.onblur = box.onpointerleave;
}

function renderChart(s) {
  const all = pnlSeries(view.trades, view.hours, { now: view.head_ts, priceUsd: view.price_usd });
  const from = days ? view.head_ts - days * 86400 : -Infinity;
  /* a period starts from the last point before it, so the line does not begin in mid-air */
  const first = all.findIndex((p) => p.ts >= from);
  const points = first > 0 ? all.slice(first - 1) : all;
  drawChart(points, view.trades);
  $('chartTotal').textContent = signed(s.total);
  $('chartTotal').className = 'chart-total ' + tone(s.total);
  $('holding').innerHTML = s.qty > 0
    ? `Holding <b>${kat(s.qty)} KAT</b> · cost ${money(s.cost)} · worth ${money(s.value)} at ${price(view.price_usd)}`
    : 'No KAT held in this book now.';
}

/* ---- the trade simulator: a short plan of buys and sells, run after the real trades.
   The steps are built once and kept through every refresh; only the results redraw. A
   step's price follows today's until it is typed or moved off "Now". ---- */
const MOVES = [-0.1, -0.05, 0, 0.05, 0.1];
const plan = [];
const priceInput = (v) => (Number.isFinite(v) ? v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '') : '');
const newStep = () => ({ side: 'buy', amount: '25', price: priceInput(view && view.price_usd), follow: true });

function buildSim() {
  const box = $('simSteps');
  box.innerHTML = plan.map((st, i) => `<div class="sim-step" data-i="${i}">
      <div class="sim-side" role="group" aria-label="Buy or sell"><button type="button" data-side="buy" aria-pressed="${st.side === 'buy'}" class="${st.side === 'buy' ? 'on' : ''}">Buy</button><button type="button" data-side="sell" aria-pressed="${st.side === 'sell'}" class="${st.side === 'sell' ? 'on' : ''}">Sell</button></div>
      <label class="sim-field"><span class="amt-label">${st.side === 'buy' ? 'Spend · USD' : 'Sell · KAT'}</span><input type="number" inputmode="decimal" step="any" min="0" data-f="amount" value="${esc(st.amount)}"></label>
      <label class="sim-field"><span>Price · USD per KAT</span><input type="number" inputmode="decimal" step="any" min="0" data-f="price" value="${esc(st.price)}"></label>
      <div class="sim-chips" role="group" aria-label="Price from today's">${MOVES.map((m) => `<button type="button" data-move="${m}">${m ? (m > 0 ? '+' : '−') + Math.abs(m * 100) + '%' : 'Now'}</button>`).join('')}</div>
      <button type="button" class="sim-remove" aria-label="Remove this trade" title="Remove this trade"${plan.length < 2 ? ' hidden' : ''}>×</button>
      <div class="sim-fill"></div>
    </div>`).join('');
  $('simAdd').hidden = plan.length >= 6;
}

function renderSim() {
  if (!plan.length) { plan.push(newStep()); buildSim(); }
  const now = view.price_usd;
  /* untouched prices follow today's */
  plan.forEach((st, i) => {
    if (!st.follow || st.price === priceInput(now)) return;
    st.price = priceInput(now);
    const el = $('simSteps').querySelector(`[data-i="${i}"] [data-f=price]`);
    if (el && document.activeElement !== el) el.value = st.price;
  });
  const steps = plan.map((st) => {
    const a = Number(st.amount), p = Number(st.price);
    return { side: st.side, price: p, usd: st.side === 'buy' ? a : undefined, kat: st.side === 'sell' ? a : undefined, valid: a > 0 && p > 0 };
  });
  const sim = simulate(view.trades, steps.filter((x) => x.valid), now);
  let r = 0;
  $('simSteps').querySelectorAll('.sim-step').forEach((el, i) => {
    const st = steps[i];
    el.querySelector('[data-f=amount]').setAttribute('aria-invalid', String(!(Number(plan[i].amount) > 0)));
    el.querySelector('[data-f=price]').setAttribute('aria-invalid', String(!(Number(plan[i].price) > 0)));
    el.querySelectorAll('.sim-chips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.move) === 0 && plan[i].follow));
    const fill = el.querySelector('.sim-fill');
    if (!st.valid) { fill.innerHTML = '<span class="muted">Enter an amount and a price.</span>'; return; }
    const row = sim.rows[r++], vsNow = st.price / now - 1;
    const at = `${price(st.price)}${Math.abs(vsNow) >= 0.0005 ? ` (${vsNow > 0 ? '+' : ''}${fmt(vsNow * 100, 1)}% on today)` : ''}`;
    if (row.side === 'buy') { fill.innerHTML = `Gets <b>${kat(row.kat)} KAT</b> for ${money(row.usd)} at ${at}`; return; }
    const held = row.kat - row.outside, avg = held > 0 ? row.basis / held : null;
    fill.innerHTML = `Gets <b>${money(row.usd)}</b> for ${kat(row.kat)} KAT at ${at}`
      + (row.realized !== null ? ` · realises <span class="${tone(row.realized)}">${signed(row.realized)}</span> against the ${price(avg)} average` : '')
      + (row.outside > 0 ? `<span class="outside">Only ${kat(held)} KAT is held in this book then; the other ${kat(row.outside)} is left out.</span>` : '');
  });
  const b = sim.before, a = sim.after;
  const cell = (label, value, cls, subText) => `<div><div class="metric-label">${label}</div><div class="metric-value ${cls || ''}">${value}</div><div class="metric-sub">${subText}</div></div>`;
  $('simOut').innerHTML = [
    cell('KAT held', kat(a.qty), '', `now ${kat(b.qty)}`),
    cell('Average buy price', a.avg !== null ? price(a.avg) : '—', 'gold', `now ${b.avg !== null ? price(b.avg) : '—'}`),
    cell('Realised P&amp;L', signed(a.realized), tone(a.realized), `${signed(a.realized - b.realized)} from these trades`),
    cell('Unrealised P&amp;L', signed(a.unrealized), tone(a.unrealized), `at today's ${price(now)} · now ${signed(b.unrealized)}`),
    cell('Total P&amp;L', signed(a.total), tone(a.total), `at today's price · now ${signed(b.total)}`),
    cell('Break-even price', a.breakEven !== null ? price(a.breakEven) : '—', '', a.breakEven !== null ? `total P&amp;L is zero here · now ${b.breakEven !== null ? price(b.breakEven) : '—'}` : 'nothing held after these trades'),
  ].join('');
  /* what the real routes took, so the price typed can allow for it */
  const cuts = view.trades.filter((t) => t.usd > 0).map((t) => t.fees.usd / t.usd * 100);
  $('simNote').textContent = (cuts.length ? `Your real trades lost ${fmt(Math.min(...cuts), 2)}–${fmt(Math.max(...cuts), 2)}% to fees, inside their prices; enter the price you would actually get. ` : '')
    + "Everything after the trades is valued at today's price.";
}

$('simSteps').addEventListener('input', (e) => {
  const f = e.target.dataset.f, step = e.target.closest('.sim-step');
  if (!f || !step) return;
  const i = Number(step.dataset.i);
  plan[i][f] = e.target.value;
  if (f === 'price') plan[i].follow = false;
  if (view) renderSim();
});
$('simSteps').addEventListener('click', (e) => {
  const step = e.target.closest('.sim-step'), b = e.target.closest('button');
  if (!step || !b) return;
  const i = Number(step.dataset.i), st = plan[i], now = view && view.price_usd;
  if (b.dataset.side) {
    if (b.dataset.side === st.side) return;
    /* keep the trade's size: dollars to KAT and back at its price */
    const a = Number(st.amount), p = Number(st.price) || now;
    if (a > 0 && p > 0) st.amount = st.side === 'buy' ? String(Math.round(a / p)) : (a * p).toFixed(2);
    st.side = b.dataset.side;
    buildSim();
  } else if (b.dataset.move !== undefined && now) {
    const m = Number(b.dataset.move);
    st.follow = m === 0; st.price = priceInput(now * (1 + m));
    step.querySelector('[data-f=price]').value = st.price;
  } else if (b.classList.contains('sim-remove')) {
    plan.splice(i, 1); buildSim();
  } else return;
  if (view) renderSim();
});
$('simAdd').addEventListener('click', () => {
  const prev = plan[plan.length - 1];
  plan.push(prev ? { ...prev } : newStep());
  buildSim();
  if (view) renderSim();
  const inputs = $('simSteps').querySelectorAll('[data-f=amount]');
  inputs[inputs.length - 1].focus();
});

/* ---- the trades, newest first ---- */
function renderTrades(s) {
  const rows = replay(view.trades).rows.reverse();
  const body = $('trades').querySelector('tbody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="trades-empty">No trades since 27 Oct yet.</td></tr>'; $('tradesFoot').textContent = ''; return; }
  body.innerHTML = rows.map((r) => {
    const pill = `<span class="side ${r.side}">${r.side === 'buy' ? 'Buy' : 'Sell'}</span>`;
    const parts = (r.fees.parts || []).map((p) => `${p.what}: ${fmt(p.amount, p.token === 'KAT' ? 4 : 6)} ${p.token} (${money(p.usd, 4)})`)
      .concat(r.fees.gas_eth > 0 ? [`Gas: ${fmt(r.fees.gas_eth * 1e9, 0)} gwei of ETH (${money(r.fees.gas_usd, 4)})`] : []).join('\n') || 'No fee taken';
    return `<tr>
      <td class="when"><a href="${TX + esc(r.hash)}" target="_blank" rel="noopener noreferrer" title="Open the transaction">${esc(when(r.ts))}<span class="ext">↗</span></a><span class="side-inline">${pill}</span></td>
      <td class="side-cell" data-label="Side">${pill}</td>
      <td class="num" data-label="KAT">${kat(r.kat)}</td>
      <td class="num" data-label="Price">${price(r.price)}</td>
      <td class="num" data-label="${r.side === 'buy' ? 'Paid' : 'Received'}">${fmt(r.usd, 2)} ${esc(r.token)}</td>
      <td class="num" data-label="Cost basis">${money(r.basis)}</td>
      <td class="num ${r.realized === null ? 'muted' : tone(r.realized)}" data-label="Realised">${r.realized === null ? '—' : signed(r.realized)}${r.outside > 0 ? `<span class="outside">${kat(r.outside)} KAT from outside this book, left out</span>` : ''}</td>
      <td class="num fee-cell" data-label="Fees" title="${esc(parts)}">${fee(r.fees.usd)}</td>
    </tr>`;
  }).join('');
  const avg = (x) => (x.kat > 0 ? price(x.usd / x.kat) : '—');
  $('tradesFoot').innerHTML = `Bought ${kat(s.bought.kat)} KAT for ${money(s.bought.usd)} (average ${avg(s.bought)}) · `
    + `Sold ${kat(s.sold.kat)} KAT for ${money(s.sold.usd)} (average ${avg(s.sold)}) · Fees ${fee(s.fees)} in all, already inside the prices`;
}

function renderWaiting() {
  const old = (view.waiting || []).filter((w) => view.head_ts - w.ts > 600);
  const note = $('waiting');
  note.hidden = !old.length;
  if (old.length) note.innerHTML = old.map((w) => `<b>${esc(kat(w.kat))} KAT</b> sent to a swap deposit address at ${esc(when(w.ts))} MYT has not been paid back yet. It shows as a sale once it is.`).join('<br>');
}

function renderStamp() {
  const age = nowS() - readAt, fresh = lastOk && age <= FRESH;
  $('stamp').className = 'stamp' + (fresh ? '' : ' stale');
  $('stamp').innerHTML = `<span class="dot"></span><span class="st">${fresh ? 'LIVE' : readAt ? 'STALE' : 'LOADING'}</span><br>${fresh ? clockTime(nowS()) : readAt ? clockTime(readAt) : '—'}`;
}

function render() {
  if (view) {
    const s = summary(view.trades, view.price_usd);
    renderOverview(s); renderChart(s); renderSim(); renderTrades(s); renderWaiting();
  }
  const msgs = [failure, ...((view && view.health && view.health.notes) || [])].filter(Boolean);
  $('health').textContent = msgs.join(' ');
  $('health').classList.toggle('on', msgs.length > 0);
  renderStamp();
}

const usable = (v) => v && Array.isArray(v.trades) && Array.isArray(v.hours) && v.price_usd > 0;

async function load(force) {
  if (busy || (!force && document.hidden)) return;
  busy = true;
  try {
    const r = await fetch('/api/kat-trades', { cache: 'no-store', signal: AbortSignal.timeout(25000) });
    const v = await r.json();
    if (!r.ok || v.error || !usable(v)) throw new Error(v.error || 'HTTP ' + r.status);
    view = v; readAt = nowS(); lastOk = true; failure = '';
    try { localStorage.setItem(KEY, JSON.stringify({ t: readAt, v })); } catch (e) { /* storage is a convenience */ }
  } catch (e) {
    lastOk = false;
    failure = view ? `Could not refresh (${e.message}). Showing the reading from ${when(readAt)} MYT.` : `Could not read the trades yet (${e.message}). Retrying.`;
  } finally { busy = false; render(); }
}

document.querySelectorAll('.ranges button').forEach((b) => b.addEventListener('click', () => {
  days = Number(b.dataset.days);
  document.querySelectorAll('.ranges button').forEach((o) => { o.classList.toggle('on', o === b); o.setAttribute('aria-pressed', String(o === b)); });
  if (view) renderChart(summary(view.trades, view.price_usd));
}));
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view) renderChart(summary(view.trades, view.price_usd)); }, 120); });

/* the last reading paints at once, marked STALE until a fresh one arrives */
try {
  const seed = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (seed && usable(seed.v)) { view = seed.v; readAt = seed.t; }
} catch (e) { /* no saved reading */ }
render();
load(true);
setInterval(load, POLL);
setInterval(renderStamp, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
