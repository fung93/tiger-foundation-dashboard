/* Known mathematical cases for sampled market risk and prospective range memory. */
import assert from 'node:assert/strict';
import { positionMarket,updatePoolHistory,lpRisk,rangeCandidates,chooseAutomaticRange,observedFeeRate,renderPositionSuggestion } from '../api/_agent-auto-analysis.mjs';
import { qualifiedRangeOutcome,mergeRangeOutcome } from '../api/_agent-auto-learning.mjs';
import { poolKey,positionKey,recordPoolObservation } from '../api/_agent-auto-observations.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { automaticCadence } from '../api/_agent-auto-state.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const now=Date.now()+86400000,stamp=at=>new Date(at).toISOString(),address=n=>'0x'+String(n).repeat(40);
for(const positions of [0,1,2,10,30]){
  const plan=automaticCadence({positions,closed:100,claims:100});
  check(plan.scheduledStepsPerDay+5*plan.estimatedSteps+64+200<=3000,true,'Full observations leave Free step headroom for manual checks, reviews and recovery');
  check(plan.intervalMinutes%5,0,'The observation cadence stays aligned with the independent five-minute Cron');
}
const p={chain:'katana',pool:address(3),owner:address(1),contract:address(2),id:'1',positionId:'1',status:'observed',observedAt:stamp(now),protocol:'Sushi V3',
  raw:{lowerTick:-1000,upperTick:1000,token0:{address:address(4),symbol:'TOKEN',decimals:0},token1:{address:address(5),symbol:'USDC',decimals:0}}};
const market={chain:'katana',pool:p.pool,ts:stamp(now),status:'fresh',price:1,sqrtPrice:1,tick:0,tickSpacing:10,activeLiquidity:1000,
  baseIndex:0,base:'TOKEN',quote:'USDC',token0:{...p.raw.token0,usd:1},token1:{...p.raw.token1,usd:1},recent:{}};
let history={};
for(let i=0;i<=8;i++){const at=now-(8-i)*300000,price=i%2?1.04:1;history=updatePoolHistory(history,{...market,ts:stamp(at),price,tick:Math.round(Math.log(price)/Math.log(1.0001))},at);}
const before=JSON.stringify(history);const risk=lpRisk(p,market,history,now);
check(risk.signals.some(signal=>signal.kind==='volatility'),true,'Oscillating prices are risky even when the endpoint price is unchanged');
check(risk.priceMovePct,0,'The price-move figure does not confuse oscillation with net direction');
check(JSON.stringify(history),before,'Risk analysis never rewrites the original price samples');
check(updatePoolHistory(history,{...market,price:5},now),history,'The same source timestamp cannot create another observation');
check(lpRisk(p,{...market,ts:stamp(now-100000)},history,now).status,'unavailable','Old quotes cannot create fresh risk advice');
check(lpRisk(p,{...market,tick:999},history,now).signals.some(signal=>signal.kind==='near_edge'),true,'The exclusive upper edge is monitored before crossing it');
check(lpRisk(p,{...market,tick:1000},history,now).inRange,false,'The exact upper tick is outside a V3 range');
check(lpRisk(p,{...market,tick:-1000},history,now).inRange,true,'The exact lower tick remains inside a V3 range');
const gappy={samples:[...history.samples.slice(0,2),history.samples.at(-1)],hours:history.hours};
check(lpRisk(p,market,gappy,now).volatilityPct,null,'Gaps cannot masquerade as a verified low-volatility interval');
const known={...market,recent:{7:{complete:true,lowTick:-100,highTick:100,swaps:100},14:{complete:true,lowTick:-300,highTick:300,swaps:200},30:{complete:true,lowTick:-600,highTick:600,swaps:400}}};
check(positionMarket(p,{...known,ratesObservedAt:stamp(now-100000),katPerDay:100},now).katPerDay,null,
  'A fresh market quote never renews an old incentive reading');
check(rangeCandidates(known,{},now).length,3,'Verified history produces bounded deterministic comparison bands');
check(rangeCandidates({...known,recent:{7:{...known.recent[7],swaps:0}}},{},now).length,0,'An empty swap window cannot establish a numeric historical band');
let selection=chooseAutomaticRange({position:p,market:known,history:{},risk:{status:'steady'},policy:{version:0},now});
check(selection.selected.days,14,'Normal automatic operation uses a labelled default, without a policy form');
check(selection.basis,'observational_defaults','Automatic assumptions never pretend to be owner-confirmed preferences');
selection=chooseAutomaticRange({position:p,market:known,history:{},risk:{status:'watch'},policy:{version:0},now});
check(selection.selected.tickLower<=p.raw.lowerTick&&selection.selected.tickUpper>=p.raw.upperTick,true,'A risk-driven band comparison does not silently narrow the current range');
const hours=Array.from({length:25},(_,index)=>({hour:Math.floor(now/3600000)-24+index,firstAt:stamp(now-(24-index)*3600000),lastAt:stamp(now-(24-index)*3600000),
  count:index===24?1:12,maxGapMs:300000,low:-10,high:10,feeGrowth0:((1n<<256n)-(1n<<127n)).toString(),feeGrowth1:'0',block:index}));
