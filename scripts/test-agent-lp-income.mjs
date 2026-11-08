/* Goal math, latest-message intent, data gaps and cross-channel persistence.
   No real model, chain, bot or private account is contacted. */
import assert from 'node:assert/strict';
import { incomeContext } from './fixtures/agent-lp-income.mjs';
import { requestedLPDailyRewardGoal,isLPIncomeQuestion } from '../api/_agent-lp-income.mjs';
import { runAgentTool,renderAgentToolResult } from '../api/_agent-tools.mjs';
import { respondAgent } from '../api/_agent-brain.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { getSettings } from '../api/_agent-settings.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { liquidityForCapital,priceAtTick,estimateReward } from '../strategy-core.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const close=(a,b,n)=>check(Math.abs(a-b)<=Math.max(1e-7,Math.abs(b)*1e-7),true,n);
const question='what is the suitable LP range for katana vbUSDC/WBTC to earn $10 worth of KAT daily?';
for(const [text,expected]of [[question,10],['Can my BTC/USDC LP earn $10/day?',10],['I want daily KAT rewards of USD 10',10],
  ['Target $1,000 in KAT per day for BTC/USDC',1000],['Earn 10 USD worth of KAT daily',10],['Daily KAT income target is $2.50',2.5],
  ['What range for BTC/USDC?',null],['KAT price is $0.01 and I want $10/day from this LP',10],
  ['I currently earn $10/day in this LP',null],['What if someone says "$10/day"?',null]])
  check(requestedLPDailyRewardGoal(text)?.usdPerDay??null,expected,'Only an explicit daily reward goal is parsed: '+text);
for(const text of ['Could this LP earn $10 or $20 daily?','Aim for $10–20/day in KAT','Target $0/day','Earn $10/day or $20/day from my LP'])
  check(!!requestedLPDailyRewardGoal(text)?.error,true,'Ambiguous or invalid goals require clarification');
check(isLPIncomeQuestion('Can my BTC/USDC LP earn $10/day?'),true,'An income question needs no range template');
check(isLPIncomeQuestion('Can my salary earn $10/day?'),false,'An unrelated cash question does not become an LP plan');
check(requestedLPDailyRewardGoal('Can my BTC/USDC LP make $10/day net profit?').kind,'net_target','Net-profit goals cannot be silently treated as gross rewards');
check(requestedLPDailyRewardGoal('What LP range earns $10 profit daily?').kind,'net_target','A profit label before the daily unit still receives explicit profit scope');
check(requestedLPDailyRewardGoal('LP daily net profit target is $10').kind,'net_target','A leading daily profit label cannot bypass scope checks');

const at=Date.now(),context=incomeContext(at),p=context.lp.positions[0].canonical,pool=context.strategy.pools[0];
const call=(c=context,args={pair:'USDC/WBTC',dailyRewardTargetUsd:10},policy)=>runAgentTool('analyzeLPRange',args,{context:c,policy,now:at});
const original=JSON.stringify(context),result=await call(),g=result.data.incomeGoal;
check(result.status,'ready','A reconciled current LP supports a conditional income-goal calculation');
check(g.status,'ready','Goal availability stays separate from goal feasibility');
check(g.targetUsdPerDay,10,'The owner’s dollar-per-day target is retained');
check(g.targetKatPerDay,1000,'KAT/day uses the observed KAT/USD quote');
close(g.capitalUsd,500,'Capital is detected from raw LP liquidity at the pool quote');
close(g.current.usdPerDay,1,'Current rewards use the actual existing share rather than adding the owner twice');
check(g.otherEligibleLiquidity,pool.eligible.liquidity-Number(p.raw.liquidity),'Repositioning removes existing eligible owner liquidity first');
check(g.observation.rawOwnerLiquidity,p.raw.liquidity,'The private result retains the raw owner liquidity used for the calculation');
check(g.observation.katPerDay,pool.katPerDay,'The original emission rate is retained without reverse-engineering rounded dollars');
check(g.historicalChoice,null,'A historical band below target is not presented as meeting it');
check(g.targetOnlyRange.reachesTarget,true,'A bounded usable-tick search can find a target-only comparison');
check(g.targetOnlyRange.coversPreferredHistory,false,'The narrow income band cannot masquerade as historical coverage');
check(g.targetOnlyRange.tickLower%pool.tickSpacing===0&&g.targetOnlyRange.tickUpper%pool.tickSpacing===0,true,'The target band uses valid pool ticks');
check(g.capitalRequiredForPreferredUsd>g.capitalUsd,true,'Required capital is a calculated scenario rather than an invented deposit');
const counterfactual={...pool,eligible:{...pool.eligible,liquidity:g.otherEligibleLiquidity,amount0:0,amount1:0}};
const verification=estimateReward(counterfactual,{capitalUsd:g.capitalRequiredForPreferredUsd,lowerPrice:g.preferred.lowerPrice,upperPrice:g.preferred.upperPrice},
  {now:at/1000,katUsd:context.strategy.kat_usd,rewardStart:pool.campaign.start,rewardEnd:pool.campaign.end});
