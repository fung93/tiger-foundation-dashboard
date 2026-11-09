/* Real deterministic LP judgment with hypothetical market data. Tests include
   independent inventory/share checks, data gaps, private state and follow-ups. */
import assert from 'node:assert/strict';
import { incomeContext,incomeSources } from './fixtures/agent-lp-income.mjs';
import { requestedLPAdviceFocus,requestedLPPriceCase,requestedLPRewardFloor } from '../api/_agent-lp-advice.mjs';
import { runAgentTool,renderAgentToolResult } from '../api/_agent-tools.mjs';
import { loadAgentContext,loadAgentSupplementalContext } from '../api/_agent-context.mjs';
import { loadLPAdviceContext } from '../api/_agent-lp-advice-context.mjs';
import { respondAgent } from '../api/_agent-brain.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { liquidityForCapital,snapRange,amountsPerLiquidity,estimateReward } from '../strategy-core.mjs';
import { usdAtTick } from '../kat-core.mjs';
let count=0;
const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;},near=(a,b,n)=>check(Math.abs(a-b)<=Math.max(1e-7,Math.abs(b)*1e-7),true,n);
const at=Date.parse('2026-11-08T10:00:00Z'),stamp=new Date(at).toISOString();
function fixture(reverse=false){
  const c=incomeContext(at,{reverse,katPerDay:930000}),p=c.lp.positions[0].canonical,q=c.strategy.pools[0];
  const range=snapRange(98000,110000,q),liquidity=Math.round(liquidityForCapital(500,range.tickLower,range.tickUpper,q).liquidity);
  Object.assign(p.raw,{lowerTick:range.tickLower,upperTick:range.tickUpper,liquidity:String(liquidity)});
  q.eligible.liquidity=liquidity*1000;
  c.lp.positions[0].rewardPace={start:at/1000-43200,end:at/1000,hours:12,katEarned:465,carryExcluded:true,source:'/api/lpbook'};
  c.lpAdviceFunding={schemaVersion:'agent-lp-funding-v1',chain:'katana',owner:p.owner,observedAt:stamp,priceObservedAt:stamp,
    gasUsd:6,gasUnits:2000000,gasPriceWei:'1000000000',nativePriceUsd:3000,block:1234};
  return c;
}
const args={pair:'USDC/WBTC',dailyRewardTargetUsd:10},call=(context=fixture(),extra={})=>runAgentTool('analyzeLPRange',{...args,...extra},{context,now:at});
for(const reverse of [false,true]){
  const c=fixture(reverse),before=JSON.stringify(c),r=await call(c),g=r.data.incomeGoal,a=r.data.advice;
  check(a.judgment,'keep_small_gap','A small live income shortfall does not automatically justify a reset');
  near(g.current.usdPerDay,9.3,'Current share uses owner liquidity once');
  near(a.recordedPace.katPerDay,930,'Recorded pace uses native earned tokens and the measured interval');
  near(a.shortfallUsdPerDay,.7,'The reward gap is a deterministic dollar calculation');
  near(a.currentShare,.001,'Existing campaign share is not confused with TVL or vote share');
  near(a.targetShare,10/9300,'The target share comes from the current pool reward budget');
  check(a.reset.tokens.find(row=>row.symbol==='vbWBTC').deltaUsd<0,true,'Recentering this asymmetric band requires selling BTC in either on-chain token order');
  near(a.reset.tokens.reduce((s,row)=>s+row.deltaUsd,0),0,'Indicative reset conserves capital at this quote');
  near(a.reset.swapUsd,a.reset.tokens.find(row=>row.symbol==='vbUSDC').deltaUsd,'Swap amount counts one side rather than both token legs');
  near(a.reset.poolFeeUsd,a.reset.swapUsd*.0005,'Swap fee uses this exact pool fee tier');
  near(a.reset.slippageCaseUsd,a.reset.swapUsd*.005,'The slippage allowance is an explicit case');
  near(a.reset.costEstimateUsd,6+a.reset.poolFeeUsd+a.reset.slippageCaseUsd,'Gas and swap costs are separate, without hidden zero assumptions');
  check(a.reset.capitalAfterCostsUsd<g.capitalUsd,true,'Paying costs reduces capital available for the replacement');
  const expected=estimateReward({...c.strategy.pools[0],eligible:{liquidity:g.otherEligibleLiquidity,amount0:0,amount1:0}},
    {capitalUsd:a.reset.capitalAfterCostsUsd,lowerPrice:a.candidate.lowerPrice,upperPrice:a.candidate.upperPrice},
    {now:at/1000,katUsd:g.katUsd,rewardStart:g.campaign.start,rewardEnd:g.campaign.end});
  near(a.reset.grossUsdPerDayAfterCosts,expected.usdPerDay,'After-cost deployment capital is repriced with the existing shared reward engine');
  near(a.reset.staticPaybackDays,a.reset.costEstimateUsd/(expected.usdPerDay-g.current.usdPerDay),'Cost recovery uses incremental rewards after costs reduce capital');
  check(a.candidate.reachesTarget,true,'The target-only candidate can meet the gross spot goal');
  check(a.candidate.coversPreferredHistory,false,'A target-only band still carries its actual history gap');
  const reply=renderAgentToolResult(structuredClone(r));
  const enhanced=structuredClone(r);enhanced.data.frontier={status:'ready',reply:'Suggestion: Compare several longer-horizon paths.'};
  check(renderAgentToolResult(enhanced),reply,'A ready multi-path comparison cannot replace the answer to the owner’s specific daily reward goal');
  check(reply.includes('small income gap')&&reply.includes('sell about'),true,'The concise judgment connects the small benefit to the actual token mix');
  check(reply.includes('target-only band')&&reply.includes('misses part'),true,'Serialization cannot lose the candidate’s target-only label');
  check(reply.includes('Recorded pace:')&&reply.includes('including any time out of range'),true,'Recorded Merkl pace is not passed off as the current in-range rate');
  check(reply.length<2200,true,'The combined analysis remains a short summary');
  check(/support|analysts|sell.low|cost you before|guarantee/i.test(reply),false,'No unsupported analyst level, personal-loss story or guaranteed return is invented');
  check(JSON.stringify(c),before,'Judgment preserves all accounting, balances and policy inputs');
}
const floor=await call(fixture(),{analysisFocus:'reward_price',dailyRewardFloorUsd:7});
near(floor.data.advice.sensitivity.floorPriceUsd,7/930,'The owner’s floor is a reward break-even price, not technical support');
check(renderAgentToolResult(floor).includes('$7.00/day floor'),true,'A requested income floor receives a direct numeric explanation');
near(floor.data.advice.sensitivity.scenarios[0].usdPerDay,8.37,'A minus-ten-percent KAT case changes reward dollar value, not token count');
const katCase=await call(fixture(),{analysisFocus:'reward_price',priceCase:{symbol:'KAT',priceUsd:.008}});
near(katCase.data.advice.priceCase.usdPerDay,7.44,'A freely stated KAT price gets a deterministic custom scenario');
check(renderAgentToolResult(katCase).startsWith('At KAT $0.008'),true,'The response leads with the question’s chosen scenario');
const btcCase=await call(fixture(),{analysisFocus:'market',priceCase:{symbol:'BTC',changePct:-5}}),bc=btcCase.data.advice.priceCase;
check(bc.inRange,false,'A BTC fall below this actual LP floor is recognized');
near(bc.price,95000,'The base-price case uses the current pool quote');
const currentUnits=amountsPerLiquidity(fixture().lp.positions[0].canonical.raw.lowerTick,fixture().lp.positions[0].canonical.raw.upperTick,
  fixture().strategy.pools[0].sqrtPrice,8,6),liquidity=Number(fixture().lp.positions[0].canonical.raw.liquidity);
