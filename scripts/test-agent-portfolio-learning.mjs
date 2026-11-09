/* Synthetic prospective observations; no model, chain, bot or live account. */
import assert from 'node:assert/strict';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { portfolioLearningObservation,derivePortfolioLessons,recordPortfolioLearning,loadPortfolioLearning,renderPortfolioLearning,isPortfolioLearningQuestion,LEARNING_KEY } from '../api/_agent-portfolio-learning.mjs';
import { runAgentTool,renderAgentToolResult } from '../api/_agent-tools.mjs';
let count=0;const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);count++;};
let now=Date.now()+86400000;const stamp=()=>new Date(now).toISOString(),a=n=>'0x'+String(n).repeat(40);
const fixture=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:fixture.db},{now:()=>now});
function context(health=1.3){const p={chain:'robinhood',contract:a(2),owner:a(1),id:'12',positionId:'12',pool:a(3),pair:'WETH / USDG',
  status:'observed',observedAt:stamp(),principalUsd:1000,inRange:true,raw:{liquidity:'100',lowerTick:-100,upperTick:100},
  performance:{complete:true,costUsd:1100,netUsd:-70,earnedUsd:30,unclaimedUsd:5}};
  return {asOf:stamp(),lp:{status:'fresh',ts:stamp(),cards:{open:1},positions:[{canonical:p,pair:p.pair,comparison:{available:true,difference_usd:-20}}]},
    lending:{status:'fresh',markets:[{key:'avkat-kat',label:'avKAT / KAT',status:'fresh',ts:stamp(),health,ltv:.6,debt_amount:100,debt_usd:1,loan_token:'KAT',raw:{debt:'100',collateral:'200'}}]},
    kat:{status:'fresh',ts:stamp(),price_usd:.004,historyCoverage:{complete:true},summary:{realized:20,unrealized:-10,fees:1}},
    tracking:{positions:[p],closed:[{chain:'katana',id:'1',contract:a(4),wallet_address:a(1),pool:a(5),pair:'BTC/USDC',closed:'2026-11-01T00:00:00Z',net_usd:-20,fee_usd:10,cost_usd:100,held_hours:24}]}};}
async function wallets(raw='100'){
  for(const chain of ['katana','robinhood','arc','solana'])await store.set('automation:wallet:'+chain,{chain,status:'fresh',observedAt:stamp(),balances:[{
    chain,owner:chain==='solana'?'synthetic-solana':a(1),address:chain==='solana'?null:a(6),symbol:'TEST',raw,decimals:2,amount:Number(raw)/100,
    valueUsd:Number(raw)/100,observedAt:stamp(),status:'observed'}]});
}
try{
  check(isPortfolioLearningQuestion('What have you learned from my portfolio?'),true,'Natural learning question needs no form');
  check(isPortfolioLearningQuestion('What is the suitable ETH/USDG LP range?'),false,'Ordinary range advice is not intercepted by portfolio memory');
  await wallets();let result=await recordPortfolioLearning(store,context(),0,{now});
  check(result.status,'recorded','The existing automatic controls require no new policy form');
  let state=await store.get(LEARNING_KEY);check(state.days.length,1,'The first successful cycle establishes one daily cohort');
  check(state.summary.lessons.some(row=>row.kind==='lp'&&row.message.includes('behind')),true,'LP versus holding uses the existing comparison');
  check(state.summary.lessons.some(row=>row.kind==='closed_lp'&&row.netUsd===-20),true,'Realised history stays distinct from current capital');
  check(state.summary.lessons.some(row=>row.kind==='kat'),true,'KAT trade-book results enter memory with their own scope');
  const originalKey='learning:day:'+state.days[0].day+':original',original=await store.get(originalKey);
  check((await recordPortfolioLearning(store,context(),0,{now})).status,'not_due','Immediate retries do not create another learned outcome');
  for(const health of [1.2,1.1]){now+=86400000;await wallets(String(health*1000));result=await recordPortfolioLearning(store,context(health),0,{now});}
  state=await store.get(LEARNING_KEY);check(state.days.length,3,'Different recorded days remain distinct cohorts');
  const loan=state.summary.lessons.find(row=>row.kind==='lending');
  check(loan.trend,'falling','Three later decreasing health observations inform subsequent review');
  check(loan.suggestion.includes('weakened'),true,'The learned trend changes the review suggestion without inventing a health target');
  check(state.summary.lessons.some(row=>row.kind==='holdings'&&row.suggestion.includes('not treat')),true,'Balance changes cannot become investment return');
  check(state.summary.returnsAvailable,false,'No cash-flow-adjusted portfolio return is invented');
  check(await store.get(originalKey),original,'Later outcomes never rewrite the original observation');
  check(await store.get('policy:current'),null,'Learning does not invent or modify owner strategy policy');
  const loaded=await loadPortfolioLearning(store,{now,policy:{version:2,status:'confirmed',constraints:{marketLimits:{'avkat-kat':{targetHealth:1.25}}}}});
  check(loaded.lessons.find(row=>row.kind==='lending').suggestion.includes('saved target'),true,'Current owner targets are checked independently of old memory');
  check(loaded.policyVersion,2,'A new policy does not relabel an old policy-dependent conclusion');
  const excluded=await loadPortfolioLearning(store,{now,policy:{version:3,status:'confirmed',constraints:{allowedAnalysisTypes:['lending']}}});
  check(excluded.lessons.every(row=>row.kind==='lending'),true,'Persistent policy exclusions apply to recorded lessons as well as live tools');
  const exposure=await runAgentTool('getKATExposure',{}, {context:{snapshot:{assets:[],liabilities:[],status:'partial',allocationBlocked:true},portfolioLearning:loaded},now});
  check(renderAgentToolResult(exposure).includes('KAT trade book'),true,'Ordinary KAT answers use the same dated trade-book lessons');
  check(exposure.data.verifiedGrossKat,0,'Past realised rewards or trade results are not added to current wallet exposure');
  now+=7200000;const stale=await loadPortfolioLearning(store,{now});check(stale.status,'stale','Stored readings retain their real age');
  check(renderPortfolioLearning(stale).startsWith('From my recorded'),true,'Historical lessons cannot masquerade as fresh readings');
  check((await recordPortfolioLearning(store,context(),0,{now,enabled:false})).status,'disabled','Rollback stops collection without deleting evidence');
  const broken=context();broken.lp.status='stale';broken.lending.markets[0].status='unavailable';broken.kat.historyCoverage.complete=false;
  const observation=portfolioLearningObservation({context:broken,now});
  check(observation.lps.length,0,'Retained positions are not new observations');check(observation.loans.length,0,'A failed loan is not zero debt');
  check(observation.kat,null,'Incomplete trade history cannot create a performance lesson');
  const noData=derivePortfolioLessons();check(noData.status,'collecting','An empty database honestly reports a baseline is needed');
  check(JSON.stringify(await store.get(LEARNING_KEY)).includes('raw_amounts_unavailable'),false,'Memory contains typed observations rather than untrusted instruction strings');
  console.log('Portfolio learning: '+count+' assertions passed.');
}finally{fixture.close();}
