/* Independent network revenue panel: a failed revenue provider must not block
   personal holdings. All arithmetic comes finished from deterministic code. */
import {buildRevenueView} from './katana-revenue-core.mjs?v=167';
const $=id=>document.getElementById(id),KEY='tf_katana_revenue_v1',POLL=300000,MAX_AGE=15*60,
 esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 fmt=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—',
 money=n=>Number.isFinite(n)?(n<0?'−$':'$')+fmt(Math.abs(n)):'—',
 when=ts=>new Date(ts*1000).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
let view=null,busy=false,failed=false,failure='';
const usable=v=>v?.schemaVersion==='katana-revenue-v1'&&Array.isArray(v.sources)&&v.sources.length===4&&v.totals?.[30]&&v.buybacks?.[30];
const amount=p=>money(p?.usd??p?.knownUsd),valueCell=(p,label)=>`<td data-label="${label}"><b>${amount(p)}</b>${p?.coveredDays&&p.coveredDays<p.days?`<small>${p.coveredDays}/${p.days} days recorded</small>`:''}</td>`;
function render(){
 if(!view){$('revenueHealth').textContent=failure;return;}
 const total=view.totals[30],b=view.buybacks[30];
 $('revenueTotalLabel').textContent=total.complete?'Network revenue · 30 days':'Recorded income subtotal · 30 days';
 $('revenueTotal').textContent=money(total.usd??total.knownUsd);
 $('revenueCoverage').textContent=total.knownUsd===null?'No verified revenue readings yet':`${total.completeSources} of 4 sources have all 30 reporting days. ${total.complete?'':'Full network revenue remains incomplete.'}`;
 $('revenueAllocation').textContent=amount(b.allocated);$('revenueSpent').textContent=amount(b.purchased);$('revenueKat').textContent=fmt(b.purchased.kat);
 $('revenueAllocationNote').textContent=b.allocated.complete?'Verified allocation records':b.allocated.count?'Recorded allocations; coverage incomplete':'Revenue share not disclosed in the supplied article';
 $('revenueSpentNote').textContent=b.purchased.complete?'Verified purchase records':b.purchased.count?'Recorded purchases; coverage incomplete':'Buyback launch date and execution feed are unverified';
 $('revenuePeriod').textContent=`Through ${when(view.reporting.end)} MYT. Daily = the last completed UTC day (08:00–08:00 MYT); weekly/monthly = 7/30 completed days. Missing days are not projected.`;
 $('revenueRows').innerHTML=view.sources.map(s=>`<tr><th scope="row"><span>${esc(s.name)}</span><small>${esc(s.detail)}</small>${s.scope?`<small>${esc(s.scope)}</small>`:''}<small class="revenue-source-status">${esc(s.state?.status==='gross_only'?'Gross fees available; retained revenue unverified':s.state?.status==='unconfigured'?'Awaiting verified revenue feed':s.lastReportedDay?'Reported through '+s.lastReportedDay+' UTC':'Revenue reading unavailable')}</small></th>`
  +[1,7,30].map((d,i)=>valueCell(s.periods[d],['Daily','Weekly · 7D','Monthly · 30D'][i])).join('')+'</tr>').join('');
 $('revenueTotals').innerHTML='<tr><th scope="row">'+(view.totals[30].complete?'Network total':'Verified subtotal')+'</th>'+[1,7,30].map((d,i)=>`<td data-label="${['Daily','Weekly','Monthly'][i]}"><b>${amount(view.totals[d])}</b>${!view.totals[d].complete?'<small>Incomplete coverage</small>':''}</td>`).join('')+'</tr>';
 $('buybackRows').innerHTML=[1,7,30].map(d=>{const p=view.buybacks[d];return `<tr><th scope="row">${d===1?'Daily':d===7?'Weekly · 7D':'Monthly · 30D'}</th><td data-label="Allocated · USD"><b>${amount(p.allocated)}</b>${!p.allocated.complete?'<small>Not fully verified</small>':''}</td><td data-label="Spent · USD"><b>${amount(p.purchased)}</b>${!p.purchased.complete?'<small>Not fully verified</small>':''}</td><td data-label="KAT bought"><b>${fmt(p.purchased.kat)}</b></td></tr>`;}).join('');
 $('buybackHistory').innerHTML=view.purchases.length?'<ul>'+view.purchases.map(p=>`<li><a href="https://explorer.katana.network/tx/${esc(p.transactionHash)}" target="_blank" rel="noopener noreferrer">${esc(when(p.ts))} MYT ↗</a> · ${money(Number(p.usdMicros)/1e6)} · ${fmt(Number(p.katRaw)/1e18)} KAT</li>`).join('')+'</ul>':'A verified buyback execution feed is not connected yet. An incoming KAT transfer alone does not prove an open-market purchase.';
 $('revenueEvidence').innerHTML=view.sources.map(s=>`<p><b>${esc(s.name)}:</b> ${esc(s.state?.note||'Awaiting a verified revenue feed.')}${s.evidenceUrl?` <a href="${esc(s.evidenceUrl)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`:''}`
  +(s.state?.status==='gross_only'&&s.grossPeriods[1]?.usd!==null?` Gross gas fees reported for the day: ${money(s.grossPeriods[1].usd)}. This is excluded from network revenue.`:'')+'</p>').join('');
 $('revenueHealth').textContent=failure||'Figures are product revenue, not your personal staking income. Buyback allocation and execution remain unverified until their feeds are connected.';
 stamp();
}
function stamp(){if(!view)return;const old=Date.now()-Date.parse(view.generatedAt)>MAX_AGE*1000,b=$('revenueStatus');
 b.textContent=failed||old?'STALE':view.status==='complete'?'Reported':view.status==='partial'?'Partial data':'Needs sources';b.classList.toggle('stale',failed||old);}
async function load(force=false){if(busy||!force&&document.hidden)return;busy=true;
 try{const r=await fetch('/api/vkat?view=revenue',{cache:'no-store',signal:AbortSignal.timeout(35000)}),v=await r.json();
  if(!r.ok||!usable(v))throw Error('The revenue reading is unavailable');view=v;failed=false;failure='';try{localStorage.setItem(KEY,JSON.stringify(v));}catch{}
 }catch{failed=true;failure=view?'Could not refresh revenue. Previously recorded figures and their reporting dates are retained.':'Revenue sources could not be read yet. Personal holdings continue to refresh independently.';}
 finally{busy=false;render();}}
async function savedReading(){try{const r=await fetch('/katana-revenue.json',{cache:'no-store',signal:AbortSignal.timeout(6000)});
 if(r.ok&&!view){const saved=buildRevenueView(await r.json());if(!view){view=saved;failed=true;render();}}}catch{/* The live pass reports its own availability. */}}
try{const seed=JSON.parse(localStorage.getItem(KEY)||'null');if(usable(seed)){view=seed;failed=true;}}catch{}
render();savedReading();load(true);setInterval(()=>load(),POLL);setInterval(stamp,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true);});
