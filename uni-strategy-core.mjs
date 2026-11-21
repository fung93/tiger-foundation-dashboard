/* Receipt-backed UNI strategy accounting. No network, writes, signing or model.
   Net funding follows external capital, not repeated use of the same cash. */
export const STRATEGY_ASSETS = Object.freeze({
 base:{uni:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',npm:'0x03a520b32c04bf3beef7beb72e919cf822ed34f1',stables:[
  ['USDC','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',6],['USDT','0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',6],['DAI','0x50c5725949a6f0c72e6c4a641f24049a917db0cb',18],['USDbC','0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',6]]},
 bnb:{uni:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1',npm:'0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',stables:[
  ['USDT','0x55d398326f99059ff775485246999027b3197955',18],['USDC','0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',18],['DAI','0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3',18]]},
});
const finite=Number.isFinite,address=v=>/^0x[0-9a-f]{40}$/.test(v||''),hash=v=>/^0x[0-9a-f]{64}$/.test(v||''),raw=v=>typeof v==='string'&&/^\d{1,78}$/.test(v),sum=xs=>xs.reduce((a,b)=>a+b,0);
export const strategyTokens=chain=>[{symbol:'UNI',address:STRATEGY_ASSETS[chain].uni,decimals:18},...STRATEGY_ASSETS[chain].stables.map(([symbol,address,decimals])=>({symbol,address,decimals}))];
export const emptyUniStrategy=wallets=>({version:1,wallets:[...wallets],chains:{},positions:{},events:[],owed:{}});
export function validateUniStrategy(book){
 if(book?.version!==1||!Array.isArray(book.wallets)||book.wallets.length!==2||new Set(book.wallets).size!==2||!book.wallets.every(address)||!book.chains||!book.positions||!Array.isArray(book.events)||book.events.length>20000)throw Error('Invalid UNI strategy ledger');
 for(const [chain,s]of Object.entries(book.chains)){
  if(!STRATEGY_ASSETS[chain]||!Number.isSafeInteger(s.startBlock)||s.startBlock<1||!Number.isSafeInteger(s.cursor)||s.cursor<s.startBlock-1||!Number.isSafeInteger(s.head)||s.cursor>s.head||s.cursor>=s.startBlock&&!hash(s.hash)||!Number.isSafeInteger(s.ts)||s.ts<=0)throw Error('Invalid strategy checkpoint');
  for(const values of [s.opening,s.balances])if(values!==null&&values!==undefined)for(const owner of book.wallets)for(const token of strategyTokens(chain))if(!raw(values[owner]?.[token.address]))throw Error('Incomplete strategy token balances');
 }
 for(const [key,p]of Object.entries(book.positions)){
  const c=STRATEGY_ASSETS[p.chain],tokens=c&&strategyTokens(p.chain);
  if(!c||key!==p.chain+':'+p.id||!/^\d+$/.test(p.id)||!book.wallets.includes(p.owner)||!address(p.pool)||p.token0===p.token1||![p.token0,p.token1].includes(c.uni)||![p.token0,p.token1].every(a=>tokens.some(t=>t.address===a)))throw Error('Invalid strategy LP identity');
 }
 const seen=new Set();
 for(const e of book.events){
  const s=book.chains[e.chain];
  if(!s||!hash(e.hash)||e.id!==e.chain+':'+e.hash||seen.has(e.id)||!hash(e.blockHash)||!Number.isSafeInteger(e.block)||e.block<s.startBlock||e.block>s.cursor||!Number.isSafeInteger(e.index)||e.index<0||!Number.isSafeInteger(e.ts)||e.ts<=0||!Array.isArray(e.moves)||!Array.isArray(e.lp))throw Error('Invalid strategy receipt');
  seen.add(e.id);
  for(const m of e.moves)if(!strategyTokens(e.chain).some(t=>t.address===m.token)||!address(m.from)||!address(m.to)||!raw(m.raw)||![m.from,m.to].some(o=>book.wallets.includes(o)))throw Error('Invalid strategy token movement');
  for(const op of e.lp)if(!book.positions[e.chain+':'+op.id]||!['add','remove','collect','transfer'].includes(op.kind)||op.kind!=='transfer'&&(!raw(op.a0)||!raw(op.a1))||['add','remove'].includes(op.kind)&&!raw(op.liquidity)||op.kind==='transfer'&&(!address(op.from)||!address(op.to))||op.kind==='collect'&&!address(op.recipient))throw Error('Invalid strategy LP action');
  if(e.trade&&(!['buy','sell'].includes(e.trade.side)||e.trade.verified!==true||!book.wallets.includes(e.trade.owner)||!raw(e.trade.raw)||!finite(e.trade.usd)||e.trade.usd<=0||!Array.isArray(e.trade.quote)||!e.trade.quote.length||e.trade.quote.some(p=>!STRATEGY_ASSETS[e.chain].stables.some(s=>s[1]===p.address&&s[2]===p.decimals)||!/^\-?\d{1,78}$/.test(p.raw))))throw Error('Unverified strategy swap');
 }
 for(const [key,o]of Object.entries(book.owed||{}))if(!book.positions[key]||!raw(o.a0)||!raw(o.a1)||!Number.isSafeInteger(o.block)||o.block>book.chains[book.positions[key].chain]?.cursor)throw Error('Invalid strategy receivable snapshot');
 return book;
}

