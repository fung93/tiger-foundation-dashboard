import {CFG} from './_core.mjs';
export function createRevenueRpc({maxRequests=64,timeoutMs=22000}={}){
 let used=0;const deadline=Date.now()+timeoutMs;
 return async(method,params)=>{
  if(++used>maxRequests||Date.now()>=deadline)throw Error('Revenue reading budget reached; no partial day was saved');
  const r=await fetch(CFG.katRpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
   signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now())))});
  if(!r.ok)throw Error('Katana RPC HTTP '+r.status);const j=await r.json();if(j.error)throw Error(j.error.message);if(!Object.hasOwn(j,'result'))throw Error('Missing Katana RPC result');return j.result;
 };
}
export async function revenueClock(rpc){
 const head=Number(BigInt(await rpc('eth_blockNumber',[]))),blocks=new Map();
 async function stamp(n){if(!blocks.has(n)){const b=await rpc('eth_getBlockByNumber',['0x'+n.toString(16),false]);if(!b?.timestamp)throw Error('Missing reporting block time');blocks.set(n,Number(BigInt(b.timestamp)));}return blocks.get(n);}
 const headTs=await stamp(head);
 async function firstBlock(ts){let guess=Math.max(0,head-(headTs-ts)),time=await stamp(guess);if(time===ts)return guess;
  let lo=time<ts?guess+1:0,hi=time<ts?head:guess;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(await stamp(mid)<ts)lo=mid+1;else hi=mid;}
  if(await stamp(lo)<ts)throw Error('Reporting interval is ahead of the RPC');return lo;}
 return {head,headTs,stamp,firstBlock};
}
export async function completeRevenueLogs(rpc,filter,from,to){
 try{const logs=await rpc('eth_getLogs',[{...filter,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]);
  if(!Array.isArray(logs))throw Error('Malformed revenue logs');if(logs.length>=10000)throw Error('Log result limit exceeded');return logs;
 }catch(e){if(!/log.*(?:count.*)?limit|limit.*(?:exceeded|results)|more than.*results/i.test(e.message)||from>=to)throw e;
  const mid=Math.floor((from+to)/2);return [...await completeRevenueLogs(rpc,filter,from,mid),...await completeRevenueLogs(rpc,filter,mid+1,to)];}
}
