/* Real private SQLite persistence with closed readers and bounded Workflow
   invocations. Financial scenarios use the actual deterministic engine. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { autofillContext, fundingFixture } from './fixtures/agent-lp-autofill.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { executeAutomaticWorkflow } from '../api/_agent-auto-workflow.mjs';
import { automaticStatus, dispatchAutomaticObservation, saveAutomaticControls } from '../api/_agent-auto-state.mjs';
import { positionKey, markAbsentPositions } from '../api/_agent-auto-observations.mjs';
import { priceAtTick } from '../strategy-core.mjs';
import { recordAgentDecision } from '../api/_agent-decisions.mjs';

let count=0,queries=0,maxQueries=0,now=Date.now()+1000,near=false,empty=false,incomplete=false,walletFails=false,loads=0,failPublish=false,closedHistory=[];
const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const fixture=createAgentSQLiteFixture({usage:true});
const db={prepare(sql){return {bind(...args){const statement=fixture.db.prepare(sql).bind(...args);return {...statement,
  ...Object.fromEntries(['first','run','all'].map(name=>[name,()=>{queries++;return statement[name]();}]))};}};},
  batch(statements){queries++;return fixture.db.batch(statements);}};
const env={AGENT_DB:db,AGENT_ORIGIN:'https://automation.fixture.test',PORTFOLIO_REVIEWS:{create:async()=>({id:'fixture'}),get:async()=>({})},
  CRON_SECRET:'fixture-cron-only-at-least-24',
  AI:{run(){throw Error('Automatic observations must not call inference');}}};
const store=createAgentStore(env,{now:()=>now}),steps=[];
let lastContext;
const loadContext=async()=>{
  loads++;const context=await autofillContext(now),p=context.lp.positions[0].canonical,pool=context.strategy.pools[0];
  if(near){pool.tick=p.raw.upperTick-1;pool.sqrtPrice=1.0001**(pool.tick/2);pool.price=priceAtTick(pool.tick,pool);pool.token0.usd=pool.price;}
  p.pair='vbWBTC / vbUSDC';p.performance={costUsd:500,withdrawnUsd:0,principalUsd:p.principalUsd,pnlUsd:0,earnedUsd:2,netUsd:2,complete:true};
  pool.activeLiquidity=Number(p.raw.liquidity)*10;pool.activeLiquidityRaw=String(BigInt(p.raw.liquidity)*10n);pool.eligible.liquidity=pool.activeLiquidity;
  pool.liquidityEvidence={schemaVersion:'agent-liquidity-v1',chain:p.chain,pool:p.pool,block:100,currentTick:pool.tick,
    activeLiquidityRaw:pool.activeLiquidityRaw,lowerTick:-887272,upperTick:887273,ticks:[],complete:true};
  context.tracking={positions:empty?[]:[p],enumerationComplete:!incomplete,closed:closedHistory};
  if(empty){context.lp.positions=[];context.lp.cards={open:0,value_usd:0,pnl_usd:0,fees_usd:0,net_usd:0,unclaimed_usd:0};}
  if(incomplete)context.lp.status='stale';
  lastContext=context;return context;
};
const readWallet=async chain=>{
  if(walletFails&&chain==='katana')throw Error('Fixture read failure');
  return {schemaVersion:'agent-wallet-observation-v1',chain,block:100,observedAt:new Date(now).toISOString(),status:'fresh',
    balances:[{chain,owner:'fixture-owner',symbol:'TEST',raw:'1000000',decimals:6,amount:1,valueUsd:1,priceUsd:1,status:'observed',
      block:100,observedAt:new Date(now).toISOString()}]};
};
const step={async do(name,options,operation){if(name==='observe-publish'&&failPublish){failPublish=false;throw Error('Fixture lost before publication');}
  queries=0;const result=await operation();maxQueries=Math.max(maxQueries,queries);steps.push({name,queries});
  check(queries<=50,true,'Workflow stage '+name+' stays below the Free D1 invocation ceiling ('+queries+')');return result;}};
const run=()=>executeAutomaticWorkflow({env,store,params:{schemaVersion:1,mode:'observe',manual:false,requestId:'observe-'+Math.floor(now/300000)},
  workflowId:'fixture-auto-'+now,step,dependencies:{now:()=>now,loadContext,readWallet,
    readPool:async()=>({...lastContext.strategy.pools[0],schemaVersion:'agent-pool-observation-v1',chain:'katana',block:100,
      observedAt:new Date(now).toISOString(),accounting:{valuationBlockPinned:true}}),
    readFunding:async selected=>fundingFixture(selected.owner,now)}});
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real outbound requests in automatic tracking tests');};
try{
  let result=await run(),status=await automaticStatus(store,env,{now});
  check(result.positions,1,'Current LPs are detected with no form submission');
  check(status.latest.positions.length,1,'The private automatic brief includes the live position');
  check(status.schedulerConfigured,true,'Cron readiness is reported separately from Workflow readiness');
  check(!!status.lastScheduledAttempt,true,'An actual scheduled invocation is distinguished from a manual reading');
  check(status.latest.positions[0].range.selected?.days,14,'An explicit observational default selects a historical band without a confirmed policy');
  check(await store.get('policy:current'),null,'Automatic defaults never create or confirm an investment policy');
  check((await store.list('journal:decision:')).items.length,1,'A dated automatic comparison creates a prospective journal record');
  check((await store.list('investment:baseline:')).items.length,1,'The automatic runner also saves the original equal-capital decision before future quotes');
  const key=positionKey(lastContext.tracking.positions[0]),first=await store.get(key);
  check(first.proposal.observations,0,'A newly proposed band has no invented past outcomes');
  check(first.position.performance.netUsd,2,'Actual LP Book performance readings retain their original values');
  check(status.latest.reply.includes('• Suggestion:'),true,'The default brief gives a short suggestion');
  check((await store.list('usage:')).items.length,0,'Five-minute observations consume no chat/inference budget counters');
  check((await fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_usage').bind().first()).count,0,'No inference ledger attempt is created');
  const loadsBefore=loads;await run();check(loads,loadsBefore,'Duplicate scheduled ticks do not reread providers before they are due');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;near=true;await run();
  check((await store.get('alerts')||[]).filter(row=>row.type==='lp').length,0,'A near-edge warning requires two distinct current readings');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;failPublish=true;await assert.rejects(run(),/Fixture lost before publication/);count++;
  await run();
  check((await store.get('alerts')||[]).filter(row=>row.type==='lp').length,1,'A persistent near-edge observation produces one durable alert');
  check((await store.get('alerts')).find(row=>row.type==='lp').sourceTs,new Date(now).toISOString(),'A publication retry retains the original pending signal after the position checkpoint');
  check((await store.get(key)).proposal.observations,2,'Only later source times assess the original band');
  check((await store.list('journal:decision:')).items.length,1,'Repeated checks do not create repeated same-day comparison decisions');
  const proposals=(await store.list('automation:proposal:')).items;
  check(proposals.length,1,'The original range proposal is recorded once per position/day/policy');
  check(proposals[0].value.observations,0,'Later observations never rewrite an original proposal');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;walletFails=true;await run();status=await automaticStatus(store,env,{now});
  const retained=status.latest.wallets.find(source=>source.chain==='katana');
  check(retained.status,'stale','An unavailable wallet keeps its last good reading explicitly stale');
  check(retained.balances[0].raw,'1000000','A failed wallet read cannot erase the last known amount');
  check(Date.parse(retained.observedAt)<now,true,'A failed refresh cannot renew an old wallet timestamp');
  check((await store.get('alerts')||[]).filter(row=>row.type==='lp').length,1,'Repeated unchanged conditions do not send another alert during cooldown');
  const decision=(await store.list('journal:decision:')).items[0].value;
  await recordAgentDecision(store,{decisionId:decision.decisionId,expectedVersion:1,state:'rejected',
    requestId:'fixture-owner-rejection',rationale:'Keep my existing range for now.'},{now});
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;await run();
  const declined=await store.get(key);
  check(declined.range.status,'owner_declined','A real journal rejection suppresses future automatic range suggestions under the same policy');
  check(declined.range.selected,null,'A rejected numeric range is no longer presented as a current suggestion');
  check(declined.risk.status,'watch','Rejecting a suggestion cannot hide independently observed live risk');
  await recordAgentDecision(store,{decisionId:decision.decisionId,expectedVersion:2,state:'deferred',
    requestId:'fixture-owner-clear-rejection',rationale:'Allow range comparisons again.'},{now});
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;await run();
  check(!!(await store.get(key)).range.selected,true,'Only a subsequent owner choice clears the applicable rejection');
  walletFails=false;now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;empty=true;incomplete=true;await run();
  check((await store.get(key)).status,'open','An incomplete enumeration cannot prove a position closed');
  status=await automaticStatus(store,env,{now});
  check(status.latest.positions[0].current,false,'Retained LP observations cannot become current recommendations');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;incomplete=false;await run();
  check((await store.get(key)).status,'no_longer_owned','A complete empty enumeration records an ownership/lifecycle transition');
  check((await store.list('automation:closed:')).items.length,0,'Absence never fabricates a realised closed-position performance record');
  const closedAt=new Date(now-86400000).toISOString(),p=lastContext.tracking.positions[0]||first.position;
  closedHistory=[{id:'42',chain:p.chain,pair:'vbWBTC / vbUSDC',wallet_address:p.owner,contract:p.contract,pool:p.pool,
    closed:closedAt,fee_usd:5,net_usd:3,incomplete:false,comparison:{volatile:'first quote'}}];
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;await run();
  const originalClose=(await store.list('automation:closed:')).items[0];
  check(originalClose.value.net_usd,3,'Actual closed LP Book net is stored at its original recorded value');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;closedHistory[0].comparison={volatile:'different current quote'};await run();
  check((await store.list('automation:closed:')).items.length,1,'Volatile LP-vs-holding metadata cannot rewrite or duplicate realised performance history');
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;closedHistory[0]={...closedHistory[0],fee_usd:6,net_usd:4};await run();
  check((await store.list('automation:closed:')).items.length,2,'A later final claim-accounting change adds a new immutable financial version');
  check((await store.get(originalClose.key)).net_usd,3,'The earlier closed-performance version remains intact');
  check((await store.list('automation:closed-latest:')).items[0].value.net_usd,4,'The historical list selects the latest verified accounting version');
  check((await store.list('automation:wallet-day:')).items.length,4,'Daily wallet snapshots persist separately from ephemeral job contexts');
  check((await store.list('automation:context:')).items.length,0,'Successful workflows delete their temporary context payloads');
  const disappearing=[];
  for(let i=0;i<4;i++){
    const position={...p,id:String(2000+i),positionId:String(2000+i),observedAt:new Date(now-300000).toISOString()},k=positionKey(position);
    const proposal={id:'fixture-qualified-closure-'+i,day:'2026-11-07',policyVersion:0,createdAt:new Date(now-21600000).toISOString(),
      lastObservedAt:new Date(now).toISOString(),observations:72,outsideObservations:20,coveredMs:21600000,unobservedMs:0,
      shadowBands:[{days:14,observations:72,outsideObservations:20}]};
    await store.set(k,{status:'open',position,proposal,pendingOutcomes:[]});disappearing.push(k);
  }
  await step.do('fixture-four-qualified-closures',{},()=>markAbsentPositions(store,disappearing,[],0,{complete:true,observedAt:new Date(now).toISOString(),now}));
  check((await store.get(disappearing[3])).pendingOutcomes.length,0,'The maximum closure batch merges qualified learning without exceeding Free D1 queries');
  await store.set('settings',{dailyEnabled:true,dailyTime:'00:00'});
  await store.set('telegram',{chatId:'42',userId:'42'});
  const beforeDaily=loads;now+=300000;result=await run();
  check(result.status!=='not_due',true,'A due daily summary bypasses the slower full-scan wait');
  check(loads,beforeDaily+1,'The due daily summary receives a new source reading on its next Cron tick');
  await saveAutomaticControls(store,{enabled:false,expectedRevision:0},{now});
  now+=(await store.get('automation:latest'))?.intervalMinutes*60000||300000;const beforePause=loads;result=await run();
  check(result.status,'paused','The operational pause stops automatic reads');
  check((await automaticStatus(store,env,{now})).nextIntendedCheck,null,'Paused tracking never advertises an active next check');
  check(loads,beforePause,'A paused run never calls a wallet or position provider');
  check(await store.get('policy:current'),null,'Pausing tracking cannot change strategy policy or Lending settings');
  let created;
  const queued=await dispatchAutomaticObservation({env:{PORTFOLIO_REVIEWS:{create:async value=>{created=value;}}},now});
  check(queued.status,'queued','Cron only queues the existing background Workflow');
  check(created.params.mode,'observe','The observation mode stays separate from the AI review mode');
  check(created.id,'observe-'+Math.floor(now/300000),'Repeated scheduled dispatch uses the same deterministic instance ID');
  console.log('Automatic portfolio tracking and LP workflow: '+count+' assertions passed; max '+maxQueries+' D1 queries/stage.');
}finally{fixture.close();globalThis.fetch=originalFetch;}
