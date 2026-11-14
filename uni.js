import {uniDefaultInput,uniEstimate,uniPoolLink,uniReadingStatus,validateUniSnapshot,mergeUniSnapshots} from './uni-core.mjs?v=171';
const $=id=>document.getElementById(id),states=new Map(),rows=new Map();
const REFRESH=60000,CACHE='tf_uni_pools_v1';let busy=false,chains=[],lastError=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v):'—';
const feeMoney=v=>Number.isFinite(v)?(v>0&&v<.000001?'<$0.000001':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:v>0&&v<.01?6:2}).format(v)):'—';
const compact=v=>Number.isFinite(v)?'$'+new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(v):'—';
const number=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(v):'—';
const price=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumSignificantDigits:7}).format(v):'—';
const percent=v=>Number.isFinite(v)?v>0&&v<.0001?'<0.01%':(v*100).toLocaleString('en-US',{maximumFractionDigits:2})+'%':'—';
const time=ts=>new Date(ts*1000).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false})+' MYT';
function validPool(p){return p&&['base','bnb'].includes(p.chain)&&p.id===p.chain+':'+p.pool&&/^0x[0-9a-f]{40}$/.test(p.pool)&&p.price>0&&Number.isFinite(p.price)&&p.at>0&&p.token0&&p.token1&&[0,1].includes(p.baseIndex);}
function state(p){if(!states.has(p.id))states.set(p.id,{open:false,input:null,anchor:null,anchorEdited:false});return states.get(p.id);}
const reading=p=>uniReadingStatus(p,{now:Date.now()/1000,liveFailed:lastError});
function accept(value,{saved=false}={}){
  if(value?.schemaVersion!==1||!Array.isArray(value.chains)||!Array.isArray(value.pools))throw Error('Invalid pool response');
  if(value.chains.length!==2||new Set(value.chains.map(c=>c.key)).size!==2||value.chains.some(c=>!['base','bnb'].includes(c.key)||!['fresh','partial','unavailable'].includes(c.status))||value.pools.some(p=>!validPool(p)))throw Error('Incomplete pool response');
  const incoming=new Set(value.pools.filter(validPool).map(p=>p.id));
  for(const [id,old] of rows){const source=value.chains.find(c=>c.key===old.chain);if(!incoming.has(id)){if(source?.status==='fresh')rows.delete(id);else old.retained=true;}}
  for(const p of value.pools){if(!validPool(p))continue;const old=rows.get(p.id);if(old&&p.at<old.at)continue;
    // Price/TVL and history have separate evidence times. A failed fee method
    // must not freeze a later valid TVL or erase its last dated fee observation.
    const next={...p};
    if(old&&old.at<=p.at&&p.at-old.at<=8*3600){
      if(!next.feeWindow&&old.feeWindow?.verified&&p.at-old.feeWindow.toTs<=8*3600){next.feeWindow=old.feeWindow;next.feeHistoryRetained=true;}
      if(next.fees24hUsd===null&&Number.isFinite(old.fees24hUsd)&&p.at-(old.tradingWindow?.toTs??old.at)<=8*3600){next.fees24hUsd=old.fees24hUsd;next.volume24hUsd=old.volume24hUsd;next.apr=old.apr;next.tradingWindow=old.tradingWindow||{toTs:old.at};next.tradingRetained=true;}
    }
    rows.set(p.id,{...next,retained:saved?(old?.at===p.at?old.retained:true):!!p.retained});}
  chains=value.chains;
  if(!saved)try{localStorage.setItem(CACHE,JSON.stringify({schemaVersion:1,chains,pools:[...rows.values()]}));}catch{}
}
function poolCard(p){
  const id='uni-'+p.chain+'-'+p.pool.slice(2),s=state(p),card=document.createElement('article');card.className='card pool-card uni-pool';card.id=id;
  card.innerHTML=`<button class="pool-head" aria-expanded="false" aria-controls="${id}-body"><div class="pool-name"><h3>UNI / ${esc(p.stable)}</h3><span class="uni-pill">${percent(p.fee/1e6)}</span><span class="uni-chain">${esc(p.chainName)} · Uniswap V3</span></div><div class="pool-figs"><div><div class="metric-label">Pool TVL</div><div class="pool-fig" data-read="tvl"></div></div><div><div class="metric-label">Volume · 24h</div><div class="pool-fig" data-read="volume"></div></div><div><div class="metric-label">LP fees · 24h</div><div class="pool-fig" data-read="fees"></div></div><div><div class="metric-label">Pool fee APR · 24h</div><div class="pool-fig apr" data-read="apr"></div></div></div><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
  <div class="pool-body" id="${id}-body" hidden><div class="pool-context" data-read="reading"></div>
  <fieldset class="uni-step"><legend>Step 1 · What will you deposit?</legend><div class="mode-options">
  <label class="mode-option"><input type="radio" name="${id}-mode" value="uni"><strong>Single sided UNI</strong><span>Start with UNI. Sell gradually if its price rises.</span></label>
  <label class="mode-option"><input type="radio" name="${id}-mode" value="stable"><strong>Single sided stablecoin</strong><span>Start with ${esc(p.stable)}. Buy UNI if its price falls.</span></label>
  <label class="mode-option"><input type="radio" name="${id}-mode" value="balanced"><strong>Balance</strong><span>Use both tokens and start earning while in range.</span></label>
  </div><p class="mode-hint" data-read="modeHint">Choose an option to set your price range.</p></fieldset>
  <fieldset class="uni-step" data-step="2" hidden><legend>Step 2 · Choose your price range</legend><div class="uni-current" data-read="current"></div><div class="uni-inputs"><label><span data-read="amountLabel"></span><input type="number" min="0" step="any" inputmode="decimal" data-input="amount"></label><label>Minimum price · ${esc(p.stable)} per UNI<input type="number" min="0" step="any" inputmode="decimal" data-input="lowerPrice"></label><label>Maximum price · ${esc(p.stable)} per UNI<input type="number" min="0" step="any" inputmode="decimal" data-input="upperPrice"></label></div><div class="uni-result" aria-live="polite"></div></fieldset>
  <div class="uni-actions" hidden><button type="button" class="uni-link">Copy pool link</button><small class="copy-status" role="status">Copy the link, then paste it in your browser.</small><input class="copy-fallback" aria-label="Pool link to copy" readonly hidden></div></div>`;
  card.querySelector('.pool-head').addEventListener('click',()=>{s.open=!s.open;expand(card,s);});
  card.querySelectorAll('input[type=radio]').forEach(r=>r.addEventListener('change',()=>{if(!r.checked)return;s.input=uniDefaultInput(rows.get(p.id),r.value);s.anchor=r.value==='uni'?'lowerPrice':r.value==='stable'?'upperPrice':null;s.anchorEdited=false;setInputs(card,s);updateCard(card,rows.get(p.id));}));
  card.querySelectorAll('[data-input]').forEach(input=>input.addEventListener('input',()=>{if(!s.input)return;s.input[input.dataset.input]=Number(input.value);if(s.anchor===input.dataset.input)s.anchorEdited=true;updateResult(card,rows.get(p.id),s);}));
  card.querySelector('.uni-link').addEventListener('click',async()=>{const status=card.querySelector('.copy-status'),field=card.querySelector('.copy-fallback'),link=uniPoolLink(p.chain,p.pool);
    try{await navigator.clipboard.writeText(link);field.hidden=true;status.textContent='Pool link copied. Paste it in your browser.';}
    catch{field.hidden=false;field.value=link;field.focus();field.select();status.textContent='Select and copy this link, then paste it in your browser.';}});
  expand(card,s);return card;
}
function expand(card,s){card.classList.toggle('open',s.open);card.querySelector('.pool-head').setAttribute('aria-expanded',String(s.open));card.querySelector('.pool-body').hidden=!s.open;}
function setInputs(card,s){for(const input of card.querySelectorAll('[data-input]')){const v=s.input[input.dataset.input];input.value=Number(v.toPrecision(9));s.input[input.dataset.input]=Number(input.value);}}
function updateResult(card,p,s){
  const out=card.querySelector('.uni-result');if(!s.input){out.innerHTML='';return;}
  const r=uniEstimate(p,s.input,{now:Date.now()/1000});
  if(r.error){out.innerHTML=`<div class="uni-result-error" role="status">${esc(r.error)}</div>`;return;}
  const source=reading(p),earnings=r.activeFeesPerDay,apr=r.activeApr;
  const pnl=v=>Number.isFinite(v)?Math.abs(v)<.005?money(0):(v>=0?'+':'−')+money(Math.abs(v)):'—';
  const pnlTone=v=>Number.isFinite(v)&&Math.abs(v)>=.005?(v>0?'up':'down'):'';
  const cell=(label,value,tone='',hint='')=>`<div><div class="metric-label">${label}</div><div class="uni-result-value ${tone}">${value}</div>${hint?`<div class="uni-result-basis">${hint}</div>`:''}</div>`;
  out.innerHTML=`<div class="uni-result-grid">${cell('Upper edge P&amp;L',pnl(r.edges?.upper.pnlUsd),pnlTone(r.edges?.upper.pnlUsd))}${cell('Lower edge P&amp;L',pnl(r.edges?.lower.pnlUsd),pnlTone(r.edges?.lower.pnlUsd))}${cell('Estimated fees / day',feeMoney(earnings),'','While in range')}${cell('Estimated fee APR',percent(apr),'','While in range')}</div>
    ${r.inRange?'':`<p class="uni-result-note uni-current-earnings"><strong>At this price: ${feeMoney(r.feesPerDay)}/day · ${percent(r.apr)} APR.</strong> Waiting for price to enter your range.</p>`}
    <p class="uni-result-note"><strong>Deposit:</strong> ${number(r.deposit.uni)} UNI + ${number(r.deposit.stable)} ${esc(p.stable)} · about ${money(r.capitalUsd)}.</p>
    <p class="uni-result-note">Uniswap’s usable range: <strong>${price(r.range.lowerPrice)}–${price(r.range.upperPrice)} ${esc(p.stable)} per UNI</strong>. ${r.inRange?'Your position starts in range.':''}</p>
    <p class="uni-result-note">${source.recorded?'Using the recorded price from '+time(p.at)+'. ':''}${r.feeBasis&&earnings!==null?`${r.feeBasis.method==='swap_fee_lower_bound'?'Conservative estimate from verified recent swaps':'Based on recorded fee growth'} from ${time(r.feeBasis.fromTs)} to ${time(r.feeBasis.toTs)}. ${r.inRange?'Assumes similar trading and active pool liquidity while price stays in range.':'Uses today’s active pool liquidity and recorded trading pace; both may differ when your range becomes active.'}`:'A recent fee reading and active pool liquidity are needed to estimate income while in range.'}</p>
    <p class="uni-result-note">Edge P&amp;L excludes fees and transaction costs. Below the lower edge you hold UNI, so losses can grow if its price keeps falling.</p>`;
}
function updateCard(card,p){
  const s=state(p),put=(key,value)=>{card.querySelector(`[data-read="${key}"]`).textContent=value;};
  if(s.input&&s.anchor&&!s.anchorEdited){const field=card.querySelector(`[data-input="${s.anchor}"]`);if(document.activeElement!==field){field.value=Number(p.price.toPrecision(12));s.input[s.anchor]=Number(field.value);}}
  put('tvl',compact(p.tvlUsd));put('volume',compact(p.volume24hUsd));put('fees',feeMoney(p.fees24hUsd));put('apr',percent(p.apr));
  put('reading',`${reading(p).live?'Current reading':'Recorded reading'} · ${time(p.at)} · LP fees in the recorded day: ${feeMoney(p.fees24hUsd)}${p.tradingWindow?.toTs?' · Fee/volume period ends '+time(p.tradingWindow.toTs):''}`);
  put('current',`${reading(p).live?'Current price':'Recorded price'}: ${price(p.price)} ${p.stable} per UNI`);
  card.querySelector('[data-step="2"]').hidden=!s.input;
  card.querySelector('.uni-actions').hidden=!s.input;
  if(s.input){put('amountLabel',s.input.mode==='uni'?'Amount to deposit · UNI':s.input.mode==='stable'?`Amount to deposit · ${p.stable}`:'Total deposit value · USD');
    put('modeHint',s.input.mode==='uni'?'The minimum starts at the current price and rounds outward to a usable tick. You can adjust it; UNI earns when price enters the range.':s.input.mode==='stable'?'The maximum starts at the current price and rounds outward to a usable tick. You can adjust it; the deposit earns when price enters the range.':'Your range must include today’s price. The calculator shows the exact mix required; it is not necessarily 50/50.');}
  updateResult(card,p,s);
}
function render(){
  const selected=$('chainFilter').value,visible=[...rows.values()].filter(p=>selected==='all'||p.chain===selected).sort((a,b)=>b.tvlUsd-a.tvlUsd),container=$('pools');
  container.querySelector('.uni-empty')?.remove();
  for(const p of visible){let card=document.getElementById('uni-'+p.chain+'-'+p.pool.slice(2));if(!card){card=poolCard(p);container.append(card);}card.hidden=false;updateCard(card,p);}
  for(const card of container.querySelectorAll('.uni-pool'))card.hidden=!visible.some(p=>card.id==='uni-'+p.chain+'-'+p.pool.slice(2));
  if(!visible.length){const empty=document.createElement('div');empty.className='card uni-empty';empty.textContent=lastError||!chains.length||chains.filter(c=>selected==='all'||c.key===selected).some(c=>c.status!=='fresh')?'Pool readings are unavailable. The page will retry automatically.':'No funded UNI/stablecoin V3 pool was found in the checked fee tiers.';container.append(empty);}
  const selectedChains=chains.filter(c=>selected==='all'||c.key===selected),statuses=visible.map(reading);
  $('chainStatus').textContent=selectedChains.map(c=>{const list=visible.filter(p=>p.chain===c.key),latest=list.reduce((n,p)=>Math.max(n,p.at),0);return `${c.name}: ${list.length?(list.every(p=>reading(p).live)?'updated ':'recorded ')+time(latest):c.status==='fresh'?'no funded pools':'waiting for a reading'}`;}).join(' · ');
  const missingNetworks=selectedChains.filter(c=>c.status!=='fresh'&&!visible.some(p=>p.chain===c.key&&reading(p).quote)).map(c=>c.name);
  const allReady=visible.length>0&&statuses.every(s=>s.ready)&&!missingNetworks.length,allLive=allReady&&statuses.every(s=>s.live),anyQuote=statuses.some(s=>s.quote);
  $('stamp').className='stamp'+(allLive?'':' stale');$('stamp').textContent=allLive?'LIVE':allReady?'RECORDED':anyQuote?'PARTIAL':visible.length?'STALE':'UNAVAILABLE';
  let warning='';
  if(!visible.length&&(lastError||missingNetworks.length))warning='Pool readings are unavailable. Retrying automatically.';
  else if(visible.length&&!anyQuote)warning='A newer pool reading is needed for estimates. Retrying automatically.';
  else if(missingNetworks.length)warning=missingNetworks.join(' and ')+' readings are unavailable. Available pools remain below.';
  else if(visible.some(p=>reading(p).quote&&p.activeLiquidity>0&&!reading(p).fees))warning='Fee history is unavailable for some pools. Available figures remain below.';
  $('health').style.display=warning?'block':'none';$('health').textContent=warning;
  container.setAttribute('aria-busy','false');
}
async function refresh(){if(busy||document.hidden)return;busy=true;
  try{const r=await fetch('/api/uni',{cache:'no-store',signal:AbortSignal.timeout(55000)}),value=await r.json();validateUniSnapshot(value);accept(value);lastError=!r.ok||value.chains.every(c=>c.status==='unavailable');}
  catch{lastError=true;}finally{busy=false;render();}}
try{const saved=JSON.parse(localStorage.getItem(CACHE));if(saved){accept(saved,{saved:true});render();}}catch{}
fetch('/uni-pools.json',{cache:'no-store',signal:AbortSignal.timeout(6000)}).then(r=>{if(!r.ok)throw Error('Saved pool readings unavailable');return r.json();}).then(value=>{validateUniSnapshot(value);const merged=mergeUniSnapshots({schemaVersion:1,checkedAt:Date.now()/1000,chains,pools:[...rows.values()]},value);if(value.pools.length){accept(merged,{saved:true});render();}}).catch(()=>{});
$('chainFilter').addEventListener('change',render);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh();setInterval(refresh,REFRESH);setInterval(()=>{if(!document.hidden)render();},15000);