near(bc.holdingUsd,liquidity*(currentUnits.amount0*95000+currentUnits.amount1),'Holding keeps the same current tokens at the scenario price');
check(bc.principalUsd<=bc.holdingUsd+.001,true,'The falling-price principal-versus-holding comparison has the expected V3 convexity loss');
check(renderAgentToolResult(btcCase).includes('stops earning KAT'),true,'The answer explains the scenario’s immediate reward consequence');

for(const mutate of [c=>{c.lpAdviceFunding=null;},c=>{c.lpAdviceFunding.owner='0x'+'9'.repeat(40);},c=>{c.lpAdviceFunding.gasUsd=0;},
  c=>{c.lpAdviceFunding.observedAt=new Date(at-90000).toISOString();}]){
  const c=fixture();mutate(c);const r=await call(c);
  check(r.data.advice.reset.costEstimateUsd,null,'Missing, mismatched, inconsistent or stale gas cannot become a free reset');
  check(r.data.advice.reset.staticPaybackDays,null,'Unknown costs cannot produce a payback claim');
}
for(const mutate of [p=>{p.hours=1;},p=>{p.carryExcluded=false;},p=>{p.katEarned=-1;},p=>{p.end-=3600;}]){
  const c=fixture();mutate(c.lp.positions[0].rewardPace);check((await call(c)).data.advice.recordedPace,null,'Invalid/too-short/unverified intervals cannot become a native daily pace');
}
const gap=fixture();gap.strategy.pools[0].eligible.liquidity=null;
const incomplete=await call(gap);
check(incomplete.data.incomeGoal.status,'unavailable','Recorded payouts cannot invent current eligible liquidity');
check(incomplete.data.advice.recordedPace.katPerDay,930,'A verified recorded pace still makes an incomplete answer useful');
check(renderAgentToolResult(incomplete).includes('Recorded recently:')&&renderAgentToolResult(incomplete).includes('cannot price a new band'),true,'The fallback explains exactly what can and cannot be inferred');
const reference=fixture();reference.katanaMCP={status:'ready',gauges:[{pool:reference.strategy.pools[0].pool,katPerDay:0,votes:0,observedAt:stamp,raw:'Index says zero'}]};
const referenced=await call(reference);
check(referenced.data.advice.mcpComparison.campaignRateDiffers,true,'MCP disagreement is retained as evidence');
near(referenced.data.incomeGoal.current.usdPerDay,9.3,'An indexed zero cannot erase a chain/Merkl-verified active campaign');
const market=fixture();market.kat={market:{observedAt:stamp,currentUsd:.01,priorUsd:.011,change24hPct:-100/11}};
check(!!(await call(market)).data.advice.market.kat,true,'Fresh consistent KAT market observations can support a dated trend');
market.kat.market.currentUsd=.02;check((await call(market)).data.advice.market.kat,null,'Inconsistent KAT quotes cannot support a misleading trend');

