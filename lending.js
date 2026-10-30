import { MARKETS, readMorpho, targetMetrics, liquidationMetrics } from './morpho-core.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = value => Number.isFinite(value) ? '$' + value.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) : '—';
const katPrice = value => Number.isFinite(value) && value>0 ? '$'+(value<1e-6 ? value.toExponential(4) : value.toFixed(6)) : '—';
const number = (value, digits=2) => {
  if(!Number.isFinite(value))return '—';
  const magnitude=Math.abs(value);
  return magnitude>=1e12 || (magnitude>0 && magnitude<10**-digits)
    ? value.toExponential(Math.min(digits,4)) : value.toLocaleString('en-US', { maximumFractionDigits:digits });
};
const pct = value => number(value * 100, 2) + '%';
const ltvInputValue = (lltv, health) => {
  const value=lltv/health*100, rounded=Math.round(value*10000)/10000;
  return String(rounded>0 ? rounded : value);
};
const date = (ts, full=false) => new Date(ts*1000).toLocaleString('en-GB', { timeZone:'Asia/Kuala_Lumpur', day:'numeric', month:'short', ...(full ? { year:'numeric' } : {}), hour:'2-digit', minute:'2-digit', hour12:false });
const time = ts => new Date(ts*1000).toLocaleTimeString('en-GB', { timeZone:'Asia/Kuala_Lumpur', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const CACHE = 'tf_morpho_full_v1';
const DEFAULT_MAX_LTV = { 'avkat-kat': .70, 'avkat-usdc': .35, 'kat-usdc': .35 };
const HOLD = 5*60, POLL = 15000;
let targets = {}, records = new Map(), history = [], live = null, busy = false, historyBusy = false, historyReadAt = 0, warnings = [], lastFull = false, lastRead = 0;
let katQuote = null;
const editing = new Set(), drafts = new Map();
const periods = new Map(MARKETS.map(m=>[m.id,7]));
// Each page opening starts from Alex's defaults; edits apply only to this visit.
function resetTargets() {
  for (const m of MARKETS) targets[m.id] = targetMetrics({lltv:m.lltv,error:'default'},m.lltv/DEFAULT_MAX_LTV[m.key]).target_health;
}
resetTargets();

function tokenAmount(value, token, direction='normal') {
  if (!Number.isFinite(value)) return '—';
  // Room rounds down; a repayment rounds up. Never round a small positive repayment to zero.
  const dp = token === 'KAT' ? 2 : 6, scale = 10 ** dp;
  const n = direction === 'borrow' ? Math.floor(value * scale + 1e-9) / scale : direction === 'repay' ? Math.ceil(value * scale - 1e-9) / scale : value;
  return number(n, dp) + ' ' + token;
}

function shell(m) {
  const article = document.createElement('article');
  article.className = 'card market-card'; article.id = m.key;
  article.innerHTML = `<div class="market-head"><div><h3 class="market-name">${esc(m.label)}</h3><div class="market-context">${esc(m.collateral_token)} collateral · ${esc(m.loan_token)} borrowed · <span class="market-lltv">Market LLTV ${pct(m.lltv)}</span></div><div class="market-state"><span class="status-pill">Loading</span><span class="reading-time"></span></div></div>
    <div class="target-box"><div class="target-fields"><div class="target-field"><label for="${m.key}-target">My minimum health</label><input type="number" id="${m.key}-target" data-target="${m.id}" min="1" step="any" inputmode="decimal" value="${targets[m.id]}" aria-describedby="${m.key}-help" readonly></div><div class="target-field"><div class="target-label-row"><label for="${m.key}-ltv">My max LTV %</label><div class="target-actions"><button type="button" class="target-edit" data-edit="${m.id}" aria-label="Edit ${esc(m.label)} limit">Edit</button><button type="button" class="target-save" data-save="${m.id}" aria-label="Save ${esc(m.label)} limit" hidden>Save</button><button type="button" class="target-cancel" data-cancel="${m.id}" aria-label="Cancel ${esc(m.label)} edit" title="Cancel" hidden>&times;</button></div></div><input type="number" id="${m.key}-ltv" data-ltv="${m.id}" min="0" max="${m.lltv*100}" step="any" inputmode="decimal" value="${ltvInputValue(m.lltv,targets[m.id])}" aria-describedby="${m.key}-help" readonly></div></div><span class="target-help" id="${m.key}-help" role="status">Saved target · choose Edit to change</span></div></div>
    <div class="market-figures"><div><div class="metric-label">Collateral · oracle</div><div class="metric-value col-value">—</div><div class="metric-sub col-sub">Reading collateral…</div></div><div><div class="metric-label">My debt limit</div><div class="metric-value limit-value">—</div><div class="metric-sub limit-sub">At my chosen health</div></div><div><div class="metric-label debt-label"><span>Borrowed</span><span class="current-ltv">LTV —</span></div><div class="metric-value debt-value">—</div><div class="metric-sub debt-sub">Reading debt…</div></div><div><div class="metric-label action-label">Borrow or repay</div><div class="metric-value room-value">—</div><div class="metric-sub action-sub">Waiting for a complete reading</div></div></div>
    <div class="liquidation-box"><div><div class="metric-label liquidation-label">KAT liquidation price</div><div class="liquidation-value">—</div><div class="liquidation-current"></div></div><div class="liquidation-explanation">Reading Morpho’s liquidation boundary…</div></div>
    <div class="market-chart-bar"><div class="metric-label">Market history</div><div class="ranges" role="group" aria-label="${esc(m.label)} chart period"><button type="button" data-days="7" class="on" aria-pressed="true">7D</button><button type="button" data-days="14" aria-pressed="false">14D</button><button type="button" data-days="0" aria-pressed="false">All</button></div></div>
    <div class="market-graphs"><section class="plot-block"><div class="plot-heading"><span>Collateral &amp; borrowing</span><span>USD · oracle value</span></div><div class="plot value-plot" tabindex="0" role="img" aria-label="${esc(m.label)} collateral, debt and borrowing limits over time"></div><div class="plot-legend"><span><i style="border-color:var(--text)"></i>Collateral · oracle</span><span><i style="border-color:var(--chart-debt)"></i>Borrowed</span><span><i style="border-color:var(--gold)"></i>My saved limit</span><span><i class="dash" style="border-color:var(--chart-boundary)"></i>Liquidation boundary · 1</span></div></section>
    <section class="plot-block"><div class="plot-heading"><span>Health</span><span class="health-now">—</span></div><div class="plot health-plot" tabindex="0" role="img" aria-label="${esc(m.label)} health over time, saved target and liquidation boundary"></div><div class="plot-legend"><span><i style="border-color:var(--text)"></i>Actual health</span><span><i class="dash" style="border-color:var(--gold)"></i>My saved target</span><span><i class="dash" style="border-color:var(--chart-boundary)"></i>Liquidation boundary · 1</span></div></section></div>
    <div class="market-foot"><span class="liquidation-note">Health 1 is the liquidation boundary</span><a href="https://app.morpho.org/katana/market/${m.id}" target="_blank" rel="noopener noreferrer">Market on Morpho ↗</a></div>`;
  $('markets').append(article);
}
MARKETS.forEach(shell);

function targetMessage(m,text,error=false){$(m.key).querySelector('.target-box').classList.toggle('has-error',error);$(m.key+'-help').textContent=text;}

function renderLiquidation(el,row,expired,stale) {
  const metric=liquidationMetrics(row),label=el.querySelector('.liquidation-label'),value=el.querySelector('.liquidation-value'),current=el.querySelector('.liquidation-current'),explain=el.querySelector('.liquidation-explanation');
  label.textContent=metric.kind==='kat-ratio'?'avKAT / KAT liquidation boundary':'Est. KAT liquidation price';
  el.dataset.liquidationPrice=String(metric.estimated_kat_liquidation_usd);
  el.dataset.liquidationRatio=String(metric.oracle_liquidation_price);
  value.classList.remove('ratio-message');
  if(expired){value.textContent='—';current.textContent='Reading over 5 minutes old';explain.textContent='Waiting for a fresh market reading before showing the liquidation estimate.';return;}
  if(metric.status==='no-debt'){value.textContent='No debt';current.textContent='No current loan to liquidate';explain.textContent='A liquidation threshold will appear when there is debt in this market.';return;}
  if(metric.status!=='ok'){value.textContent='Unavailable';current.textContent='';explain.textContent='A complete collateral, debt and oracle reading is needed.';return;}
  const price=n=>Number.isFinite(n)?'$'+n.toFixed(6):'—';
  if(metric.kind==='kat-ratio'){
    value.textContent='No single KAT dollar price';value.classList.add('ratio-message');
    current.textContent=`Boundary: 1 avKAT = ${number(metric.oracle_liquidation_price,6)} KAT · now ${number(metric.oracle_current_price,6)} KAT`;
    explain.textContent='Both collateral and debt are in KAT, so KAT’s dollar price cancels out. Liquidation becomes possible below this avKAT-to-KAT oracle ratio. Interest can still reduce health.';
  } else if(Number.isFinite(metric.estimated_kat_liquidation_usd)) {
    value.textContent=price(metric.estimated_kat_liquidation_usd);
    current.textContent=`${metric.kat_price_basis==='oracle'?'Morpho KAT price':'KAT market price'} at reading ${price(metric.kat_price_usd)} · `+(metric.liquidatable?'already below the liquidation boundary':`${number(metric.kat_drop_pct,2)}% below that price`);
    explain.textContent=(metric.kat_price_basis==='oracle'?'Based on Morpho’s KAT/USD price feed.':'KAT/USD oracle feed unavailable; this is a market-price-scaled estimate.')+' Assumes current debt, collateral and other oracle inputs stay unchanged. The actual trigger is Morpho’s oracle.';
  } else {value.textContent='USD price unavailable';current.textContent=`Oracle boundary ${number(metric.oracle_liquidation_price,8)} ${row.loan_token} per ${row.collateral_token}`;explain.textContent='The oracle boundary is readable, but the current KAT dollar price is unavailable.';}
  if(stale)current.textContent+=' · at last reading';
}

function draftTarget(input) {
  const id = input.dataset.target || input.dataset.ltv, m = MARKETS.find(m => m.id === id);
  if (!editing.has(id)) return null;
  const v = input.value.trim() === '' ? NaN : Number(input.value), isLtv = !!input.dataset.ltv;
  const target = isLtv ? m.lltv*100/v : v;
  let effective;
  try {
    if (!Number.isFinite(target) || target<1 || !Number.isFinite(v) || v<=0
      || (isLtv && v>m.lltv*100)) throw new RangeError();
    effective=targetMetrics({lltv:m.lltv,error:'draft'},target).target_health;
  } catch {
    const message='Use health of at least 1 or a positive LTV no higher than '+pct(m.lltv)+'.';
    input.setAttribute('aria-invalid','true'); input.setCustomValidity(message);
    drafts.set(id,null); targetMessage(m,message+' The graph keeps your saved target.',true); return null;
  }
  input.removeAttribute('aria-invalid'); input.setCustomValidity('');
  drafts.set(id,effective);
  const other = $(m.key + (isLtv ? '-target' : '-ltv'));
  other.value = isLtv ? String(effective) : ltvInputValue(m.lltv,effective);
  other.removeAttribute('aria-invalid'); other.setCustomValidity('');
  targetMessage(m,'Unsaved changes · Save updates the graph');
  return effective;
}
function finishEditing(m,message) {
  editing.delete(m.id);drafts.delete(m.id);const el=$(m.key);el.classList.remove('editing');
  const health=$(m.key+'-target'),ltv=$(m.key+'-ltv');
  health.value=String(targets[m.id]);ltv.value=ltvInputValue(m.lltv,targets[m.id]);
  for(const input of [health,ltv]){input.readOnly=true;input.removeAttribute('aria-invalid');input.setCustomValidity('');}
  el.querySelector('.target-edit').hidden=false;el.querySelector('.target-save').hidden=true;el.querySelector('.target-cancel').hidden=true;
  targetMessage(m,message);
}
function editTarget(m) {
  editing.add(m.id);drafts.set(m.id,targets[m.id]);const el=$(m.key);el.classList.add('editing');
  el.querySelector('.target-edit').hidden=true;el.querySelector('.target-save').hidden=false;el.querySelector('.target-cancel').hidden=false;
  $(m.key+'-target').readOnly=false;$(m.key+'-ltv').readOnly=false;
  targetMessage(m,'Editing · graph keeps the saved target until Save');
  $(m.key+'-target').focus();
}
function saveTarget(m) {
  const target=drafts.get(m.id);
  if(!Number.isFinite(target)||target<1){targetMessage(m,'Use health of at least 1 or a positive LTV no higher than '+pct(m.lltv)+'.',true);return;}
  targets={...targets,[m.id]:target};finishEditing(m,'Saved for this visit · graph updated');
  render();
}
$('markets').addEventListener('input', e => { if(e.target.matches('input[data-target],input[data-ltv]'))draftTarget(e.target); });
$('markets').addEventListener('click', e => {
  const button=e.target.closest('button[data-edit],button[data-save],button[data-cancel]');if(!button)return;
  const id=button.dataset.edit||button.dataset.save||button.dataset.cancel,m=MARKETS.find(m=>m.id===id);if(!m)return;
  if(button.dataset.edit)editTarget(m);else if(button.dataset.save)saveTarget(m);else finishEditing(m,'Changes cancelled · saved target kept');
});
$('markets').addEventListener('keydown',e=>{if(!e.target.matches('input[data-target],input[data-ltv]'))return;const id=e.target.dataset.target||e.target.dataset.ltv,m=MARKETS.find(m=>m.id===id);if(e.key==='Enter'){e.preventDefault();saveTarget(m);}else if(e.key==='Escape'){e.preventDefault();finishEditing(m,'Changes cancelled · saved target kept');}});
$('markets').addEventListener('click',e=>{
  const button=e.target.closest('button[data-days]');if(!button)return;
  const card=button.closest('.market-card'),m=MARKETS.find(m=>m.key===card.id);if(!m)return;
  periods.set(m.id,Number(button.dataset.days));
  card.querySelectorAll('[data-days]').forEach(b=>{b.classList.toggle('on',b===button);b.setAttribute('aria-pressed',String(b===button));});
  render();
});

function adopt(sample, isLive) {
  if (!sample || !Array.isArray(sample.markets) || !Number.isFinite(sample.ts) || !Number.isFinite(sample.block)) throw new Error('Incomplete market reading');
  if (!isLive && live) return;
  if (isLive && sample.ts < lastRead) { lastFull=false; warnings=['Katana returned an older reading. Keeping the previous figures and their original reading time.']; render(); return; }
  const errors = [];
  const quote = sample.markets.map(row=>row.kat_price_usd).find(value=>Number.isFinite(value)&&value>0);
  if(Number.isFinite(quote)) {
    if(!katQuote || sample.ts>=katQuote.ts)katQuote={usd:quote,ts:sample.ts};
  } else if(isLive) errors.push('KAT market price could not be read.'+(katQuote?' Keeping its previous price and reading time.':''));
  for (const m of MARKETS) {
    const row = sample.markets.find(r => r.id === m.id), prev = records.get(m.id);
    if (!row || row.error) { errors.push(m.label+' could not be read.'); if (prev) prev.stale = true; continue; }
    if (!prev || sample.ts >= prev.ts) records.set(m.id, { ...m, ...row, ts:sample.ts, block:sample.block, stale:!isLive });
    if (row.valuation_error) errors.push(m.label+': market USD price is unavailable.');
  }
  if (isLive) {
    live = sample; lastRead = sample.ts; lastFull = errors.length===0; warnings=errors;
    if (lastFull) { try { localStorage.setItem(CACHE,JSON.stringify(sample)); } catch {} }
  } else lastRead=Math.max(lastRead,sample.ts);
  render();
}

// Start at this market's first borrowing, before applying a shorter viewing period.
// Keep later empty/error readings: they are genuine gaps, not a reason to join lines.
function lendingSeries(samples,latest,id,periodDays) {
  const rows=samples.map(s=>({ts:s.ts,block:s.block,interval_seconds:s.interval_seconds||21600,row:s.markets?.find(r=>r.id===id)}));
  if(latest&&(!rows.length||latest.ts>rows.at(-1).ts))rows.push({ts:latest.ts,block:latest.block,interval_seconds:21600,row:latest});
  const firstBorrow=rows.findIndex(p=>p.row&&!p.row.error&&!p.row.no_position&&Number.isFinite(p.row.debt_amount)&&p.row.debt_amount>0);
  if(firstBorrow<0)return [];
  const end=rows.at(-1).ts,from=periodDays?end-periodDays*86400:0;
  return rows.slice(firstBorrow).filter(p=>p.ts>=from).map(p=>({...p,row:p.row&&!p.row.error&&!p.row.no_position?p.row:null}));
}
function seriesFor(id) {return lendingSeries(history,records.get(id),id,periods.get(id)??7);}

function marketIsInactive(row) {
  return !!row && !row.error && row.no_position===true;
}
function marketIsHidden(m,row) {
  return m.key==='avkat-usdc' && marketIsInactive(row);
}
function lendingOverview(rows) {
  let collateral=0,debt=0;
  const unknown={oracle_collateral_usd:null,debt_usd:null,average_ltv:null};
  for(const row of rows){
    if(!row || row.error)return unknown;
    if(marketIsInactive(row))continue;
    if(!Number.isFinite(row.oracle_collateral_usd)||row.oracle_collateral_usd<0||!Number.isFinite(row.debt_usd)||row.debt_usd<0)return unknown;
    collateral+=row.oracle_collateral_usd;debt+=row.debt_usd;
  }
  return {oracle_collateral_usd:collateral,debt_usd:debt,average_ltv:collateral>0?debt/collateral:null};
}

function render() {
  for (const m of MARKETS) {
    const el=$(m.key), row=records.get(m.id), target=targets[m.id];
    const find=s=>el.querySelector(s), inactive=marketIsInactive(row);
    el.hidden=marketIsHidden(m,row);el.classList.toggle('inactive',inactive);el.dataset.inactive=String(inactive);
    const points=seriesFor(m.id);
    if(!el.hidden){draw(find('.value-plot'),points,target,false);draw(find('.health-plot'),points,target,true);}
    if(!row)continue;
    const metric=targetMetrics(row,target), expired=Date.now()/1000-row.ts>HOLD, stale=row.stale || expired;
    el.dataset.health=String(row.health); el.dataset.target=String(target); el.dataset.debt=String(row.debt_amount);
    el.dataset.borrow=String(metric.borrow_amount); el.dataset.repay=String(metric.repay_amount); el.dataset.block=String(row.block);
    find('.col-value').textContent=money(row.oracle_collateral_usd);
    find('.col-sub').textContent=tokenAmount(row.collateral_amount,m.collateral_token);
    find('.debt-value').textContent=money(row.debt_usd);
    find('.current-ltv').textContent='LTV '+(Number.isFinite(row.ltv)?pct(row.ltv):'—');
    find('.market-lltv').textContent='Market LLTV '+pct(row.lltv);
    find('.debt-sub').textContent=tokenAmount(row.debt_amount,m.loan_token);
    find('.limit-value').textContent=money(metric.target_debt_usd);
    find('.limit-sub').textContent=tokenAmount(metric.target_debt_amount,m.loan_token);
    const currentHealth = row.debt_amount===0 ? 'No debt' : Number.isFinite(row.health) ? number(row.health,4) : 'Unavailable';
    find('.health-now').textContent=(stale?'At reading ':'Now ')+currentHealth;
    find('.reading-time').textContent=(stale?'Reading ':'')+date(row.ts)+' MYT';
    renderLiquidation(el,row,expired,stale);
    const pill=find('.status-pill');
    pill.className='status-pill'+(inactive?' inactive':row.health!==null&&row.health<1?' liquidatable':row.health!==null&&row.health<target?' below':'');
    pill.textContent=inactive?(stale?'Inactive · stale':'Inactive'):stale?'Stale reading':row.health!==null&&row.health<1?'Below liquidation boundary':metric.status==='repay'?'Below my target':row.debt_amount===0?'No debt':'Within my target';
    const action=find('.room-value'); action.classList.toggle('repay-value',metric.status==='repay'&&!expired);
    if (expired) {
      find('.action-label').textContent='Borrow or repay'; action.textContent='—'; find('.action-sub').textContent='Reading over 5 minutes old. Waiting for refresh.';
    } else if (metric.status==='repay') {
      find('.action-label').textContent='Repay to reach my target'; action.textContent=tokenAmount(metric.repay_amount,m.loan_token,'repay');
      find('.action-sub').textContent=money(metric.repay_usd)+` · bring health to ${number(target,6)}`+(stale?' · at last reading':'');
    } else if (metric.status==='borrow' || metric.status==='at-target') {
      find('.action-label').textContent='Still able to borrow'; action.textContent=tokenAmount(metric.borrow_amount,m.loan_token,'borrow');
      find('.action-sub').textContent=money(metric.borrow_usd)+(Number.isFinite(row.health)&&row.health<1?' · no further borrowing below health 1':` · keep health at least ${number(Math.max(target,1),6)}`)+(stale?' · at last reading':'')+(metric.protocol_limited?' · capped by Morpho’s liquidation limit':'')+(metric.liquidity_limited?' · capped by market liquidity':'');
    } else { find('.action-label').textContent='Borrow or repay'; action.textContent='—'; find('.action-sub').textContent=metric.status==='no-position'?'No collateral in this market.':'Oracle or debt reading unavailable.'; }
  }
  const overview=lendingOverview(MARKETS.map(m=>records.get(m.id)));
  const quoteAge=katQuote ? Date.now()/1000-katQuote.ts : Infinity, quoteFresh=lastFull&&quoteAge>=-30&&quoteAge<=90;
  const quoteStatus=katQuote ? quoteFresh?'':'Stale · '+date(katQuote.ts)+' MYT' : 'Waiting for price';
  const quoteNote=quoteStatus?'<div class="metric-sub kat-price-status">'+quoteStatus+'</div>':'';
  $('overview').innerHTML=`<div class="card overview-card kat-price-card" data-status="${quoteFresh?'live':katQuote?'stale':'loading'}" data-price-ts="${katQuote?.ts||''}"><div class="metric-label">KAT price</div><div class="overview-value">${katPrice(katQuote?.usd)}</div>${quoteNote}</div><div class="card overview-card"><div class="metric-label">Oracle collateral</div><div class="overview-value">${money(overview.oracle_collateral_usd)}</div></div><div class="card overview-card"><div class="metric-label">Borrowed</div><div class="overview-value">${money(overview.debt_usd)}</div></div><div class="card overview-card"><div class="metric-label">Average LTV</div><div class="overview-value" title="Total debt divided by total oracle collateral">${Number.isFinite(overview.average_ltv)?pct(overview.average_ltv):'—'}</div></div>`;
  const age=Date.now()/1000-lastRead, fresh=lastFull&&age<=90;
  $('stamp').className='stamp'+(fresh?'':' stale');
  $('stamp').innerHTML=`<span class="dot"></span><span class="st">${fresh?'LIVE':lastRead?'STALE':'LOADING'}</span><br>${lastRead?time(lastRead):'—'}`;
  const msgs=[...warnings];
  if (!fresh&&lastRead&&!msgs.length) msgs.push('Showing the last reading from '+date(lastRead)+' MYT. Waiting for a fresh Katana read.');
  $('health').textContent=msgs.join(' '); $('health').classList.toggle('on',msgs.length>0);
}

function draw(box, points, target, isHealth) {
  box.dataset.savedTarget=String(target);
  box.dataset.start=points.length?String(points[0].ts):'';
  box.dataset.end=points.length?String(points.at(-1).ts):'';
  const valid=points.filter(p=>p.row && (isHealth?Number.isFinite(p.row.health):Number.isFinite(p.row.oracle_collateral_usd)&&Number.isFinite(p.row.debt_usd)&&Number.isFinite(p.row.liquidation_usd)));
  if (valid.length<2) { box.innerHTML='<div class="plot-empty">'+(valid.length?'One recorded reading. The line will grow with history.':'No recorded position in this period.')+'</div>'; box.onpointermove=null; box.onkeydown=null; box.onpointerleave=null; box.onblur=null; delete box.dataset.points; return; }
  const W=Math.max(200,box.clientWidth),H=Math.max(100,box.clientHeight),P={l:44,r:10,t:10,b:26}, end=points.at(-1).ts, start=points[0].ts, span=Math.max(1,end-start);
  const defs=isHealth ? [{name:'Actual health',color:'var(--text)',get:r=>r.health},{name:'My saved target',color:'var(--gold)',dash:'5 4',get:()=>target},{name:'Liquidation boundary',color:'var(--chart-boundary)',dash:'2 4',get:()=>1}]
    : [{name:'Collateral · oracle',color:'var(--text)',get:r=>r.oracle_collateral_usd},{name:'Borrowed',color:'var(--chart-debt)',get:r=>r.debt_usd},{name:'My saved limit',color:'var(--gold)',get:r=>r.liquidation_usd/target},{name:'Liquidation boundary · 1',color:'var(--chart-boundary)',dash:'3 4',get:r=>r.liquidation_usd}];
  const values=valid.flatMap(p=>defs.map(d=>d.get(p.row))).filter(Number.isFinite), peak=Math.max(...values,1), hi=peak<=Number.MAX_VALUE/1.13?peak*1.13:peak;
  const x=t=>P.l+(t-start)/span*(W-P.l-P.r), y=v=>H-P.b-v/hi*(H-P.t-P.b);
  let svg='';
  for(let i=0;i<=3;i++){const v=hi*(i/3),yy=y(v);svg+=`<line x1="${P.l}" x2="${W-P.r}" y1="${yy}" y2="${yy}" stroke="var(--chart-grid)"/><text x="${P.l-7}" y="${yy+3}" fill="var(--faint)" font-family="var(--chart-font, Inter, system-ui, sans-serif)" font-size="10" text-anchor="end">${isHealth?number(v,1):'$'+number(v,0)}</text>`;}
  for (const d of defs) {
    let path='',pen=false,lastTs=0,lastInterval=21600;
    for(const p of points){const val=p.row?d.get(p.row):null;if(!Number.isFinite(val)){pen=false;continue;}const gap=lastTs&&p.ts-lastTs>Math.max(lastInterval,p.interval_seconds||21600)*1.75;path+=(pen&&!gap?'L':'M')+x(p.ts).toFixed(2)+','+y(val).toFixed(2)+' ';pen=true;lastTs=p.ts;lastInterval=p.interval_seconds||21600;}
    svg+=`<path d="${path}" data-series="${esc(d.name)}" fill="none" stroke="${d.color}" stroke-width="${d.name.includes('saved')?1.8:1.4}" ${d.dash?`stroke-dasharray="${d.dash}"`:''} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    const last=valid.at(-1),v=d.get(last.row);svg+=`<circle cx="${x(last.ts)}" cy="${y(v)}" r="2.5" fill="${d.color}"/>`;
  }
  const shortDate=t=>new Date(t*1000).toLocaleDateString('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short'});
  svg+=`<text x="${P.l}" y="${H-5}" fill="var(--faint)" font-family="var(--chart-font, Inter, system-ui, sans-serif)" font-size="10">${esc(shortDate(start))}</text><text x="${W-P.r}" y="${H-5}" fill="var(--faint)" font-family="var(--chart-font, Inter, system-ui, sans-serif)" font-size="10" text-anchor="end">${esc(shortDate(end))}</text>`;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${svg}<line class="crosshair" x1="0" x2="0" y1="${P.t}" y2="${H-P.b}" stroke="var(--chart-zero)" stroke-dasharray="2 3" style="display:none"/></svg><div class="plot-tooltip" hidden></div>`;
  box.dataset.points=String(valid.length);
  let cursor=valid.length-1;
  function show(index){cursor=Math.max(0,Math.min(valid.length-1,index));const p=valid[cursor],tip=box.querySelector('.plot-tooltip'),line=box.querySelector('.crosshair');tip.hidden=false;tip.innerHTML='<strong>'+esc(date(p.ts))+' MYT</strong>'+defs.map(d=>`<div class="tip-row"><span>${esc(d.name)}</span><span>${isHealth?number(d.get(p.row),4):money(d.get(p.row))}</span></div>`).join('');const at=x(p.ts);line.style.display='';line.setAttribute('x1',at);line.setAttribute('x2',at);const left=at/W*box.clientWidth;tip.style.left=Math.max(0,Math.min(left-65,box.clientWidth-tip.offsetWidth))+'px';tip.style.top='5px';}
  box.onpointermove=e=>{const rect=box.getBoundingClientRect(),t=start+Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*W-P.l)/(W-P.l-P.r)))*span;let best=0;for(let i=1;i<valid.length;i++)if(Math.abs(valid[i].ts-t)<Math.abs(valid[best].ts-t))best=i;show(best);};
  box.onpointerleave=()=>{box.querySelector('.plot-tooltip').hidden=true;box.querySelector('.crosshair').style.display='none';};
  box.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();show(e.key==='Home'?0:e.key==='End'?valid.length-1:cursor+(e.key==='ArrowRight'?1:-1));}if(e.key==='Escape')box.onpointerleave();};
  box.onblur=box.onpointerleave;
}

