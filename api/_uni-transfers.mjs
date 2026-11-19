/* Fixed read-only transfer queries; batch IDs and every result are verified.
   Providers commonly cap a log interval at 50,000 blocks. Batching preserves that
   limit while avoiding thousands of separate HTTP requests during backfill. */
import {TRANSFER} from '../uni-trade-core.mjs';
import {CFG,pad} from './_core.mjs';
const extra={base:['https://base.drpc.org','https://base.llamarpc.com'],bnb:['https://56.rpc.thirdweb.com']};
export function createUniTransferBatch(chain,{fetcher=fetch,timeoutMs=jobTimeout(),maxRequests=8000}={}){
 const until=Date.now()+timeoutMs,verified=new Set(),owners=CFG.wallets.map(w=>'0x'+pad(w.address)),sources=[...chain.rpcs.filter(u=>u.includes('publicnode')),...(extra[chain.key]||[]),...chain.rpcs.filter(u=>!u.includes('publicnode'))];let used=0,preferred=0,nextArchiveSend=0;
 async function send(url,payload){if(url.includes('rpc.thirdweb.com')){const slot=Math.max(Date.now(),nextArchiveSend);nextArchiveSend=slot+1100;if(slot>Date.now())await new Promise(resolve=>setTimeout(resolve,slot-Date.now()));}
  if(Date.now()>=until||used+(Array.isArray(payload)?payload.length:1)>maxRequests)throw Error('UNI transfer reading limit reached');used+=Array.isArray(payload)?payload.length:1;
  const controller=new AbortController();let timer;const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNI transfer source timed out'));},Math.max(1,Math.min(10000,until-Date.now())));});
  try{return await Promise.race([(async()=>{const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});if(!r.ok)throw Error('UNI transfer source HTTP '+r.status);return r.json();})(),expired]);}finally{clearTimeout(timer);}
 }
 return async filters=>{
  if(!Array.isArray(filters)||!filters.length||filters.length>40)throw Error('Invalid UNI transfer batch');
  for(const f of filters){const sides=f.topics?.slice(1).filter(Array.isArray);if(f.address!==chain.uni.address||f.topics?.[0]!==TRANSFER||sides.length!==1||JSON.stringify(sides[0])!==JSON.stringify(owners)
   ||Number(BigInt(f.toBlock))-Number(BigInt(f.fromBlock))<0||Number(BigInt(f.toBlock))-Number(BigInt(f.fromBlock))>=50000)throw Error('Invalid fixed UNI transfer query');}
  let last;
  for(let n=0;n<sources.length;n++){
   const index=(preferred+n)%sources.length,url=sources[index];
   try{
    if(!verified.has(url)){const j=await send(url,{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});if(j.error||Number(BigInt(j.result))!==chain.id)throw Error('UNI transfer chain mismatch');verified.add(url);}
    const pieces=filters.flatMap((filter,parent)=>{const from=Number(BigInt(filter.fromBlock)),to=Number(BigInt(filter.toBlock)),step=url.includes('rpc.thirdweb.com')?1000:50000,result=[];
      for(let a=from;a<=to;a+=step)result.push({parent,filter:{...filter,fromBlock:'0x'+a.toString(16),toBlock:'0x'+Math.min(to,a+step-1).toString(16)}});return result;});
    const rows=filters.map(()=>[]);
    const size=url.includes('rpc.thirdweb.com')?10:100,parallel=url.includes('rpc.thirdweb.com')?1:2;
    for(let offset=0;offset<pieces.length;offset+=size*parallel)await Promise.all(Array.from({length:parallel},(_,i)=>pieces.slice(offset+i*size,offset+(i+1)*size)).filter(part=>part.length).map(async part=>{
      const replies=await send(url,part.map(({filter},id)=>({jsonrpc:'2.0',id,method:'eth_getLogs',params:[filter]})));
      if(!Array.isArray(replies)||replies.length!==part.length)throw Error('Incomplete UNI transfer batch');
      const ids=new Set();
      for(const reply of replies){if(!Number.isInteger(reply.id)||reply.id<0||reply.id>=part.length||ids.has(reply.id)||reply.error||!Array.isArray(reply.result)||reply.result.length>=10000)throw Error(reply.error?.message||'Incomplete UNI transfer batch');ids.add(reply.id);rows[part[reply.id].parent].push(...reply.result);}
    }));
    if(rows.some(row=>row.length>=10000))throw Error('UNI transfer result limit reached');
    preferred=index;return rows;
   }catch(error){last=error;}
  }
  throw last||Error('UNI transfer history unavailable');
 };
}
function jobTimeout(){return 240000;}
