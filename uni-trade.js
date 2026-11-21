import {replayUniTrades} from './uni-trade-core.mjs?v=180';
import {uniTradeOverview} from './uni-accounting.mjs?v=188';
import {replayUniStrategy,valueUniStrategy,validateUniStrategy} from './uni-strategy-core.mjs?v=189';
const $=id=>document.getElementById(id),TOKENS={base:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',bnb:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1'},KEY='tf_uni_trades_v2';
let trade=null,lastFull=null,lp=null,lastLP=null,tradeBusy=false,lpBusy=false,failed=false,lpFailed=false,
 strategy=null,strategyBusy=false,strategyFailed=false,lastStrategyTotals=null,lastStrategyAt=null;
const money=n=>{if(!Number.isFinite(n))return '—';const value=Math.abs(n)<.005?0:n;return (value<0?'-$':'$')+Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
const unitPrice=money;
const num=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—',
 gasAmount=n=>n.toLocaleString('en-US',{maximumFractionDigits:8}),esc=LPCards.esc,chainName=c=>c==='bnb'?'BNB Chain':'Base';
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
 renderTotals();
 const quotes=trade?.quotes||display?.quotes||{};
 const quote=quotes.base||quotes.bnb;
 $('uniCurrentPrice').textContent=money(quote?.priceUsd);
 const balances=trade?.wallets||display?.wallets||[];
 $('walletUni').textContent=balances.length?'Wallet UNI: '+num(balances.reduce((s,w)=>s+w.uni,0))+' · '+money(balances.reduce((s,w)=>s+w.valueUsd,0)):'Wallet balances are being read.';
 $('tradeHealth').textContent=failed?'Could not refresh UNI trades. Previous figures keep their original reading time.':trade&&!trade.complete?'Trade history is syncing. Complete figures will appear automatically.':trade&&Object.keys(trade.errors||{}).length?'Some live readings could not be refreshed.':summary?.cost===null?'Some trade costs still need verification.':'';
 $('tradeHealth').classList.toggle('on',!!$('tradeHealth').textContent);
 const selected=$('tradeNetwork').value,rows=(summary?.rows||[]).filter(t=>selected==='all'||t.chain===selected);
 $('tradeCount').textContent=display?display.trades.length+' recorded swaps':'Buy / sell history';
 $('tradeHistory').innerHTML=rows.length?'<table class="uni-trade-table"><thead><tr><th>Time · wallet</th><th>Side</th><th class="num">UNI</th><th class="num">Trade price</th><th class="num">Paid / received</th><th class="num">Realised P&L</th><th>Transaction</th></tr></thead><tbody>'+rows.map(t=>{
  const url=(t.chain==='base'?'https://basescan.org/tx/':'https://bscscan.com/tx/')+t.hash,settled=(lastStrategyTotals?.settlements||[]).filter(s=>s.kind==='sale'&&s.chain===t.chain&&s.hash===t.hash),saleResult=settled.length?settled.reduce((sum,s)=>sum+s.usd,0):null;
  return '<tr><td>'+esc(when(t.ts))+' MYT<small>'+chainName(t.chain)+(t.route==='1inch_limit'?' · 1inch limit':'')+' · '+esc(t.owner.slice(0,6)+'…'+t.owner.slice(-4))+'</small></td><td data-label="'+esc(window.TFI18n?.translate('Side')||'Side')+'" class="'+(t.side==='buy'?'up':'down')+'">'+(t.side==='buy'?'Buy':'Sell')+'</td><td data-label="UNI" class="num">'+esc(num(t.uni))+'</td><td data-label="'+esc(window.TFI18n?.translate('Trade price')||'Trade price')+'" class="num">'+esc(unitPrice(t.price))+'</td><td data-label="'+esc(window.TFI18n?.translate('Paid / received')||'Paid / received')+'" class="num">'+esc(money(t.usd))+(t.note?'<small>'+esc(t.note)+'</small>':'')+'</td><td data-label="'+esc(window.TFI18n?.translate('Realised P&L')||'Realised P&L')+'" class="num">'+esc(t.side==='sell'?money(saleResult):'—')+'</td><td><a href="'+url+'" target="_blank" rel="noopener noreferrer">View transaction ↗</a><small>Network fee '+esc(t.gasPayer==='resolver'?'Resolver paid':Number.isFinite(t.gas)?gasAmount(t.gas)+' '+t.gasToken:'—')+'</small></td></tr>';
 }).join('')+'</tbody></table>':'<div class="uni-trade-empty">'+(ready?(display?.historyComplete?'No UNI buys or sells on this network.':'Earlier history is syncing. New fills are tracked live.'):'Reading your UNI swap history…')+'</div>';
 $('historyCoverage').textContent=trade&&!trade.historyComplete?'Earlier history is syncing. New fills are tracked live.':'';
 renderLP();stamp();
}
function renderTotals(){
 const display=trade?.complete?trade:lastFull||trade,view=lp||lastLP,
  overview=uniTradeOverview({trade:display,lpView:view});
 $('uniPrice').textContent=money(overview.averageBuyPriceUsd);
 $('uniHeld').textContent=num(overview.heldUni);
 $('uniHeldDetail').textContent='Wallet '+num(overview.walletUni)+' · LP '+num(overview.lpUni);
 let record=null;
 const sourceTimes=[...Object.values(strategy?.book?.chains||{}).map(s=>s.ts),...Object.values(display?.quotes||{}).map(q=>q.ts),Date.parse(view?.generated)/1000],freshSources=sourceTimes.length>=4&&sourceTimes.every(ts=>Number.isFinite(ts)&&ts>0&&Date.now()/1000-ts<=180&&ts<=Date.now()/1000+30);
 if(strategy?.complete&&display?.complete&&view&&freshSources&&!failed&&!lpFailed&&!strategyFailed)try{
  record=valueUniStrategy(replayUniStrategy(strategy.book),{trade:display,lpView:view});
  lastStrategyTotals=record;lastStrategyAt=Math.min(...sourceTimes);
 }catch{/* Keep the previous complete calculation while independent readers catch up. */}
 const retained=!record&&!!lastStrategyTotals;
 record||=lastStrategyTotals;
 const label=(name,n)=>'<span>'+name+'</span> <span>'+esc(money(n))+'</span>';
 $('uniCapital').textContent=money(record?.capitalUsd);
 $('uniCapitalDetail').innerHTML=record?label('Original',record.originalUsd)+' · '+label('Added',record.addedUsd)+(record.withdrawnUsd>.004?' · '+label('Withdrawn',record.withdrawnUsd):''):'Reading strategy cash history…';
 $('uniWorth').textContent=money(record?.valueNowUsd);
 $('uniWorthDetail').innerHTML=record?label('Wallet',record.walletValueUsd)+' · '+label('LP',record.lpValueUsd)+' · '+label('Cash',record.cashUsd)+(record.pendingValueUsd>.004?' · '+label('Pending',record.pendingValueUsd):''):'Includes returned LP cash';
 $('uniPnl').textContent=money(record?.pnlUsd);$('uniPnl').className='uni-trade-value '+(record?.pnlUsd>.004?'up':record?.pnlUsd<-.004?'down':'');
 $('uniPnlDetail').innerHTML=record?label('Realized',record.realizedUsd)+' · '+label('Current',record.unrealizedUsd):'Realized + current';
 const syncing=!!strategy&&!strategy.complete,hasError=strategyFailed||failed||lpFailed;
 $('strategyHealth').textContent=retained?'Strategy figures could not refresh. Last verified reading: '+when(lastStrategyAt)+' MYT.':hasError?'Strategy cash history could not be verified yet. Retrying automatically.':syncing||!record?'Strategy cash history is syncing. Prices and LP cards refresh independently.':'';
 $('strategyHealth').classList.toggle('on',!!$('strategyHealth').textContent);
 renderPnlRecord(record,lastStrategyAt);
}
function renderPnlRecord(record,observedAt){
 if(!record){$('uniPnlRecordBody').innerHTML='<p class="uni-trade-help">Strategy cash history is syncing. Prices and LP cards refresh independently.</p>';return;}
 const value=(n,profit=false)=>'<span class="uni-pnl-amount '+(profit?(n>.004?'up':n<-.004?'down':''):'')+'">'+esc(money(n))+'</span>',
  line=(label,n,extra='',profit=false)=>'<div class="uni-pnl-line '+extra+'"><span>'+label+'</span>'+value(n,profit)+'</div>',
  txLink=(chain,hash)=>'<a class="uni-pnl-evidence" href="'+(chain==='base'?'https://basescan.org/tx/':'https://bscscan.com/tx/')+esc(hash)+'" target="_blank" rel="noopener noreferrer">View transaction ↗</a>';
 const positions=record.currentPositions.map(p=>'<section class="uni-pnl-position" data-position="'+esc(p.key)+'"><div class="uni-pnl-position-head"><strong>'+esc(p.pair||'UNI LP')+'</strong>'+value(p.unrealizedUsd,true)+'</div>'
  +'<div class="uni-trade-help">'+esc(chainName(p.chain))+' · #'+esc(p.id)+' · <span>Open</span></div>'
  +'<div class="uni-pnl-parts"><div><span>Cycle cost</span>'+value(p.basisUsd)+'</div><div><span>Value incl. fees</span>'+value(p.valueUsd)+'</div></div></section>').join('');
 const completed=record.positions.filter(p=>p.settledCostUsd>0||p.feesUsd>0).map(p=>{
  const evidence=record.settlements.filter(s=>s.position===p.key),last=evidence.at(-1);
  return '<section class="uni-pnl-position" data-settled="'+esc(p.key)+'"><div class="uni-pnl-position-head"><strong>'+esc(p.pair||'UNI LP')+' #'+esc(p.id)+'</strong>'+value(p.realizedUsd,true)+'</div>'
   +'<div class="uni-trade-help">'+esc(chainName(p.chain))+' · <span>'+(p.closedTs?'Closed':'Settled portion')+'</span>'+(last?' · '+esc(when(last.ts))+' MYT':'')+'</div>'
   +'<div class="uni-pnl-parts"><div><span>Settled cost</span>'+value(p.settledCostUsd)+'</div><div><span>Returned incl. fees</span>'+value(p.proceedsUsd+p.feesUsd)+'</div></div>'+(last?txLink(p.chain,last.hash):'')+'</section>';
 }).join('');
 const other=record.settlements.filter(s=>!s.position).map(s=>'<div class="uni-pnl-settlement">'+line(s.kind==='sale'?'UNI sale':'UNI withdrawal',s.usd,'',true)+'<div class="uni-trade-help">'+esc(when(s.ts))+' MYT · '+txLink(s.chain,s.hash)+'</div></div>').join('');
 const funding=record.funding.map(f=>'<div class="uni-pnl-funding">'+line(f.kind==='in'?'Funds added':'Funds withdrawn',f.usd)+'<div class="uni-trade-help">'+esc(when(f.ts))+' MYT · '+txLink(f.chain,f.hash)+'</div></div>').join('');
 $('uniPnlRecordBody').innerHTML='<p class="uni-trade-help">Capital tracks fresh money, not repeated purchases. Reusing LP proceeds does not add capital.</p>'
  +'<div class="uni-pnl-totals">'+line('Original funding',record.originalUsd)+line('Added funding',record.addedUsd)+line('Withdrawn',record.withdrawnUsd)+line('Net capital',record.capitalUsd)
  +line('Wallet UNI value',record.walletValueUsd)+line('Open LP value incl. fees',record.lpValueUsd)+line('Returned strategy cash',record.cashUsd)+(record.pendingValueUsd>.004?line('Pending principal / fees',record.pendingValueUsd):'')
  +line('Value now',record.valueNowUsd)+line('Realized P&L',record.realizedUsd,'',true)+line('Current P&L',record.unrealizedUsd,'',true)+line('Total P&L',record.pnlUsd,'uni-pnl-grand-total',true)+'</div>'
  +'<h3>Current cycle</h3>'+positions+(!positions?'<p class="uni-trade-help">No open UNI LPs.</p>':'')
  +'<h3>Settled results</h3>'+(completed+other||'<p class="uni-trade-help">No settled results yet.</p>')
  +'<p class="uni-trade-help">Settled results keep their transaction-time values. Reinvesting does not erase them.</p>'
  +'<details class="uni-pnl-funding-list"><summary>Funding record</summary>'+funding+'</details>'
  +'<p class="uni-trade-help">Returned cash is attributed to this strategy, not your entire wallet balance. Strategy operations use that cash first; unrelated spending uses unrelated cash first. Dollar stablecoins use the stated $1 anchor. Native network fees remain separate.</p>'
  +'<p class="uni-trade-help"><span>Verified strategy coverage</span>: '+esc(Object.keys(strategy?.book?.chains||{}).map(chainName).join(' · '))+'</p>'
  +(Object.values(strategy?.coverage||{}).includes('earlier_history_unverified')?'<p class="uni-trade-help">Earlier activity on an untracked network is not included until verified.</p>':'')
  +(Number.isFinite(observedAt)?'<p class="uni-trade-help"><span>Last verified reading</span> · '+esc(when(observedAt))+' MYT</p>':'');
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
 if(state.partial&&lastLP&&Date.now()-Date.parse(lastLP.generated)<300000){lp=lastLP;lpFailed=true;}else{lp=next;lpFailed=state.partial;if(state.fresh&&!state.partial)lastLP=next;}render();}catch{lpFailed=true;render();}finally{lpBusy=false;}}
async function loadStrategy(){if(strategyBusy||document.hidden)return;strategyBusy=true;
 try{const next=await json('/api/uni?view=strategy');if(next?.schemaVersion!=='uni-strategy-view-v1'||typeof next.complete!=='boolean')throw Error('Invalid strategy reading');validateUniStrategy(next.book);strategy=next;strategyFailed=false;render();}
 catch{strategyFailed=true;renderTotals();}finally{strategyBusy=false;}}
try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(valid(saved)){trade=saved;lastFull=saved.complete?saved:null;failed=true;}}catch{}
$('tradeNetwork').addEventListener('change',render);window.addEventListener('tf-language-change',render);
$('uniPnlRecordBtn').addEventListener('click',()=>$('uniPnlRecord').showModal());
$('uniPnlRecordClose').addEventListener('click',()=>$('uniPnlRecord').close());
$('uniPnlRecord').addEventListener('click',event=>{if(event.target!==$('uniPnlRecord'))return;const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();});
render();loadTrades();loadLP();loadStrategy();setInterval(loadTrades,30000);setInterval(loadLP,15000);setInterval(loadStrategy,30000);setInterval(stamp,1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadTrades();loadLP();loadStrategy();}});
