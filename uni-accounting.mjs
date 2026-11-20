/* Numeric UNI performance, shared by the API and page. No reads, writes or model.
   LP net comes from LP Book; loose UNI never includes inventory still in an LP. */
const UNI={base:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',bnb:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1'},finite=Number.isFinite;
const sum=xs=>xs.reduce((s,n)=>s+n,0),order=(a,b)=>a.block-b.block||a.index-b.index||a.id.localeCompare(b.id);

/* Actual exposure is independent of the swap-book balance. LP swaps change its
   UNI units; claimed fees move between these two buckets without creating UNI. */
export function uniTradeOverview({trade,lpView}={}){
 const lower=value=>typeof value==='string'?value.toLowerCase():'',
  owners=new Set((Array.isArray(trade?.book?.wallets)?trade.book.wallets:[]).map(lower)),seenWallets=new Set();
 let walletReady=owners.size===2&&!owners.has(''),walletUni=0,walletValue=0,walletValueReady=true;
 for(const wallet of Array.isArray(trade?.wallets)?trade.wallets:[]){
  if(!wallet){walletReady=false;continue;}
  const key=wallet.chain+':'+lower(wallet.owner);
  if(!UNI[wallet.chain]||!owners.has(lower(wallet.owner))||seenWallets.has(key)||!finite(wallet.uni)||wallet.uni<0){walletReady=false;continue;}
  seenWallets.add(key);walletUni+=wallet.uni;
  const price=trade?.quotes?.[wallet.chain]?.priceUsd;
  if(wallet.uni>0){if(!finite(price)||price<=0)walletValueReady=false;else walletValue+=wallet.uni*price;}
 }
 for(const chain of Object.keys(UNI))for(const owner of owners)if(!seenWallets.has(chain+':'+owner))walletReady=false;
 const lp=lpView?.uni,records=Array.isArray(lp?.positions)?lp.positions:[],data=lpView?.position_data,metrics=lpView?.position_metrics;
 let lpReady=lp?.schemaVersion==='uni-lp-accounting-v1'&&lp.complete===true&&Array.isArray(lp.positions)
  &&Array.isArray(data)&&Array.isArray(metrics)&&owners.size===2,
  lpPrincipalUni=0,unclaimedUni=0,lpValue=0,lpValueReady=true;
 const currentPositions=[];
 const seenLPs=new Set();
 for(const record of records.filter(p=>p?.status==='open')){
  if(!UNI[record.chain]||!owners.has(lower(record.owner))||seenLPs.has(record.key)){lpReady=false;continue;}
  seenLPs.add(record.key);
  const position=(Array.isArray(data)?data:[]).find(p=>p?.chain===record.chain&&String(p.id)===String(record.id)&&lower(p.owner)===lower(record.owner)),
   token=[position?.raw?.token0,position?.raw?.token1].find(t=>lower(t?.address)===UNI[record.chain]),
   metric=(Array.isArray(metrics)?metrics:[]).find(m=>m?.key===record.key&&lower(m.owner)===lower(record.owner)),
   principal=token&&position?.amounts?.[token.symbol],fees=metric?.unclaimedTokens;
  if(position?.status!=='observed'||token?.decimals!==18||!finite(principal)||principal<0
    ||metric?.complete!==true||!fees||typeof fees!=='object'||Array.isArray(fees)
    ||typeof position.feesMine!=='boolean'){lpReady=false;continue;}
  const raw=fees[token.symbol+'@'+record.chain]??0,
   fee=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)?Number(raw):NaN;
  if(!finite(fee)||fee<0){lpReady=false;continue;}
  lpPrincipalUni+=principal;unclaimedUni+=position.feesMine?fee:0;
  const principalUsd=finite(position.principalUsd)&&position.principalUsd>=0?position.principalUsd:null,
   unclaimedFeeUsd=position.feesMine?(finite(metric.unclaimedUsd)&&metric.unclaimedUsd>=0?metric.unclaimedUsd:null):0,
   valueUsd=principalUsd!==null&&unclaimedFeeUsd!==null?principalUsd+unclaimedFeeUsd:null;
  if(valueUsd===null||!finite(valueUsd))lpValueReady=false;else lpValue+=valueUsd;
  currentPositions.push({key:record.key,id:String(record.id),chain:record.chain,owner:record.owner,pair:record.pair,
   principalUsd,unclaimedFeeUsd,valueUsd:finite(valueUsd)?valueUsd:null});
 }
 // A canonical UNI position omitted by the summary cannot disappear from exposure.
 for(const position of Array.isArray(data)?data:[])if(position&&UNI[position.chain]&&owners.has(lower(position.owner))
   &&[position.raw?.token0,position.raw?.token1].some(t=>lower(t?.address)===UNI[position.chain])
   &&!seenLPs.has(position.chain+':'+position.id))lpReady=false;
 const buys=Array.isArray(trade?.trades)?trade.trades.filter(t=>t?.side==='buy'):[],seenBuys=new Set();
 const buysReady=Array.isArray(trade?.trades)&&trade.trades.every(t=>t&&['buy','sell'].includes(t.side))&&buys.every(t=>{
  const key=t.chain+':'+t.id;
  if(!UNI[t.chain]||!t.id||seenBuys.has(key)||t.verified!==true||!finite(t.usd)||t.usd<0)return false;
  seenBuys.add(key);return true;
 });
 const capital=buysReady&&(buys.length>0||trade?.historyComplete===true)?sum(buys.map(t=>t.usd)):null,
  lpUni=lpPrincipalUni+unclaimedUni,
  walletValueUsd=walletReady&&walletValueReady&&finite(walletValue)?walletValue:null,
  lpValueUsd=lpReady&&lpValueReady&&finite(lpValue)?lpValue:null,
  value=walletValueUsd!==null&&lpValueUsd!==null?walletValueUsd+lpValueUsd:null,
  valueNowUsd=finite(value)?value:null,capitalUsd=finite(capital)?capital:null;
 return {heldUni:walletReady&&lpReady?walletUni+lpUni:null,walletUni:walletReady?walletUni:null,
  lpUni:lpReady?lpUni:null,lpPrincipalUni:lpReady?lpPrincipalUni:null,unclaimedUni:lpReady?unclaimedUni:null,
  capitalUsd,capitalComplete:buysReady&&trade?.historyComplete===true,walletValueUsd,lpValueUsd,valueNowUsd,
  pnlUsd:valueNowUsd!==null&&capitalUsd!==null?valueNowUsd-capitalUsd:null,currentPositions};
}

