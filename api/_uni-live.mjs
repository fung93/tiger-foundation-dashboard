/* Current-only UNI reads. No logs, archive lookups, wallet nonce searches or
   historical accounting can hold this refresh behind a backfill. */
import {readFile} from 'node:fs/promises';
import {CFG,encodeAgg3,decodeAgg3,pad} from './_core.mjs';
import {UNI_CHAINS,UNI_MULTICALL} from './_uni-config.mjs';
import {readUniPools,createUniRpc} from './_uni-reader.mjs';
import {createLiveCache,responseHeaders} from './_live-cache.mjs';
import {emptyUniSnapshot,validateUniSnapshot,mergeUniSnapshots} from '../uni-core.mjs';
const wallets=CFG.wallets.map(w=>w.address.toLowerCase()),hex=n=>'0x'+n.toString(16);
export function createUniLiveReader({readSaved=async()=>JSON.parse(await readFile(new URL('../uni-pools.json',import.meta.url),'utf8')),readPools=readUniPools,rpcFactory=chain=>createUniRpc(chain,{timeoutMs:2500,requestTimeoutMs:800,maxRequests:12,preferHealthy:true})}={}){
 let latest=null;
 const cache=createLiveCache({ttlMs:3000,complete:v=>v.chains.every(c=>c.quoteComplete===true)}),marketCache=createLiveCache({ttlMs:3000,complete:v=>v.complete===true});
 const remember=value=>{validateUniSnapshot(value);latest=mergeUniSnapshots(latest||emptyUniSnapshot(),value);};
 const read=()=>cache('current',async()=>{
  let saved;try{saved=validateUniSnapshot(await readSaved());}catch{saved=emptyUniSnapshot();}
  const baseline=mergeUniSnapshots(latest||emptyUniSnapshot(),saved),next=await readPools({saved:baseline,currentOnly:true,currentTimeoutMs:5000});
  latest=mergeUniSnapshots(latest||baseline,mergeUniSnapshots(baseline,next));return latest;
 });
 const market=()=>marketCache('market',async()=>{
  const snapshot=await read(),quotes={},balances=[],errors={};
  await Promise.all(Object.values(UNI_CHAINS).map(async chain=>{try{
   const source=snapshot.chains.find(c=>c.key===chain.key),pool=snapshot.pools.filter(p=>p.chain===chain.key&&!p.retained).sort((a,b)=>b.tvlUsd-a.tvlUsd)[0];
   if(!source?.quoteComplete||!pool||pool.at!==source.at)throw Error('Current UNI pool reading unavailable');
   quotes[chain.key]={priceUsd:pool.price,pool:pool.pool,block:pool.block,ts:pool.at,tvl:pool.tvlUsd};
   const rpc=rpcFactory(chain),calls=wallets.map(owner=>({to:chain.uni.address,data:'0x70a08231'+pad(owner)})),rows=decodeAgg3(await rpc('eth_call',[{to:UNI_MULTICALL,data:encodeAgg3(calls)},hex(pool.block)]),calls.length);
   if(rows.some(r=>!r.ok||!/^0x[0-9a-f]{64}$/i.test(r.data)))throw Error('Current UNI wallet balance unavailable');
   if((await rpc('eth_getBlockByNumber',[hex(pool.block),false]))?.hash!==pool.blockHash)throw Error('Current UNI wallet block changed');
   for(let i=0;i<wallets.length;i++){const raw=BigInt(rows[i].data),uni=Number(raw)/1e18,valueUsd=uni*pool.price;if(!Number.isFinite(valueUsd))throw Error('Invalid wallet value');balances.push({chain:chain.key,owner:wallets[i],raw:raw.toString(),uni,valueUsd,ts:pool.at,block:pool.block});}
  }catch{errors[chain.key]='Current UNI price or wallet balance unavailable';}}));
  return {schemaVersion:'uni-market-view-v1',quotes,wallets:balances,complete:!Object.keys(errors).length,errors};
 });
 return {read,market,remember};
}
const current=createUniLiveReader();
export const rememberUniHistory=value=>current.remember(value);
export async function handleUniLive(req,res){
 const query=req.query||Object.fromEntries(new URL(req.url||'/','https://local.invalid').searchParams);
 if(!['live','market'].includes(query.view))return false;
 responseHeaders(res);
 try{const value=query.view==='live'?await current.read():await current.market(),complete=query.view==='live'?value.chains.every(c=>c.quoteComplete===true):value.complete;
  res.setHeader('cache-control',complete?'public, max-age=0, s-maxage=3, must-revalidate':'no-store');
  const available=query.view==='live'?value.chains.some(c=>c.quoteComplete):Object.keys(value.quotes).length>0;
  res.status(available?200:503).json(value);return true;
 }catch{res.status(502).json({error:'Current UNI readings are unavailable.'});return true;}
}