async function loadHistory() {
  if(historyBusy)return;historyBusy=true;
  try {
    const r=await fetch('/morpho-history.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('History HTTP '+r.status);
    const book=await r.json(); const samples=(book.samples||[]).filter(s=>Number.isFinite(s.ts)&&Array.isArray(s.markets));
    const byBlock=new Map(history.map(s=>[s.block,s]));for(const s of samples)if(!byBlock.has(s.block))byBlock.set(s.block,s);
    history=[...byBlock.values()].sort((a,b)=>a.ts-b.ts);historyReadAt=Date.now();
    if(history.length&&!live)adopt(history.at(-1),false);
    const first=history[0],last=history.at(-1);
    $('history-note').textContent=first?`${history.length} recorded samples · ${date(first.ts,true)} to ${date(last.ts,true)} MYT. Each chart begins with that market’s first borrowing. Older history is sampled daily, recent history every 6 hours; live values refresh every 15 seconds.`:'History begins with the first complete market reading.';
    render();
  } catch(e) { $('history-note').textContent='Recorded history could not be refreshed. Existing chart points and live readings remain available.'; }
  finally {historyBusy=false;}
}
async function refresh() {
  if(busy||document.hidden)return;busy=true;
  try {
    let sample;
    if(['localhost','127.0.0.1'].includes(location.hostname)) sample=await readMorpho();
    else { const r=await fetch('/api/morpho?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(25000)});if(!r.ok)throw new Error('Katana reading unavailable');sample=await r.json(); }
    adopt(sample,true);
  } catch(e) { lastFull=false;warnings=['Katana could not be read. Previous figures keep their original reading time.'];for(const r of records.values())r.stale=true;render(); }
  finally {busy=false;}
}
try { const cached=JSON.parse(localStorage.getItem(CACHE)||'null');if(cached?.full){adopt(cached,false);lastRead=cached.ts;} } catch {}
loadHistory(); refresh();
setInterval(refresh,POLL);
setInterval(()=>{if(!document.hidden)render();},30000);
setInterval(()=>{if(!document.hidden)loadHistory();},600000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();if(Date.now()-historyReadAt>300000)loadHistory();}});
window.addEventListener('pageshow',e=>{
  if(!e.persisted)return;
  resetTargets();
  for(const m of MARKETS)finishEditing(m,'Opening defaults restored · choose Edit to change');
  render();
});
let resizeTimer;
new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(render,100);}).observe($('markets'));
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
