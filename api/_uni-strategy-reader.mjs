/* Bounded, read-only receipt history for UNI-related capital and cash. This
   checkpoint is independent of trade and LP ledgers; no old values are changed. */
import {CFG,encodeAgg3,decodeAgg3,pad} from './_core.mjs';
import {UNI_CHAINS,UNI_MULTICALL} from './_uni-config.mjs';
import {createUniRpc} from './_uni-reader.mjs';
import {createUniTransferBatch} from './_uni-transfers.mjs';
import {readUniReturnPrice} from './_uni-trades.mjs';
import {uniTransfers,TRANSFER} from '../uni-trade-core.mjs';
import {STRATEGY_ASSETS,strategyTokens,validateUniStrategy} from '../uni-strategy-core.mjs';
const ZERO='0x'+'0'.repeat(40),hex=n=>'0x'+n.toString(16),hash=v=>/^0x[0-9a-f]{64}$/i.test(v||''),
 INC='0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',DEC='0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',COL='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const word=(s,i=0)=>{if(!/^0x[0-9a-f]*$/i.test(s||'')||s.length<66+i*64)throw Error('Incomplete strategy contract reading');return BigInt('0x'+s.slice(2+i*64,66+i*64));},addr=(s,i)=>'0x'+word(s,i).toString(16).padStart(64,'0').slice(-40);
