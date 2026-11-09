/* Prospective evidence uses local SQLite and hypothetical portfolio data only. */
import assert from 'node:assert/strict';
import {recordInvestmentDecision,markInvestmentDecision} from '../api/_agent-decision-evaluation.mjs';
import {createAgentSQLiteFixture} from './fixtures/agent-sqlite.mjs';
import {createAgentStore} from '../api/_agent-store.mjs';
import {autofillContext} from './fixtures/agent-lp-autofill.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};let now=Date.now()+1000;
const db=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:db.db},{now:()=>now});
try{
 const context=await autofillContext(now),position=context.lp.positions[0].canonical,market={...context.strategy.pools[0],chain:position.chain};
 position.performance={attribution:{capitalVersion:'capital-v1',grossCashBasisPnlUsd:1}};
 const frontier={options:[{id:'keep',tickLower:position.raw.lowerTick,tickUpper:position.raw.upperTick,liquidity:Number(position.raw.liquidity),costUsd:0}],
  brief:{suggestion:'Keep as the baseline.'},assumptions:['No future income is guaranteed.']};
 let result=await recordInvestmentDecision({store,position,market,frontier,now});
 check(result.status,'recorded','A qualified current suggestion records its original before later prices');
 const original=(await store.list('investment:baseline:')).items[0].value;
 check(original.options[0].id,'keep','Original options are retained');
 check((await store.list('investment:evaluation:')).items.length,0,'A first suggestion cannot evaluate itself');
 check((await recordInvestmentDecision({store,position,market,frontier,now})).status,'duplicate','Retries do not create new originals or marks');
 now+=120000;position.observedAt=new Date(now).toISOString();market.ts=position.observedAt;
 position.performance.attribution.grossCashBasisPnlUsd=2;
 result=await recordInvestmentDecision({store,position,market,frontier,now});
 check(result.evaluation.status,'observed','A later qualified quote marks the original');
 check(result.evaluation.winner,null,'Principal marks cannot declare a net investment winner');
 check(result.evaluation.marks[0].feeIncomeUsd,null,'Unobserved alternative fees are never zero');
 check(result.evaluation.observedCashBasisWealthChangeUsd,1,'Observed same-position wealth changes remain distinct from strategy returns');
 check((await store.get(original.id)).position.performance.attribution.grossCashBasisPnlUsd,1,'Later readings cannot rewrite the baseline');
 check((await recordInvestmentDecision({store,position,market,frontier,now})).status,'duplicate','Repeated reads in one evaluation window are deduplicated');
 check(markInvestmentDecision(original,{position,market,policyVersion:1,now}).status,'earlier_policy','Policy changes do not judge an old decision under new limits');
 const changed=structuredClone(position);changed.performance.attribution.capitalVersion='capital-v2';
 check(markInvestmentDecision(original,{position:changed,market,policyVersion:0,now}).status,'capital_changed','A deposit or claim-flow version change ends comparability');
 check(markInvestmentDecision(original,{position:{...position,owner:'0x'+'a'.repeat(40)},market,policyVersion:0,now}).status,'unavailable','Another owner cannot supply the benchmark');
 check(markInvestmentDecision(original,{position,market:{...market,chain:'arc'},policyVersion:0,now}).status,'unavailable','A cross-chain price cannot mark the position');
 check(markInvestmentDecision(original,{position:{...position,pool:'0x'+'b'.repeat(40)},market,policyVersion:0,now}).status,'unavailable','A contradictory current pool cannot mark the old decision');
 check(markInvestmentDecision(original,{position:{...position,raw:{...position.raw,lowerTick:position.raw.lowerTick+10}},market,policyVersion:0,now}).status,'capital_changed','Changed current geometry cannot be treated as the unchanged original LP');
 check(markInvestmentDecision(original,{position,market:{...market,ts:original.createdAt},policyVersion:0,now}).status,'unavailable','Cached original prices cannot become later evidence');
 now+=21600000;position.observedAt=new Date(now).toISOString();market.ts=position.observedAt;
 check((await recordInvestmentDecision({store,position,market,frontier,now})).evaluation.status,'observed','The next six-hour window adds new evidence');
 await store.set('settings',{pausedUntil:new Date(now+3600000).toISOString()});
 check((await recordInvestmentDecision({store,position,market,frontier,now})).status,'paused_or_superseded','Paused monitoring stops new decision writes');
 check(await store.get('policy:current'),null,'Evaluation never creates investment policy or Lending settings');
 console.log('Prospective investment decision evaluation: '+n+' assertions passed.');
}finally{db.close();}