// Exercise the actual first-party adapters, not only constructed tool objects.
const samples=incomeSources(at);
samples.lp.live[0].apr_detail={available:true,complete:true,start_ts:at/1000-43200,end_ts:at/1000,
  elapsed_hours:12,earned_usd:4.65,earned_tokens:{'KAT@katana':465}};
const sourceFetcher=async url=>Response.json(new URL(url).pathname==='/api/lpbook'?samples.lp
  :new URL(url).pathname==='/history.json'?{data:[]} : {});
const adapted=await loadAgentContext({origin:'https://advice.fixture.test',fetcher:sourceFetcher,now:at});
check(adapted.lp.positions[0].rewardPace.katEarned,465,'The live adapter consumes actual native token deltas instead of parsing APR dollar text');
check(adapted.lp.positions[0].rewardPace.carryExcluded,true,'The adapter identifies the original carry-adjusted APR basis');
const katSample={at:at/1000,head:1234,head_ts:at/1000,price_usd:usdAtTick(100000)*.9,health:{notes:[]},
  hours:[[Math.floor(at/1000/3600)*3600-86400,100000]],trades:[],waiting:[],start:{block:1,ts:at/1000-86400},wallet_kat:0};
const katContext=await loadAgentSupplementalContext({origin:'https://advice.fixture.test',needs:['kat'],now:at,fetcher:async()=>Response.json(katSample)});
near(katContext.kat.market.change24hPct,-10,'The market adapter derives approximately 24-hour change from the recorded closing tick');
katSample.hours=[];
check((await loadAgentSupplementalContext({origin:'https://advice.fixture.test',needs:['kat'],now:at,
  fetcher:async()=>Response.json(katSample)})).kat.market,null,'Missing prior market data never becomes a fabricated zero-percent trend');

const question='Suggest a range for katana USDC/WBTC to earn $10 of KAT daily';
let inference=0;
const env={AGENT_ORIGIN:'https://advice.fixture.test',AI:{run:async()=>{inference++;return {response:{tool:{name:'getPortfolioSnapshot',args:{}}}};}}};
const c=fixture();c.asOf=new Date().toISOString();c.lp.ts=c.asOf;c.lp.positions[0].canonical.observedAt=c.asOf;c.strategy.ts=c.asOf;c.strategy.pools[0].ts=c.asOf;
const history=[{role:'user',content:question}];
for(const [text,focus,target]of [['Is resetting worth it?','reset',10],['What if KAT drops 10%?','reward_price',10],['What if BTC drops 5%?','market',10],
  ['Why that range?','balanced',10],['What about $12/day?',null,12],['My floor is $7/day','reward_price',10]]){
  const answer=await respondAgent({message:text,messages:history,context:c,env});
  check(answer.toolResults[0].data.incomeGoal.targetUsdPerDay,target,'Natural follow-up retains or explicitly changes the goal: '+text);
  if(focus)check(answer.toolResults[0].data.advice.focus,focus,'The answer focuses on the actual question');
  check(answer.action,null,'Follow-up analysis has no wallet or settings authority');
}
check(inference,6,'Each question uses one selector, with no prose repair loop');
const shorthand=await respondAgent({message:'Based on current market situation, suggest a USDC/WBTC pool range to earn $10 worth of KAT?',context:c,env});
check(shorthand.toolResults[0].data.incomeGoal.targetUsdPerDay,10,'The owner’s shorthand income question does not lose its dollar target');
check(shorthand.reply.startsWith('Assuming you mean $10.00/day'),true,'An omitted period becomes an explicit daily scenario, never an undisclosed assumption');
const chained=await respondAgent({message:'What if BTC drops 5%?',messages:[...history,{role:'user',content:'weekly'},
  {role:'user',content:'Is resetting worth it?'},{role:'user',content:'What about $12/day?'},{role:'user',content:'My floor is $7/day'},
  {role:'user',content:'What if KAT drops 10%?'}],context:c,env});