check(verification.usdPerDay>=10,true,'The required-capital result is verified by the existing Strategy reward engine');
const smaller=estimateReward(counterfactual,{capitalUsd:g.capitalRequiredForPreferredUsd-.01,lowerPrice:g.preferred.lowerPrice,upperPrice:g.preferred.upperPrice},
  {now:at/1000,katUsd:context.strategy.kat_usd,rewardStart:pool.campaign.start,rewardEnd:pool.campaign.end});
check(smaller.usdPerDay<10,true,'Required capital is rounded up to the smallest sufficient cent');
check(result.data.profitRankingAvailable,false,'A gross reward goal cannot create a net-profit ranking');
check(result.data.capitalAllocationVerified,false,'The rate calculation does not claim spare cash or an allocation mandate');
check(JSON.stringify(context),original,'No balance, original LP, campaign or risk policy is mutated');
const reply=renderAgentToolResult(result);
check(reply.includes('$10.00/day'),true,'The answer leads with the actual earning goal');
check(reply.includes('target-only band')&&reply.includes('misses part'),true,'A tight target band carries its measured coverage trade-off');
check(reply.includes('before transaction and borrowing costs'),true,'Gross KAT income is not misrepresented as net profit');
check(reply.includes('14-day history:'),false,'The goal answer replaces the old long history enumeration');
check(reply.length<1700,true,'Advice stays short');
check(reply.includes('calc:')||reply.includes('snapshot:')||reply.includes('policy v'),false,'Internal evidence remains outside the reply');

const low=await call(context,{pair:'BTC/USDC',dailyRewardTargetUsd:.1});
check(low.data.incomeGoal.historicalChoice.days,30,'When the goal permits, the widest supported historical band is compared');
const already=await call(context,{pair:'BTC/USDC',dailyRewardTargetUsd:1});
check(already.data.incomeGoal.current.reachesTarget,true,'An already-met goal is recognized without proposing a forced range change');
const carried=incomeContext(at);carried.lp.positions[0].canonical.performance={earnedUsd:1000000,unclaimedTokens:{KAT:'100000000'}};
close((await call(carried)).data.incomeGoal.current.usdPerDay,1,'Accrued and carried rewards never inflate newly projected daily KAT income');
const budget=await call(incomeContext(at,{katPerDay:200}));
check(budget.data.incomeGoal.poolBudgetUsd,2,'The total campaign budget is checked before promising daily income');
check(budget.data.incomeGoal.targetOnlyRange,null,'A target above the entire pool budget cannot be reached with a narrower band');
check(budget.data.incomeGoal.capitalRequiredForPreferredUsd,null,'No finite capital requirement is invented above the campaign budget');
const equal=await call(incomeContext(at,{katPerDay:1000}));
check(equal.data.incomeGoal.targetOnlyRange,null,'The full budget is unattainable at finite capital when competing liquidity remains');
const solo=await call(incomeContext(at,{katPerDay:1000,othersMultiplier:0}));
check(solo.data.incomeGoal.current.reachesTarget,true,'A sole eligible position can receive the entire current budget');
const tiny=await call(incomeContext(at,{othersMultiplier:1e9}));
check(tiny.data.incomeGoal.targetOnlyRange,null,'Even the narrowest usable tick band can fail at the current capital');
check(renderAgentToolResult(tiny).includes('tightest usable band'),true,'Capital shortfall is explained directly');
const reverse=await call(incomeContext(at,{reverse:true}));
close(reverse.data.incomeGoal.current.usdPerDay,1,'Inverse on-chain token order preserves reward economics');
check(reverse.data.incomeGoal.targetOnlyRange.reachesTarget,true,'Tick-search orientation works for reversed tokens with different decimals');
const outside=incomeContext(at),op=outside.lp.positions[0].canonical,oq=outside.strategy.pools[0],spacing=oq.tickSpacing;
op.raw.lowerTick=Math.ceil(oq.tick/spacing)*spacing+spacing*10;op.raw.upperTick=op.raw.lowerTick+spacing*10;
op.raw.liquidity=String(Math.round(liquidityForCapital(500,op.raw.lowerTick,op.raw.upperTick,oq).liquidity));op.inRange=false;
const out=await call(outside);
check(out.data.incomeGoal.current.usdPerDay,0,'An out-of-range LP has zero current campaign reward under the verified scoring rule');
check(out.data.incomeGoal.otherEligibleLiquidity,oq.eligible.liquidity,'An out-of-range owner LP is never subtracted from eligible in-range competitors');
const depeg=incomeContext(at);depeg.strategy.pools[0].token0.usd*=.98;depeg.strategy.pools[0].token1.usd=.98;depeg.lp.positions[0].canonical.principalUsd=490;
const unpegged=await call(depeg);
check(renderAgentToolResult(unpegged).includes('vbUSDC–'),true,'A non-dollar quote retains explicit token units in target range prices');
close(unpegged.data.incomeGoal.current.usdPerDay,1,'The KAT dollar target is separate from the quote token’s changing USD value');
const early=incomeContext(at);early.strategy.pools[0].campaign.end=Math.floor(at/1000)+30;
const ends=await call(early);
check(ends.validUntil,new Date(early.strategy.pools[0].campaign.end*1000).toISOString(),'A cached earning estimate expires no later than its campaign');
check(renderAgentToolResult(ends).includes('less than one full day'),true,'A daily rate is not a promise of a full day after campaign expiry');
const noHistory=incomeContext(at);noHistory.strategy.pools[0].recent={};
check((await call(noHistory)).data.incomeGoal.current.usdPerDay,1,'A current reward calculation remains possible while history is missing');
check(renderAgentToolResult(await call(noHistory)).includes('history needed'),true,'Missing history is not reported as a tested historical failure');

