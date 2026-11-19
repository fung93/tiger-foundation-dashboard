import {CFG,pad} from './_core.mjs';
import {UNI_CHAINS} from './_uni-config.mjs';
import {createUniTransferBatch} from './_uni-transfers.mjs';
import {TRANSFER,uniTransfers,receiptUniTrade} from '../uni-trade-core.mjs';
import {verifyUniOrders} from './_uni-orders.mjs';
const owners=CFG.wallets.map(w=>w.address.toLowerCase()),hex=n=>'0x'+n.toString(16),hash=v=>/^0x[0-9a-f]{64}$/i.test(v||'');
const collect='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01',npms={base:'0x03a520b32c04bf3beef7beb72e919cf822ed34f1',bnb:'0x7b8a01b39d58278b5de7e48c8449c9f4f5170613'};
export async function scanUniFlows(book,chain,rpc,tip,{maxWindows=32,recent=false,deadlineMs=Infinity,readBatch,provePool,readReturnPrice,quote}={}){
 const original=book.chains[chain.key];if(!original)throw Error('UNI history baseline unavailable');
 let state=original;
 if(recent){
  const start=original.recentStart??Math.max(1,tip.number-49999);
  if(original.recentCursor===undefined){
   original.recentStart=start;original.recentCursor=start-1;original.recentHash=null;original.recentOpeningUni=null;
  }
  state={...original,transferStart:original.recentStart,transferCursor:original.recentCursor,transferHash:original.recentHash,openingUni:original.recentOpeningUni};
 }

 if(state.transferCursor===undefined){
  let start=Math.max(1,state.startBlock);let opening;
  for(let n=0;n<50;n++){
   opening=await Promise.all(owners.map(owner=>rpc('eth_call',[{to:chain.uni.address,data:'0x70a08231'+pad(owner)},hex(start-1)])));
   if(opening.every(v=>/^0x[0-9a-f]{64}$/i.test(v)&&BigInt(v)===0n))break;
   if(n===49||start<=1)throw Error('Opening UNI holding basis unavailable');start=Math.max(1,start-50000);
  }
  state.transferStart=start;state.transferCursor=start-1;state.transferHash=null;state.openingUni=Object.fromEntries(owners.map((w,i)=>[w,BigInt(opening[i]).toString()]));
 }
 if(state.transferCursor>tip.number)throw Error('UNI transfer source is behind');
 if(state.transferHash&&(await rpc('eth_getBlockByNumber',[hex(state.transferCursor),false])).hash!==state.transferHash)throw Error('UNI transfer checkpoint changed');
 // Only fill a missing historical price; never reprice an already recorded one.
 if(!recent)for(const flow of (book.flows||[]).filter(f=>f.chain===chain.key&&f.kind==='lp_return'&&f.returnPriceUsd===null).slice(0,8)){
  try{const block=await rpc('eth_getBlockByNumber',[hex(flow.block),false]);if(block.hash!==flow.blockHash)continue;
   const price=await readReturnPrice(chain,rpc,flow.block,quote);if(price>0&&Number.isFinite(price))flow.returnPriceUsd=price;
  }catch{/* Keep unavailable basis and allow independent new fills to be read. */}
 }
 const read=readBatch||createUniTransferBatch(chain,{timeoutMs:Math.min(maxWindows>32?200000:18000,deadlineMs-Date.now()),maxRequests:maxWindows>32?120000:4000}),blocks=new Map(),known=new Set((book.flows||[]).map(f=>f.id));book.flows ||= [];
 for(let done=0;state.transferCursor<tip.number&&done<maxWindows;){
  const windows=Array.from({length:Math.min(chain.key==='bnb'&&!recent?1:20,maxWindows-done,Math.ceil((tip.number-state.transferCursor)/50000))},(_,i)=>({from:state.transferCursor+1+i*50000,to:Math.min(tip.number,state.transferCursor+(i+1)*50000)}));
  const filters=windows.flatMap(w=>[1,2].map(side=>{const topics=[TRANSFER,null,null];topics[side]=owners.map(o=>'0x'+pad(o));return {address:chain.uni.address,topics,fromBlock:hex(w.from),toBlock:hex(w.to)};})),results=await read(filters);
  if(!Array.isArray(results)||results.length!==filters.length)throw Error('Incomplete UNI transfer interval');
  for(let index=0;index<windows.length;index++){
   const w=windows[index],logs=[...results[index*2],...results[index*2+1]],flows=[],trades=[];
   for(const l of logs){const n=Number(BigInt(l.blockNumber));if(l.removed||l.address?.toLowerCase()!==chain.uni.address||!hash(l.transactionHash)||!hash(l.blockHash)||n<w.from||n>w.to||l.topics?.[0]!==TRANSFER||l.topics.length!==3||!l.topics.slice(1).some(t=>owners.includes('0x'+t.slice(-40).toLowerCase())))throw Error('Unverified UNI transfer log');}
   for(const h of [...new Set(logs.map(l=>l.transactionHash.toLowerCase()))]){
    const id=chain.key+':'+h;if(known.has(id))continue;
    const [receipt,transaction]=await Promise.all([rpc('eth_getTransactionReceipt',[h]),rpc('eth_getTransactionByHash',[h])]);
    if(!receipt||!transaction||receipt.status!=='0x1'||receipt.transactionHash!==h||transaction.hash!==h||!Array.isArray(receipt.logs))throw Error('UNI fill receipt unavailable');
    const n=Number(BigInt(receipt.blockNumber));if(n<w.from||n>w.to)throw Error('UNI fill outside its transfer interval');
    if(!blocks.has(n))blocks.set(n,await rpc('eth_getBlockByNumber',[hex(n),false]));const source=blocks.get(n);
    if(source.hash!==receipt.blockHash||transaction.blockHash!==source.hash||logs.filter(l=>l.transactionHash.toLowerCase()===h).some(l=>l.blockHash!==source.hash||!receipt.logs.some(r=>r.logIndex===l.logIndex&&r.address?.toLowerCase()===chain.uni.address&&r.data===l.data&&JSON.stringify(r.topics)===JSON.stringify(l.topics))))throw Error('UNI transfer receipt changed');
    const ts=Number(BigInt(source.timestamp)),legs=uniTransfers(receipt),delta=legs.filter(t=>t.token===chain.uni.address).reduce((s,t)=>s+(owners.includes(t.to)?t.raw:0n)-(owners.includes(t.from)?t.raw:0n),0n);
    const verifiedOrders=await verifyUniOrders(chain,owners,rpc,receipt,transaction),verifiedPools=verifiedOrders.length?[]:await provePool(chain,rpc,receipt),found=receiptUniTrade({chain,wallets:owners,receipt,transaction,ts,verifiedOrders,verifiedPools});
    if(found.trade&&!book.trades.some(t=>t.id===found.trade.id))trades.push(found.trade);
    if(delta!==0n){
     const collections=receipt.logs.filter(l=>l.address?.toLowerCase()===npms[chain.key]&&l.topics?.[0]===collect&&/^0x[0-9a-f]{192}$/i.test(l.data||'')&&owners.includes('0x'+l.data.slice(26,66).toLowerCase())).map(l=>({id:BigInt(l.topics[1]).toString()}));
     const returnPriceUsd=collections.length&&delta>0n?await readReturnPrice(chain,rpc,n,quote):null;
     flows.push({id,returnPriceUsd,chain:chain.key,hash:h,block:n,blockHash:source.hash,index:Number(BigInt(receipt.transactionIndex)),ts,raw:delta.toString(),uni:Number(delta)/1e18,kind:collections.length&&delta>0n?'lp_return':found.trade?'trade':'transfer',collections});
    }
   }
   if(flows.length||trades.length||index===windows.length-1){
    const checkpoint=await rpc('eth_getBlockByNumber',[hex(w.to),false]);if(!hash(checkpoint.hash)||w.to===tip.number&&checkpoint.hash!==tip.hash)throw Error('UNI transfer head changed');
    book.trades.push(...trades);book.flows.push(...flows);flows.forEach(f=>known.add(f.id));state.transferCursor=w.to;state.transferHash=checkpoint.hash;
    if(recent){original.recentCursor=state.transferCursor;original.recentHash=state.transferHash;}
   }done++;
  }
 }
 if(recent&&original.recentCursor===tip.number){
  const raw=await Promise.all(owners.map(owner=>rpc('eth_call',[{to:chain.uni.address,data:'0x70a08231'+pad(owner)},hex(tip.number)])));
  if(!raw.every(value=>/^0x[0-9a-f]{64}$/i.test(value)))throw Error('Current UNI inventory unavailable');
  const moved=(book.flows||[]).filter(flow=>flow.chain===chain.key&&flow.block>=original.recentStart&&flow.block<=tip.number).reduce((total,flow)=>total+BigInt(flow.raw),0n),opening=raw.reduce((total,value)=>total+BigInt(value),0n)-moved;
  if(opening<0n)throw Error('UNI movements do not reconcile with current balances');
  // Canonical UNI is a non-rebasing ERC20. A complete Transfer interval plus
  // current balance proves its combined opening units without an archive call.
  if(original.recentOpeningUni&&Object.values(original.recentOpeningUni).reduce((sum,value)=>sum+BigInt(value),0n)!==opening)throw Error('UNI opening inventory changed');
  original.recentOpeningUni={combined:opening.toString()};
 }
}
