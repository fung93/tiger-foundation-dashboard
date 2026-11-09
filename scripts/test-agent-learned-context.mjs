/* Closed, synthetic cross-chain cases and shared private memory. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { poolKey,positionKey } from '../api/_agent-auto-observations.mjs';
import { loadLearnedLPContext } from '../api/_agent-learned-context.mjs';
import { runAgentTool,renderAgentToolResult } from '../api/_agent-tools.mjs';
import { priceAtTick,tickAtPrice,snapRange,liquidityForCapital } from '../strategy-core.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { buildReviewAnalysis } from '../api/_agent-review-analysis.mjs';
let count=0;const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);count++;};
const now=Date.now()+86400000,stamp=at=>new Date(at).toISOString(),a=n=>'0x'+String(n).repeat(40);
function fixture(){
  const pool={schemaVersion:'agent-pool-observation-v1',chain:'robinhood',pool:a(3),kind:'fees',status:'fresh',observedAt:stamp(now),block:123,
    token0:{address:a(4),symbol:'USDG',decimals:18,usd:1},token1:{address:a(5),symbol:'WETH',decimals:18,usd:2000},
    baseIndex:1,base:'WETH',quote:'USDG',price:2000,sqrtPrice:Math.sqrt(1/2000),tickSpacing:10,fee:3000,
    activeLiquidity:1e24,feeGrowth0:'0',feeGrowth1:'0',recent:{}};
  pool.tick=Math.floor(tickAtPrice(2000,pool));
  const range=snapRange(1800,2200,pool),L=liquidityForCapital(1000,range.tickLower,range.tickUpper,pool).liquidity;
  const position={id:'99',positionId:'99',chain:'robinhood',contract:a(2),owner:a(1),pool:pool.pool,protocol:'Uniswap V3',pair:'WETH / USDG',
    status:'observed',observedAt:stamp(now),principalUsd:1000,feesMine:true,staked:false,
    raw:{liquidity:String(Math.round(L)),lowerTick:range.tickLower,upperTick:range.tickUpper,token0:pool.token0,token1:pool.token1}};
  const lo=Math.floor(tickAtPrice(2300,pool)),hi=Math.ceil(tickAtPrice(1700,pool));
  const growth=1n<<100n,history={samplingIntervalMinutes:5,hours:Array.from({length:721},(_,i)=>({
    hour:Math.floor(now/3600000)-720+i,firstAt:stamp(now-(720-i)*3600000),lastAt:stamp(now-(720-i)*3600000),count:12,maxGapMs:300000,
    low:lo,high:hi,feeGrowth0:(growth*BigInt(i)).toString(),feeGrowth1:'0',block:i}))};
  pool.feeGrowth0=(growth*720n).toString();
  const context={asOf:stamp(now),sources:[{name:'lp',status:'fresh',ts:stamp(now)}],snapshot:{snapshotId:'test',assets:[],liabilities:[],allocationBlocked:true},
    lp:{status:'fresh',ts:stamp(now),positions:[{canonical:position,pair:position.pair}],cards:{open:1}},lending:{markets:[]}};
  return {pool,position,history,context};
}
const sql=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:sql.db},{now:()=>now});
try{
  const f=fixture();let calls=[];
  await store.set(poolKey(f.position),{history:f.history,learning:{0:{policyVersion:0,completedProposals:3,observations:72,outsideObservations:30}}});
  const fetcher=async url=>{const query=new URL(url).searchParams;calls.push({url,view:query.get('view')});
    if(['agent-pool','agent-liquidity'].includes(query.get('view')))return Response.json(f.pool);
    if(query.get('view')==='lp-funding')return Response.json({schemaVersion:'agent-lp-funding-v1',chain:'robinhood',owner:f.position.owner,
      observedAt:stamp(now),priceObservedAt:stamp(now),block:123,gasUnits:100000,gasPriceWei:'1000000000',nativePriceUsd:2000,gasUsd:.2});
    throw Error('Unexpected outbound');};
  let context=await loadLearnedLPContext({store,context:f.context,args:{pair:'USDG/ETH'},origin:'https://fixture.test',fetcher,now});
  check(calls.length,2,'One detected pool uses two fixed first-party reads and no MCP request');
  check(context.lpMarkets[0].chain,'robinhood','A Robinhood reading never becomes a Katana source');
  check(context.lpMarkets[0].fees.usd_per_day>0,true,'A covered modulo fee-growth interval supports a scoped fee scenario');
  let result=await runAgentTool('analyzeLPRange',{pair:'USDG/ETH'},{context,now});
  check(result.status,'ready','The actual requested fee-paying pool is analysable');
  check(result.data.chain,'robinhood','Chain identity reaches the final calculation');
  check(Math.abs(result.data.price-2000)<1e-8,true,'Stable token0 is inverted into USDG per ETH');
  check(result.data.learning.applied,true,'Qualified same-pool evidence reaches chat analysis');
  check(result.data.preferredDays,30,'Earlier containment failures change the on-demand comparison');
  check(result.data.startingPoint.days,30,'The learned lookback affects the selected candidate');
  check(result.data.windows.every(row=>row.historyBasis==='sampled_pool_quotes'&&row.swaps===null),true,'Sampled quotes never become fabricated swap extrema/counts');
  check(Number.isFinite(result.data.feeAdvice.current.feeUsdPerDay),true,'Owner earnings use the actual owned liquidity share');
  check(result.data.incomeGoal,undefined,'Fee-paying Robinhood is not assigned a Katana KAT campaign');
  const text=renderAgentToolResult(result);check(text.includes('WETH/USDG on robinhood'),true,'The reply names the actual pool and chain');
  check(text.includes('Memory:'),true,'The reason for a changed comparison is visible');
  check(text.includes('24-hour fee-growth'),true,'The fee estimate discloses its measurement basis');
  check(result.data.feeAdvice.reset.costEstimateUsd>0,true,'A reset includes gas, actual pool fee and an explicit slippage allowance');
  const noOwnerFees=structuredClone(context);noOwnerFees.lp.positions[0].canonical.feesMine=false;
  const routed=await runAgentTool('analyzeLPRange',{pair:'USDG/ETH'},{context:noOwnerFees,now});
  check(routed.data.feeAdvice.current,null,'Fees routed away from the owner cannot become a projected owner earning');
  check(renderAgentToolResult(routed).includes('fee routing'),true,'Unknown or non-owner fee routing remains explicit');
  const scenario=await runAgentTool('analyzeLPRange',{pair:'ETH/USDG',analysisFocus:'market',priceCase:{symbol:'ETH',changePct:-20}},{context,now});
  check(scenario.data.feeAdvice.priceCase.inRange,false,'An ETH move tests the actual fee-paying LP boundaries');
  check(renderAgentToolResult(scenario).includes('stops earning new trading fees'),true,'Range-exit advice distinguishes trading fees from KAT rewards');
  check(scenario.data.feeAdvice.priceCase.principalUsd<=scenario.data.feeAdvice.priceCase.holdingUsd,true,'The same-current-token benchmark includes IL once');
  const cold=await loadLearnedLPContext({store,context:f.context,args:{pair:'ETH/USDG'},origin:'https://fixture.test',fetcher,now,enabled:false});
  const pending=await runAgentTool('analyzeLPRange',{pair:'ETH/USDG'},{context:cold,now});
  check(pending.status,'partial','A cold pool still explains its current range without inventing history');
  check(pending.data.windows.length,0,'Disabling learning cannot silently reuse private history');
  await store.set(poolKey(f.position),{history:{...f.history,hours:f.history.hours.slice(-25).map(row=>({...row,low:f.pool.tick-10,high:f.pool.tick+10}))}});
  const early=await loadLearnedLPContext({store,context:f.context,args:{pair:'ETH/USDG'},origin:'https://fixture.test',fetcher,now});
  const earlyResult=await runAgentTool('analyzeLPRange',{pair:'ETH/USDG'},{context:early,now});
  check(earlyResult.data.startingPoint.days,1,'A covered first day supports an explicitly early comparison');
  check(earlyResult.data.startingPoint.provisional,true,'Short evidence cannot masquerade as a mature 14-day band');
  check(earlyResult.data.startingPoint.tickLower<=f.position.raw.lowerTick&&earlyResult.data.startingPoint.tickUpper>=f.position.raw.upperTick,true,
    'Early observed quiet prices cannot silently tighten the owned range');
  check(renderAgentToolResult(earlyResult).includes('longer history is still building'),true,'The maturity limit is explained in the concise reply');
  const stale=await loadLearnedLPContext({store,context:f.context,args:{pair:'ETH/USDG'},origin:'https://fixture.test',now,
    fetcher:async()=>Response.json({...f.pool,observedAt:stamp(now-100000)})});
  check(stale.lpMarkets,undefined,'An old saved quote cannot be relabelled live');
  const policy={status:'confirmed',version:0,constraints:{allowedAnalysisTypes:['lp'],eligibleProtocols:['Sushi V3']}};
  result=await runAgentTool('analyzeLPRange',{pair:'ETH/USDG'},{context,policy,now});
  check(result.data.startingPoint,null,'Protocol restrictions survive cross-chain support');
  await store.set(positionKey(f.position),{policyVersion:0,range:{status:'owner_declined'}});
  const declined=await loadLearnedLPContext({store,context:f.context,args:{pair:'USDG/ETH'},origin:'https://fixture.test',fetcher,now});
  result=await runAgentTool('analyzeLPRange',{pair:'ETH/USDG'},{context:declined,now});
  check(result.data.startingPoint,null,'Earlier owner rejection suppresses another numeric suggestion under the same policy');
  const disabledDeclined=await loadLearnedLPContext({store,context:f.context,args:{pair:'USDG/ETH'},origin:'https://fixture.test',fetcher,now,enabled:false});
  check(disabledDeclined.lpLearning['robinhood:'+f.position.pool].ownerDeclined,true,'Turning off lesson adaptation does not revoke an explicit owner rejection');
  const before=calls.length;
  await loadLearnedLPContext({store,context:{...f.context,policy:{status:'confirmed',constraints:{allowedAnalysisTypes:['lending']}}},args:{pair:'ETH/USDG'},origin:'https://fixture.test',fetcher,now});
  check(calls.length,before,'Excluded analysis does not call providers');
  const analysis=await buildReviewAnalysis({context,policy:{version:0,status:'confirmed',constraints:{allowedAnalysisTypes:['lp']}},plans:[],now});
  check(analysis.candidates.some(row=>row.label.includes('USDG')),true,'A recurring strategy review includes the Robinhood LP');
  const withMemory=await buildReviewAnalysis({context:{...context,portfolioLearning:{lessons:[{id:'lesson:test',kind:'kat',key:'trade-book',message:'An older recorded result.',
    suggestion:'Review exposure.',priority:30,sourceTimes:[stamp(now-86400000)],provenance:'verified_observations'}]}},
    policy:{version:0,status:'confirmed',constraints:{}},plans:[],now});
  check(withMemory.lessons.length,0,'Pre-existing portfolio memory is not fabricated as a later outcome of a journal decision');
  check(withMemory.portfolioLessons.length,1,'Dated general memory remains inspectable separately in a review');
  const answer=await processAgentMessage({store,message:'What have you learned from my portfolio?',source:'telegram',requestId:'learning-on-telegram',
    context:{sources:[]},env:{AGENT_ORIGIN:'https://fixture.test'}});
  check(answer.mode,'learning','Dashboard and Telegram use the same deterministic memory route');
  check(answer.reply.includes('starting your portfolio memory'),true,'A first-use question does not pretend historical lessons exist');
  const replay=await processAgentMessage({store,message:'What have you learned from my portfolio?',source:'telegram',requestId:'learning-on-telegram',context:{sources:[]},env:{AGENT_ORIGIN:'https://fixture.test'}});
  check(replay.reply,answer.reply,'The same private request reference reuses its result');
  console.log('Shared learning and cross-chain fee LPs: '+count+' assertions passed.');
}finally{sql.close();}
