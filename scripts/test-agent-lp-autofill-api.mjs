/* Actual private action, SQLite persistence and fresh comparison preparation.
   Wallets, providers and every monetary input are closed synthetic fixtures. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { agentAction } from '../api/_agent-actions.mjs';
import { reviewPolicy } from './fixtures/agent-review.mjs';
import { autofillContext, fundingFixture } from './fixtures/agent-lp-autofill.mjs';

let count=0; const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const fixture=createAgentSQLiteFixture(),env={AGENT_DB:fixture.db,AGENT_ORIGIN:'https://lp-autofill.fixture.test'},store=createAgentStore(env);
let readings=0,fundingReads=0,closed=false,fundingFails=false,cash=150;
const outbound=[];
const options={env,store,loadContext:async ({needs})=>{readings++;check(needs,['strategy'],'Automatic preparation explicitly requests live pool data');
  const context=await autofillContext(Date.now());if(closed)context.lp.positions=[];return context;},
  fetcher:async url=>{const request=new URL(url);outbound.push(request);fundingReads++;
    if(fundingFails)throw Error('Fixture funding outage');
    check(request.origin,env.AGENT_ORIGIN,'Only the fixed first-party origin supplies live funding');
    check(request.searchParams.get('view'),'lp-funding','The request selects the bounded existing Strategy funding view');
    return Response.json(fundingFixture(request.searchParams.get('owner'),Date.now(),{cashUsd:cash}));}};
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real provider in LP API tests');};
try{
 await store.set('policy:current',reviewPolicy());
 const setup=await agentAction({action:'lpCompareSetup'},options);
 check(setup.status,'ready','The authenticated action detects a usable open LP');
 check(await store.get('messages'),null,'Prefilling a form cannot fabricate a chat or owner decision');
 const beforeCompare=readings;cash=175;
 const body={action:'compare',automaticLP:{positionKey:setup.position.key,overrides:{}},requestId:'auto-lp-api-fixture'};
 const answer=await agentAction(body,options);
 check(readings,beforeCompare+1,'Submitting refreshes current positions rather than trusting the older form reading');
 check(answer.report.comparisonInput.cashUsd,175,'The actual calculation uses refreshed wallet cash');
 check(answer.report.autofill.funding.cashUsd,175,'The immutable report retains funding provenance');
 check(answer.report.comparisonInput.owner,setup.position.owner,'The trusted identity includes the wallet');
 check(answer.report.result.comparisonBasis,'before_financing','The saved result retains the explicitly scoped financing basis');
 check(answer.reply.includes('before borrowing costs'),true,'Conversation text cannot present the auto case as after-financing performance');
 const decision=await store.list('journal:decision:');
 check(decision.items.length,1,'One automatic comparison produces one prospective journal entry');
 check(decision.items[0].value.options.length>1,true,'Real calculated alternatives reach the journal');
 const saved=await store.get(answer.report.reportId);
 check(saved.autofill.fieldSources.slippageBps.basis,'scenario','Saved provenance distinguishes estimated assumptions from observations');
 const beforeRetry=readings,fundingBeforeRetry=fundingReads;
 const retried=await agentAction(body,options);
 check(retried.report.reportId,answer.report.reportId,'A retry reuses the original dated report');
 check(readings,beforeRetry,'A completed retry does not repeat market reads');
 check(fundingReads,fundingBeforeRetry,'A completed retry does not repeat wallet reads');
 await assert.rejects(()=>agentAction({...body,automaticLP:{...body.automaticLP,overrides:{gasUsd:2}}},options),error=>error.status===409);count++;
 closed=true;const prior=await store.list('report:');
 await assert.rejects(()=>agentAction({...body,requestId:'closed-auto-lp'},options),error=>error.status===409);count++;
 check((await store.list('report:')).items.length,prior.items.length,'A closed LP cannot generate a fresh investment comparison');
 closed=false;fundingFails=true;
 const unknown=await agentAction({action:'lpCompareSetup'},options);
 check(unknown.inputs.cashUsd,null,'A provider outage leaves the form’s cash unknown');
 check(unknown.inputs.gasUsd,null,'A provider outage leaves the form’s gas unknown');
 const blocked=await agentAction({...body,requestId:'unknown-funding'},options);
 check(blocked.report.status,'blocked','Unknown funding cannot become a fully priced automatic comparison');
 check((await store.get('policy:current')).version,1,'Automatic setup never edits the owner’s policy');
 const readsBeforeInvalid=readings;
 await assert.rejects(()=>agentAction({action:'lpCompareSetup',automaticLP:{positionKey:'bad-url',overrides:{}}},options),error=>error.status===400);count++;
 check(readings,readsBeforeInvalid,'Malformed identity is rejected before external reads');
 check(outbound.every(url=>url.pathname==='/api/strategy'),true,'Automatic data uses an existing endpoint, not an arbitrary target');
 console.log('Automatic LP private actions and persistence: '+count+' assertions passed.');
}finally{fixture.close();globalThis.fetch=originalFetch;}
