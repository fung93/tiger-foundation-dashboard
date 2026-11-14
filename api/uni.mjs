/* Public read-only pool data. Fixed networks/contracts; no user-supplied URLs. */
import {readUniPools} from './_uni-reader.mjs';
let pending=null,cached=null;
export default async function handler(req,res){
  if(!['GET','HEAD'].includes(req.method||'GET')){res.setHeader('allow','GET, HEAD');return res.status(405).json({error:'Read-only endpoint'});}
  const now=Math.floor(Date.now()/1000);
  if(cached&&now-cached.checkedAt<30){res.setHeader('cache-control','public, s-maxage=30, stale-while-revalidate=30');return res.status(200).json(cached);}
  if(!pending)pending=readUniPools().finally(()=>{pending=null;});
  const value=await pending;
  if(value.chains.some(c=>c.status!=='unavailable'))cached=value;
  res.setHeader('cache-control',value.chains.every(c=>c.status==='unavailable')?'no-store':'public, s-maxage=30, stale-while-revalidate=30');
  return res.status(value.chains.every(c=>c.status==='unavailable')?503:200).json(value);
}
