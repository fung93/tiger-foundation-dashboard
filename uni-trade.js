import {validUniTradeFeed,savedUniTradeFeed,mergeUniTradeFeeds} from './uni-history.mjs?v=191';
import {fetchUniJSON} from './uni-refresh.mjs?v=190';
import {uniTradeOverview} from './uni-accounting.mjs?v=188';
import {replayUniStrategy,valueUniStrategy,validateUniStrategy} from './uni-strategy-core.mjs?v=189';
const $=id=>document.getElementById(id),TOKENS={base:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',bnb:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1'},KEY='tf_uni_trade_feed_v1';
let trade=null,lp=null,lastLP=null,tradeBusy=false,lpBusy=false,failed=false,lpFailed=false,
 strategy=null,strategyBusy=false,strategyFailed=false,lastStrategyTotals=null,lastStrategyAt=null,
 market=null,marketBusy=false,marketFailed=false;
const money=n=>{if(!Number.isFinite(n))return '—';const value=Math.abs(n)<.005?0:n;return (value<0?'-$':'$')+Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
const unitPrice=money;
const num=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—',
 esc=LPCards.esc,chainName=c=>c==='bnb'?'BNB Chain':'Base';
const when=ts=>new Date(ts*1000).toLocaleString(window.TFI18n?.getLanguage()==='zh-CN'?'zh-CN':'en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const json=(url,timeoutMs=55000)=>fetchUniJSON(url,{timeoutMs});
const validMarket=v=>v?.schemaVersion==='uni-market-view-v1'&&v.quotes&&Array.isArray(v.wallets)&&typeof v.complete==='boolean'&&v.errors&&Object.entries(v.quotes).every(([c,q])=>TOKENS[c]&&Number.isFinite(q.priceUsd)&&q.priceUsd>0&&Number.isSafeInteger(q.ts)&&q.ts>0&&Number.isSafeInteger(q.block))&&v.wallets.every(w=>TOKENS[w.chain]&&/^0x[0-9a-f]{40}$/.test(w.owner)&&/^\d+$/.test(w.raw)&&Number.isFinite(w.uni)&&w.uni>=0&&Number.isFinite(w.valueUsd)&&w.valueUsd>=0&&w.ts===v.quotes[w.chain]?.ts&&w.block===v.quotes[w.chain]?.block)&&(!v.complete||Object.keys(v.quotes).length===2&&v.wallets.length===4&&!Object.keys(v.errors).length&&new Set(v.wallets.map(w=>w.chain+':'+w.owner)).size===4);
function displayTrade(){
 const source=trade;if(!source||!market)return source;
 const quotes={},wallets=new Map();
 for(const q of [source.quotes||{},trade?.quotes||{},market.quotes])for(const [chain,row]of Object.entries(q))if(!quotes[chain]||row.ts>=quotes[chain].ts)quotes[chain]=row;
 for(const row of [...(source.wallets||[]),...(trade?.wallets||[]),...market.wallets]){const key=row.chain+':'+row.owner;if(!wallets.has(key)||row.ts>=wallets.get(key).ts)wallets.set(key,row);}
 return {...source,quotes,wallets:[...wallets.values()],complete:market.complete&&!marketFailed};
}
function uniLPState(view){
 const status=LPCards.readingState(view),records=view?.uni?.positions;
 const complete=view?.uni?.complete===true&&Array.isArray(records)&&Array.isArray(view.position_data)&&Array.isArray(view.position_metrics)&&records.filter(p=>p.status==='open').every(p=>{
  const data=view.position_data.find(d=>d.chain===p.chain&&String(d.id)===String(p.id)&&d.owner===p.owner),metric=view.position_metrics.find(m=>m.key===p.key);
  return data?.status==='observed'&&metric?.complete===true&&Number.isFinite(data.principalUsd)&&Number.isFinite(metric.unclaimedUsd);
 });
 return {...status,partial:!complete};
}
function stamp(){
 const display=displayTrade(),quotes=market?.quotes||display?.quotes||{},dates=Object.values(quotes).map(q=>q.ts).filter(Number.isFinite),ts=dates.length?Math.min(...dates):0,
  fresh=!!display?.complete&&(market?!marketFailed:!failed)&&dates.length===2&&ts>0&&Date.now()/1000-ts<=180&&dates.every(t=>t<=Date.now()/1000+30);
 const box=$('stamp');box.className='stamp'+(fresh?'':' stale');box.innerHTML='<span class="dot"></span><span class="st">'+(fresh?'LIVE':ts?'STALE':'LOADING')+'</span><br>'+(ts?new Date(ts*1000).toLocaleTimeString('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour12:false}):'—');
 box.title=ts?when(ts)+' MYT':'';
}
function render(){
 const display=displayTrade();
 renderTotals();
 const quotes=display?.quotes||market?.quotes||{};
 const quote=quotes.base||quotes.bnb;
 $('uniCurrentPrice').textContent=money(quote?.priceUsd);
 const balances=display?.wallets||market?.wallets||[];
 $('walletUni').textContent=balances.length?'Wallet UNI: '+num(balances.reduce((s,w)=>s+w.uni,0))+' · '+money(balances.reduce((s,w)=>s+w.valueUsd,0)):'Wallet balances are being read.';
 const selected=$('tradeNetwork').value,networks=selected==='all'?['base','bnb']:[selected],
  readFailed=failed||networks.some(c=>trade?.errors?.[c]),pending=!!trade&&networks.some(c=>!trade.coverage[c].current),
  rows=(trade?.trades||[]).filter(t=>selected==='all'||t.chain===selected);
 $('tradeHealth').textContent=readFailed?'Could not check new UNI trades. Showing your confirmed trades.':pending?'Checking newer trades. Confirmed trades are shown below.':'';
 $('tradeHealth').classList.toggle('on',!!$('tradeHealth').textContent);
 $('tradeCount').textContent=trade?rows.length+' recorded swaps':'Buy / sell history';
 $('tradeHistory').innerHTML=rows.length?'<table class="uni-trade-table"><thead><tr><th>Time</th><th>Side</th><th class="num">UNI</th><th class="num">Trade price</th><th class="num">Paid / received</th></tr></thead><tbody>'+rows.map(t=>
  '<tr><td>'+esc(when(t.ts))+' MYT<small>'+chainName(t.chain)+'</small></td><td data-label="'+esc(window.TFI18n?.translate('Side')||'Side')+'" class="'+(t.side==='buy'?'up':'down')+'">'+(t.side==='buy'?'Buy':'Sell')+'</td><td data-label="UNI" class="num">'+esc(num(t.uni))+'</td><td data-label="'+esc(window.TFI18n?.translate('Trade price')||'Trade price')+'" class="num">'+esc(unitPrice(t.price))+'</td><td data-label="'+esc(window.TFI18n?.translate('Paid / received')||'Paid / received')+'" class="num">'+esc(money(t.usd))+'</td></tr>'
 ).join('')+'</tbody></table>':'<div class="uni-trade-empty">'+(!trade?'Reading your UNI swap history…':pending?'No UNI trades recorded yet. Checking for new trades.':'No UNI buys or sells on this network.')+'</div>';
 $('historyCoverage').innerHTML=trade?networks.map(c=>'<span>'+chainName(c)+' · '+(trade.coverage[c].checkedAt?'<span>Last checked</span>: '+esc(when(trade.coverage[c].checkedAt))+' MYT':'<span>New trades have not been checked yet.</span>')+'</span>').join('<br>')+(!trade.historyComplete?'<br><span>Older activity is still being verified separately.</span>':''):'';
 renderLP();stamp();
}
function renderTotals(){
 const display=displayTrade(),view=lp||lastLP,
  overview=uniTradeOverview({trade:display,lpView:view});
 $('uniPrice').textContent=money(overview.averageBuyPriceUsd);
 $('uniHeld').textContent=num(overview.heldUni);
 $('uniHeldDetail').textContent='Wallet '+num(overview.walletUni)+' · LP '+num(overview.lpUni);
 let record=null;
 const sourceTimes=[...Object.values(strategy?.book?.chains||{}).map(s=>s.ts),...Object.values(display?.quotes||{}).map(q=>q.ts),Date.parse(view?.generated)/1000],freshSources=sourceTimes.length>=4&&sourceTimes.every(ts=>Number.isFinite(ts)&&ts>0&&Date.now()/1000-ts<=180&&ts<=Date.now()/1000+30);
 if(strategy?.complete&&display?.complete&&view&&freshSources&&(market?!marketFailed:!failed)&&!lpFailed&&!strategyFailed)try{
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
 const syncing=!!strategy&&!strategy.complete,hasError=strategyFailed||(market?marketFailed:failed)||lpFailed;
 $('strategyHealth').textContent=retained?'Strategy figures could not refresh. Last verified reading: '+when(lastStrategyAt)+' MYT.':hasError?'Strategy cash history could not be verified yet. Retrying automatically.':syncing||!record?'Strategy cash history is syncing. Prices and LP cards refresh independently.':'';
 $('strategyHealth').classList.toggle('on',!!$('strategyHealth').textContent);
 renderPnlRecord(record,lastStrategyAt);
}
function renderPnlRecord(record,observedAt){
 if(!record){$('uniPnlRecordBody').innerHTML='<p class="uni-trade-help">Strategy cash history is syncing. Prices and LP cards refresh independently.</p>';return;}
 const fundingOpen=$('uniPnlRecordBody').querySelector('.uni-pnl-funding-list')?.open,
  value=(n,profit=false)=>'<span class="uni-pnl-amount '+(profit?(n>.004?'up':n<-.004?'down':''):'')+'">'+esc(money(n))+'</span>',
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
  +'<details class="uni-pnl-funding-list"'+(fundingOpen?' open':'')+'><summary>Funding record</summary>'+funding+'</details>'
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
 $('uniLps').innerHTML=rows.length?LPCards.list(rows):'<div class="card uni-trade-empty">'+(uniLPState(view).partial?'Your current UNI LPs could not be verified.':'No current UNI LPs in the LP Book.')+'</div>';
 const status=uniLPState(view);
 $('lpHealth').textContent=lpFailed||status.partial||!status.fresh?'Could not refresh every LP reading. Previous figures keep their original reading time.':'';
 requestAnimationFrame(()=>LPCards.align($('uniLps')));
}
async function loadTrades(){if(tradeBusy||document.hidden)return;tradeBusy=true;try{
 const next=await json('/api/uni?view=history',9000);trade=mergeUniTradeFeeds(trade,next);failed=false;
 try{localStorage.setItem(KEY,JSON.stringify(trade));}catch{}render();
 }catch{failed=true;render();}finally{tradeBusy=false;}}
async function loadLP(){if(lpBusy||document.hidden)return;lpBusy=true;try{const next=await json('/api/lpbook?scope=uni',15000),state=uniLPState(next);if(!next?.cards||!Array.isArray(next.live))throw Error('LP reading unavailable');
 if(state.partial&&lastLP&&Date.now()-Date.parse(lastLP.generated)<300000){lp=lastLP;lpFailed=true;}else{lp=next;lpFailed=state.partial;if(state.fresh&&!state.partial)lastLP=next;}render();}catch{lpFailed=true;render();}finally{lpBusy=false;}}
async function loadStrategy(){if(strategyBusy||document.hidden)return;strategyBusy=true;
 try{const next=await json('/api/uni?view=strategy');if(next?.schemaVersion!=='uni-strategy-view-v1'||typeof next.complete!=='boolean')throw Error('Invalid strategy reading');validateUniStrategy(next.book);strategy=next;strategyFailed=false;render();}
 catch{strategyFailed=true;renderTotals();}finally{strategyBusy=false;}}
async function loadMarket(){if(marketBusy||document.hidden)return;marketBusy=true;
 try{const next=await json('/api/uni?view=market',9000);if(!validMarket(next))throw Error('Invalid current reading');market=next;marketFailed=false;render();}
 catch{marketFailed=true;render();}finally{marketBusy=false;}}
async function loadSavedTrades(){try{const book=await json('/uni-trades.json',6000),saved=savedUniTradeFeed(book);
 trade=trade?mergeUniTradeFeeds(saved,trade):saved;render();
 }catch{/* Live history is independent of the initial saved display. */}}
try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(validUniTradeFeed(saved)){trade={...saved,complete:false,coverage:Object.fromEntries(Object.entries(saved.coverage).map(([c,s])=>[c,{...s,current:false}]))};failed=true;}}catch{}
$('tradeNetwork').addEventListener('change',render);window.addEventListener('tf-language-change',render);
$('uniPnlRecordBtn').addEventListener('click',()=>$('uniPnlRecord').showModal());
$('uniPnlRecordClose').addEventListener('click',()=>$('uniPnlRecord').close());
$('uniPnlRecord').addEventListener('click',event=>{if(event.target!==$('uniPnlRecord'))return;const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();});
render();loadMarket();loadSavedTrades();loadTrades();loadLP();loadStrategy();setInterval(loadMarket,10000);setInterval(loadTrades,10000);setInterval(loadLP,10000);setInterval(loadStrategy,30000);setInterval(stamp,1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadMarket();loadTrades();loadLP();loadStrategy();}});
