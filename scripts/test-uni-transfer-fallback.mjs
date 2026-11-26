import assert from 'node:assert/strict';
import {CFG,pad} from '../api/_core.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {TRANSFER} from '../uni-trade-core.mjs';
import {createUniTransferBatch} from '../api/_uni-transfers.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;},hex=n=>'0x'+n.toString(16),chain=UNI_CHAINS.base;
const filter=(from=10,to=20,side=1)=>{const topics=[TRANSFER,null,null];topics[side]=CFG.wallets.map(w=>'0x'+pad(w.address));return {address:chain.uni.address,topics,fromBlock:hex(from),toBlock:hex(to)};};
for(const mode of ['envelope','http','null-row','range']){
 let batches=0,singles=0;const intervals=[];
 const read=createUniTransferBatch({...chain,rpcs:['https://'+mode+'.publicnode.invalid']},{fetcher:async(url,options)=>{
  ok(url.endsWith(mode+'.publicnode.invalid'),'Recovery uses the same chain-verified peer');const q=JSON.parse(options.body);
  if(q.method==='eth_chainId')return Response.json({id:q.id,result:'0x2105'});
  if(Array.isArray(q)){batches++;return mode==='http'?new Response('',{status:400}):Response.json(mode==='null-row'?[null]:{error:{code:-32600,message:'Batch is not supported'}});}
  singles++;eq(q.method,'eth_getLogs','The fallback only reads fixed transfer intervals');const f=q.params[0],a=Number(BigInt(f.fromBlock)),b=Number(BigInt(f.toBlock));
  if(mode==='range'&&b-a>3)return Response.json({id:q.id,error:{code:-32005,message:'Block range too large'}});
  intervals.push([a,b]);return Response.json({id:q.id,result:[{marker:a}]});
 }});
 const result=await read([filter()]);ok(result[0].length>0,'A provider without batch support still yields a complete interval');eq(batches,1,'An unsupported envelope is tried once');
 if(mode==='range'){const sorted=intervals.sort((a,b)=>a[0]-b[0]);eq(sorted[0][0],10,'Splitting retains the first block');eq(sorted.at(-1)[1],20,'Splitting retains the last block');ok(sorted.every((r,i)=>i===0||r[0]===sorted[i-1][1]+1),'Adaptive ranges have no omitted or overlapping block');}
 const before=batches;await read([filter(21,24)]);eq(batches,before,'A recovered peer remembers it needs individual requests');ok(singles>=2,'Subsequent checks use the working request format');
}
let attempts=0;
const bad=createUniTransferBatch({...chain,rpcs:['https://missing.publicnode.invalid']},{fetcher:async(_u,options)=>{const q=JSON.parse(options.body);attempts++;return Response.json(q.method==='eth_chainId'?{id:q.id,result:'0x2105'}:Array.isArray(q)?q.map(r=>({id:r.id,result:[]})).slice(1):{id:q.id});}});
await assert.rejects(()=>bad([filter(),filter(10,20,2)]),/Incomplete/);n++;ok(attempts<20,'Incomplete single results fail with a bounded number of peer attempts');
const capped=createUniTransferBatch({...chain,rpcs:['https://cap.publicnode.invalid']},{maxRequests:2,fetcher:async(_u,options)=>{const q=JSON.parse(options.body);return Response.json(q.method==='eth_chainId'?{id:q.id,result:'0x2105'}:{error:{message:'Batch unsupported'}});}});
await assert.rejects(()=>capped([filter()]),/limit reached/);n++;
let denied=0;const wrong=createUniTransferBatch({...chain,rpcs:['https://wrong.publicnode.invalid']},{fetcher:async(_u,options)=>{const q=JSON.parse(options.body);if(q.method!=='eth_chainId')denied++;return Response.json({id:q.id,result:'0x38'});}});
await assert.rejects(()=>wrong([filter()]),/chain mismatch/);n++;eq(denied,0,'Wrong-chain peers never receive a log query');
console.log(`UNI batch rejection recovery, exact range splitting and read-only limits: ${n} assertions passed.`);
