/* Public read-only pool data. Fixed networks/contracts; no user-supplied URLs. */
import {readUniPools} from './_uni-reader.mjs';
import {readFile} from 'node:fs/promises';
import {emptyUniSnapshot,validateUniSnapshot,mergeUniSnapshots} from '../uni-core.mjs';
let pending=null,cached=null,cachedUntil=0;
export default async function handler(req,res){
  if(!['GET','HEAD'].includes(req.method||'GET')){res.setHeader('allow','GET, HEAD');return res.status(405).json({error:'Read-only endpoint'});}
  if(cached&&Date.now()<cachedUntil){res.setHeader('cache-control','public, s-maxage=30, stale-while-revalidate=30');return res.status(200).json(cached);}
  if(!pending)pending=(async()=>{
    let saved;try{saved=validateUniSnapshot(JSON.parse(await readFile(new URL('../uni-pools.json',import.meta.url),'utf8')));}catch{saved=emptyUniSnapshot();}
    return mergeUniSnapshots(saved,await readUniPools({saved}));
  })().finally(()=>{pending=null;});
  const value=await pending;
  if(value.chains.some(c=>c.status!=='unavailable')){cached=value;cachedUntil=Date.now()+30000;}
  res.setHeader('cache-control',value.chains.every(c=>c.status==='unavailable')?'no-store':'public, s-maxage=30, stale-while-revalidate=30');
  return res.status(value.chains.every(c=>c.status==='unavailable')?503:200).json(value);
}
