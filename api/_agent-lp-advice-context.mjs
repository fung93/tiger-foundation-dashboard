/* Optional reads for a selected LP analysis only. Public MCP calls receive no
   wallet, transcript, policy or secret. Failure never replaces first-party data. */
import { loadAgentSupplementalContext,readAgentJSON } from './_agent-context.mjs';
import { readKatanaMCP,katanaMCPEnabled } from './_agent-katana-mcp.mjs';
import { lpPairKey } from './_agent-lp-range.mjs';

export async function loadLPAdviceContext({context={},args={},env={},origin,fetcher=fetch,
  loadSupplementalContext=loadAgentSupplementalContext,readMCP=readKatanaMCP}={}){
  const allowed=context.policy?.status==='confirmed'?context.policy.constraints?.allowedAnalysisTypes:null;
  if(Array.isArray(allowed)&&!allowed.includes('lp'))return context;
  if(args.chain&&args.chain!=='katana')return context;
  if(context.lpAnalysisChain&&context.lpAnalysisChain!=='katana')return context;
  const extended=args.dailyRewardTargetUsd!==undefined||!!args.analysisFocus;
  const needs=['strategy',...(extended?['kat']:[])].filter(name=>!context[name]);
  const positions=(context.lp?.positions||[]).map(row=>row.canonical).filter(p=>p?.chain==='katana'
    &&(!args.chain||args.chain==='katana')&&(!args.positionId||String(p.positionId)===args.positionId.replace(/^#/,''))
    &&(!args.owner||p.owner?.toLowerCase()===args.owner.toLowerCase())
    &&(!args.pair||lpPairKey(args.pair)===lpPairKey(p.raw?.token0?.symbol+'/'+p.raw?.token1?.symbol))
    &&p.status==='observed'&&/^0x[0-9a-f]{40}$/i.test(p.owner||''));
  // Funding uses a detected owner's address, never a submitted/model-only one.
  const selected=extended&&positions.length===1?positions[0]:null;
  const funding=selected?readAgentJSON(origin+'/api/strategy?'+new URLSearchParams({view:'lp-funding',chain:'katana',owner:selected.owner}),
    {fetcher,timeoutMs:2500,maxBytes:32000,init:{redirect:'manual'}}).catch(()=>null):null;
  const [enhanced,mcp,gas]=await Promise.all([
    needs.length?loadSupplementalContext({origin,needs,context,timeoutMs:6000,fetcher}):context,
    readMCP({env,fetcher}),funding,
  ]);
  const sources=(enhanced.sources||[]).filter(row=>row.name!=='katana-mcp');
  if(katanaMCPEnabled(env))sources.push({name:'katana-mcp',status:mcp.status==='ready'?'reference':mcp.status==='connected'?'connected':'unavailable',ts:mcp.checkedAt});
  return {...enhanced,katanaMCP:mcp,lpAdviceFunding:gas,sources};
}
