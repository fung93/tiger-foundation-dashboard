/* vkat.js: lays out /api/vkat. The API returns the finished book (vkat-core.mjs's voteBook):
   each epoch's vote, its rewards and their value, and the totals; this page draws the
   cards, the labelled reward chart and the vote history. */
import { epochStart, EPOCH } from './vkat-core.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MYT = 'Asia/Kuala_Lumpur';
const fmt = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
const money = (v) => (Number.isFinite(v) ? (v < 0 ? '-$' : '$') + fmt(Math.abs(v), 2) : '—');
const cents = (v) => (v > 0 && v < 0.005 ? '<$0.01' : money(v));
const pct = (v) => (Number.isFinite(v) ? fmt(v * 100, Math.abs(v) >= 10 ? 0 : 1) + '%' : '—');
/* a token amount with as many places as it needs: dollars in cents, dust by its first figures */
const STABLES = new Set(['vbUSDC', 'vbUSDT', 'AUSD', 'USDC']);
const amount = (v, t) => (STABLES.has(t) || v >= 100 ? fmt(v, 2) : v >= 1 ? fmt(v, 4) : v > 0 ? v.toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '0');
/* "24 Sep", not the browser's "24 Sept" */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const myt = (ts) => new Date((ts + 8 * 3600) * 1000);
const day = (ts) => { const d = myt(ts); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
const when = (ts) => { const d = myt(ts); return `${day(ts)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: MYT, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const nowS = () => Date.now() / 1000;
const ORDER = ['vbUSDC', 'vbUSDT', 'vbETH', 'vbWBTC', 'KAT'];
const tokenList = (t) => Object.entries(t).sort((a, b) => (ORDER.indexOf(a[0]) + 99 * (ORDER.indexOf(a[0]) < 0)) - (ORDER.indexOf(b[0]) + 99 * (ORDER.indexOf(b[0]) < 0)));

const KEY = 'tf_vkat', POLL = 60000, FRESH = 150;
let view = null, readAt = 0, lastOk = false, busy = false, failure = '';

function renderOverview() {
  const b = view.book, cells = $('overview').children;
  const set = (i, value, sub) => { cells[i].querySelector('.overview-value').textContent = value; cells[i].querySelector('.metric-sub').textContent = sub; };
  const kat = view.locks.reduce((s, l) => s + (l.kat || 0), 0), power = view.locks.reduce((s, l) => s + (l.power || 0), 0);
  const ids = view.locks.map((l) => '#' + l.id).join(', ');
  set(0, fmt(kat, 2), view.locks.length ? `${view.locks.length === 1 ? 'lock' : 'locks'} ${ids} · worth ${money(kat * view.kat_usd)}` : 'No vKAT lock held');
  const standing = view.standing.map((s) => view.pools[s.gauge] || s.gauge.slice(0, 10)).join(', ');
  set(1, `${b.voted} epoch${b.voted === 1 ? '' : 's'}`, `voting power ${fmt(power, 0)}` + (standing ? ` · now on ${standing}` : ''));
  set(2, money(b.total_usd), `${b.voted} epoch${b.voted === 1 ? '' : 's'} · ${b.claimed ? 'all claimed' : 'some still to claim'}`);
  /* the breakdown behind the "!": each token, its amount and its dollars when paid */
  $('rewardInfo').querySelector('.info-tip').innerHTML = '<span class="info-title">Reward breakdown</span>'
    + tokenList(b.tokens).map(([t, v]) => `<span class="info-row"><span>${amount(v, t)} ${esc(t)}</span><span>${cents((b.tokens_usd || {})[t])}</span></span>`).join('')
    + `<span class="info-foot">Each valued when it was paid${b.claimed ? ' · all claimed' : ''}</span>`;
  set(3, pct(b.apy), `APR ${pct(b.apr)} · ${b.epochs.filter((e) => e.settled && e.value_usd).length} epochs, vKAT at each epoch's KAT price`);
  const w = view.vote_week, note = $('voteNote');
  note.hidden = false;
  note.innerHTML = w.open
    ? `<b>Epoch ${view.epoch}'s vote is open</b> until ${esc(when(w.closes))} MYT.` + (standing ? ` Your vote stands on ${esc(standing)}.` : ' You have no vote standing.')
    : `<b>Epoch ${view.epoch + 1}'s vote</b> opens ${esc(when(w.opens))} and closes ${esc(when(w.closes))} MYT.` + (standing ? ` Your vote stays on ${esc(standing)} unless you change it.` : '');
}

/* ---- the chart: the total reward so far, epoch by epoch, each point labelled with that
   epoch's reward. Points keep at least 52 px apart so every label sits clear above its
   own point; when the epochs outgrow the card the chart scrolls sideways, opening on the
   latest, with the dollar axis pinned at the left. ---- */
const MIN_GAP = 52;
function drawChart() {
  const box = $('plot'), eps = view.book.epochs;
  if (!eps.length) { box.innerHTML = '<div class="plot-empty">The line starts with the first vote.</div>'; return; }
  const n = eps.length, P = { l: 46, r: 22, t: 26, b: 34 };
  const avail = Math.max(240, box.clientWidth), H = Math.max(140, box.clientHeight);
  const W = Math.max(avail, P.l + P.r + (n - 1) * MIN_GAP), scroll = W > avail + 1;
  const top = Math.max(1, ...eps.map((e) => e.cumulative));
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => top / v <= 4) || 1000;
  const hi = Math.ceil(top * 1.12 / step) * step;
  const gap = (W - P.l - P.r) / Math.max(1, n - 1);
  const x = (i) => (n === 1 ? (W + P.l - P.r) / 2 : P.l + i * gap), y = (v) => H - P.b - v / hi * (H - P.t - P.b);
  const font = 'font-family="var(--chart-font, Inter, system-ui, sans-serif)"';
  let svg = '', axis = '';
  for (let v = 0; v <= hi + step / 2; v += step) {
    const yy = y(v).toFixed(1);
    svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="${v ? 'var(--chart-grid)' : 'var(--chart-zero)'}"/>`;
    axis += `<text x="${P.l - 8}" y="${+yy + 3}" fill="var(--faint)" ${font} font-size="10" text-anchor="end">$${fmt(v, 0)}</text>`;
  }
  eps.forEach((e, i) => {
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 18}" fill="var(--faint)" ${font} font-size="10" text-anchor="middle">${e.epoch}</text>`
      + `<text x="${x(i).toFixed(1)}" y="${H - 5}" fill="var(--faint)" ${font} font-size="9" text-anchor="middle">${esc(day(epochStart(e.epoch)))}</text>`;
  });
  svg += `<path d="${eps.map((e, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(e.cumulative).toFixed(1)).join(' ')}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round"/>`;
  eps.forEach((e, i) => {
    const cx = x(i).toFixed(1), cy = y(e.cumulative);
    svg += `<circle cx="${cx}" cy="${cy.toFixed(1)}" r="4.5" fill="var(--card)" stroke="var(--gold)" stroke-width="1.6"/>`
      + `<text x="${cx}" y="${(cy - 11).toFixed(1)}" fill="var(--text)" ${font} font-size="10.5" font-weight="500" text-anchor="middle">+${esc(money(e.usd))}</text>`;
  });
  svg += `<line class="crosshair" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="var(--chart-zero)" stroke-dasharray="2 3" style="display:none"/>`;
  const main = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${scroll ? '' : axis}${svg}</svg>`;
  box.innerHTML = `<div class="plot-scroll${scroll ? ' on' : ''}">${main}</div>`
    + (scroll ? `<svg class="plot-yaxis" width="${P.l}" height="${H}" viewBox="0 0 ${P.l} ${H}" aria-hidden="true">${axis}</svg>` : '')
    + '<div class="plot-tooltip" hidden></div>';
  const pane = box.querySelector('.plot-scroll');
  if (scroll) pane.scrollLeft = pane.scrollWidth;
  $('chartHint').textContent = scroll ? 'Swipe sideways for earlier epochs' : "Each point is labelled with that epoch's reward";
  let cursor = n - 1;
  const show = (i) => {
    cursor = Math.max(0, Math.min(n - 1, i));
    const e = eps[cursor], tip = box.querySelector('.plot-tooltip'), line = box.querySelector('.crosshair');
    tip.hidden = false;
    tip.innerHTML = `<strong>Epoch ${e.epoch} · ${esc(day(epochStart(e.epoch)))} – ${esc(day(epochStart(e.epoch) + EPOCH))}</strong>`
      + `<div class="tip-row"><span>Voted</span><span>${esc(e.pools.map((q) => view.pools[q.gauge] || q.gauge.slice(0, 10)).join(', ') || '—')}</span></div>`
      + `<div class="tip-row"><span>That epoch</span><span>+${money(e.usd)}</span></div>`
      + `<div class="tip-row"><span>Total so far</span><span>${money(e.cumulative)}</span></div>`
      + `<div class="tip-row"><span>APY</span><span>${pct(e.apy)}</span></div>`;
    line.style.display = ''; line.setAttribute('x1', x(cursor)); line.setAttribute('x2', x(cursor));
    const at = x(cursor) - pane.scrollLeft;
    if (scroll && (at < P.l || at > avail - 10)) { pane.scrollLeft = Math.max(0, x(cursor) - avail / 2); }
    tip.style.left = Math.max(0, Math.min(x(cursor) - pane.scrollLeft - 80, box.clientWidth - tip.offsetWidth)) + 'px'; tip.style.top = '4px';
  };
  box.onpointermove = (ev) => { const r = pane.getBoundingClientRect(); show(Math.round((ev.clientX - r.left + pane.scrollLeft + (scroll ? P.l : 0) - P.l) / gap)); };   /* the pane starts after the pinned axis when it scrolls */
  box.onpointerleave = () => { box.querySelector('.plot-tooltip').hidden = true; box.querySelector('.crosshair').style.display = 'none'; };
  pane.onscroll = () => box.onpointerleave();
  box.onkeydown = (ev) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) { ev.preventDefault(); show(ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : cursor + (ev.key === 'ArrowRight' ? 1 : -1)); }
    if (ev.key === 'Escape') box.onpointerleave();
  };
  box.onblur = box.onpointerleave;
  $('chartTotal').textContent = money(view.book.total_usd);
}

/* ---- the vote history, newest first ---- */
function renderVotes() {
  const body = $('votes').querySelector('tbody'), eps = [...view.book.epochs].reverse();
  if (!eps.length) { body.innerHTML = '<tr><td colspan="6" class="trades-empty">No vote recorded yet.</td></tr>'; return; }
  body.innerHTML = eps.map((e) => {
    const s = epochStart(e.epoch), isNow = e.epoch === view.epoch;
    const pools = e.pools.length ? e.pools.map((p) => `<span>${esc(view.pools[p.gauge] || p.gauge.slice(0, 10))}${e.pools.length > 1 ? ` <span class="muted">· ${fmt(p.votes, 0)}</span>` : ''}</span>`).join('') : '<span class="muted">No vote standing</span>';
    const rewards = tokenList(e.rewards);
    const rewardCell = rewards.length ? rewards.map(([t, v]) => `<span>${amount(v, t)} ${esc(t)}</span>`).join('') : `<span class="muted">${e.settled ? 'None' : 'Not paid yet'}</span>`;
    /* on a phone: epoch and value, pool and APY, then vKAT and what it was paid in */
    const short = `<td class="ph-meta">${e.total > 0 ? fmt(e.total, 0) + ' vKAT' : 'No vote'}${rewards.length ? ' · paid in ' + rewards.map(([t]) => esc(t)).join(' + ') : ''}</td>`;
    return `<tr>
      <td class="epoch"><b>${e.epoch}${isNow ? '<span class="now-tag">now</span>' : ''}</b><span class="dates">${esc(day(s))} – ${esc(day(s + EPOCH))}</span></td>
      <td class="pools lines" data-label="Pool voted">${pools}</td>
      <td class="num vkat" data-label="vKAT used">${e.total > 0 ? fmt(e.total, 2) : '—'}</td>
      <td class="lines reward" data-label="Reward">${rewardCell}</td>
      <td class="num value" data-label="Value">${money(e.usd)}</td>
      <td class="num apy-cell" data-label="APY" title="${e.apr !== null ? `APR ${pct(e.apr)} · KAT $${fmt(e.kat_usd, 6)} when the vote week closed` : ''}"><span class="apy">${pct(e.apy)}</span><span class="ph-apy"> APY</span>${e.apr !== null ? `<span class="sub">APR ${pct(e.apr)}</span>` : ''}</td>
      ${short}
    </tr>`;
  }).join('');
  const b = view.book, best = [...b.epochs].filter((e) => e.apy !== null).sort((a, c) => c.apy - a.apy)[0];
  $('votesFoot').textContent = `${b.voted} epochs voted · ${money(b.total_usd)} in all at the prices when each was paid` + (best ? ` · best: epoch ${best.epoch}, ${view.pools[best.pools[0] && best.pools[0].gauge] || ''}, ${pct(best.apy)} APY` : '');
}

function renderStamp() {
  const age = nowS() - readAt, fresh = lastOk && age <= FRESH;
  $('stamp').className = 'stamp' + (fresh ? '' : ' stale');
  $('stamp').innerHTML = `<span class="dot"></span><span class="st">${fresh ? 'LIVE' : readAt ? 'STALE' : 'LOADING'}</span><br>${fresh ? clockTime(nowS()) : readAt ? clockTime(readAt) : '—'}`;
}

function render() {
  if (view) { renderOverview(); drawChart(); renderVotes(); }
  const msgs = [failure, ...((view && view.health && view.health.notes) || [])].filter(Boolean);
  $('health').textContent = msgs.join(' ');
  $('health').classList.toggle('on', msgs.length > 0);
  renderStamp();
}

const usable = (v) => v && v.book && Array.isArray(v.book.epochs) && Array.isArray(v.locks);

async function load(force) {
  if (busy || (!force && document.hidden)) return;
  busy = true;
  try {
    const r = await fetch('/api/vkat', { cache: 'no-store', signal: AbortSignal.timeout(40000) });
    const v = await r.json();
    if (!r.ok || v.error || !usable(v)) throw new Error(v.error || 'HTTP ' + r.status);
    view = v; readAt = nowS(); lastOk = true; failure = '';
    try { localStorage.setItem(KEY, JSON.stringify({ t: readAt, v })); } catch (e) { /* storage is a convenience */ }
  } catch (e) {
    lastOk = false;
    failure = view ? `Could not refresh (${e.message}). Showing the reading from ${when(readAt)} MYT.` : `Could not read the votes yet (${e.message}). Retrying.`;
  } finally { busy = false; render(); }
}

/* the "!" opens on hover or focus, and on a tap for phones; a tap elsewhere or Escape closes it */
const info = $('rewardInfo'), infoBtn = info.querySelector('.info-btn');
const setInfo = (open) => { info.classList.toggle('open', open); infoBtn.setAttribute('aria-expanded', String(open)); };
infoBtn.addEventListener('click', (e) => { e.stopPropagation(); setInfo(!info.classList.contains('open')); });
document.addEventListener('click', (e) => { if (!info.contains(e.target)) setInfo(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setInfo(false); });

let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view) drawChart(); }, 120); });

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