export function buildUniLPAccounting(book,view){
 const positions=Object.values(book.positions||{}).filter(p=>UNI[p.chain]&&[p.a0?.toLowerCase(),p.a1?.toLowerCase()].includes(UNI[p.chain])&&book.wallets.some(w=>w.toLowerCase()===p.wallet?.toLowerCase())),rows=[],claims=[],tokens={},earnedTokens={};
 const sourceGap=Object.keys(view.health?.errors||{}).some(key=>key==='base'||key.startsWith('base '))||Number(view.health?.behind?.base||0)>0;
 let complete=!sourceGap,feeComplete=!sourceGap,earnedComplete=!sourceGap,netUsd=0,claimedUsd=0,earnedUsd=0;
 for(const p of positions){
  const metric=(view.position_metrics||[]).find(m=>m.key===p.key),closed=(view.alltime?.history||[]).find(m=>m.chain===p.chain&&String(m.id)===String(p.id)&&m.wallet_address?.toLowerCase()===p.wallet.toLowerCase());
  const net=p.status==='open'?metric?.netUsd:closed?.net_usd;
  const affected=Object.keys(view.health?.errors||{}).some(key=>key===p.chain||key.startsWith(p.chain+' '))||Number(view.health?.behind?.[p.chain]||0)>0||(view.health?.unread||[]).includes(p.key);
  const ready=finite(net)&&!p.unpriced&&!(p.status==='closed'&&closed?.incomplete)&&!affected;
  if(affected)feeComplete=false;
  if(!ready)complete=false;else netUsd+=net;
  // Match LP Book's earnings: current LPs include both collected and uncollected
  // fees; closed LPs keep their recorded claim prices. Net already includes them.
  const fees=p.status==='open'?metric?.earnedUsd:closed?.fee_usd,
   feeParts=p.status==='open'?[metric?.claimedTokens,metric?.unclaimedTokens]:[closed?.fee_tokens];
  if(!ready||p.status==='open'&&metric?.complete!==true||!finite(fees)||fees<0||feeParts.some(part=>!part||typeof part!=='object'||Array.isArray(part))){earnedComplete=false;}
  else{
   earnedUsd+=fees;
   for(const part of feeParts)for(const [key,raw]of Object.entries(part)){
    const amount=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)?Number(raw):NaN;
    if(!finite(amount)||amount<0)earnedComplete=false;
    else{const symbol=book.tokens?.[key]?.s||key.split('@')[0];earnedTokens[symbol]=(earnedTokens[symbol]||0)+amount;}
   }
  }
  const uniKey=p.a0?.toLowerCase()===UNI[p.chain]?p.t0:p.t1;
  const pricePnl=p.status==='open'?metric?.pnlUsd:closed?.pnl_usd;
  rows.push({key:p.key,id:String(p.id),chain:p.chain,owner:p.wallet,pair:p.pair,status:p.status,
   openedAt:p.opened_ts?new Date(p.opened_ts*1000).toISOString():null,
   closedAt:p.closed_ts?new Date(p.closed_ts*1000).toISOString():null,
   pnlUsd:ready&&finite(pricePnl)?pricePnl:null,feesUsd:ready&&finite(fees)?fees:null,netUsd:ready?net:null});
  for(const c of [...(p.claims||[]),...(p.trading_claims||[])]){
   if(!finite(c.usd)){feeComplete=false;}else claimedUsd+=c.usd;
   for(const [key,amount]of Object.entries(c.tokens||{})){if(!finite(amount)||amount<0)feeComplete=false;else{const symbol=book.tokens?.[key]?.s||key.split('@')[0];tokens[symbol]=(tokens[symbol]||0)+amount;}}
   claims.push({position:p.key,chain:p.chain,owner:p.wallet,id:String(p.id),block:c.block,ts:c.ts,uni:c.tokens?.[uniKey]||0,uniPriceUsd:c.prices?.[uniKey]??null,open:p.status==='open'});
  }
 }
 return {schemaVersion:'uni-lp-accounting-v1',asOf:view.generated,complete,netUsd:complete?netUsd:null,claimedUsd:feeComplete?claimedUsd:null,tokens,
  earnedUsd:earnedComplete?earnedUsd:null,earnedTokens:earnedComplete?earnedTokens:null,positions:rows,claims,
  basis:'LP Book net already includes all LP fees. Open LP fees include claimed and unclaimed amounts at live prices; closed fees and collected fee records keep their recorded prices.'};
}
export function uniPortfolioPerformance({lp,trades=[],flows=[],quotes={},wallets=[],historyComplete=false,coverage}={}){
 const quoteOwners=new Set(),balances={};let walletComplete=true;
 for(const w of wallets){const key=w.chain+':'+w.owner;if(quoteOwners.has(key)||!UNI[w.chain]||!finite(w.uni)||w.uni<0){walletComplete=false;continue;}quoteOwners.add(key);balances[w.chain]=(balances[w.chain]||0)+w.uni;}
 for(const chain of Object.keys(UNI))if(wallets.filter(w=>w.chain===chain).length!==2)walletComplete=false;
 const books={};
 for(const [chain,source]of Object.entries(coverage||{})){const opening=sum(Object.values(source.openingUni||{}).map(raw=>Number(BigInt(raw))/1e18));if(opening>0)books[chain]=[{qty:opening,cost:null,openFee:false}];}
 const byId=new Map(trades.map(t=>[t.id,t]));
 for(const f of [...flows].sort(order)){
  if(coverage?.[f.chain]&&f.block<coverage[f.chain].fromBlock)continue;
  const lots=books[f.chain]||=([]),trade=byId.get(f.id),q=f.uni;
  if(!(finite(q)&&q!==0))continue;
  if(q<0){const quantity=sum(lots.map(l=>l.qty)),fraction=quantity>0?Math.max(0,1-Math.abs(q)/quantity):0;for(const lot of lots)lot.qty*=fraction;continue;}
  if(trade?.side==='buy'){lots.push({qty:q,cost:trade.verified&&finite(trade.usd)?trade.usd/q:null,openFee:false});continue;}
  if(f.kind==='lp_return'){
   const relevant=(lp?.claims||[]).filter(c=>c.chain===f.chain&&c.block===f.block&&f.collections?.some(p=>p.id===c.id)),feeQty=sum(relevant.map(c=>c.uni));
   if(feeQty>q+1e-9){lots.push({qty:q,cost:null,openFee:false});continue;}
   if(q-feeQty>0)lots.push({qty:q-feeQty,cost:f.returnPriceUsd>0?f.returnPriceUsd:null,openFee:false});
   for(const c of relevant)if(c.uni>0)lots.push({qty:c.uni,cost:c.uniPriceUsd>0?c.uniPriceUsd:null,openFee:c.open});
   continue;
  }
  lots.push({qty:q,cost:null,openFee:false});
 }
 let holdingUnrealized=0,holdingComplete=walletComplete;
 for(const [chain,quantity]of Object.entries(balances)){
  // A genuinely empty wallet has no unrealised token exposure, even while older
  // fills are still backfilling. Never apply this shortcut to an unread balance.
  if(quantity<=1e-9)continue;
  const lots=books[chain]||[],total=sum(lots.map(l=>l.qty)),price=quotes[chain]?.priceUsd;
  if(!(coverage?.[chain]?.complete??historyComplete)||!(price>0)||!finite(price)||Math.abs(total-quantity)>Math.max(1e-9,quantity*1e-8)||lots.some(l=>l.qty>1e-9&&!finite(l.cost))){holdingComplete=false;continue;}
  for(const lot of lots)if(!lot.openFee)holdingUnrealized+=lot.qty*(price-lot.cost);
 }
 const lpNet=lp?.schemaVersion==='uni-lp-accounting-v1'&&lp.complete===true&&finite(lp.netUsd)?lp.netUsd:null,
  holding=holdingComplete?holdingUnrealized:null;
 return {lpNetUsd:lpNet,holdingUnrealizedUsd:holding,pnlUsd:lpNet!==null&&holding!==null?lpNet+holding:null,
  lpFeesUsd:lp?.schemaVersion==='uni-lp-accounting-v1'&&finite(lp.earnedUsd)?lp.earnedUsd:null,lpFeeTokens:lp?.earnedTokens||{},
  collectedFeesUsd:lp?.schemaVersion==='uni-lp-accounting-v1'&&finite(lp.claimedUsd)?lp.claimedUsd:null,collectedTokens:lp?.tokens||{},
  basis:'LP Book net plus unrealised gain on actual wallet UNI. Open-LP claimed fee appreciation is already included in LP net and is not counted twice.'};
}

/* Attribution explains the existing total; it never substitutes a new P&L rule.
   Missing/old rows may show verified entries, but cannot claim reconciliation. */
export function uniPnlRecord(lp,performance){
 const source=lp?.schemaVersion==='uni-lp-accounting-v1'&&Array.isArray(lp.positions)?lp.positions:[],keys=new Set(),
  positions=source.filter(p=>{
   if(!p||typeof p.key!=='string'||!p.key||keys.has(p.key)||!UNI[p.chain]||!['open','closed'].includes(p.status))return false;
   keys.add(p.key);return true;
  }),valid=positions.length===source.length&&positions.every(p=>finite(p.netUsd));
 const reconciled=lp?.schemaVersion==='uni-lp-accounting-v1'&&lp.complete===true&&Array.isArray(lp.positions)&&valid&&finite(performance?.lpNetUsd)
  &&Math.abs(sum(positions.map(p=>p.netUsd))-performance.lpNetUsd)<1e-7;
 return {positions,reconciled,asOf:lp?.asOf||null,lpNetUsd:performance?.lpNetUsd??null,
  holdingUnrealizedUsd:performance?.holdingUnrealizedUsd??null,totalUsd:performance?.pnlUsd??null};
}