for(const [reason,mutate]of [
  ['kat_price_unavailable',c=>{c.strategy.kat_usd=null;}],['kat_price_unavailable',c=>{c.strategy.ts=new Date(at-90000).toISOString();}],
  ['campaign_inactive',c=>{c.strategy.pools[0].campaign.end=Math.floor(at/1000)-1;}],
  ['reward_inputs_unavailable',c=>{c.strategy.pools[0].rules.weightToken0=100;}],
  ['reward_inputs_unavailable',c=>{c.strategy.pools[0].eligible.liquidity=null;}],
  ['staking_unverified',c=>{c.lp.positions[0].canonical.staked=false;}],
  ['liquidity_unavailable',c=>{c.lp.positions[0].canonical.raw.liquidity=null;}],
  ['valuation_mismatch',c=>{c.lp.positions[0].canonical.principalUsd*=2;}],
  ['eligible_liquidity_mismatch',c=>{c.strategy.pools[0].eligible.liquidity=1;}],
]){const c=incomeContext(at);mutate(c);const output=await call(c);
  check(output.data.incomeGoal.reason,reason,'Incomplete source data blocks income sizing: '+reason);
  check(output.data.incomeGoal.targetOnlyRange,undefined,'A rejected estimate leaves no hidden numeric target band');
}
const many=incomeContext(at);many.lp.positions.push({...many.lp.positions[0],canonical:{...many.lp.positions[0].canonical,id:'8102',positionId:'8102',owner:'0x'+'9'.repeat(40)}});
check((await call(many)).data.reason,'choose_position','Several owned LPs cannot silently become the first one for income sizing');
check((await call(many,{positionId:'8101',dailyRewardTargetUsd:10})).data.incomeGoal.status,'ready','An exact position resolves income sizing without a financial form');
const excluded=await call(context,undefined,{status:'confirmed',version:2,constraints:{eligibleProtocols:['Morpho']}});
check(excluded.data.incomeGoal.reason,'outside_policy','A goal cannot override saved protocol eligibility');
for(const target of [-1,0,Infinity,NaN,'10',1e10]){await assert.rejects(()=>call(context,{pair:'BTC/USDC',dailyRewardTargetUsd:target}),e=>e.status===400);count++;}