export function replayUniStrategy(book){
 validateUniStrategy(book);
 if(!Object.keys(book.chains).length)throw Error('Strategy cash history is syncing.');
 const owners=new Set(book.wallets),wallets={},positions={},settlements=[],funding=[];
 let contributedUsd=0,withdrawnUsd=0,originalUsd=0,initialClosed=false,realizedUsd=0;
 const get=(chain,owner,token)=>wallets[chain+':'+owner+':'+token];
 for(const [chain,s]of Object.entries(book.chains)){
  if(s.cursor!==s.head||!s.opening||!s.balances)throw Error('Strategy cash history is syncing.');
  for(const owner of owners)for(const t of strategyTokens(chain)){
   const q=BigInt(s.opening[owner][t.address]);
   if(t.symbol==='UNI'&&q!==0n)throw Error('Earlier UNI purchase cost still needs verification.');
   wallets[chain+':'+owner+':'+t.address]={chain,owner,token:t.address,symbol:t.symbol,decimals:t.decimals,quantity:q,reserve:0n,basisUsd:0};
  }
 }
 const units=(chain,token,q)=>Number(q)/10**strategyTokens(chain).find(t=>t.address===token).decimals;
 const price=(e,token,key)=>{
  if(token!==STRATEGY_ASSETS[e.chain].uni)return 1;
  const px=e.prices?.[key]??e.uniPriceUsd;if(!(finite(px)&&px>0))throw Error('A historical UNI price still needs verification.');return px;
 };
 const value=(e,token,q,key)=>q===0n?0:units(e.chain,token,q)*price(e,token,key);
 const fund=(e,usd,kind)=>{if(!finite(usd)||usd<0)throw Error('Invalid strategy funding');if(usd===0)return;
  if(kind==='in'){contributedUsd+=usd;if(!initialClosed)originalUsd+=usd;}else withdrawnUsd+=usd;
  funding.push({id:e.id+':fund:'+funding.length,chain:e.chain,hash:e.hash,block:e.block,ts:e.ts,kind,usd});};
 const realize=(e,usd,kind,key)=>{if(!finite(usd))throw Error('Unverified realized value');realizedUsd+=usd;
  settlements.push({id:e.id+':'+settlements.length,chain:e.chain,hash:e.hash,block:e.block,ts:e.ts,kind,position:key||null,usd});if(key)positions[key].realizedUsd+=usd;};
 const takeBasis=(w,q)=>{if(q>w.quantity)throw Error('UNI movements do not reconcile with wallet inventory.');const basis=w.quantity? w.basisUsd*Number(q)/Number(w.quantity):0;w.quantity-=q;w.basisUsd-=basis;if(w.quantity===0n)w.basisUsd=0;return basis;};
 const events=[...book.events].sort((a,b)=>a.ts-b.ts||a.chain.localeCompare(b.chain)||a.block-b.block||a.index-b.index);
 for(const e of events){
  const net={};for(const m of e.moves){if(owners.has(m.from))net[m.from+':'+m.token]=(net[m.from+':'+m.token]||0n)-BigInt(m.raw);if(owners.has(m.to))net[m.to+':'+m.token]=(net[m.to+':'+m.token]||0n)+BigInt(m.raw);}
  const outgoing=(token,q,preferred)=>{
   let left=q,basis=0;
   for(const owner of [...owners].sort((a,b)=>Number(b===preferred)-Number(a===preferred))){const k=owner+':'+token,n=net[k]||0n;if(n>=0n)continue;const part=left<-n?left:-n;if(!part)continue;const w=get(e.chain,owner,token);if(part>w.quantity)throw Error('A strategy payment exceeds its verified wallet balance.');
    if(w.symbol==='UNI')basis+=takeBasis(w,part);
    else{const reused=part<w.reserve?part:w.reserve;w.quantity-=part;w.reserve-=reused;const fresh=units(e.chain,token,part-reused);fund(e,fresh,'in');basis+=units(e.chain,token,part);}
    net[k]+=part;left-=part;if(!left)break;
   }if(left)throw Error('Compound UNI operation needs a complete funding proof.');return basis;
  };
  const incoming=(token,q,basis,recipient)=>{
   if(!owners.has(recipient)){fund(e,basis,'out');return;}
   const k=recipient+':'+token;if((net[k]||0n)<q)throw Error('Strategy receipt proceeds do not reconcile.');const w=get(e.chain,recipient,token);w.quantity+=q;if(w.symbol==='UNI')w.basisUsd+=basis;else w.reserve+=q;net[k]-=q;
  };
  if(e.trade){
   if(e.lp.some(op=>op.kind!=='transfer'))throw Error('Combined swap and LP operations need a dedicated cost proof.');
   const t=e.trade,token=STRATEGY_ASSETS[e.chain].uni,q=BigInt(t.raw);
   if(t.side==='buy'){
    let spent=0;for(const part of t.quote){if(BigInt(part.raw)>=0n)throw Error('Unsupported UNI purchase funding');const amount=-BigInt(part.raw);spent+=outgoing(part.address,amount,t.owner);}
    if(Math.abs(spent-t.usd)>1e-7)throw Error('UNI purchase costs do not reconcile.');
    let left=q;for(const owner of owners){const n=net[owner+':'+token]||0n,part=n>0n?(left<n?left:n):0n;if(part){incoming(token,part,t.usd*Number(part)/Number(q),owner);left-=part;}}if(left)throw Error('UNI purchase inventory is incomplete.');
   }else{
    const basis=outgoing(token,q,t.owner);let got=0;for(const part of t.quote){const amount=BigInt(part.raw);if(amount<=0n)throw Error('Unsupported UNI sale proceeds');got+=units(e.chain,part.address,amount);let left=amount;for(const owner of owners){const n=net[owner+':'+part.address]||0n,portion=n>0n?(left<n?left:n):0n;if(portion){incoming(part.address,portion,units(e.chain,part.address,portion),owner);left-=portion;}}if(left)throw Error('UNI sale proceeds are incomplete.');}
    if(Math.abs(got-t.usd)>1e-7)throw Error('UNI sale value does not reconcile.');realize(e,got-basis,'sale');initialClosed=true;
   }
  }
  for(const op of e.lp){
   const key=e.chain+':'+op.id,meta=book.positions[key];
   const p=positions[key]||=( {key,id:op.id,chain:e.chain,owner:meta.owner,pair:meta.pair,token0:meta.token0,token1:meta.token1,liquidity:0n,basisUsd:0,depositedUsd:0,settledCostUsd:0,proceedsUsd:0,feesUsd:0,realizedUsd:0,pending:[],openedTs:e.ts,closedTs:null} );
   if(op.kind==='transfer'){if(op.to==='0x'+'0'.repeat(40)){if(p.liquidity||p.pending.some(l=>l.raw>0n))throw Error('Burned LP still has unsettled principal.');p.burned=true;continue;}if(op.from==='0x'+'0'.repeat(40))continue;if(!owners.has(op.from)||!owners.has(op.to))throw Error('Transferred UNI LP requires original cost verification.');p.owner=op.to;continue;}
   const amounts=[BigInt(op.a0),BigInt(op.a1)],tokens=[meta.token0,meta.token1];
   if(op.kind==='add'){
    let basis=0;for(let i=0;i<2;i++)if(amounts[i])basis+=outgoing(tokens[i],amounts[i],meta.owner);
    p.liquidity+=BigInt(op.liquidity);p.basisUsd+=basis;p.depositedUsd+=basis;p.closedTs=null;initialClosed=true;
   }else if(op.kind==='remove'){
    const liq=BigInt(op.liquidity);if(!p.liquidity||liq>p.liquidity)throw Error('Missing LP entry history.');const basis=p.basisUsd*Number(liq)/Number(p.liquidity);p.liquidity-=liq;p.basisUsd-=basis;if(!p.liquidity)p.basisUsd=0;
    const values=tokens.map((token,i)=>value(e,token,amounts[i],key)),total=sum(values);let assigned=0;
    if(total===0){realize(e,-basis,'principal',key);p.settledCostUsd+=basis;}
    else{const nonzero=amounts.map((q,i)=>q?i:null).filter(i=>i!==null);for(const [j,i]of nonzero.entries()){const cost=j===nonzero.length-1?basis-assigned:basis*values[i]/total;assigned+=cost;p.pending.push({token:tokens[i],raw:amounts[i],basisUsd:cost});}}
   }else{
    for(let i=0;i<2;i++){
     const token=tokens[i],amount=amounts[i];let remaining=amount,cost=0,principal=0n;
     for(const lot of p.pending.filter(l=>l.token===token&&l.raw>0n)){const q=remaining<lot.raw?remaining:lot.raw;if(!q)continue;const basis=lot.basisUsd*Number(q)/Number(lot.raw);cost+=basis;lot.raw-=q;lot.basisUsd-=basis;if(!lot.raw)lot.basisUsd=0;remaining-=q;principal+=q;if(!remaining)break;}
     if(principal){const proceeds=value(e,token,principal,key);p.settledCostUsd+=cost;p.proceedsUsd+=proceeds;realize(e,proceeds-cost,'principal',key);incoming(token,principal,proceeds,op.recipient);}
     if(remaining){const earned=value(e,token,remaining,key);p.feesUsd+=earned;realize(e,earned,'fee',key);incoming(token,remaining,earned,op.recipient);}
    }
   }
   if(p.liquidity===0n&&!p.pending.some(l=>l.raw>0n)&&p.closedTs===null)p.closedTs=e.ts;
  }
  // Carry cost/reserves between owned wallets before considering outside flows.
  for(const token of strategyTokens(e.chain).map(t=>t.address)){
   for(const from of owners)for(const to of owners){if(from===to)continue;const a=net[from+':'+token]||0n,b=net[to+':'+token]||0n;if(a>=0n||b<=0n)continue;const q=-a<b?-a:b,source=get(e.chain,from,token),target=get(e.chain,to,token);if(q>source.quantity)throw Error('Internal UNI-strategy transfer exceeds inventory.');
    if(source.symbol==='UNI'){const basis=takeBasis(source,q);target.quantity+=q;target.basisUsd+=basis;}else{const cash=q<source.reserve?q:source.reserve;source.quantity-=q;source.reserve-=cash;target.quantity+=q;target.reserve+=cash;}net[from+':'+token]+=q;net[to+':'+token]-=q;
   }
   for(const owner of owners){const delta=net[owner+':'+token]||0n,w=get(e.chain,owner,token);
    if(delta>0n){w.quantity+=delta;if(w.symbol==='UNI'){const usd=value(e,token,delta);w.basisUsd+=usd;fund(e,usd,'in');}}
    if(delta<0n){const q=-delta;if(q>w.quantity)throw Error('Wallet transfer history is incomplete.');if(w.symbol==='UNI'){const basis=takeBasis(w,q),usd=value(e,token,q);fund(e,usd,'out');realize(e,usd-basis,'withdrawal');}
     else{const unrelated=w.quantity-w.reserve,withdraw=q>unrelated?q-unrelated:0n;w.quantity-=q;w.reserve-=withdraw;fund(e,units(e.chain,token,withdraw),'out');}}
   }
  }
 }
 for(const w of Object.values(wallets))if(w.quantity!==BigInt(book.chains[w.chain].balances[w.owner][w.token]))throw Error('Strategy movements do not reconcile with current token balances.');
 const pendingFees=[];
 for(const p of Object.values(positions))if(p.liquidity===0n&&!p.burned){
  const owed=book.owed?.[p.key],meta=book.positions[p.key];
  if(!owed||owed.block!==book.chains[p.chain].head)throw Error('Closed LP fees are still being verified.');
  for(const [i,token]of [meta.token0,meta.token1].entries()){
   const principal=p.pending.filter(l=>l.token===token).reduce((q,l)=>q+l.raw,0n),amount=BigInt(owed['a'+i]);
   if(amount<principal)throw Error('Pending LP principal does not reconcile with the contract.');
   if(amount>principal)pendingFees.push({key:p.key,chain:p.chain,token,raw:(amount-principal).toString()});
  }
 }
 return {schemaVersion:'uni-strategy-replay-v1',available:true,wallets:Object.values(wallets).map(w=>({...w,quantity:w.quantity.toString(),reserve:w.reserve.toString()})),pendingFees,
  positions:Object.values(positions).map(p=>({...p,liquidity:p.liquidity.toString(),pending:p.pending.map(l=>({...l,raw:l.raw.toString()}))})),
  contributedUsd,withdrawnUsd,originalUsd,addedUsd:contributedUsd-originalUsd,capitalUsd:contributedUsd-withdrawnUsd,realizedUsd,settlements,funding};
}

