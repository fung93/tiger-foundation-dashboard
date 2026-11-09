/* Deterministic, privately stored investment reviews. No signing, model maths,
   policy changes or inference is needed to inspect the verified calculations. */
import {createHash} from 'node:crypto';
import {agentMoney,agentReadingTime} from '../agent-language.mjs';
import {renderInvestmentAnswer} from '../agent-investment-brief.mjs';
import {lpPairKey} from './_agent-lp-range.mjs';
import {readAgentJSON,loadAgentSupplementalContext} from './_agent-context.mjs';
import {loadStressContext} from './_agent-investment-context.mjs';
import {stressPortfolio} from '../agent-portfolio-stress.mjs';
import {runAgentTool} from './_agent-tools.mjs';
import {loadLearnedLPContext} from './_agent-learned-context.mjs';
import {loadLPAdviceContext} from './_agent-lp-advice-context.mjs';
import {recordInvestmentDecision} from './_agent-decision-evaluation.mjs';
import {checkProtocolWatch} from './_agent-protocol-watch.mjs';
import {readAgentState} from './_agent-store.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fresh=(ts,now)=>Number.isFinite(Date.parse(ts))&&now-Date.parse(ts)>=-30000&&now-Date.parse(ts)<90000;
export {investmentQuestion} from './_agent-investment-intent.mjs';
export function performanceReview(context,{pair,positionId,chain,now=Date.now()}={}){
  const rows=(context.lp?.positions||[]).filter(row=>row.canonical&&(!pair||lpPairKey(pair)===lpPairKey(row.pair||row.canonical.pair))
    &&(!chain||row.canonical.chain===chain)&&(!positionId||String(row.canonical.positionId||row.canonical.id)===String(positionId).replace(/^#/,'')))
    .slice(0,30).map(row=>({positionId:String(row.canonical.positionId||row.canonical.id),chain:row.canonical.chain,pair:row.pair,
      attribution:context.lp.status==='fresh'&&fresh(row.canonical.observedAt,now)?row.canonical.performance?.attribution||null:null}));
  const verified=rows.filter(row=>Number.isFinite(row.attribution?.grossCashBasisPnlUsd));
  const total=verified.reduce((n,row)=>n+row.attribution.grossCashBasisPnlUsd,0),netKnown=verified.length===rows.length&&rows.length>0
    &&rows.every(row=>Number.isFinite(row.attribution.netAfterAllCostsUsd));
  const label=verified.length===1?(verified[0].pair||'LP')+' #'+verified[0].positionId:verified.length+' LPs';
  const brief={suggestion:verified.length?(total<0?'Fees and rewards have not covered the LP principal loss in these verified readings.':'Your verified LP result is positive before costs; check costs before treating it as a net gain.'):'Wait for the complete priced LP reading before treating the balance change as profit.',
    evidence:verified.length?label+': '+agentMoney(total)+' before costs, using original claim prices. '
      +verified.slice(0,2).map(row=>'#'+row.positionId+': principal '+agentMoney(row.attribution.principalPnlUsd)+', claimed '
        +agentMoney(row.attribution.claimedAtEventUsd)+', still to claim '+agentMoney(row.attribution.unclaimedNowUsd)+'.').join(' ')
      :'Original capital, event-price earnings or current LP coverage is missing.',
    tradeOff:netKnown?'Verified gas, swap and financing costs are included in the detailed net result.'
      :'Fully net profit remains unknown until transaction and financing costs are verified. These LP results are not whole-portfolio profit.',
    recheck:'A claim, deposit, withdrawal or verified cost changes the reading'+(context.lp?.ts?' · read '+agentReadingTime(context.lp.ts):'')+'.'};
  return {status:verified.length===rows.length&&netKnown?'ready':verified.length?'partial':'blocked',performance:{rows,verifiedCount:verified.length,totalCount:rows.length,
    grossCashBasisSubtotalUsd:verified.length?total:null,netAfterAllCostsUsd:netKnown?rows.reduce((n,row)=>n+row.attribution.netAfterAllCostsUsd,0):null,
    portfolioPnlUsd:null,portfolioFlowCoverage:'unverified'},brief};
}
export async function runInvestmentReview({store,context,focus='performance',pair,positionId,chain,scenarios,question='',origin,env={},fetcher=fetch,now=Date.now()}={}){
  const startedAt=Date.now(),clock=()=>now+Math.max(0,Date.now()-startedAt);
  const allowed=context.policy?.status==='confirmed'?context.policy.constraints?.allowedAnalysisTypes:null;
  const analysisType=['ranges','performance','evaluation'].includes(focus)?'lp':focus==='protocols'?'research':'portfolio';
  if(env.AGENT_INVESTMENT_ENABLED==='false'||focus!=='performance'&&env.AGENT_STRATEGY_ENABLED==='false')return {status:'blocked',mode:'investment_review',action:null,
    reply:'Investment comparisons are switched off. Your ordinary portfolio readings remain available.',sources:[]};
  if(Array.isArray(allowed)&&!allowed.includes(analysisType))return {status:'blocked',mode:'investment_review',action:null,
    reply:'Your saved analysis limits exclude this review.',sources:[]};
  if(positionId&&!chain&&(context.lp?.positions||[]).filter(row=>String(row.canonical?.positionId||row.canonical?.id)===positionId).length>1)
    return {status:'blocked',mode:'investment_review',action:null,reply:'I found that position number on more than one chain. Which chain do you mean?',sources:[]};
  if(origin&&focus==='performance'&&context.lp?.status==='fresh'){
    const selected=(context.lp.positions||[]).filter(row=>row.canonical?.performance?.attribution&&(!pair||lpPairKey(pair)===lpPairKey(row.pair))
      &&(!chain||row.canonical.chain===chain)&&(!positionId||String(row.canonical.positionId||row.canonical.id)===String(positionId))).slice(0,2);
    const evidence=await Promise.all(selected.map(async row=>{
      const p=row.canonical;try{return await readAgentJSON(origin+'/api/lpbook?'+new URLSearchParams({view:'cost-evidence',chain:p.chain,positionId:p.positionId||p.id}),
        {fetcher,timeoutMs:6000,maxBytes:24000,init:{redirect:'manual'}});}catch{return null;}}));
    context={...context,lp:{...context.lp,positions:context.lp.positions.map(row=>{const index=selected.indexOf(row),cost=evidence[index],p=row.canonical;
      if(index<0||cost?.schemaVersion!=='agent-cost-evidence-v1'||cost.chain!==p.chain||cost.positionId!==String(p.positionId||p.id)
        ||cost.owner?.toLowerCase()!==p.owner?.toLowerCase())return row;
      return {...row,canonical:{...p,performance:{...p.performance,attribution:{...p.performance.attribution,
        identifiedTransactionGasUsd:Number.isFinite(cost.gasUsd)?cost.gasUsd:null,costEvidence:cost}}}};})}};
  }
  let detail;
  if(focus==='stress'){
    if(scenarios?.invalid)return {status:'blocked',mode:'investment_review',action:null,
      reply:'I can’t apply every move in that scenario reliably. I support bounded percentage shocks for BTC, ETH, KAT, USDG, USDC, USDT and SOL, plus the avKAT/KAT oracle ratio.',sources:[]};
    context=await loadStressContext({context,origin,fetcher,now});
    const risk=await runAgentTool('getLendingRisk',{}, {context,policy:null,now});
    const stress=stressPortfolio({context,risk,scenarios,now});detail={status:stress.status,stress,brief:stress.brief};
  }else if(focus==='protocols'){
    if(origin&&env.AGENT_RESEARCH_ENABLED!=='false')context=await loadAgentSupplementalContext({origin,context,needs:['strategy'],fetcher,timeoutMs:6000});
    let protocolWatch=store?await checkProtocolWatch({store,context,fetcher,now,enabled:env.AGENT_RESEARCH_ENABLED!=='false'}):{status:'unavailable',sources:[],warnings:[]};
    const topics=[...new Set((question.match(/\b(?:morpho|sushi|merkl)\b/gi)||[]).map(v=>v.toLowerCase()))];
    const scopedPositions=(context.lp?.positions||[]).filter(row=>row.canonical&&(!chain||row.canonical.chain===chain)&&(!positionId||String(row.canonical.positionId||row.canonical.id)===positionId)
      &&(!pair||lpPairKey(pair)===lpPairKey(row.pair||row.canonical.pair))).map(row=>row.canonical),scopedPools=scopedPositions.map(p=>p.pool?.toLowerCase());
    const relevant=protocol=>topics.length?topics.some(topic=>protocol?.toLowerCase().includes(topic)):scopedPositions.some(p=>p.chain==='katana'&&/sushi|merkl/i.test(protocol));
    if(pair||chain||positionId||topics.length)protocolWatch={...protocolWatch,warnings:protocolWatch.warnings.filter(warning=>
      (!topics.length||relevant(warning.protocol))&&(!(pair||chain||positionId)||(warning.pool?scopedPools.includes(warning.pool.toLowerCase()):relevant(warning.protocol)))),
      sources:protocolWatch.sources.filter(source=>!topics.length||topics.some(topic=>source.protocol?.toLowerCase().includes(topic)))};
    const warning=protocolWatch.warnings[0],count=protocolWatch.sources.filter(row=>row.status==='fresh').length;
    detail={status:protocolWatch.status,protocolWatch,brief:{
      suggestion:warning?'Review the changed protocol/incentive evidence before relying on the same yield.':'Keep monitoring the configured official sources and incentives.',
      evidence:warning?warning.message:count+' of '+protocolWatch.sources.length+' official release feeds verified; no new notice was established in the available readings.',
      tradeOff:'Coverage includes configured releases and current campaigns. It does not establish all announcements, governance activity or a live deployment upgrade.',
      recheck:warning?warning.recheck:'A release, funded campaign, reward budget or source availability changes.'}};
  }else if(focus==='evaluation'){
    const page=store?await store.list('investment:evaluation:',{limit:10,reverse:true}):{items:[]};let evaluations=page.items.map(row=>row.value);
    if(store&&(pair||positionId||chain)){
      const keys=[...new Set(evaluations.map(row=>row.baselineId).filter(key=>typeof key==='string'&&key.startsWith('investment:baseline:')&&key.length<=300))],originals=keys.length?await readAgentState(store,keys):{};
      evaluations=evaluations.filter(row=>{const original=originals[row.baselineId],p=original?.position;
        return p&&original.identity===row.identity&&(!chain||p.chain===chain)&&(!positionId||String(p.positionId||p.id)===positionId)
          &&(!pair||lpPairKey(pair)===lpPairKey(p.pair||p.raw?.token0?.symbol+'/'+p.raw?.token1?.symbol));});
    }
    detail={status:evaluations.length?'partial':'collecting',evaluations,evaluationCoverage:{recentRecords:page.items.length,scoped:!!(pair||chain||positionId)},brief:{
      suggestion:evaluations.length?'Review the original decisions against these later readings.':'Keep collecting later observations before judging the recommendations.',
      evidence:evaluations.length?evaluations.length+' recorded evaluations are available; original bands and assumptions remain unchanged.'
        :'There is no later qualified evaluation yet. A new suggestion is saved before future quotes arrive.',
      tradeOff:'Principal marks are measurable; alternative fees, financing and unexecuted costs remain estimates. No net winner or win rate is claimed.',
      recheck:'A later six-hour observation window arrives, the original position changes capital, or its policy changes.'}};
  }else if(focus==='ranges'){
    const owned=(context.lp?.positions||[]).filter(row=>row.canonical&&(!pair||lpPairKey(pair)===lpPairKey(row.pair||row.canonical.pair))&&(!chain||row.canonical.chain===chain)
      &&(!positionId||String(row.canonical.positionId||row.canonical.id)===positionId));
    const selected=[...owned].sort((a,b)=>Number(a.canonical.inRange!==false)-Number(b.canonical.inRange!==false)||(b.canonical.principalUsd||0)-(a.canonical.principalUsd||0)).slice(0,2),analyses=[];
    for(const row of selected){const p=row.canonical,args={positionId:String(p.positionId||p.id),chain:p.chain,owner:p.owner,analysisFocus:'balanced'};
      context=await loadLearnedLPContext({store,context,args,origin,fetcher,now,enabled:env.AGENT_LEARNING_ENABLED!=='false'});
      context=await loadLPAdviceContext({context,args,env,origin,fetcher});
      const calculation=await runAgentTool('analyzeLPRange',args,{context,now:clock()});analyses.push(calculation);
      const market=[...(context.strategy?.pools||[]),...(context.strategy?.fee_pools||[]),...(context.lpMarkets||[])].find(m=>(m.chain||'katana')===p.chain&&m.pool?.toLowerCase()===p.pool?.toLowerCase());
      if(store&&calculation.data?.frontier?.options?.length)await recordInvestmentDecision({store,position:p,market:{...market,chain:p.chain},
        frontier:calculation.data.frontier,policyVersion:context.policy?.version||0,now:clock()});
    }
    const frontier=analyses.find(row=>row.data?.frontier?.brief)?.data.frontier;
    detail={status:frontier?(frontier.status==='ready'&&analyses.every(row=>row.status==='ready'&&row.data?.frontier?.status==='ready')?'ready':'partial'):'blocked',rangeAnalyses:analyses,rangeCoverage:{reviewed:selected.length,total:owned.length},brief:frontier?.brief?{...frontier.brief,
      evidence:frontier.brief.evidence+' Reviewed '+selected.length+' of '+owned.length+' owned LPs; full background tracking continues separately.'}:{
      suggestion:'Wait for a complete LP/pool reading before choosing a new band.',evidence:'Capital, units, price history or owned pool identity could not be verified.',
      tradeOff:'A narrow band can stop earning quickly; missing costs cannot be treated as free.',recheck:'The current LP and pool readings recover.'}};
  }else detail=performanceReview(context,{pair,positionId,chain,now});
  const report={schemaVersion:'agent-investment-v1',focus,createdAt:new Date(now).toISOString(),snapshotId:context.snapshot?.snapshotId||null,
    policyVersion:context.policy?.version||0,sources:context.sources||[],...detail};
  const validTimes=focus==='ranges'?(detail.rangeAnalyses||[]).filter(row=>row.status!=='blocked').map(row=>Date.parse(row.validUntil))
    :focus==='performance'?(detail.performance?.rows||[]).filter(row=>row.attribution).map(row=>Date.parse(row.attribution.observedAt||context.lp.ts)+90000)
    :focus==='stress'?(detail.stress?.cases||[]).flatMap(row=>[...row.rows,...row.loans].map(value=>Date.parse(value.sourceTime)+90000)):[];
  report.validUntil=validTimes.length&&validTimes.every(Number.isFinite)?new Date(Math.min(...validTimes)).toISOString():null;
  report.reportId='investment:report:'+hash(report);
  if(store)await store.putImmutable(report.reportId,report);
  return {status:report.status,mode:'investment_review',action:null,reply:renderInvestmentAnswer(report,{question}),result:report,sources:report.sources,
    snapshotId:report.snapshotId,policyVersion:report.policyVersion};
}
