/* Share private observed history with on-demand analysis. Fixed first-party
   reads only; an old stored quote is never refreshed by loading its memory. */
import { readAgentState } from './_agent-store.mjs';
import { autoHash,autoFresh } from './_agent-auto-state.mjs';
import { observedFeeRate } from './_agent-auto-analysis.mjs';
import { readAgentJSON } from './_agent-context.mjs';
import { lpPairKey } from './_agent-lp-range.mjs';
import { positionIdentity } from '../portfolio-core.mjs';

export async function loadLearnedLPContext({store,context={},args={},origin,fetcher=fetch,now=Date.now(),enabled=true}={}) {
  const policy=context.policy,allowed=policy?.status==='confirmed'?policy.constraints?.allowedAnalysisTypes:null;
  if(Array.isArray(allowed)&&!allowed.includes('lp'))return context;
  const positions=(context.lp?.positions||[]).map(row=>row.canonical).filter(p=>p&&['katana','robinhood','arc'].includes(p.chain)
    &&(!args.chain||args.chain===p.chain)&&(!args.owner||args.owner.toLowerCase()===p.owner?.toLowerCase())
    &&(!args.positionId||String(p.positionId||p.id)===args.positionId.replace(/^#/,''))
    &&(!args.pair||lpPairKey(args.pair)===lpPairKey(p.raw?.token0?.symbol+'/'+p.raw?.token1?.symbol))
    &&/^0x[0-9a-f]{40}$/i.test(p.pool||'')&&/^0x[0-9a-f]{40}$/i.test(p.owner||''));
  if(!positions.length)return context;
  const pools=[...new Set(positions.map(p=>p.chain+':'+p.pool.toLowerCase()))];
  if(pools.length>1)return context; // Let the tool ask which pool, without new reads.
  const p=positions[0],key=p.chain+':'+p.pool.toLowerCase(),poolKey='automation:pool:'+autoHash([p.chain,p.pool.toLowerCase()]);
  const positionKeys=positions.slice(0,4).map(row=>'automation:position:'+autoHash(positionIdentity({chain:row.chain,
    protocolContract:row.contract,positionId:String(row.positionId||row.id),owner:row.owner})));
  const feedbackKeys=positions.slice(0,4).map(row=>'automation:feedback:'+autoHash([positionIdentity({chain:row.chain,
    protocolContract:row.contract,positionId:String(row.positionId||row.id),owner:row.owner}),policy?.version||0]));
  const raw=await readAgentState(store,[...(enabled?[poolKey]:[]),...positionKeys,...feedbackKeys]),state=raw[poolKey];
  const learning={...(context.lpLearning||{})};
  learning[key]={lessons:enabled?state?.learning?.[policy?.version||0]||null:null,history:enabled?state?.history||{}:{},
    ownerDeclined:positionKeys.some((k,i)=>raw[feedbackKeys[i]]?['rejected','invalidated'].includes(raw[feedbackKeys[i]].state)
      :raw[k]?.range?.status==='owner_declined'&&raw[k]?.policyVersion===(policy?.version||0)),
    sourceRecord:poolKey};
  if(p.chain==='katana')return {...context,lpLearning:learning,lpAnalysisChain:p.chain};
  if(context.lp?.status!=='fresh'||!autoFresh(p.observedAt,now)||p.status!=='observed')return {...context,lpLearning:learning,lpAnalysisChain:p.chain};
  const query=new URLSearchParams({view:'agent-pool',chain:p.chain,pool:p.pool});
  const fundingQuery=new URLSearchParams({view:'lp-funding',chain:p.chain,owner:p.owner});
  const [market,funding]=await Promise.all([
    readAgentJSON(origin+'/api/strategy?'+query,{fetcher,timeoutMs:4000,maxBytes:32000,init:{redirect:'manual'}}).catch(()=>null),
    positions.length===1?readAgentJSON(origin+'/api/strategy?'+fundingQuery,{fetcher,timeoutMs:2500,maxBytes:32000,init:{redirect:'manual'}}).catch(()=>null):null,
  ]);
  if(market?.schemaVersion!=='agent-pool-observation-v1'||market.chain!==p.chain||market.pool?.toLowerCase()!==p.pool.toLowerCase()
    ||market.status!=='fresh'||!autoFresh(market.observedAt,now))return {...context,lpLearning:learning,lpAnalysisChain:p.chain};
  const pool={...market,ts:market.observedAt,fees:observedFeeRate(state?.history||{},{...market,ts:market.observedAt}),
    historySource:poolKey,sampledHistory:enabled?state?.history||{}:{},kind:'fees'};
  return {...context,lpLearning:learning,lpAnalysisChain:p.chain,lpMarkets:[...(context.lpMarkets||[]).filter(m=>m.chain!==p.chain||m.pool!==pool.pool),pool],
    lpAdviceFunding:funding,sources:[...(context.sources||[]).filter(s=>s.name!=='lp-market'),{name:'lp-market',status:'fresh',ts:pool.ts}]};
}
