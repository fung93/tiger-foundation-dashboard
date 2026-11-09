/* Fresh fixed first-party views for investment checks. Owner addresses and
   destination URLs never come from the model or external research. */
import {readAgentJSON} from './_agent-context.mjs';
import {WALLET} from '../morpho-core.mjs';
const CHAINS=['katana','robinhood','arc','solana'];
const OWNERS=[WALLET.toLowerCase(),'0x4da1d0d5f7b123364d7580f19b716de2ed4e9770','GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B'];
const fresh=(s,now)=>Number.isFinite(Date.parse(s))&&now-Date.parse(s)>=-30000&&now-Date.parse(s)<90000;
export async function loadStressContext({context,origin,fetcher=fetch,now=Date.now()}={}){
  if(!origin)return context;
  const results=await Promise.all(CHAINS.map(async chain=>{try{return await readAgentJSON(origin+'/api/strategy?'+new URLSearchParams({view:'agent-wallet',chain}),
    {fetcher,timeoutMs:5000,maxBytes:48000,init:{redirect:'manual'}});}catch{return null;}}));
  const assets=(context.snapshot?.assets||[]).filter(row=>row.kind!=='wallet'),missing=[];
  for(let i=0;i<CHAINS.length;i++){
    const chain=CHAINS[i],source=results[i];
    if(source?.schemaVersion!=='agent-wallet-observation-v1'||source.chain!==chain||!fresh(source.observedAt,now)||!Array.isArray(source.balances)||source.balances.length>60){
      missing.push(chain);assets.push(...(context.snapshot?.assets||[]).filter(row=>row.kind==='wallet'&&row.chain===chain).map(row=>({...row,status:'stale'})));continue;}
    if(source.status!=='fresh')missing.push(chain);
    for(const row of source.balances){
      const owner=chain==='solana'?row.owner:String(row.owner).toLowerCase();if(!OWNERS.includes(owner)||row.chain!==chain){missing.push(chain);continue;}
      const valid=row.status==='observed'&&fresh(row.observedAt,now)&&typeof row.raw==='string'&&/^\d{1,160}$/.test(row.raw)
        &&Number.isInteger(row.decimals)&&row.decimals>=0&&row.decimals<=36&&Number.isSafeInteger(row.block)&&row.block===source.block;
      assets.push({id:'wallet:'+chain+':'+owner+':'+(row.address||'native'),chain,owner,kind:'wallet',symbol:row.symbol,
        tokenAddress:row.address,rawAmount:valid?row.raw:null,decimals:row.decimals,amount:valid?row.amount:null,
        valueUsd:valid&&Number.isFinite(row.valueUsd)?row.valueUsd:null,priceUsd:row.priceUsd??null,observedAt:row.observedAt,
        block:row.block,status:valid?'fresh':'unavailable',sourceId:'configured-wallet-reader',basis:'live'});
    }
  }
  return {...context,stressAssets:assets.slice(0,250),stressCoverageIncomplete:missing.length>0||assets.length>250,
    stressWalletCoverage:{chains:CHAINS.filter(chain=>!missing.includes(chain)),missingChains:[...new Set(missing)]}};
}
