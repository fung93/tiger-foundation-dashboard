import {replayUniTrades} from './uni-trade-core.mjs?v=179';
import {uniPortfolioPerformance} from './uni-accounting.mjs?v=179';
const $=id=>document.getElementById(id),TOKENS={base:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',bnb:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1'},KEY='tf_uni_trades_v2';
let trade=null,lastFull=null,lp=null,lastLP=null,tradeBusy=false,lpBusy=false,failed=false,lpFailed=false;
const money=n=>{if(!Number.isFinite(n))return '—';const value=Math.abs(n)<.005?0:n;return (value<0?'-$':'$')+Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
const unitPrice=n=>Number.isFinite(n)?'$'+n.toLocaleString('en-US',{minimumFractionDigits:5,maximumFractionDigits:5}):'—';
const num=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:6}):'—',esc=LPCards.esc,chainName=c=>c==='bnb'?'BNB Chain':'Base';
const when=ts=>new Date(ts*1000).toLocaleString(window.TFI18n?.getLanguage()==='zh-CN'?'zh-CN':'en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const valid=v=>v?.schemaVersion==='uni-trade-view-v1'&&v.accountingVersion===2&&Array.isArray(v.flows)&&Array.isArray(v.trades)&&v.trades.every(t=>['base','bnb'].includes(t.chain)&&/^0x[0-9a-f]{64}$/i.test(t.hash)&&Number.isFinite(t.uni)&&t.uni>0&&/^0x[0-9a-f]{40}$/i.test(t.owner)&&Number.isSafeInteger(t.ts)&&t.ts>0&&(t.usd===null||Number.isFinite(t.usd)&&t.usd>=0)&&['buy','sell'].includes(t.side))&&v.book&&v.quotes&&Object.entries(v.quotes).every(([c,q])=>TOKENS[c]&&Number.isFinite(q.priceUsd)&&q.priceUsd>0&&Number.isSafeInteger(q.ts)&&q.ts>0)&&Array.isArray(v.wallets)&&v.wallets.every(w=>TOKENS[w.chain]&&Number.isFinite(w.uni)&&w.uni>=0&&Number.isFinite(w.valueUsd)&&w.valueUsd>=0)&&typeof v.complete==='boolean';
async function json(url){const c=new AbortController();let timer;const limit=new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(Error('Reading timed out'));},55000);});try{return await Promise.race([(async()=>{const r=await fetch(url,{cache:'no-store',signal:c.signal});if(!r.ok)throw Error('Reading unavailable');return r.json();})(),limit]);}finally{clearTimeout(timer);}}
function stamp(){
 const dates=Object.values(trade?.quotes||{}).map(q=>q.ts).filter(Number.isFinite),ts=dates.length?Math.min(...dates):0,
  fresh=!!trade?.complete&&!failed&&!Object.keys(trade.errors||{}).length&&dates.length===2&&ts>0&&Date.now()/1000-ts<=180&&dates.every(t=>t<=Date.now()/1000+30);
 const box=$('stamp');box.className='stamp'+(fresh?'':' stale');box.innerHTML='<span class="dot"></span><span class="st">'+(fresh?'LIVE':ts?'STALE':'LOADING')+'</span><br>'+(ts?new Date(ts*1000).toLocaleTimeString('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour12:false}):'—');
 box.title=ts?when(ts)+' MYT':'';
}
function render(){
 const display=trade?.complete?trade:lastFull||trade,ready=!!display?.complete||!!display?.trades?.some(t=>t.verified&&t.route==='1inch_limit'),summary=display?replayUniTrades(display.trades,display.quotes):null;
 $('uniHeld').textContent=ready?num(summary.qty):'—';$('uniWorth').textContent=ready?money(summary.value):'—';$('uniAverage').textContent=ready?unitPrice(summary.avg):'—';
 renderTotals();
 const quotes=trade?.quotes||display?.quotes||{};
 $('tradeQuotes').innerHTML=Object.entries(quotes).map(([key,q])=>'<span>'+chainName(key)+' · UNI '+esc(money(q.priceUsd))+' <small>· '+esc(when(q.ts))+' MYT</small></span>').join('')||'Reading UNI prices…';
 const balances=trade?.wallets||display?.wallets||[];
 $('walletUni').textContent=balances.length?'Wallet UNI: '+num(balances.reduce((s,w)=>s+w.uni,0))+' · '+money(balances.reduce((s,w)=>s+w.valueUsd,0)):'Wallet balances are being read.';
 $('tradeHealth').textContent=failed?'Could not refresh UNI trades. Previous figures keep their original reading time.':trade&&!trade.complete?'Trade history is syncing. Complete figures will appear automatically.':trade&&Object.keys(trade.errors||{}).length?'Some live readings could not be refreshed.':summary?.cost===null?'Some trade costs still need verification.':'';
 $('tradeHealth').classList.toggle('on',!!$('tradeHealth').textContent);
 const selected=$('tradeNetwork').value,rows=(summary?.rows||[]).filter(t=>selected==='all'||t.chain===selected);
 $('tradeCount').textContent=display?display.trades.length+' recorded swaps':'Buy / sell history';
 $('tradeHistory').innerHTML=rows.length?'<table class="uni-trade-table"><thead><tr><th>Time · wallet</th><th>Side</th><th class="num">UNI</th><th class="num">Trade price</th><th class="num">Paid / received</th><th class="num">Realised P&L</th><th>Transaction</th></tr></thead><tbody>'+rows.map(t=>{
  const url=(t.chain==='base'?'https://basescan.org/tx/':'https://bscscan.com/tx/')+t.hash;
  return '<tr><td>'+esc(when(t.ts))+' MYT<small>'+chainName(t.chain)+(t.route==='1inch_limit'?' · 1inch limit':'')+' · '+esc(t.owner.slice(0,6)+'…'+t.owner.slice(-4))+'</small></td><td data-label="'+esc(window.TFI18n?.translate('Side')||'Side')+'" class="'+(t.side==='buy'?'up':'down')+'">'+(t.side==='buy'?'Buy':'Sell')+'</td><td data-label="UNI" class="num">'+esc(num(t.uni))+'</td><td data-label="'+esc(window.TFI18n?.translate('Trade price')||'Trade price')+'" class="num">'+esc(unitPrice(t.price))+'</td><td data-label="'+esc(window.TFI18n?.translate('Paid / received')||'Paid / received')+'" class="num">'+esc(money(t.usd))+(t.note?'<small>'+esc(t.note)+'</small>':'')+'</td><td data-label="'+esc(window.TFI18n?.translate('Realised P&L')||'Realised P&L')+'" class="num">'+esc(ready&&t.side==='sell'?money(t.realized):'—')+'</td><td><a href="'+url+'" target="_blank" rel="noopener noreferrer">View transaction ↗</a><small>Network fee '+esc(t.gasPayer==='resolver'?'Resolver paid':Number.isFinite(t.gas)?num(t.gas)+' '+t.gasToken:'—')+'</small></td></tr>';
 }).join('')+'</tbody></table>':'<div class="uni-trade-empty">'+(ready?(display?.historyComplete?'No UNI buys or sells on this network.':'Earlier history is syncing. New fills are tracked live.'):'Reading your UNI swap history…')+'</div>';
 $('historyCoverage').textContent=trade&&!trade.historyComplete?'Earlier history is syncing. New fills are tracked live.':'';
 renderLP();stamp();
}
function renderTotals(){
 const display=trade?.complete?trade:lastFull||trade,view=lp||lastLP,
  p=uniPortfolioPerformance({lp:view?.uni,trades:display?.trades||[],flows:display?.flows||[],quotes:display?.quotes||{},wallets:display?.wallets||[],historyComplete:!!display?.historyComplete,coverage:display?.inventoryCoverage});
 $('uniPnl').textContent=money(p.pnlUsd);$('uniPnl').className='uni-trade-value '+(p.pnlUsd>.004?'up':p.pnlUsd<-.004?'down':'');
 $('uniPnlDetail').textContent='LP '+money(p.lpNetUsd)+' · Holding '+money(p.holdingUnrealizedUsd);
 $('uniFees').textContent=money(p.collectedFeesUsd);
 $('uniFeesDetail').textContent=Object.entries(p.collectedTokens).map(([symbol,amount])=>num(amount)+' '+symbol).join(' + ')||'UNI + USDC';
}
function renderLP(){
 renderTotals();
 const view=lp||lastLP;
 if(!view){$('uniLps').innerHTML='<div class="card uni-trade-empty">'+(lpFailed?'Your current UNI LPs could not be verified.':'Reading your current UNI LPs…')+'</div>';return;}
 if(!Array.isArray(view.position_data)){$('uniLps').innerHTML='<div class="card uni-trade-empty">Your current UNI LPs could not be verified.</div>';return;}
 const canonical=view.position_data,ids=new Set(canonical.filter(p=>TOKENS[p.chain]&&[p.raw?.token0?.address?.toLowerCase(),p.raw?.token1?.address?.toLowerCase()].includes(TOKENS[p.chain])).map(p=>p.chain+':'+String(p.id).replace(/^#/,'')));
 const rows=(view.live||[]).filter(p=>ids.has(p.chain+':'+String(p.id).replace(/^#/,'')));
 $('uniLps').innerHTML=rows.length?LPCards.list(rows):'<div class="card uni-trade-empty">'+(LPCards.readingState(view).partial?'Your current UNI LPs could not be verified.':'No current UNI LPs in the LP Book.')+'</div>';
 const status=LPCards.readingState(view);
 $('lpHealth').textContent=lpFailed||status.partial||!status.fresh?'Could not refresh every LP reading. Previous figures keep their original reading time.':'';
 requestAnimationFrame(()=>LPCards.align($('uniLps')));
}
async function loadTrades(){if(tradeBusy||document.hidden)return;tradeBusy=true;try{const next=await json('/api/uni?view=trades');if(!valid(next))throw Error('Invalid trade reading');trade=next;failed=false;if(next.complete){lastFull=next;try{localStorage.setItem(KEY,JSON.stringify(next));}catch{}}render();}catch{failed=true;render();}finally{tradeBusy=false;}}
async function loadLP(){if(lpBusy||document.hidden)return;lpBusy=true;try{const next=await LPCards.fetchBook(),state=LPCards.readingState(next);if(!next?.cards||!Array.isArray(next.live))throw Error('LP reading unavailable');
 if(state.partial&&lastLP&&Date.now()-Date.parse(lastLP.generated)<300000){lp=lastLP;lpFailed=true;}else{lp=next;lpFailed=state.partial;if(state.fresh&&!state.partial)lastLP=next;}renderLP();}catch{lpFailed=true;renderLP();}finally{lpBusy=false;}}
try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(valid(saved)){trade=saved;lastFull=saved.complete?saved:null;failed=true;}}catch{}
$('tradeNetwork').addEventListener('change',render);window.addEventListener('tf-language-change',render);
render();loadTrades();loadLP();setInterval(loadTrades,30000);setInterval(loadLP,15000);setInterval(stamp,1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadTrades();loadLP();}});
