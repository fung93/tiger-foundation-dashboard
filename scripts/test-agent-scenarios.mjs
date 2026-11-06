/* Conditional calculations against shared core and hand-worked LP cases. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareAgentStrategies,validateAgentComparison,renderAgentStrategyResult } from '../api/_agent-scenarios.mjs';
import { loadAgentContext } from '../api/_agent-context.mjs';
import { targetMetrics } from '../morpho-core.mjs';
import { liquidityForCapital } from '../strategy-core.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createStrategyReport,persistAgentReport } from '../api/_agent-reports.mjs';
import { listAgentDecisions,observeAgentDecision } from '../api/_agent-decisions.mjs';
let count=0;
const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const near=(a,b,n)=>{assert.ok(Math.abs(a-b)<1e-7,n+': '+a+' vs '+b);count++;};
const clone=structuredClone;
const sample=JSON.parse(readFileSync(new URL('../morpho-history.json',import.meta.url))).samples.at(-1),now=sample.ts*1000+1000;
const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Scenario tests never contact external services');};
try{
  const context=await loadAgentContext({origin:'https://fixture.test',now,fetcher:async url=>new Response(JSON.stringify(
    new URL(url).pathname==='/api/morpho'?{...sample,full:true}:{}))});
  const row=context.lending.markets.find(r=>r.key==='avkat-kat');
  const input={kind:'lending',market:'avkat-kat',targetHealth:2,horizonDays:30,annualRatePct:0,cashUsd:100000,gasUsd:1,oracleMovesPct:[0,-10]};
  const result=await compareAgentStrategies({context,input,now}),maintain=result.options.find(o=>o.id==='maintain'),reduce=result.options.find(o=>o.id==='reduce_debt');
  check(reduce.repayRaw,targetMetrics(row,2).repay_raw,'Repayment is quoted by the actual shared integer core');
  check(maintain.outcomes[0].projectedDebtRaw,row.raw.debt,'An explicitly zero interest assumption preserves current debt');
  check(maintain.outcomes[0].oracleVariable,'avKAT/KAT ratio','The modeled variable is the oracle ratio, not a KAT dollar fall');
  check(maintain.outcomes[1].health<maintain.outcomes[0].health,true,'A ratio shock changes oracle health');
  const repriced=clone(context);
  for(const m of repriced.lending.markets)for(const k of ['loan_usd','collateral_price_usd','debt_usd','oracle_collateral_usd','collateral_usd','liquidation_usd','kat_price_usd'])if(Number.isFinite(m[k]))m[k]*=2;
  const common=await compareAgentStrategies({context:repriced,input,now});
  check(common.options.find(o=>o.id==='maintain').outcomes.map(o=>o.health),maintain.outcomes.map(o=>o.health),'A common USD repricing cannot change fixed avKAT/KAT oracle health');
  const charged=await compareAgentStrategies({context,input:{...input,annualRatePct:10},now});
  const debt=BigInt(row.raw.debt),expected=(debt*(36500n*1000000n+10000000n*30n)+36500n*1000000n-1n)/(36500n*1000000n);
  check(charged.options.find(o=>o.id==='maintain').outcomes[0].projectedDebtRaw,String(expected),'Projected debt rounds the explicit simple-rate assumption upward');
  check(charged.options.find(o=>o.id==='maintain').outcomes[0].health<maintain.outcomes[0].health,true,'Interest reduces future health');
  const extra=result.options.find(o=>o.id==='add_collateral'),newC=BigInt(extra.outcomes[0].collateralRaw),r=row.raw;
  check((newC*BigInt(r.oracle_price)/10n**36n*BigInt(r.lltv)/10n**18n)*10n**18n>=BigInt(r.debt)*2n*10n**18n,true,'Added collateral satisfies the double-floor protocol health target');
  const stale=clone(context);stale.lending.markets[0].status='stale';
  check((await compareAgentStrategies({context:stale,input,now})).status,'blocked','Stale debt prevents unsupported amount scenarios');
  check((await compareAgentStrategies({context,input:{...input,annualRatePct:null},now})).status,'blocked','Missing future rate is not silently zero');
  const lowCash=await compareAgentStrategies({context,input:{...input,cashUsd:0},now});
  check(lowCash.options.find(o=>o.id==='reduce_debt').status,'outside_policy','Insufficient cash does not become a feasible repayment strategy');
  const owner='0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',poolAddress='0x1111111111111111111111111111111111111111';
  const pool={pool:poolAddress,status:'fresh',ts:new Date(now-1000).toISOString(),kind:'rewards',
    token0:{address:'0x2222222222222222222222222222222222222222',symbol:'T0',decimals:18,usd:1},
    token1:{address:'0x3333333333333333333333333333333333333333',symbol:'T1',decimals:18,usd:1},
    tick:0,sqrtPrice:1,price:1,baseIndex:0,tickSpacing:10,fee:500,
    rules:{weightFees:10000,weightToken0:0,weightToken1:0,outOfRange:false},katPerDay:100,
    campaign:{start:now/1000-86400,end:now/1000+2*86400}};
  const liq=BigInt(Math.floor(liquidityForCapital(1000,-1000,1000,pool).liquidity));
  const L=Number(liq);pool.eligible={liquidity:L*10};pool.activeLiquidity=L*10;
  const position={id:'fixture',positionId:'fixture',chain:'katana',owner,pool:poolAddress,
    contract:'0x4444444444444444444444444444444444444444',status:'observed',observedAt:pool.ts,block:123,
    principalUsd:1000,feesMine:false,staked:true,inRange:true,
    raw:{liquidity:String(liq),lowerTick:-1000,upperTick:1000,token0:pool.token0,token1:pool.token1}};
  const lpContext={snapshot:{snapshotId:'portfolio:lp',status:'partial',allocationBlocked:true,assets:[]},
    lp:{status:'fresh',ts:pool.ts,positions:[{canonical:position}]},strategy:{pools:[pool],fee_pools:[]}};
  const lpInput={kind:'lp',positionId:'fixture',horizonDays:7,cashUsd:1000,gasUsd:1,swapFeeBps:5,slippageBps:10,borrowingCostUsd:0,
    widenFactor:2,lowerPrice:.9,upperPrice:1.1,rewardPriceUsd:2,rewardEligible:true,competingLiquidityMultiplier:1,useObservedRates:true,
    paths:[{label:'Flat',points:[{day:0,ratio:1},{day:7,ratio:1}]},{label:'Up20',points:[{day:0,ratio:1},{day:7,ratio:1.2}]}]};
  const lpResult=await compareAgentStrategies({context:lpContext,input:lpInput,now});
  const keep=lpResult.options.find(o=>o.id==='maintain').outcomes;
  near(keep[0].principalUsd,1000,'The original LP values back to the same starting capital on a flat path');
  near(keep[0].newRewardsKat,20,'Existing liquidity is counted once and rewards stop at the actual campaign end');
  near(keep[0].newFeesUsd,0,'Staked Sushi trading fees are excluded from owner earnings');
  near(keep[0].netUsd,2040,'Terminal wealth includes the same cash reserve and eligible new rewards');
  check(keep[1].timeInRangeDays<7,true,'An explicit path can leave the range');
  check(lpResult.options.find(o=>o.id==='hold').outcomes[0].netUsd,1999,'Holding closes the LP with its explicit gas cost');
  const moreCompetition=await compareAgentStrategies({context:lpContext,input:{...lpInput,competingLiquidityMultiplier:2},now});
  near(moreCompetition.options.find(o=>o.id==='maintain').outcomes[0].newRewardsKat,200/19,'Competing liquidity dilutes reward share without double counting the existing LP');
  const highCosts=await compareAgentStrategies({context:lpContext,input:{...lpInput,gasUsd:20},now});
  check(highCosts.options.find(o=>o.id==='reposition').outcomes[0].netUsd<lpResult.options.find(o=>o.id==='reposition').outcomes[0].netUsd,true,'Higher costs reduce projected net wealth');
  const noCost=await compareAgentStrategies({context:lpContext,input:{...lpInput,gasUsd:null},now});
  check(noCost.options.find(o=>o.id==='reposition').status,'blocked','Missing transaction costs block the affected LP option');
  const noRewards=await compareAgentStrategies({context:lpContext,input:{...lpInput,rewardPriceUsd:null},now});
  check(noRewards.options.find(o=>o.id==='maintain').outcomes[0].netUsd,null,'Missing reward-price assumptions do not become zero-valued net income');
  const ended=clone(lpContext);ended.strategy.pools[0].status='stale';
  check((await compareAgentStrategies({context:ended,input:lpInput,now})).status,'blocked','Stale campaign state cannot produce a current reward recommendation');
  const carry=clone(lpContext);carry.lp.positions[0].canonical.inheritedRewards=999999;
  near((await compareAgentStrategies({context:carry,input:lpInput,now})).options.find(o=>o.id==='maintain').outcomes[0].newRewardsKat,20,'Carried historical rewards never become projected newly earned income');
  check(lpResult.capitalBaseUsd,2000,'All options use the same principal plus cash base');
  const paperDb=createAgentSQLiteFixture();
  try{
    const store=createAgentStore({AGENT_DB:paperDb.db}),report=createStrategyReport({context:lpContext,policy:{version:0},result:lpResult,input:lpInput,now});
    await persistAgentReport(store,report,lpContext.snapshot);
    const decision=(await listAgentDecisions(store)).items[0],later=clone(lpContext);
    later.snapshot.snapshotId='portfolio:future-paper';later.strategy.pools[0].ts=new Date(now+1000).toISOString();
    const observation=await observeAgentDecision(store,decision.decisionId,later,{now:now+1000});
    check(observation.event.status,'partial','Prospective LP marks retain the actual missing-income limitation');
    const mark=observation.event.marks.find(mark=>mark.optionId==='maintain');
    near(mark.paperMarkBeforeEarningsUsd,2000,'Observed price marks do not pretend the projected KAT rewards were earned');
    near(observation.event.marks.find(mark=>mark.optionId==='hold').paperMarkBeforeEarningsUsd,1999,'Observed holding comparison preserves the original gas assumption and same cash base');
    check(!!(await store.get(observation.event.calculationId)),true,'A paper observation retains its deterministic calculation and original report reference');
    const repriced=clone(later);repriced.strategy.pools[0].token0.usd=1.2;repriced.strategy.pools[0].sqrtPrice=Math.sqrt(1.2);
    const next=await observeAgentDecision(store,decision.decisionId,repriced,{now:now+1000});
    check(next.event.calculationId!==observation.event.calculationId,true,'Distinct point-in-time pool quotes retain distinct paper observations');
    check(next.event.marks.find(mark=>mark.optionId==='maintain').differenceBeforeEarningsUsd<0,true,'An observed price move changes the LP-versus-original-holding paper comparison');
    repriced.strategy.pools[0].status='stale';
    check((await observeAgentDecision(store,decision.decisionId,repriced,{now:now+2000})).event.status,'blocked','Stale pool quotes cannot produce prospective paper marks');
  }finally{paperDb.close();}
  check(lpResult.scope.includes('probability'),true,'Conditional scenarios do not imply calibrated probabilities');
  check(renderAgentStrategyResult(lpResult).includes('not future facts'),true,'The owner sees rate assumptions alongside the results');
  const kat=await compareAgentStrategies({context,input:{kind:'kat',horizonDays:30,thesis:'Prospective thesis'},now});
  check(kat.status,'partial','Incomplete KAT coverage cannot authorize an allocation');
  check(kat.options[0].id,'maintain_review','Maintain and review remains available without pretending risk is safe');
  for(const change of [{horizonDays:0},{paths:[{label:'Bad',points:[{day:0,ratio:2},{day:7,ratio:3}]}]},{probability:.9},{gasUsd:-1}]){
    assert.throws(()=>validateAgentComparison({...lpInput,...change}),error=>error.status===400);count++;
  }
  console.log('Conditional agent strategy scenarios: '+count+' assertions passed.');
}finally{globalThis.fetch=oldFetch;}
