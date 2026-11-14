import {uniDefaultInput,uniEstimate,uniPoolLink} from './uni-core.mjs?v=168';
const $=id=>document.getElementById(id),states=new Map(),rows=new Map();
const FRESH=180,REFRESH=60000,CACHE='tf_uni_pools_v1';let busy=false,chains=[],lastError=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v):'—';
const feeMoney=v=>Number.isFinite(v)?(v>0&&v<.000001?'<$0.000001':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:v>0&&v<.01?6:2}).format(v)):'—';
const compact=v=>Number.isFinite(v)?'$'+new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(v):'—';
const number=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(v):'—';
const price=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumSignificantDigits:7}).format(v):'—';
const percent=v=>Number.isFinite(v)?v>0&&v<.0001?'<0.01%':(v*100).toLocaleString('en-US',{maximumFractionDigits:2})+'%':'—';
const time=ts=>new Date(ts*1000).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false})+' MYT';
const age=p=>Date.now()/1000-p.at;
function validPool(p){return p&&['base','bnb'].includes(p.chain)&&p.id===p.chain+':'+p.pool&&/^0x[0-9a-f]{40}$/.test(p.pool)&&p.price>0&&Number.isFinite(p.price)&&p.at>0&&p.token0&&p.token1&&[0,1].includes(p.baseIndex);}
function state(p){if(!states.has(p.id))states.set(p.id,{open:false,input:null});return states.get(p.id);}
function accept(value,{saved=false}={}){
  if(value?.schemaVersion!==1||!Array.isArray(value.chains)||!Array.isArray(value.pools))throw Error('Invalid pool response');
  if(value.chains.length!==2||new Set(value.chains.map(c=>c.key)).size!==2||value.chains.some(c=>!['base','bnb'].includes(c.key)||!['fresh','partial','unavailable'].includes(c.status))||value.pools.some(p=>!validPool(p)))throw Error('Incomplete pool response');
  const incoming=new Set(value.pools.filter(validPool).map(p=>p.id));
  for(const [id,old] of rows){const source=value.chains.find(c=>c.key===old.chain);if(!incoming.has(id)){if(source?.status==='fresh')rows.delete(id);else old.retained=true;}}
  for(const p of value.pools){if(!validPool(p))continue;const old=rows.get(p.id);if(old&&p.at<old.at)continue;
    // Retain the complete prior reading if a later pass loses its fee history.
    if(old?.feeWindow?.verified&&!p.feeWindow?.verified){old.retained=true;continue;}
    rows.set(p.id,{...p,retained:saved||false});}
  chains=value.chains;
  if(!saved)try{localStorage.setItem(CACHE,JSON.stringify({schemaVersion:1,chains,pools:[...rows.values()]}));}catch{}
}
function poolCard(p){
  const id='uni-'+p.chain+'-'+p.pool.slice(2),s=state(p),card=document.createElement('article');card.className='card pool-card uni-pool';card.id=id;
  card.innerHTML=`<button class="pool-head" aria-expanded="false" aria-controls="${id}-body"><div class="pool-name"><h3>UNI / ${esc(p.stable)}</h3><span class="uni-pill">${percent(p.fee/1e6)}</span><span class="uni-chain">${esc(p.chainName)} · Uniswap V3</span></div><div class="pool-figs"><div><div class="metric-label">UNI price · ${esc(p.stable)}</div><div class="pool-fig" data-read="price"></div></div><div><div class="metric-label">Pool TVL</div><div class="pool-fig" data-read="tvl"></div></div><div><div class="metric-label">Volume · 24h</div><div class="pool-fig" data-read="volume"></div></div><div><div class="metric-label">Pool fee APR · 24h</div><div class="pool-fig apr" data-read="apr"></div></div></div><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
  <div class="pool-body" id="${id}-body" hidden><div class="pool-context" data-read="reading"></div>
  <fieldset class="uni-step"><legend>Step 1 · What will you deposit?</legend><div class="mode-options">
  <label class="mode-option"><input type="radio" name="${id}-mode" value="uni"><strong>Single sided UNI</strong><span>Start with UNI. Sell gradually if its price rises.</span></label>
  <label class="mode-option"><input type="radio" name="${id}-mode" value="stable"><strong>Single sided stablecoin</strong><span>Start with ${esc(p.stable)}. Buy UNI if its price falls.</span></label>
  <label class="mode-option"><input type="radio" name="${id}-mode" value="balanced"><strong>Balance</strong><span>Use both tokens and start earning while in range.</span></label>
  </div><p class="mode-hint" data-read="modeHint">Choose an option to set your price range.</p></fieldset>
  <fieldset class="uni-step" data-step="2" hidden><legend>Step 2 · Choose your price range</legend><div class="uni-current" data-read="current"></div><div class="uni-inputs"><label><span data-read="amountLabel"></span><input type="number" min="0" step="any" inputmode="decimal" data-input="amount"></label><label>Minimum price · ${esc(p.stable)} per UNI<input type="number" min="0" step="any" inputmode="decimal" data-input="lowerPrice"></label><label>Maximum price · ${esc(p.stable)} per UNI<input type="number" min="0" step="any" inputmode="decimal" data-input="upperPrice"></label></div><div class="uni-result" aria-live="polite"></div></fieldset>
  <div class="uni-actions" hidden><a class="uni-link" href="${uniPoolLink(p.chain,p.pool)}" target="_blank" rel="noopener noreferrer">Copy pool link</a><small class="copy-status" role="status">Copies the link and opens this pool on Uniswap.</small></div></div>`;
  card.querySelector('.pool-head').addEventListener('click',()=>{s.open=!s.open;expand(card,s);});
  card.querySelectorAll('input[type=radio]').forEach(r=>r.addEventListener('change',()=>{if(!r.checked)return;s.input=uniDefaultInput(rows.get(p.id),r.value);setInputs(card,s);updateCard(card,rows.get(p.id));}));
  card.querySelectorAll('[data-input]').forEach(input=>input.addEventListener('input',()=>{if(!s.input)return;s.input[input.dataset.input]=Number(input.value);updateResult(card,rows.get(p.id),s);}));
  card.querySelector('.uni-link').addEventListener('click',()=>{const status=card.querySelector('.copy-status');try{navigator.clipboard.writeText(uniPoolLink(p.chain,p.pool)).then(()=>{status.textContent='Pool link copied. Uniswap opened in a new tab.';},()=>{status.textContent='Uniswap opened. Copy the link from the address bar.';});}catch{status.textContent='Uniswap opened. Copy the link from the address bar.';}});
  expand(card,s);return card;
}
function expand(card,s){card.classList.toggle('open',s.open);card.querySelector('.pool-head').setAttribute('aria-expanded',String(s.open));card.querySelector('.pool-body').hidden=!s.open;}
function setInputs(card,s){for(const input of card.querySelectorAll('[data-input]')){const v=s.input[input.dataset.input];input.value=Number(v.toPrecision(9));s.input[input.dataset.input]=Number(input.value);}}
function updateResult(card,p,s){
  const out=card.querySelector('.uni-result');if(!s.input){out.innerHTML='';return;}
  const r=uniEstimate(p,s.input);
  if(r.error){out.innerHTML=`<div class="uni-result-error" role="status">${esc(r.error)}</div>`;return;}
  const old=age(p)>FRESH||p.retained||lastError,earnings=old&&r.inRange?null:r.feesPerDay,apr=earnings===null?null:r.apr;
  const pnl=v=>Number.isFinite(v)?Math.abs(v)<.005?money(0):(v>=0?'+':'−')+money(Math.abs(v)):'—';
  const cell=(label,value,tone='')=>`<div><div class="metric-label">${label}</div><div class="uni-result-value ${tone}">${value}</div></div>`;
  out.innerHTML=`<div class="uni-result-grid">${cell('Upper edge P&amp;L',pnl(r.edges?.upper.pnlUsd),r.edges?.upper.pnlUsd>=0?'up':'down')}${cell('Lower edge P&amp;L',pnl(r.edges?.lower.pnlUsd),r.edges?.lower.pnlUsd>=0?'up':'down')}${cell('Estimated fees / day',feeMoney(earnings))}${cell('Estimated fee APR',percent(apr))}</div>
    <p class="uni-result-note"><strong>Deposit:</strong> ${number(r.deposit.uni)} UNI + ${number(r.deposit.stable)} ${esc(p.stable)} · about ${money(r.capitalUsd)}.</p>
    <p class="uni-result-note">Uniswap’s usable range: <strong>${price(r.range.lowerPrice)}–${price(r.range.upperPrice)} ${esc(p.stable)} per UNI</strong>. ${r.inRange?'Your position starts in range.':'Your position starts outside the range. Fees and APR are 0 until the price enters it.'}</p>
    <p class="uni-result-note">${old?'The reading is stale. Live income estimates will return after a successful refresh.':r.inRange?(r.feeBasis?`Based on actual fee growth from ${time(r.feeBasis.fromTs)} to ${time(r.feeBasis.toTs)}. Assumes a similar trading pace while your price stays in range.`:'The recent fee history is unavailable, so an income estimate cannot be verified.'):'A single-sided deposit is a waiting position, not immediate yield.'}</p>
    <p class="uni-result-note">Edge P&amp;L excludes fees and transaction costs. Below the lower edge you hold UNI, so losses can grow if its price keeps falling.</p>`;
}
function updateCard(card,p){
  const s=state(p),put=(key,value)=>{card.querySelector(`[data-read="${key}"]`).textContent=value;};
  put('price',price(p.price));put('tvl',compact(p.tvlUsd));put('volume',compact(p.volume24hUsd));put('apr',percent(p.apr));
  put('reading',`${age(p)>FRESH||p.retained||lastError?'STALE · ':p.status==='partial'?'Partial reading · ':''}${time(p.at)} · LP fees in the recorded day: ${feeMoney(p.fees24hUsd)}${p.note?' · '+p.note:''}`);
  put('current',`Current price: ${price(p.price)} ${p.stable} per UNI`);
  card.querySelector('[data-step="2"]').hidden=!s.input;
  card.querySelector('.uni-actions').hidden=!s.input;
  if(s.input){put('amountLabel',s.input.mode==='uni'?'Amount to deposit · UNI':s.input.mode==='stable'?`Amount to deposit · ${p.stable}`:'Total deposit value · USD');
    put('modeHint',s.input.mode==='uni'?'Choose a range above today’s price. Your UNI starts earning only when price rises into it.':s.input.mode==='stable'?'Choose a range below today’s price. Your stablecoin starts earning only when price falls into it.':'Your range must include today’s price. The calculator shows the exact mix required; it is not necessarily 50/50.');}
  updateResult(card,p,s);
}
function render(){
  const selected=$('chainFilter').value,visible=[...rows.values()].filter(p=>selected==='all'||p.chain===selected).sort((a,b)=>b.tvlUsd-a.tvlUsd),container=$('pools');
  container.querySelector('.uni-empty')?.remove();
  for(const p of visible){let card=document.getElementById('uni-'+p.chain+'-'+p.pool.slice(2));if(!card){card=poolCard(p);container.append(card);}card.hidden=false;updateCard(card,p);}
  for(const card of container.querySelectorAll('.uni-pool'))card.hidden=!visible.some(p=>card.id==='uni-'+p.chain+'-'+p.pool.slice(2));
  if(!visible.length){const empty=document.createElement('div');empty.className='card uni-empty';empty.textContent=lastError||!chains.length||chains.filter(c=>selected==='all'||c.key===selected).some(c=>c.status!=='fresh')?'Pool readings are unavailable. The page will retry automatically.':'No funded UNI/stablecoin V3 pool was found in the checked fee tiers.';container.append(empty);}
  $('chainStatus').textContent=chains.filter(c=>selected==='all'||c.key===selected).map(c=>`${c.name}: ${c.status==='unavailable'?'source unavailable':c.status==='partial'?'some data unavailable':c.at?time(c.at):'waiting'}`).join(' · ');
  const anyFresh=visible.some(p=>age(p)<=FRESH&&!p.retained),complete=chains.length===2&&chains.every(c=>c.status==='fresh')&&!lastError;
  $('stamp').className='stamp'+(anyFresh&&!lastError?'':' stale');$('stamp').textContent=anyFresh&&!lastError?(complete?'LIVE':'PARTIAL'):rows.size?'STALE':'UNAVAILABLE';
  const warning=lastError||chains.some(c=>c.status!=='fresh');$('health').style.display=warning?'block':'none';$('health').textContent=warning?'Some live readings could not be verified. Previous figures keep their original reading time.':'';
  container.setAttribute('aria-busy','false');
}
async function refresh(){if(busy||document.hidden)return;busy=true;
  try{const r=await fetch('/api/uni',{cache:'no-store',signal:AbortSignal.timeout(55000)}),value=await r.json();if(!r.ok)throw Error('Pool source unavailable');accept(value);lastError=false;}
  catch{lastError=true;}finally{busy=false;render();}}
try{const saved=JSON.parse(localStorage.getItem(CACHE));if(saved){accept(saved,{saved:true});render();}}catch{}
$('chainFilter').addEventListener('change',render);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh();setInterval(refresh,REFRESH);setInterval(()=>{if(!document.hidden)render();},15000);