export function valueUniStrategy(replay,{trade,lpView}={}){
 if(!replay?.available)throw Error('Strategy cash history is syncing.');
 if(lpView?.uni?.schemaVersion!=='uni-lp-accounting-v1'||lpView.uni.complete!==true||!Array.isArray(lpView.uni.positions)||!Array.isArray(lpView.position_data)||!Array.isArray(lpView.position_metrics))throw Error('Current UNI LP coverage is still being verified.');
 let walletUniValueUsd=0,cashUsd=0,lpValueUsd=0,pendingValueUsd=0,remainingBasisUsd=0;
 const currentPositions=[];
 for(const w of replay.wallets){const q=Number(BigInt(w.quantity))/10**w.decimals;
  if(w.symbol==='UNI'){const source=(trade?.wallets||[]).find(x=>x.chain===w.chain&&x.owner.toLowerCase()===w.owner);if(!source||Math.abs(source.uni-q)>Math.max(1e-9,q*1e-8))throw Error('Wallet and strategy readings are still syncing.');const price=trade?.quotes?.[w.chain]?.priceUsd;if(q&&!(finite(price)&&price>0))throw Error('Current UNI price is unavailable.');walletUniValueUsd+=q?(q*price):0;remainingBasisUsd+=w.basisUsd;}
  else cashUsd+=Number(BigInt(w.reserve))/10**w.decimals;
 }
 const active=new Set();
 for(const p of replay.positions){
  if(BigInt(p.liquidity)>0n){active.add(p.key);const source=lpView?.position_data?.find(x=>x.chain===p.chain&&String(x.id)===p.id&&x.owner===p.owner),metric=lpView?.position_metrics?.find(x=>x.key===p.key);
   if(!source||source.status!=='observed'||!metric?.complete||metric.owner!==p.owner||typeof source.feesMine!=='boolean'||!finite(source.principalUsd)||source.principalUsd<0||!finite(metric.unclaimedUsd)||metric.unclaimedUsd<0||source.raw?.liquidity!==p.liquidity||source.raw?.token0?.address!==p.token0||source.raw?.token1?.address!==p.token1)throw Error('Current LP and strategy readings are still syncing.');
   const fees=source.feesMine?metric.unclaimedUsd:0,value=source.principalUsd+fees;lpValueUsd+=value;remainingBasisUsd+=p.basisUsd;currentPositions.push({...p,principalUsd:source.principalUsd,unclaimedFeeUsd:fees,valueUsd:value,unrealizedUsd:value-p.basisUsd});
  }
  for(const lot of p.pending){const q=BigInt(lot.raw);if(!q)continue;const token=strategyTokens(p.chain).find(t=>t.address===lot.token),price=token.symbol==='UNI'?trade?.quotes?.[p.chain]?.priceUsd:1;if(!(finite(price)&&price>0))throw Error('Pending LP principal needs a verified price.');pendingValueUsd+=Number(q)/10**token.decimals*price;remainingBasisUsd+=lot.basisUsd;}
 }
 for(const fee of replay.pendingFees||[]){const token=strategyTokens(fee.chain).find(t=>t.address===fee.token),px=token.symbol==='UNI'?trade?.quotes?.[fee.chain]?.priceUsd:1;if(!(finite(px)&&px>0))throw Error('Unclaimed LP fees need a verified price.');pendingValueUsd+=Number(BigInt(fee.raw))/10**token.decimals*px;}
 for(const p of lpView?.uni?.positions||[])if(p.status==='open'&&!active.has(p.key))throw Error('A current UNI LP is missing from strategy history.');
 const valueNowUsd=walletUniValueUsd+cashUsd+lpValueUsd+pendingValueUsd,pnlUsd=valueNowUsd-replay.capitalUsd,unrealizedUsd=walletUniValueUsd+lpValueUsd+pendingValueUsd-remainingBasisUsd;
 if(Math.abs(pnlUsd-replay.realizedUsd-unrealizedUsd)>Math.max(1e-7,Math.abs(valueNowUsd)*1e-10))throw Error('Realized and current strategy P&L do not reconcile.');
 return {...replay,valueNowUsd,walletValueUsd:walletUniValueUsd,cashUsd,lpValueUsd,pendingValueUsd,pnlUsd,unrealizedUsd,currentPositions};
}