selection=chooseAutomaticRange({position:p,market,history:{hours},risk:{status:'steady'},policy:{version:0},now});
check(selection.provisional,true,'Early sampled history is visibly provisional');
check(selection.selected.tickLower<=p.raw.lowerTick&&selection.selected.tickUpper>=p.raw.upperTick,true,'A provisional comparison retains at least the current band width');
const fee=observedFeeRate({hours},{...market,feeGrowth0:(1n<<127n).toString(),feeGrowth1:'0'});
check(Math.abs(fee.usd_per_day-1000)<1e-8,true,'The observed fee window uses modulo-256 fee growth and correct token units');
check(fee.basis.includes('assumed constant'),true,'The liquidity assumption is retained with the fee estimate');
const badHours=structuredClone(hours);badHours[10].maxGapMs=3600000;
check(observedFeeRate({hours:badHours},{...market,feeGrowth0:'1',feeGrowth1:'0'}),null,'Missing fee-window readings cannot generate projected earnings');
check(renderPositionSuggestion({position:p,market:{...market,quote:'ETH',quoteUsd:2000},risk:{status:'steady',signals:[]},range:{selected:{lowerPrice:.01,upperPrice:.02,days:14}}}).includes('$0.01'),false,'Non-dollar pool units are not falsely printed as USD');

const fixture=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:fixture.db},{now:()=>now});
const cohort=day=>({id:'proposal-'+day,day:'2026-10-'+String(day).padStart(2,'0'),policyVersion:0,createdAt:stamp(now-(10-day)*86400000),
  lastObservedAt:stamp(now-(10-day)*86400000+21600000),observations:72,outsideObservations:40,coveredMs:21600000,unobservedMs:0,
  shadowBands:[{days:14,observations:72,outsideObservations:40}],gaps:0});
try{
  for(const day of [1,2,3]){const position={...p,id:String(day),positionId:String(day)},key=positionKey(position),proposal=cohort(day);
    await store.set(key,{position,pendingOutcomes:[proposal]});await mergeRangeOutcome(store,position,key,proposal,0,{now});
    check((await store.get(key)).pendingOutcomes.length,0,'An assessed proposal is atomically removed from its pending queue');
  }
  let memory=(await store.get(poolKey(p))).learning[0];
  check(memory.completedProposals,3,'Earlier closed/replaced NFT proposals contribute to the same pool’s later reviews');
  const again=cohort(3),key=positionKey({...p,id:'3',positionId:'3'});
  await mergeRangeOutcome(store,p,key,again,0,{now});
  check((await store.get(poolKey(p))).learning[0].observations,memory.observations,'Retries cannot count the same outcome twice');
  const sameDay={...cohort(3),id:'different-wallet-same-day',owner:address(9)};
  await store.set(positionKey(p),{position:p,pendingOutcomes:[sameDay]});await mergeRangeOutcome(store,p,positionKey(p),sameDay,0,{now});
  check((await store.get(poolKey(p))).learning[0].completedProposals,3,'Two wallets on one day do not become two independent test days');
  await recordPoolObservation(store,p,known,0,{now});memory=(await store.get(poolKey(p))).learning[0];
  check(memory.completedProposals,3,'Refreshing a market quote preserves its learned evidence');
  selection=chooseAutomaticRange({position:p,market:known,history:{},risk:{status:'steady'},lessons:memory,policy:{version:0},now});
  check(selection.learningApplied,true,'Sufficient later containment evidence changes a subsequent range comparison');
  check(selection.selected.days,30,'Earlier missed sampled prices lead to a longer-history comparison');
  const gap=cohort(4);gap.unobservedMs=21600000;
  check(qualifiedRangeOutcome(gap),null,'Unobserved hours cannot be converted into successful range outcomes');
  check(await store.get('policy:current'),null,'Learning updates no owner risk policy');
  check(await store.get(poolKey({...p,pool:address(8)})),null,'Evidence remains scoped to its own pool and cannot contaminate another market');
  console.log('Automatic LP risk and prospective learning: '+count+' assertions passed.');
}finally{fixture.close();}
