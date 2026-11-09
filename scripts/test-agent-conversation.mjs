/* Natural questions use deterministic backend evidence. No real AI/provider. */
import assert from 'node:assert/strict';
import {investmentQuestion,investmentScope} from '../api/_agent-investment-intent.mjs';
import {renderInvestmentAnswer,renderInvestmentBrief} from '../agent-investment-brief.mjs';
import {respondAgent} from '../api/_agent-brain.mjs';
import {AGENT_OUTPUT_SCHEMA,AGENT_REVIEW_FOCUSES} from '../api/_agent-output-schema.mjs';
import {processAgentMessage} from '../api/_agent-service.mjs';
import {createAgentStore} from '../api/_agent-store.mjs';
import {createAgentSQLiteFixture} from './fixtures/agent-sqlite.mjs';
import {incomeContext} from './fixtures/agent-lp-income.mjs';
import {runInvestmentReview} from '../api/_agent-investment.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};
for(const [question,focus]of [['Am I actually making money on my LPs?','performance'],['Should I rebalance my LPs?','ranges'],
 ['What if Bitcoin crashes 20% across my portfolio?','stress'],['Have your recommendations helped?','evaluation'],['Are any of my incentive campaigns changing?','protocols']])
 check(investmentQuestion(question)?.focus,focus,'Normal owner wording routes '+focus+' without a form');
check(investmentQuestion('What if Bitcoin crashes 20% across my portfolio?').scenarios[0].shocks.BTC,-20,'The owner’s actual crash percentage is retained');
check(investmentQuestion('What if FABLES drops 20% across my portfolio?').scenarios.invalid,true,'An unsupported explicit move cannot silently become unrelated default cases');
check(investmentQuestion('What if BTC drops 20% and FABLES drops 30% across my portfolio?').scenarios.invalid,true,'A combined case cannot quietly omit one requested shock');
check(investmentQuestion('What range earns $10 of KAT per day?'),null,'Specific daily reward goals keep their existing specialized analysis');
check(investmentQuestion('Explain "Show my actual profit breakdown"'),null,'Quoted text cannot silently request a financial review');
check(investmentScope('Are fees covering losses on my position #42 on Katana?'),{positionId:'42',chain:'katana'},'Position and chain come from the owner message');
check(investmentScope('Should I rebalance that instead?',{messages:[{role:'user',content:'Compare my BTC/USDC LP on Katana'}]}),
 {pair:'BTC/USDC',chain:'katana'},'Related questions retain the last owner-requested pool');
const attr={principalPnlUsd:-50,claimedAtEventUsd:10,unclaimedNowUsd:3,divergenceUsd:-30,grossCashBasisPnlUsd:-37};
const report={focus:'performance',performance:{rows:[{pair:'ETH / USDG',positionId:'42',attribution:attr}],grossCashBasisSubtotalUsd:-37,totalCount:1,netAfterAllCostsUsd:null}};
let reply=renderInvestmentAnswer(report);check(reply.includes('$37.00'),true,'The conversational answer leads with the verified result');
check(reply.includes('complete cost history'),true,'Natural language keeps the material unknown costs visible');
check(!/^(Suggestion|Why|Trade-off|Recheck when):/m.test(reply),true,'No fixed report headings are mandatory');
reply=renderInvestmentAnswer(report,{question:'Have fees covered impermanent loss?'});
check(reply.includes('$13.00 earned versus $30.00 lost'),true,'A fees-versus-IL question answers that comparison, not a different principal-loss question');
check(reply.includes('tokens’ overall price move'),true,'IL is kept separate from the market price move');
check(renderInvestmentAnswer({...report,performance:{...report.performance,rows:[{...report.performance.rows[0],attribution:{...attr,divergenceUsd:null}}]}},
 {question:'Have fees covered IL?'}).includes('can’t isolate impermanent loss'),true,'An unavailable holding benchmark is not replaced by principal loss');