export async function advanceUniStrategy(input,{trade,lpBook,rpcFactory,readBatchFactory,maxWindows=4,job=false,now=Date.now}={}){
 validateUniStrategy(input);const book=structuredClone(input),errors={},until=Date.now()+(job?240000:22000),owners=book.wallets;
 if(JSON.stringify(owners)!==JSON.stringify(CFG.wallets.map(w=>w.address.toLowerCase())))throw Error('Strategy wallets differ from the configured owners');
 const owned=address=>owners.includes(address?.toLowerCase());
 for(const chain of Object.values(UNI_CHAINS)){
  const c=STRATEGY_ASSETS[chain.key],tokens=strategyTokens(chain.key),known=Object.values(lpBook?.positions||{}).filter(p=>p.chain===chain.key&&owned(p.wallet)&&[p.a0,p.a1].includes(c.uni)),trades=(trade?.trades||[]).filter(t=>t.chain===chain.key);
  if(!known.length&&!trades.length&&!book.chains[chain.key]){
   if((trade?.wallets||[]).some(w=>w.chain===chain.key&&w.uni>0))errors[chain.key]='Earlier UNI ownership needs a verified starting cost.';
   continue;
  }
  if(Date.now()>=until){errors[chain.key]='Strategy history is still syncing.';continue;}
  const rpc=rpcFactory?rpcFactory(chain):createUniRpc(chain,{timeoutMs:Math.max(1,until-Date.now()),maxRequests:job?8000:350,minIntervalMs:chain.key==='bnb'?100:30,rateRetries:1});
  let state=book.chains[chain.key];
  let finalWindow=null;
  try{
   const head=Number(BigInt(await rpc('eth_blockNumber',[]))),tip=await rpc('eth_getBlockByNumber',[hex(head),false]),ts=Number(BigInt(tip.timestamp));
   if(!hash(tip.hash)||Math.abs(now()/1000-ts)>180)throw Error('Strategy chain head is stale.');
   const start=Math.min(trade?.book?.chains?.[chain.key]?.transferStart??Infinity,...known.map(p=>p.opened_block),...trades.map(t=>t.block));
   if(!Number.isSafeInteger(start)||start<1)throw Error('Strategy history has no verified starting block.');
   if(!state)state=book.chains[chain.key]={startBlock:start,cursor:start-1,head,hash:null,ts,opening:null,balances:null};
   if(start<state.startBlock)throw Error('Earlier strategy history was discovered; the opening cost needs reconciliation.');
   if(state.cursor>head)throw Error('Strategy provider is behind its saved checkpoint.');
   if(state.hash&&(await rpc('eth_getBlockByNumber',[hex(state.cursor),false])).hash!==state.hash)throw Error('Strategy history checkpoint changed; saved evidence retained.');
   state.head=head;state.ts=ts;
   for(const p of known){const key=chain.key+':'+p.id;if(!book.positions[key])book.positions[key]={chain:chain.key,id:String(p.id),owner:p.wallet.toLowerCase(),pool:p.pool,pair:p.pair,token0:p.a0,token1:p.a1};}
   const receipts=new Map(),blocks=new Map(),priceCache=new Map(),beforeIds=new Set(book.events.map(e=>e.id));
   const loadReceipt=async h=>{
    if(receipts.has(h))return receipts.get(h);
    const [receipt,tx]=await Promise.all([rpc('eth_getTransactionReceipt',[h]),rpc('eth_getTransactionByHash',[h])]);
    if(!receipt||!tx||receipt.status!=='0x1'||receipt.transactionHash!==h||tx.hash!==h||!Array.isArray(receipt.logs))throw Error('A strategy receipt could not be verified.');
    const n=Number(BigInt(receipt.blockNumber));if(!blocks.has(n))blocks.set(n,await rpc('eth_getBlockByNumber',[hex(n),false]));const block=blocks.get(n);
    if(block.hash!==receipt.blockHash||tx.blockHash!==block.hash)throw Error('Strategy receipt block changed.');
    const result={receipt,tx,ts:Number(BigInt(block.timestamp))};receipts.set(h,result);return result;
   };
   const metadata=async(id,n,receipt)=>{
    const key=chain.key+':'+id;if(book.positions[key])return book.positions[key];
    let data;for(const at of [n,Math.max(0,n-1)])try{data=await rpc('eth_call',[{to:c.npm,data:'0x99fbab88'+pad(BigInt(id).toString(16))},hex(at)]);word(data,11);break;}catch{data=null;}
    if(!data)throw Error('Historical LP identity is unavailable.');const token0=addr(data,2),token1=addr(data,3);
    if(![token0,token1].includes(c.uni))return null;
    if(![token0,token1].every(a=>tokens.some(t=>t.address===a)))throw Error('This UNI LP uses an unsupported quote asset.');
    let owner=receipt.logs.filter(l=>l.address?.toLowerCase()===c.npm&&l.topics?.[0]===TRANSFER&&l.topics.length===4&&BigInt(l.topics[3]).toString()===id).map(l=>'0x'+l.topics[2].slice(-40).toLowerCase()).find(owned);
    if(!owner){for(const at of [n,Math.max(0,n-1)])try{const candidate=addr(await rpc('eth_call',[{to:c.npm,data:'0x6352211e'+pad(BigInt(id).toString(16))},hex(at)]),0);if(owned(candidate)){owner=candidate;break;}}catch{}}
    if(!owner)return null; // An unrelated NFT can share a router receipt.
    const pool=addr(await rpc('eth_call',[{to:chain.factory,data:'0x1698ee82'+pad(token0)+pad(token1)+pad(word(data,4).toString(16))},hex(n)]),0);if(pool===ZERO)throw Error('UNI LP factory identity failed.');
    return book.positions[key]={chain:chain.key,id,owner,pool,pair:'UNI / '+tokens.find(t=>t.address!==c.uni&&[token0,token1].includes(t.address)).symbol,token0,token1};
   };
   const makeEvent=async h=>{
    const {receipt,tx,ts}=await loadReceipt(h),n=Number(BigInt(receipt.blockNumber)),lp=[],moves=uniTransfers(receipt).filter(m=>tokens.some(t=>t.address===m.token)&&(owned(m.from)||owned(m.to))).map(m=>({...m,raw:m.raw.toString()}));
    for(const l of receipt.logs.filter(l=>l.address?.toLowerCase()===c.npm)){
     let id,op;if([INC,DEC,COL].includes(l.topics?.[0])){id=BigInt(l.topics[1]).toString();const p=await metadata(id,n,receipt);if(!p)continue;
      if(l.topics[0]===COL)op={kind:'collect',id,recipient:addr(l.data,0),a0:word(l.data,1).toString(),a1:word(l.data,2).toString()};
      else op={kind:l.topics[0]===INC?'add':'remove',id,liquidity:word(l.data,0).toString(),a0:word(l.data,1).toString(),a1:word(l.data,2).toString()};
     }else if(l.topics?.[0]===TRANSFER&&l.topics.length===4){id=BigInt(l.topics[3]).toString();if(!owned('0x'+l.topics[1].slice(-40).toLowerCase())&&!owned('0x'+l.topics[2].slice(-40).toLowerCase()))continue;const p=await metadata(id,n,receipt);if(!p)continue;op={kind:'transfer',id,from:'0x'+l.topics[1].slice(-40).toLowerCase(),to:'0x'+l.topics[2].slice(-40).toLowerCase()};}
     if(op)lp.push(op);
    }
    const savedTrade=trades.find(t=>t.hash===h),e={id:chain.key+':'+h,chain:chain.key,hash:h,block:n,blockHash:receipt.blockHash,index:Number(BigInt(receipt.transactionIndex)),ts,moves,lp,trade:null,prices:{},uniPriceUsd:null};
    if(savedTrade){if(savedTrade.blockHash!==e.blockHash||!savedTrade.verified||!Number.isFinite(savedTrade.usd))throw Error('A UNI strategy trade cost is not verified yet.');
     const delta=moves.filter(m=>m.token===c.uni).reduce((q,m)=>q+(owned(m.to)?BigInt(m.raw):0n)-(owned(m.from)?BigInt(m.raw):0n),0n);if(delta!==(savedTrade.side==='buy'?1n:-1n)*BigInt(savedTrade.raw))throw Error('UNI trade and strategy receipt differ.');e.trade=structuredClone(savedTrade);e.uniPriceUsd=savedTrade.price;}
    const lpChanges=lp.some(op=>op.kind!=='transfer'),uniDelta=moves.filter(m=>m.token===c.uni).reduce((q,m)=>q+(owned(m.to)?BigInt(m.raw):0n)-(owned(m.from)?BigInt(m.raw):0n),0n),cashDelta=moves.filter(m=>m.token!==c.uni).reduce((q,m)=>q+(owned(m.to)?BigInt(m.raw):0n)-(owned(m.from)?BigInt(m.raw):0n),0n);
    if(!savedTrade&&!lpChanges&&uniDelta!==0n&&cashDelta!==0n)throw Error('A new UNI swap is waiting for trade verification.');
    for(const op of lp.filter(op=>['remove','collect'].includes(op.kind))){const key=chain.key+':'+op.id,p=book.positions[key],old=known.find(x=>String(x.id)===op.id);if((p.token0===c.uni?BigInt(op.a0):BigInt(op.a1))===0n)continue;
     const recorded=old?.frozen?.at_block===n?old.frozen.prices?.['UNI@'+chain.key]:null;
     if(recorded>0)e.prices[key]=recorded;
     else{const k=p.pool+':'+n;if(!priceCache.has(k))priceCache.set(k,await readUniReturnPrice(chain,rpc,n,{pool:p.pool}));e.prices[key]=priceCache.get(k);}
    }
    if(uniDelta!==0n&&!e.uniPriceUsd){const pool=lp.length?book.positions[chain.key+':'+lp[0].id]?.pool:trade?.quotes?.[chain.key]?.pool;e.uniPriceUsd=Object.values(e.prices).find(p=>p>0)||await readUniReturnPrice(chain,rpc,n,{pool});}
    e.gas=owned(tx.from)?{token:chain.key==='base'?'ETH':'BNB',raw:(BigInt(receipt.gasUsed||0)*BigInt(receipt.effectiveGasPrice||0)+BigInt(receipt.l1Fee||0)).toString()}:null;
    return e;
   };
   const readBatch=readBatchFactory?readBatchFactory(chain):createUniTransferBatch(chain,{timeoutMs:Math.max(1,until-Date.now()),maxRequests:job?30000:1500,tokenAddresses:tokens.map(t=>t.address)});
   for(let w=0;state.cursor<head&&w<maxWindows&&Date.now()<until;w++){
    const from=state.cursor+1,to=Math.min(head,from+49999),filters=tokens.flatMap(t=>[1,2].map(side=>{const topics=[TRANSFER,null,null];topics[side]=owners.map(o=>'0x'+pad(o));return {address:t.address,topics,fromBlock:hex(from),toBlock:hex(to)};}));
    const rows=await readBatch(filters);if(!Array.isArray(rows)||rows.length!==filters.length||rows.some(r=>!Array.isArray(r)||r.length>=10000))throw Error('Incomplete strategy token interval.');
    const checkLog=l=>{if(!l||l.removed||!hash(l.transactionHash)||!hash(l.blockHash)||!Number.isSafeInteger(Number(BigInt(l.logIndex)))||Number(BigInt(l.blockNumber))<from||Number(BigInt(l.blockNumber))>to)throw Error('Invalid strategy source log.');};
    const logs=rows.flat();for(const l of logs){checkLog(l);if(!tokens.some(t=>t.address===l.address?.toLowerCase())||l.topics?.[0]!==TRANSFER||l.topics.length!==3)throw Error('Invalid strategy token log.');}
    const nftRows=await Promise.all([1,2].map(side=>{const topics=[TRANSFER,null,null];topics[side]=owners.map(o=>'0x'+pad(o));return rpc('eth_getLogs',[{address:c.npm,topics,fromBlock:hex(from),toBlock:hex(to)}]);}));
    if(nftRows.some(r=>!Array.isArray(r)||r.length>=10000))throw Error('Strategy NFT interval is truncated.');const nfts=nftRows.flat();
    for(const l of nfts){checkLog(l);if(l.address?.toLowerCase()!==c.npm||l.topics?.[0]!==TRANSFER||l.topics.length!==4)throw Error('Invalid strategy NFT log.');}
    const hashes=new Set([...logs,...nfts].map(l=>l.transactionHash.toLowerCase()));
    const staged=[];for(const h of hashes){const e=await makeEvent(h);if(!beforeIds.has(e.id))staged.push(e);}
    const ids=Object.values(book.positions).filter(p=>p.chain===chain.key).map(p=>'0x'+pad(BigInt(p.id).toString(16)));
    const ops=ids.length?await rpc('eth_getLogs',[{address:c.npm,topics:[[INC,DEC,COL],ids],fromBlock:hex(from),toBlock:hex(to)}]):[];
    if(!Array.isArray(ops)||ops.length>=10000)throw Error('Strategy LP log interval is truncated.');for(const l of ops){checkLog(l);if(l.address?.toLowerCase()!==c.npm||![INC,DEC,COL].includes(l.topics?.[0])||!ids.includes(l.topics?.[1]))throw Error('Invalid strategy LP log.');}
    for(const h of new Set(ops.map(l=>l.transactionHash.toLowerCase())))if(!hashes.has(h)){const e=await makeEvent(h);if(!beforeIds.has(e.id))staged.push(e);}
    for(const log of [...logs,...nfts,...ops]){const {receipt}=await loadReceipt(log.transactionHash.toLowerCase());if(receipt.blockHash!==log.blockHash||!receipt.logs.some(l=>l.address.toLowerCase()===log.address.toLowerCase()&&l.logIndex===log.logIndex&&l.data===log.data&&JSON.stringify(l.topics)===JSON.stringify(log.topics)))throw Error('Strategy log receipt proof failed.');}
    const end=await rpc('eth_getBlockByNumber',[hex(to),false]);if(!hash(end.hash)||to===head&&end.hash!==tip.hash)throw Error('Strategy source changed during reading.');
    if(to===head)finalWindow={cursor:state.cursor,hash:state.hash,eventCount:book.events.length};
    book.events.push(...staged);staged.forEach(e=>beforeIds.add(e.id));state.cursor=to;state.hash=end.hash;
   }
   // Missing archive prices can recover later; recorded prices are immutable.
   for(const e of book.events.filter(e=>e.chain===chain.key)){
    for(const op of e.lp.filter(op=>['remove','collect'].includes(op.kind))){const key=chain.key+':'+op.id,p=book.positions[key];if((p.token0===c.uni?BigInt(op.a0):BigInt(op.a1))>0n&&!(e.prices?.[key]>0)){const px=await readUniReturnPrice(chain,rpc,e.block,{pool:p.pool});if(px>0)(e.prices||={})[key]=px;}}
    if(!(e.uniPriceUsd>0)&&e.moves.some(m=>m.token===c.uni)){const pool=e.lp.length?book.positions[chain.key+':'+e.lp[0].id]?.pool:trade?.quotes?.[chain.key]?.pool,px=Object.values(e.prices||{}).find(p=>p>0)||await readUniReturnPrice(chain,rpc,e.block,{pool});if(px>0)e.uniPriceUsd=px;}
   }
   if(state.cursor===head){
    // A provider returning empty logs is not proof of an empty strategy when
    // the independent trade/LP ledgers already establish historical activity.
    if(trades.some(t=>t.block>head||!book.events.some(e=>e.chain===chain.key&&e.hash===t.hash)))throw Error('A known UNI trade is missing from strategy receipt history.');
    for(const p of known)if(!book.events.some(e=>e.chain===chain.key&&e.lp.some(op=>op.id===String(p.id)&&op.kind==='add')))throw Error('A known UNI LP is missing from strategy receipt history.');
    const calls=owners.flatMap(owner=>tokens.map(t=>({to:t.address,data:'0x70a08231'+pad(owner)}))).concat(tokens.map(t=>({to:t.address,data:'0x313ce567'}))),results=decodeAgg3(await rpc('eth_call',[{to:UNI_MULTICALL,data:encodeAgg3(calls)},hex(head)]),calls.length);
    if(results.some(r=>!r.ok))throw Error('Current strategy balances are unavailable.');
    tokens.forEach((t,i)=>{if(Number(word(results[owners.length*tokens.length+i].data))!==t.decimals)throw Error('Strategy token decimals changed.');});
    const balances=Object.fromEntries(owners.map((owner,i)=>[owner,Object.fromEntries(tokens.map((t,j)=>[t.address,word(results[i*tokens.length+j].data).toString()]))])),opening=structuredClone(balances);
    for(const e of book.events.filter(e=>e.chain===chain.key))for(const m of e.moves){if(owned(m.from))opening[m.from][m.token]=(BigInt(opening[m.from][m.token])+BigInt(m.raw)).toString();if(owned(m.to))opening[m.to][m.token]=(BigInt(opening[m.to][m.token])-BigInt(m.raw)).toString();}
    if(Object.values(opening).some(tokens=>Object.values(tokens).some(q=>BigInt(q)<0n)))throw Error('Strategy token interval does not reconcile.');
    if(state.opening&&JSON.stringify(state.opening)!==JSON.stringify(opening))throw Error('Strategy opening balances changed.');
    const owed={};for(const p of Object.values(book.positions).filter(p=>p.chain===chain.key)){
     const actions=book.events.filter(e=>e.chain===chain.key).flatMap(e=>e.lp.filter(op=>op.id===p.id)),burned=actions.some(op=>op.kind==='transfer'&&op.to===ZERO);
     if(burned)continue;
     const data=await rpc('eth_call',[{to:c.npm,data:'0x99fbab88'+pad(BigInt(p.id).toString(16))},hex(head)]);
     if(addr(data,2)!==p.token0||addr(data,3)!==p.token1)throw Error('Strategy LP token identity changed.');
     const liquidity=actions.reduce((q,op)=>q+(op.kind==='add'?BigInt(op.liquidity):op.kind==='remove'?-BigInt(op.liquidity):0n),0n);
     if(word(data,7)!==liquidity)throw Error('Strategy LP liquidity does not reconcile.');
     owed[chain.key+':'+p.id]={a0:word(data,10).toString(),a1:word(data,11).toString(),block:head};
    }
    if((await rpc('eth_getBlockByNumber',[hex(head),false])).hash!==tip.hash)throw Error('Strategy head changed while valuing balances.');state.opening=opening;state.balances=balances;book.owed={...(book.owed||{}),...owed};
   }
  }catch(error){
   // The final interval is provisional until balance/liquidity/receivable proofs
   // pass. A transient failure must not strand a cursor beyond unread receipts.
   if(finalWindow){state.cursor=finalWindow.cursor;state.hash=finalWindow.hash;book.events.length=finalWindow.eventCount;}
   errors[chain.key]=String(error.message).slice(0,180);
  }
 }
 validateUniStrategy(book);
 const complete=Object.keys(book.chains).length>0&&!Object.keys(errors).length&&Object.values(book.chains).every(s=>s.cursor===s.head&&s.opening&&s.balances);
 return {book,complete,errors,at:Math.floor(now()/1000)};
}
