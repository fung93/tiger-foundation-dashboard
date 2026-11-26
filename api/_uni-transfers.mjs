/* Fixed read-only transfer queries; batch IDs and every result are verified.
   Providers commonly cap a log interval at 50,000 blocks. Batching preserves that
   limit while avoiding thousands of separate HTTP requests during backfill. */
import {TRANSFER} from '../uni-trade-core.mjs';
import {CFG,pad} from './_core.mjs';
import {uniLogRangeError} from './_uni-reader.mjs';
const extra={base:['https://base.drpc.org','https://base.llamarpc.com'],bnb:['https://56.rpc.thirdweb.com']};
const unsupportedBatches=new Map();
export function createUniTransferBatch(chain,{fetcher=fetch,timeoutMs=jobTimeout(),maxRequests=8000,requestTimeoutMs=10000,tokenAddresses=[chain.uni.address]}={}){
 const allowed=new Set([chain.uni.address,...chain.stables.map(t=>t.address)]);
 if(!Array.isArray(tokenAddresses)||!tokenAddresses.length||tokenAddresses.some(a=>!allowed.has(a)))throw Error('Invalid fixed strategy token set');
 const until=Date.now()+timeoutMs,verified=new Set(),owners=CFG.wallets.map(w=>'0x'+pad(w.address)),sources=[...chain.rpcs.filter(u=>u.includes('publicnode')),...(extra[chain.key]||[]),...chain.rpcs.filter(u=>!u.includes('publicnode'))];let used=0,preferred=0,nextArchiveSend=0;
 async function send(url,payload){if(url.includes('rpc.thirdweb.com')){const slot=Math.max(Date.now(),nextArchiveSend);nextArchiveSend=slot+1100;if(slot>Date.now())await new Promise(resolve=>setTimeout(resolve,slot-Date.now()));}
  if(Date.now()>=until||used+(Array.isArray(payload)?payload.length:1)>maxRequests)throw Error('UNI transfer reading limit reached');used+=Array.isArray(payload)?payload.length:1;
  const controller=new AbortController();let timer;const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNI transfer source timed out'));},Math.max(1,Math.min(requestTimeoutMs,until-Date.now())));});
  try{return await Promise.race([(async()=>{const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});if(!r.ok)throw Error('UNI transfer source HTTP '+r.status);return r.json();})(),expired]);}finally{clearTimeout(timer);}
 }
 async function single(url,filter){
  try{const reply=await send(url,{jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[filter]});
   if(reply?.error)throw Object.assign(Error(String(reply.error.message||'UNI log request failed')),{rpcCode:reply.error.code});
   if(reply?.id!==1||!Array.isArray(reply.result))throw Error('Incomplete UNI transfer result');
   if(reply.result.length>=10000)throw Error('UNI log result limit reached');return reply.result;
  }catch(error){const from=Number(BigInt(filter.fromBlock)),to=Number(BigInt(filter.toBlock));
   if(!uniLogRangeError(error)||from>=to)throw error;const middle=Math.floor((from+to)/2);
   return [...await single(url,{...filter,toBlock:'0x'+middle.toString(16)}),...await single(url,{...filter,fromBlock:'0x'+(middle+1).toString(16)})];
  }
 }
 async function singles(url,part,rows){let next=0;
  await Promise.all(Array.from({length:Math.min(url.includes('rpc.thirdweb.com')?1:2,part.length)},async()=>{
   while(next<part.length){const item=part[next++];rows[item.parent].push(...await single(url,item.filter));}
  }));
 }
 return async filters=>{
  if(!Array.isArray(filters)||!filters.length||filters.length>40)throw Error('Invalid UNI transfer batch');
  for(const f of filters){const sides=f.topics?.slice(1).filter(Array.isArray);if(!tokenAddresses.includes(f.address)||f.topics?.[0]!==TRANSFER||sides.length!==1||JSON.stringify(sides[0])!==JSON.stringify(owners)
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
      if((unsupportedBatches.get(url)||0)>Date.now())return singles(url,part,rows);
      let replies;
      try{replies=await send(url,part.map(({filter},id)=>({jsonrpc:'2.0',id,method:'eth_getLogs',params:[filter]})));}
      catch(error){if(!/HTTP (400|405|413|415)|batch.*(?:unsupported|not supported|disabled)/i.test(error.message))throw error;replies=null;}
      const ids=new Set(),shape=Array.isArray(replies)&&replies.length===part.length&&replies.every(reply=>{
        if(!reply||!Number.isInteger(reply.id)||reply.id<0||reply.id>=part.length||ids.has(reply.id))return false;ids.add(reply.id);return true;
      });
      if(!shape){unsupportedBatches.set(url,Date.now()+600000);if(unsupportedBatches.size>32)unsupportedBatches.delete(unsupportedBatches.keys().next().value);return singles(url,part,rows);}
      const failed=replies.find(reply=>reply.error||!Array.isArray(reply.result)||reply.result.length>=10000);
      if(failed){if(/429|rate limit|too many requests|quota|capacity/i.test(failed.error?.message||''))throw Error(failed.error.message);return singles(url,part,rows);}
      for(const reply of replies)rows[part[reply.id].parent].push(...reply.result);
    }));
    if(rows.some(row=>row.length>=10000))throw Error('UNI transfer result limit reached');
    preferred=index;return rows;
   }catch(error){last=error;}
  }
  throw last||Error('UNI transfer history unavailable');
 };
}
function jobTimeout(){return 240000;}