let calls=0;const base=incomeContext(Date.now());delete base.strategy;
const env={AGENT_ORIGIN:'https://income.fixture.test',AI:{run:async()=>{calls++;return {response:{tool:{name:'getLPPosition',args:{positionId:'8101',chain:'katana'}}}};}}};
const loader=async(_tool,c)=>({...c,strategy:incomeContext(Date.now()).strategy});
const answered=await respondAgent({message:question,context:base,env,loadToolContext:loader});
check(answered.toolResults[0].data.incomeGoal.targetUsdPerDay,10,'The exact owner question preserves $10 despite a legacy position-only model choice');
check(answered.reply.includes('$10.00/day'),true,'The answer directly addresses the target rather than only history');
check(calls,1,'No second prose or repair inference is needed');
check(answered.action,null,'A target is never a transaction or settings mutation');
const liar={...env,AI:{run:async()=>({response:{tool:{name:'analyzeLPRange',args:{pair:'ETH/USDC',dailyRewardTargetUsd:1000}}}})}};
check((await respondAgent({message:question,context:incomeContext(Date.now()),env:liar})).toolResults[0].data.incomeGoal.targetUsdPerDay,10,
  'The model cannot invent a different earning goal or requested pair');
check((await respondAgent({message:'Suitable range for BTC/USDC?',context:incomeContext(Date.now()),env:liar})).toolResults[0].data.incomeGoal,undefined,
  'A model-proposed income target is discarded when the owner never requested one');
const wrongPreference={...env,AI:{run:async()=>({response:{explanationId:'policy',preferenceChanges:[{key:'dailyEnabled',value:'true',evidence:question}]}})}};
const correctedGoal=await respondAgent({message:question,context:incomeContext(Date.now()),env:wrongPreference});
check(correctedGoal.toolResults[0].data.incomeGoal.targetUsdPerDay,10,'An earning goal cannot become a notification change through a wrong model selector');
check(correctedGoal.action,null,'Correcting the selector retains read-only authority');
const follow=await respondAgent({message:'weekly',messages:[{role:'user',content:question},{role:'assistant',content:answered.reply}],context:incomeContext(Date.now()),env:liar});
check(follow.toolResults[0].data.incomeGoal.targetUsdPerDay,10,'A short cadence follow-up can keep the prior explicit goal');
check(follow.toolResults[0].data.reviewFrequencyDays,7,'The new cadence remains an answer-only assumption');
check((await respondAgent({message:'Can my BTC/USDC LP earn $10 or $20 daily?',context:incomeContext(Date.now()),env:liar})).explanationId,
  'clarify_daily_reward_target','Ambiguous dollar targets are clarified instead of guessed');
check((await respondAgent({message:'Can my BTC/USDC LP make $10/day after gas costs?',context:incomeContext(Date.now()),env:liar})).explanationId,
  'lp_net_income_goal','An after-cost request receives its own clear scope rather than a gross-income recommendation');

const fixture=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:fixture.db});
const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real provider in goal tests');};
try{
  const settingsBefore=await getSettings(store);await store.set('settings',settingsBefore);
  const ask={store,message:question,requestId:'income:dashboard',source:'dashboard',env,loadContext:async()=>{const c=incomeContext(Date.now());delete c.strategy;return c;},
    loadSupplementalContext:async args=>({...args.context,strategy:incomeContext(Date.now()).strategy}),budgetFactory:()=>({reserve:async()=>({}),settle:async()=>{}})};
  const dashboard=await processAgentMessage(ask),telegram=await processAgentMessage({...ask,source:'telegram',requestId:'income:telegram'});
  check(dashboard.reply,telegram.reply,'Dashboard and Telegram render the same deterministic goal analysis');
  check(dashboard.result.data.incomeGoal.targetUsdPerDay,10,'The private service persists the original dollar target');
  const advice=await processAgentMessage({...ask,message:'Suggest a portfolio strategy for BTC/USDC LP to earn $10 of KAT daily',requestId:'income:advice',
    env:{...env,PORTFOLIO_REVIEWS:{create:async()=>{throw Error('The income goal must not become a generic review');}}}});
  check(advice.result.data.incomeGoal.targetUsdPerDay,10,'An advice-type income question takes priority over generic portfolio-review routing');
  const beforeRetry=calls;await processAgentMessage(ask);check(calls,beforeRetry,'A same-reference retry spends no second inference');
  check(await store.get('policy:current'),null,'No income target is silently saved as investment policy');
  check(await store.get('settings'),settingsBefore,'The advice preserves the existing notification settings');
}finally{fixture.close();globalThis.fetch=oldFetch;}
console.log('LP daily-income goal analysis: '+count+' assertions passed.');