check(chained.toolResults[0].data.incomeGoal.targetUsdPerDay,12,'Several contextual follow-ups retain the most recent owner goal');
check(chained.toolResults[0].data.advice.sensitivity.floorUsdPerDay,7,'A conversation floor can be recalled without changing saved strategy policy');
check(chained.toolResults[0].data.reviewFrequencyDays,7,'The requested scenario cadence survives related follow-ups');
const otherTopic=await respondAgent({message:'What if KAT drops for my loan health?',messages:history,context:c,env});
check(otherTopic.toolResults[0].toolName,'getPortfolioSnapshot','A loan question cannot inherit an unrelated LP goal and force LP analysis');
check(requestedLPPriceCase('What if KAT at $0.0033?'),{symbol:'KAT',priceUsd:.0033},'A native-language price case needs no form');
check(requestedLPPriceCase('KAT drops 5% or 10%'),null,'Ambiguous price cases cannot become a guessed financial scenario');
check(requestedLPRewardFloor('my floor is $7'),7,'An explicit dollar floor is independently parsed');
check(requestedLPAdviceFocus('Should I reset my LP?'),'reset','An advice question routes without the word range');
const fakeTarget={...env,AI:{run:async()=>({response:{tool:{name:'analyzeLPRange',
  args:{pair:'BTC/USDC',dailyRewardFloorUsd:99,priceCase:{symbol:'KAT',priceUsd:99}}}}})}};
const noInvent=await respondAgent({message:question,context:c,env:fakeTarget});
check(noInvent.toolResults[0].data.advice.sensitivity.floorUsdPerDay,null,'The model cannot invent an owner income floor');
check(noInvent.toolResults[0].data.advice.priceCase,undefined,'The model cannot invent a price scenario');

const sqlite=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:sqlite.db});
const beforeFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real provider in advice tests');};
try{
  const setup={store,message:question,requestId:'advice:dashboard',env,source:'dashboard',context:c,
    loadSupplementalContext:async({context})=>context,budgetFactory:()=>({reserve:async()=>({}),settle:async()=>{}})};
  const dashboard=await processAgentMessage(setup),telegram=await processAgentMessage({...setup,requestId:'advice:telegram',source:'telegram'});
  check(dashboard.reply,telegram.reply,'Both chat channels use the same judgment and calculations');
  const calls=inference;await processAgentMessage(setup);check(inference,calls,'Same-reference retry reuses the answer without another inference');
  check(await store.get('policy:current'),null,'Follow-up goals/floors never become saved strategy policy');
}finally{sqlite.close();globalThis.fetch=beforeFetch;}

let reads=[];
const loaded=await loadLPAdviceContext({context:c,args,env:{AGENT_KATANA_MCP_ENABLED:'true'},origin:env.AGENT_ORIGIN,
  loadSupplementalContext:async({needs,context})=>{reads.push(...needs);return context;},
  readMCP:async()=>({status:'unavailable',checkedAt:new Date().toISOString(),errorCategory:'http_403'}),
  fetcher:async url=>{reads.push(new URL(url).pathname);return Response.json({});}});
check(reads.includes('/api/strategy'),true,'Funding is detected automatically for the actual owner');
check(loaded.katanaMCP.status,'unavailable','An MCP outage is independent of current financial readers');
check(loaded.strategy,c.strategy,'MCP failure does not overwrite verified campaign data');
check(loaded.sources.find(row=>row.name==='katana-mcp').status,'unavailable','A failed resource is never called fresh');
reads=[];await loadLPAdviceContext({context:c,args:{pair:'BTC/USDC',owner:'0x'+'f'.repeat(40)},origin:env.AGENT_ORIGIN,
  loadSupplementalContext:async({context})=>context,readMCP:async()=>({status:'disabled'}),fetcher:async()=>{reads.push(1);throw Error();}});
check(reads.length,0,'A model-only owner address cannot cause a funding read');
for(const priceCase of [{symbol:'KAT',priceUsd:-1},{symbol:'BTC',changePct:-100},{symbol:'KAT',priceUsd:1,changePct:10},{symbol:'SOL',changePct:10}]){
  await assert.rejects(()=>call(fixture(),{priceCase}),e=>e.status===400);count++;
}
console.log('Flexible LP advice: '+count+' assertions passed.');