reply=renderInvestmentAnswer({focus:'evaluation',policyVersion:0,evaluations:[]});
check(reply.includes('building the track record'),true,'A cold start does not invent improved recommendations');
reply=renderInvestmentAnswer({focus:'protocols',protocolWatch:{status:'partial',warnings:[]}});
check(reply.includes('can’t confirm that nothing changed'),true,'Source failure is not rendered as clean news');
check(!renderInvestmentAnswer({focus:'stress',stress:{status:'partial',cases:[{shocks:{BTC:-20},rows:[],loans:[],verifiedChangeUsd:0}]}}).includes('$0'),true,'No verified assets cannot become a zero-loss scenario');
const brief={suggestion:'Keep reviewing the current range.',evidence:'Current data was checked.',tradeOff:'Future income remains conditional.',recheck:'Price approaches the boundary.'};
check(!/^Suggestion:/m.test(renderInvestmentBrief(brief)),true,'Automatic notices also use ordinary prose');
check(AGENT_OUTPUT_SCHEMA.oneOf.some(branch=>branch.properties?.review?.properties?.focus?.enum===AGENT_REVIEW_FOCUSES),true,'The AI has a closed read-only review selector');
for(const focus of AGENT_REVIEW_FOCUSES){let selected,settled=[];
 const response=await respondAgent({message:'Could you look into that for me?',context:{sources:[]},env:{AI:{run:async()=>({response:{review:{focus}},usage:{prompt_tokens:100,completion_tokens:8,total_tokens:108}})}},
  inference:{reserve:async()=>({id:'fixture'}),settle:async(_,outcome)=>settled.push(outcome)},
  runReview:async(name,args)=>{selected={name,args};return {reply:'The verified readings support this answer.',mode:'investment_review',status:'partial'};}});
 check(selected.name,focus,'The model can route unfamiliar wording to '+focus);
 check(response.mode,'investment_review','The closed selector delegates to backend evidence');
 check(settled[0].outcome,'succeeded','The single inference is settled before running the read-only review');
}
for(const review of [{focus:'transfer_tokens'},{focus:'stress',shocks:{BTC:-90}},{focus:'performance',wallet:'invented'}]){
 let invoked=false;await assert.rejects(()=>respondAgent({message:'Help me review',context:{sources:[]},env:{AI:{run:async()=>({response:{review}})}},runReview:async()=>{invoked=true;}}),e=>e.category==='invalid_model_output'||e.errorCategory==='invalid_model_output');n++;
 check(invoked,false,'A model cannot add identities, money assumptions or actions to a review');
}
const income=await respondAgent({message:'Can my BTC/USDC LP earn $10 of KAT per day?',context:incomeContext(Date.now()),
 env:{AI:{run:async()=>({response:{review:{focus:'ranges'}}})}},runReview:async()=>{throw Error('A specific income target must keep its own calculator');}});
check(income.toolResults[0].data.incomeGoal.targetUsdPerDay,10,'A broad model review cannot swallow an explicit owner daily-income goal');
const db=createAgentSQLiteFixture({usage:true}),now=Date.now(),ts=new Date(now).toISOString(),store=createAgentStore({AGENT_DB:db.db});
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Closed provider fixture');};
try{
 const context={asOf:ts,sources:[{name:'lp',status:'fresh',ts}],snapshot:{snapshotId:'fixture-conversation'},lp:{status:'fresh',ts,positions:[{pair:'ETH / USDG',canonical:{positionId:'42',chain:'robinhood',owner:'0x'+'1'.repeat(40),observedAt:ts,performance:{attribution:attr}}}]}};
 for(const source of ['dashboard','telegram']){
  const ai={run:async()=>({response:{review:{focus:'performance'}},usage:{prompt_tokens:100,completion_tokens:8,total_tokens:108}})};
  const answer=await processAgentMessage({store,source,context,message:'Does the yield offset the damage?',requestId:'natural-'+source,
   env:{AGENT_ORIGIN:'https://conversation.fixture.test',AI:ai,AGENT_DB:db.db}});
  check(answer.mode,'investment_review','Ordinary questions reach the new backend in '+source);
  check(answer.reply.includes('$37.00')&&!/^Suggestion:/m.test(answer.reply),true,'Both real service channels return the verified conversational result');
 }
 check(await store.get('policy:current'),null,'Natural analysis never creates policy or changes Lending settings');
 await store.set('settings',{dailyEnabled:true,alertsEnabled:true,dailyTime:'22:50'});
 for(const [source,message,value]of [['dashboard','Stop my weekly learning summary',false],['telegram','Send my weekly learning updates',true]]){
  const ai={run:async()=>({response:{explanationId:'policy',preferenceChanges:[{key:'weeklyEnabled',value:String(value),evidence:message}]},
    usage:{prompt_tokens:100,completion_tokens:12,total_tokens:112}})};
  const answer=await processAgentMessage({store,source,context,message,requestId:'weekly-preference-'+source,
    env:{AGENT_ORIGIN:'https://conversation.fixture.test',AI:ai,AGENT_DB:db.db}});
  check((await store.get('settings')).weeklyEnabled,value,'A weekly notification request reaches actual preference persistence in '+source);
  check(answer.reply.includes('Weekly learning summary'),true,'The acknowledgment names the weekly preference in ordinary language');
  check((await store.get('settings')).dailyEnabled&&(await store.get('settings')).alertsEnabled,true,'Changing weekly learning preserves daily reports and risk alerts');
 }
 for(const [id,pair]of [['one','BTC/USDC'],['two','ETH/USDG']]){
  const baselineId='investment:baseline:fixture-'+id,identity='fixture-'+id;
  await store.set(baselineId,{identity,position:{chain:'katana',positionId:id,pair}});
  await store.set('investment:evaluation:'+id,{identity,baselineId,status:'observed',policyVersion:0,marks:[]});
 }
 const scoped=await runInvestmentReview({store,context,focus:'evaluation',pair:'BTC/USDC',question:'Did your BTC/USDC recommendation help?'});
 check(scoped.result.evaluations.map(row=>row.identity),['fixture-one'],'A question about one pool cannot report another pool’s later decision evidence');
 console.log('Conversational backend investment analysis: '+n+' assertions passed.');
}finally{globalThis.fetch=originalFetch;db.close();}
