/* Real SQLite, real handlers, controlled provider waits. No network or wallet writes. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createResearchReport,persistAgentReport } from '../api/_agent-reports.mjs';
import { getAgentDecision,listAgentDecisions,recordAgentDecision,observeAgentDecision } from '../api/_agent-decisions.mjs';
import { draftAgentPolicy,confirmAgentPolicy } from '../api/_agent-policy.mjs';
import { beginAgentJob,agentJobKey } from '../api/_agent-jobs.mjs';
import { processAgentMessage,DEFAULT_SETTINGS } from '../api/_agent-service.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { monitorConditions } from '../api/_agent-notifications.mjs';
import { agentDiagnostics } from '../api/_agent-diagnostics.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const rejected=async(fn,status,n)=>{await assert.rejects(fn,e=>e.status===status,n);count++;};
const fixture=createAgentSQLiteFixture(),env={AGENT_DB:fixture.db,AGENT_ORIGIN:'https://journal.test',
  CRON_SECRET:'fixture-cron-secret-more-than-24-characters',AI:{run:async()=>{throw Error('Real model calls forbidden');}}};
const store=createAgentStore(env),at=Date.now(),iso=new Date(at).toISOString();
const snapshot={snapshotId:'portfolio:journal-fixture',status:'partial',assets:[],liabilities:[],allocationBlocked:true};
const context={asOf:iso,snapshot,sources:[{name:'lending',status:'fresh',ts:iso},{name:'lp',status:'fresh',ts:iso}],
  lending:{status:'fresh',ts:iso,markets:[{key:'kat-usdc',id:'fixture-market',status:'fresh',ts:iso,label:'Fixture market',debt_amount:1,health:.99,ltv:.8,lltv:.77}]},
  lp:{status:'fresh',ts:iso,positions:[]}};
const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No external providers allowed');};
try{
  const report=createResearchReport({context,policy:{version:0},query:'Prospective thesis before outcome',now:at,
    research:{protocol:'morpho',evidence:[],sources:[],limitations:[]}});
  report.options=[{id:'review',label:'Maintain and review',status:'informational'}];
  await persistAgentReport(store,report,snapshot);
  let page=await listAgentDecisions(store);check(page.items.length,1,'A saved validated brief creates one durable proposed decision');
  const id=page.items[0].decisionId;
  await persistAgentReport(store,report,snapshot);check((await listAgentDecisions(store)).items.length,1,'Saving the same brief cannot duplicate its journal proposal');
  let detail=await getAgentDecision(store,id);check(detail.events[0].provenance,'validated_report','The original proposal records trusted provenance');
  const input={decisionId:id,expectedVersion:1,state:'accepted_for_review',choice:'review',rationale:'Review the risks first',requestId:'owner-decision-1'};
  const saved=await recordAgentDecision(store,input);check(saved.decision.version,2,'A decision appends a new version');
  check(saved.event.acceptanceMeans,'review_only','Acceptance is never execution');
  check(saved.event.transaction,null,'Acceptance cannot fabricate a transaction');
  check(await recordAgentDecision(store,input),saved,'Repeated owner request reuses the same immutable event');
  await rejected(()=>recordAgentDecision(store,{...input,rationale:'Changed'}),409,'An idempotency key cannot change meaning');
  await rejected(()=>recordAgentDecision(store,{...input,requestId:'stale-version'}),409,'A stale editor cannot overwrite a newer decision');
  await rejected(()=>recordAgentDecision(store,{...input,expectedVersion:2,requestId:'model-write'},{source:'model'}),403,'A model cannot mutate the journal');
  await rejected(()=>recordAgentDecision(store,{...input,expectedVersion:2,requestId:'unknown-option',choice:'invented'}),400,'Only original options can be chosen');
  await rejected(()=>recordAgentDecision(store,{...input,expectedVersion:2,requestId:'retro-thesis',thesis:'After seeing outcome'}),400,'The original thesis cannot be backfilled');
  const transaction=await recordAgentDecision(store,{...input,expectedVersion:2,state:'deferred',requestId:'owner-report',transaction:'I made a separate repayment.'});
  check(transaction.event.transaction.provenance,'owner_report','Explicit owner transaction reports retain provenance');
  check(transaction.event.transaction.verified,false,'Owner reports are not relabeled chain-verified');
  detail=await getAgentDecision(store,id,{limit:1});check(detail.events.length,1,'Journal events are paged');
  check(!!detail.cursor,true,'A bounded event page exposes a continuation');
  check((await getAgentDecision(store,id,{cursor:detail.cursor})).events.length,2,'Continuation returns later immutable events');
  const draft=await draftAgentPolicy(store,{horizonDays:30},{expectedVersion:0,source:'owner'});
  await confirmAgentPolicy(store,draft.draftId,{source:'owner'});
  check((await listAgentDecisions(store)).items[0].reviewStatus,'superseded_policy','Policy changes visibly supersede historical assessments');
  await rejected(()=>recordAgentDecision(store,{...input,expectedVersion:3,requestId:'old-policy-accept'}),409,'An old policy assessment cannot be accepted as current');
  const observation=await observeAgentDecision(store,id,{snapshot:{...snapshot,snapshotId:'portfolio:later-fixture'}},{now:at+1000});
  check(observation.event.status,'blocked','Incomplete point-in-time coverage blocks outcome performance');
  check(observation.event.type,'paper_observation','An observation is separate from execution');
  check((await observeAgentDecision(store,id,{snapshot:{...snapshot,snapshotId:'portfolio:later-fixture'}},{now:at+2000})).event,observation.event,'Same snapshot yields one immutable prospective observation');
  check((await getAgentDecision(store,id)).decision.thesis,report.objective,'Observations preserve the original thesis');
  const permanent=await fixture.raw("SELECT COUNT(*) AS n FROM agent_state WHERE expires_at IS NOT NULL AND (key LIKE '%journal:%' OR key LIKE '%report:%' OR key LIKE '%portfolio:%')");
  check(permanent[0].n,0,'Decision records and their retained baseline do not use cache expiry');
  const stats=await store.storageUsage(),actual=await fixture.raw('SELECT COUNT(*) AS n,SUM(length(CAST(key AS BLOB))+length(CAST(value AS BLOB))) AS b FROM agent_state');
  check(stats.payloadBytes,actual[0].b,'Storage metrics count actual UTF-8 payload bytes');check(stats.rows,actual[0].n,'Storage row metrics match SQLite');
  // A process loss with an unconfirmed inference outcome is not a retry license.
  let lease=await store.lock('lost-job',90);
  const lost=await beginAgentJob(store,lease,{id:'lost-job',kind:'chat',inputHash:'fixed',policyVersion:1});await lease.release();
  lease=await store.lock('lost-job',90);
  await rejected(()=>beginAgentJob(store,lease,{id:'lost-job',kind:'chat',inputHash:'fixed',policyVersion:1}),409,'A restarted invocation cannot blindly repeat its inference');
  check((await store.get(lost.key)).state,'interrupted','Lost invocations persist an honest interrupted state');await lease.release();
  // Both leases must still exist inside the database transaction.
  const jobFence=await store.lock('job-fence',90),ownerFence=await store.lock('owner',15);await ownerFence.release();
  await rejected(()=>jobFence.commit([{key:'must-rollback',value:true}],{alsoOwned:[ownerFence]}),503,'Loss of either fence aborts the atomic update');
  check(await store.get('must-rollback'),null,'Dual fencing leaves no partial write');await jobFence.release();
  // Suspend a real chat in its provider while deterministic risk monitoring runs.
  await store.set('settings',{...DEFAULT_SETTINGS,dailyEnabled:true,dailyTime:'00:00'});
  let resolveProvider,enteredProvider;
  const entered=new Promise(resolve=>{enteredProvider=resolve;}),waiting=new Promise(resolve=>{resolveProvider=resolve;});
  const chat=processAgentMessage({store,env,context,requestId:'slow-chat',message:'Explain my current lending health',
    respond:async()=>{enteredProvider();await waiting;return {reply:'A fixture explanation.',action:null};}});
  await entered;check(await store.get('lock:owner'),null,'Slow inference does not hold the shared owner lease');
  const monitor=createMonitorHandler({env,storeFactory:()=>store,loadContext:async()=>context,summarize:()=> 'Deterministic daily fixture',now:()=>at});
  const res={setHeader(){},status(code){this.code=code;return this;},end(body){this.body=JSON.parse(body);}};
  await monitor({method:'POST',headers:{authorization:'Bearer '+env.CRON_SECRET}},res);
  check(res.code,200,'A long chat cannot suppress an independent risk tick');
  check((await store.get('alerts')).some(alert=>alert.severity==='critical'),true,'Health below one raises an immediate deterministic alert during the chat');
  check((await store.get('messages')).at(-1).source,'monitor','The monitor commits its daily message while the provider is waiting');
  resolveProvider();await chat;
  check((await store.get('messages')).some(message=>message.source==='monitor'),true,'A late chat merges the latest conversation without losing monitoring');
  check((await store.get(agentJobKey('dashboard:'+ (await import('node:crypto')).createHash('sha256').update('slow-chat').digest('hex')))).state,'completed','The synchronous job durably records completion');
  const result=monitorConditions({...context,lending:{...context.lending,markets:[{...context.lending.markets[0],health:1,ltv:.7}]}},{...DEFAULT_SETTINGS,healthThreshold:1,ltvThreshold:77});
  check(result['lending:fixture-market'].active,false,'Exact health one is not below the liquidation boundary');
  const limits=monitorConditions({...context,lending:{...context.lending,markets:[{...context.lending.markets[0],health:1.4,ltv:.6}]}},DEFAULT_SETTINGS,{policy:{constraints:{marketLimits:{'kat-usdc':{targetHealth:1.5,maxLtvPct:55}}}}});
  check(limits['lending:fixture-market'].active,true,'Confirmed per-market policy limits drive monitoring');
  const diagnostic=await agentDiagnostics({env,store,budgetFactory:()=>({status:async()=>({available:false})})});
  check(diagnostic.jobs.backgroundRunner,false,'An unconfigured Workflow is never reported as a working background runner');
  check(diagnostic.jobs.researchExecution,'bounded_synchronous','Research jobs keep their actual execution mode');
  check(diagnostic.lastMonitorSuccess,iso,'Diagnostics expose a successful check independently of inference');
  check(diagnostic.storageUsage.status,'within_local_budget','Storage is monitored without deleting durable decisions');
  const watchDraft=await draftAgentPolicy(store,{lpReviewTriggers:{outOfRange:true,rewardChangePct:25,priceMovePct:10}},
    {expectedVersion:1,source:'owner'});await confirmAgentPolicy(store,watchDraft.draftId,{source:'owner'});
  const watched=structuredClone(context);
  watched.lp.positions=[{canonical:{id:'paper-range',chain:'katana',owner:'fixture',status:'observed',block:123,inRange:false,observedAt:iso}}];
  watched.strategy={status:'fresh',pools:[{pool:'fixture-pool',status:'fresh',katPerDay:100,price:1,ts:iso}]};
  const rangeMonitor=createMonitorHandler({env,storeFactory:()=>store,loadContext:async()=>watched,now:()=>at});
  const tick=async(handler=rangeMonitor)=>{const response={setHeader(){},status(code){this.code=code;return this;},end(body){this.body=JSON.parse(body);}};
    await handler({method:'POST',headers:{authorization:'Bearer '+env.CRON_SECRET}},response);return response;};
  await tick();check((await store.get('alerts')).some(alert=>alert.key.startsWith('lp:range:')),false,'A single noisy out-of-range observation is held for confirmation');
  await tick();check((await store.get('alerts')).some(alert=>alert.key.startsWith('lp:range:')&&alert.status==='active'),true,'Two verified out-of-range observations create a review alert');
  watched.strategy.pools[0].katPerDay=140;watched.strategy.pools[0].price=1.2;
  await tick();check((await store.get('alerts')).some(alert=>alert.key==='lp:reward:fixture-pool'),false,'Material campaign changes require a second observation');
  await tick();check((await store.get('alerts')).some(alert=>alert.key==='lp:reward:fixture-pool'),true,'A persistent campaign-rate change raises a deterministic review');
  check((await store.get('alerts')).some(alert=>alert.key==='lp:price:fixture-pool'),true,'A persistent token-ratio move raises a policy review');
  const previousAlerts=(await store.get('alerts')).length;await tick();check((await store.get('alerts')).length,previousAlerts,'Stable LP review warnings do not send every tick');
  watched.lp.positions[0].canonical.inRange=true;await tick();
  check((await store.get('alerts')).some(alert=>alert.key.startsWith('lp:range:')&&alert.status==='recovered'),true,'Verified range recovery is journaled in alert history');
  const due={...report,reportId:report.reportId.replace(/:[0-9a-f-]{36}$/,'')+':11111111-1111-4111-8111-111111111111',policyVersion:2,nextReviewAt:new Date(at-1).toISOString()};
  await persistAgentReport(store,due,snapshot);await tick();
  check((await store.get('alerts')).some(alert=>alert.type==='review'),true,'The monitor finds due durable strategy reviews without inference');
  const failedMonitor=createMonitorHandler({env,storeFactory:()=>store,loadContext:async()=>{throw Error('Fixture data outage');},now:()=>at+1000});
  check((await tick(failedMonitor)).code,503,'Data infrastructure failure cannot report a healthy risk check');
  check((await store.get('lastCheck')).status,'failed','Failed attempts remain visible');
  check((await store.get('monitor:lastSuccess')).ts,iso,'A failed attempt cannot erase the last successful check');
  const degraded=await agentDiagnostics({env,store,budgetFactory:()=>({status:async()=>({available:false})})});
  check(degraded.components.monitor,'degraded','Diagnostics distinguish failed monitoring from an AI-only outage');
  let enteredChanged,finishChanged;const changedEntered=new Promise(resolve=>{enteredChanged=resolve;}),changedWait=new Promise(resolve=>{finishChanged=resolve;});
  const changing=processAgentMessage({store,env,context,requestId:'policy-changes-mid-job',message:'Set health alert to 1.5',
    respond:async()=>{enteredChanged();await changedWait;return {reply:'Fixture acknowledgement',action:{type:'settings',settings:{healthThreshold:1.5}}};}});
  await changedEntered;
  const changedDraft=await draftAgentPolicy(store,{reviewFrequencyDays:2},{expectedVersion:2,source:'owner'});
  await confirmAgentPolicy(store,changedDraft.draftId,{source:'owner'});finishChanged();
  const changedAnswer=await changing;
  check(changedAnswer.status,'superseded','A newer policy invalidates a still-running answer before commit');
  check((await store.get('settings')).healthThreshold,DEFAULT_SETTINGS.healthThreshold,'A superseded answer cannot apply its proposed preference action');
  console.log('Agent decisions, restart safety and concurrent monitoring: '+count+' assertions passed.');
}finally{globalThis.fetch=oldFetch;fixture.close();}
