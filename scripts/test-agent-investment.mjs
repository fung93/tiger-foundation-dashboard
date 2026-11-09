/* Private, deterministic owner reviews across both channels. All sources fake. */
import assert from 'node:assert/strict';
import {performanceReview,investmentQuestion,runInvestmentReview} from '../api/_agent-investment.mjs';
import {processAgentMessage} from '../api/_agent-service.mjs';
import {createAgentStore} from '../api/_agent-store.mjs';
import {createAgentSQLiteFixture} from './fixtures/agent-sqlite.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};const now=Date.now()+1000,ts=new Date(now).toISOString(),a=k=>'0x'+String(k).repeat(40);
const attribution={schemaVersion:'agent-attribution-v1',grossCashBasisPnlUsd:-37,principalPnlUsd:-50,claimedAtEventUsd:10,unclaimedNowUsd:3,netAfterAllCostsUsd:null};
const context={asOf:ts,sources:[{name:'lp',status:'fresh',ts}],snapshot:{snapshotId:'fixture-snapshot'},lp:{status:'fresh',ts,
 positions:[{pair:'WETH / USDG',canonical:{positionId:'1',id:'1',chain:'robinhood',owner:a(1),observedAt:ts,performance:{attribution}}}]}};
check(investmentQuestion('Show my actual profit breakdown').focus,'performance','Actual performance has a direct verified route');
check(investmentQuestion('Suggest a range to earn $10 per day after costs'),null,'A future income goal is not mistaken for historical performance');
let report=performanceReview(context,{now});check(report.performance.grossCashBasisSubtotalUsd,-37,'Verified scope is a subtotal rather than complete portfolio profit');
check(report.performance.netAfterAllCostsUsd,null,'The concise review keeps unknown costs explicit');
check(performanceReview({...context,lp:{...context.lp,status:'stale'}},{now}).status,'blocked','Old LP data cannot generate a new performance amount');
const db=createAgentSQLiteFixture({usage:true}),store=createAgentStore({AGENT_DB:db.db},{now:()=>now});
const fetchOriginal=globalThis.fetch;let calls=0;globalThis.fetch=async url=>{calls++;check(new URL(url).searchParams.get('view'),'cost-evidence','Only the fixed first-party cost view is requested');
 return Response.json({schemaVersion:'agent-cost-evidence-v1',chain:'robinhood',positionId:'1',owner:a(1),complete:false,gasUsd:.2,receipts:[]});};
try{
 const answer=await runInvestmentReview({store,context,origin:'https://fixture.test'});check(!/^(Suggestion|Why|Trade-off|Recheck when):/m.test(answer.reply),true,'The owner gets an ordinary-language answer without fixed headings');
 check(answer.reply.includes('before transaction and borrowing costs')&&answer.reply.includes('complete cost history'),true,'A partial result cannot become fully net profit');
 check(answer.result.performance.rows[0].attribution.identifiedTransactionGasUsd,.2,'Identified gas evidence is retained separately');
 check((await store.get(answer.result.reportId)).performance.portfolioPnlUsd,null,'The immutable record retains its coverage gate');
 for(const source of ['dashboard','telegram']){
   const response=await processAgentMessage({store,source,message:'Show my actual profit breakdown',requestId:'attribution-'+source,context,env:{AGENT_ORIGIN:'https://fixture.test'}});
   check(response.mode,'investment_review','Both channels use one shared deterministic review');
   check(response.reply.length<1200&&!/^Suggestion:/m.test(response.reply),true,'Both channels retain concise conversational answers');
 }
 const before=calls;await processAgentMessage({store,source:'telegram',message:'Show my actual profit breakdown',requestId:'attribution-telegram',context,env:{AGENT_ORIGIN:'https://fixture.test'}});
 check(calls,before,'A duplicate question reference repeats no receipt read');
 check((await db.db.prepare('SELECT COUNT(*) AS n FROM agent_usage').bind().first()).n,0,'Verified performance needs no paid or free inference');
 console.log('Private investment reviews: '+n+' assertions passed.');
}finally{globalThis.fetch=fetchOriginal;db.close();}
