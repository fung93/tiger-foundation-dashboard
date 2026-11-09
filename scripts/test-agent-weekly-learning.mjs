/* Real local SQLite, deterministic MYT calendar and closed Telegram transport.
   No production credentials, provider requests, inference or wallet writes. */
import assert from 'node:assert/strict';
import {createAgentSQLiteFixture} from './fixtures/agent-sqlite.mjs';
import {reviewPolicy} from './fixtures/agent-review.mjs';
import {createAgentStore} from '../api/_agent-store.mjs';
import {DEFAULT_SETTINGS,normalizeSettings} from '../api/_agent-settings.mjs';
import {LEARNING_KEY} from '../api/_agent-portfolio-learning.mjs';
import {WEEKLY_STATE,weeklyPeriod,weeklyDue,buildWeeklyLearningReport,prepareWeeklyLearning} from '../api/_agent-weekly-learning.mjs';
import {deliverAutomaticNotices} from '../api/_agent-auto-delivery.mjs';

let count=0,queries=0,maxQueries=0,now=Date.parse('2026-11-15T14:55:00Z');
const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);count++;},DAY=86400000;
const period=weeklyPeriod(now,'22:50'),iso=at=>new Date(at).toISOString();
check(period,{periodId:'2026-11-15',startAt:'2026-11-08T14:50:00.000Z',endAt:'2026-11-15T14:50:00.000Z'},'The saved report clock is interpreted in MYT on Sunday');
check(weeklyPeriod(Date.parse(period.endAt)-1,'22:50').periodId,'2026-11-08','One millisecond before the cutoff belongs to the earlier weekly period');
check(weeklyPeriod(Date.parse(period.endAt),'22:50').periodId,'2026-11-15','The exact Sunday cutoff is due');
check(weeklyPeriod(Date.parse('2026-11-14T16:00:00Z'),'00:00').periodId,'2026-11-15','Sunday midnight MYT is still Saturday in UTC');
check(weeklyPeriod(now+DAY,'22:50').periodId,'2026-11-15','A missed Sunday can be recovered on Monday');
check(weeklyDue({activeSince:iso(now-8*DAY)},DEFAULT_SETTINGS,now),true,'An activated weekly schedule can become due');
check(weeklyDue({activeSince:iso(now)},DEFAULT_SETTINGS,now),false,'First activation does not replay an earlier Sunday');
check(weeklyDue({activeSince:iso(now-8*DAY),deliveredPeriod:period.periodId},DEFAULT_SETTINGS,now),false,'A delivered week cannot become due twice');
check(weeklyDue({activeSince:iso(now-8*DAY),preparedPeriod:'2026-11-22'},DEFAULT_SETTINGS,now),false,'Clock rollback cannot trigger repeated scans of an older week');
check(weeklyDue({activeSince:iso(now-8*DAY)},{...DEFAULT_SETTINGS,weeklyEnabled:false},now),false,'Weekly opt-out is independent of daily preferences');
check(normalizeSettings({dailyEnabled:false}).weeklyEnabled,true,'Old saved settings gain the weekly default without changing daily reports');
assert.throws(()=>normalizeSettings({weeklyEnabled:'true'}));count++;

const day=(at,health,liquidity='100')=>({day:iso(at+8*3600000).slice(0,10),observedAt:iso(at),
 coverage:{lpComplete:true,lendingComplete:true,walletChains:['katana','robinhood','arc','solana']},
 loans:[{key:'loan',label:'avKAT / KAT',health,ltv:.7,observedAt:iso(at)}],
 lps:[{identity:'lp-fixture',chain:'katana',pool:'0xfixture',pair:'WBTC / USDC',observedAt:iso(at),liquidity,
   inRange:true,advantageUsd:-5,performance:{netUsd:-3}}],balances:[],closed:[],locks:[]});
const memory={days:[day(now-2*DAY,1.2),day(now-DAY,1.15),day(now,1.1,'120')]};
const latest={policyVersion:0,checkedAt:iso(now),positions:[{current:true,identity:'lp-fixture',
 position:{chain:'katana',pool:'0xfixture',pair:'WBTC / USDC'},range:{selected:{days:30},learningApplied:true},lessons:{completedProposals:4,observations:100}}]};
const previous={periodId:'2026-11-08',policyVersion:0,capture:{pools:[{key:'katana:0xfixture',days:14,qualified:3}]}};
const report=buildWeeklyLearningReport({memory,latest,previous,period,now});
check(report.improvements.length,1,'Only a measured qualified change from a prior week is reported as improved evidence');
check(report.reply.includes('30-day history instead of 14 days'),true,'The summary names the actual comparison change');
check(report.reply.includes('falling three-day sequence'),true,'The agent reviews recorded lending safety without an owner task');
check(report.reply.includes('liquidity changed'),true,'A capital change is kept distinct from investment return');
check(report.reply.includes('not yet prove better net investment returns'),true,'Containment evidence cannot become a proven investment gain');
check(report.reply.includes('not calculated weekly investment returns'),true,'Lifetime LP results are not mislabeled weekly profit');
check(/Open Decision|review due|Suggestion:|Recheck:/i.test(report.reply),false,'Weekly learning is a summary, not an owner review-due task');
check(report.reply.length<2400,true,'The bounded weekly summary fits one Telegram part');
check(report.evidence.length,3,'The immutable report embeds the exact dated observations used');
check(report.status,'recorded','Complete weekly sources are recorded');
const changed=structuredClone(latest);changed.positions[0].lessons.completedProposals=3;
check(buildWeeklyLearningReport({memory,latest:changed,previous,period,now}).improvements.length,0,'Repeated old outcomes cannot establish new improvement');
changed.positions[0].lessons.completedProposals=4;changed.positions[0].lessons.observations=10;
check(buildWeeklyLearningReport({memory,latest:changed,previous,period,now}).improvements.length,0,'Sparse observations cannot justify improvement');
check(buildWeeklyLearningReport({memory,latest,previous:{...previous,policyVersion:1},period,now}).improvements.length,0,'Different-policy history cannot establish current-policy improvement');
check(buildWeeklyLearningReport({memory,latest,previous:{...previous,periodId:period.periodId},period,now}).improvements.length,0,'Same-week reformatting is not a later learned improvement');
check(buildWeeklyLearningReport({memory,latest:{...latest,checkedAt:iso(now-10*DAY)},previous,period,now}).improvements.length,0,'Old latest results cannot be presented as this week’s adaptation');
const empty=buildWeeklyLearningReport({period,now});
check(empty.status,'partial','Missing memory remains partial');
check(empty.reply.includes('don’t have enough'),true,'No observations produce an honest short explanation');
const incomplete=structuredClone(memory);incomplete.days[0].coverage.lpComplete=false;
check(buildWeeklyLearningReport({memory:incomplete,period,now}).status,'partial','An incomplete earlier day cannot be hidden by a fresh complete last reading');
const future=structuredClone(memory);future.days.push(day(now+DAY,1));
check(buildWeeklyLearningReport({memory:future,period,now}).evidence.length,3,'Future observations are excluded');
const katDay={...day(now,1.1),loans:[],lps:[],kat:{realizedUsd:2,unrealizedUsd:-3,observedAt:iso(now)}};
const katReport=buildWeeklyLearningReport({memory:{days:[katDay]},period,now});
check(katReport.lessons[0].kind,'kat','The weekly summary can learn beyond lending and LPs');
check(katReport.evidence[0].kat,katDay.kat,'The exact KAT evidence is embedded when a KAT lesson is reported');

const fixture=createAgentSQLiteFixture({usage:true});
const db={prepare(sql){return {bind(...params){const s=fixture.db.prepare(sql).bind(...params);return {...s,
 ...Object.fromEntries(['first','all','run'].map(key=>[key,()=>{queries++;return s[key]();}]))};}};},
 batch(statements){queries++;return fixture.db.batch(statements);}};
const env={AGENT_DB:db,AGENT_ORIGIN:'https://weekly.fixture.test',TELEGRAM_BOT_TOKEN:'fixture-only',
 AI:{run(){throw Error('Weekly learning cannot use inference');}}};
const store=createAgentStore(env,{now:()=>now}),binding={chatId:'42',userId:'42'},sent=[];
let failure=false,replace=false;
const fetcher=async(url,options)=>{
 check(new URL(url).hostname,'api.telegram.org','The weekly sender uses the fixed Telegram destination');
 if(failure)throw Error('Fixture unavailable');
 sent.push(JSON.parse(options.body));
 if(replace)await store.set('telegram',{chatId:'43',userId:'43'});
 return Response.json({ok:true,result:{message_id:sent.length}});
};
const bounded=async fn=>{queries=0;const result=await fn();maxQueries=Math.max(maxQueries,queries);
 check(queries<=50,true,'A weekly stage fits Free D1 binding limits ('+queries+')');return result;};
const prepare=()=>bounded(()=>prepareWeeklyLearning({store,env,now}));
const deliver=()=>bounded(()=>deliverAutomaticNotices({store,env,now:()=>now,fetcher}));
const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real provider requests in weekly tests');};
try{
 await store.set('settings',{dailyEnabled:false,alertsEnabled:false,dailyTime:'22:50'});
 const busyOwner=await store.lock('owner',15);
 await assert.rejects(prepareWeeklyLearning({store,env,now}),/Private update/);count++;
 check(await store.get(WEEKLY_STATE),null,'A busy owner transaction cannot publish a competing weekly checkpoint');
 await busyOwner.release();
 check((await prepare()).status,'collecting','First background run starts collecting without a retrospective message');
 check((await prepare()).status,'not_due','The activation week is not replayed');
 await store.set(WEEKLY_STATE,{activeSince:iso(now-8*DAY)});
 await store.set(LEARNING_KEY,memory);await store.set('automation:latest',latest);
 let prepared=await prepare();
 check(prepared.status,'ready','Sunday preparation runs with no owner form or review');
 const original=prepared.report;
 check((await prepare()).report.reportId,original.reportId,'A retry reuses the original immutable report');
 await store.set(LEARNING_KEY,{days:[]});
 check((await prepare()).report.evidence.length,3,'Later source changes do not rewrite the weekly original');
 const enqueue=async(report=original)=>{
  await store.set('telegram',binding);
  await store.set('automation:pending',[{id:report.reportId,trigger:'weekly',reportId:report.reportId,periodId:report.periodId,
    text:report.reply,...binding,controlsRevision:report.controlsRevision,policyVersion:report.policyVersion,
    expiresAt:report.validUntil,validUntil:report.validUntil,sentParts:0}]);
 };
 await enqueue();failure=true;
 check((await deliver()).status,'queued','A Telegram failure retains the weekly outbox');
 check((await store.get(WEEKLY_STATE)).deliveredPeriod,undefined,'A failed request is not marked delivered');
 failure=false;check((await deliver()).status,'sent','The next attempt recovers the same weekly message');
 check(sent.length,1,'Only the acknowledged message is recorded as sent');
 check((await store.get(WEEKLY_STATE)).deliveredPeriod,period.periodId,'The completed period has a durable delivery checkpoint');
 check((await store.get('automation:latest')).weeklyLearning.status,'sent','Private status reflects the acknowledged weekly delivery');
 check((await prepare()).status,'not_due','Acknowledgment prevents weekly regeneration');
 await enqueue();check((await deliver()).status,'cancelled','A duplicate staged weekly item cannot be replayed');
 check(sent.length,1,'The duplicate creates no provider call');
 await store.set(WEEKLY_STATE,{activeSince:iso(now-8*DAY),reportId:original.reportId});
 await enqueue();await store.set('settings',{weeklyEnabled:false,dailyTime:'22:50'});
 check((await deliver()).status,'cancelled','An opted-out queued weekly message is cancelled');
 check((await prepare()).status,'paused','Opting out prevents preparation');
 await store.set('settings',{dailyTime:'22:50',pausedUntil:iso(now+DAY)});await enqueue();
 check((await deliver()).status,'cancelled','The global pause is honored for queued weekly learning');
 await store.set('settings',{dailyTime:'22:50'});await enqueue();await store.set('telegram',{chatId:'43',userId:'43'});
 check((await deliver()).status,'cancelled','An old weekly message never follows a replacement recipient');
 await enqueue();await store.set('policy:current',reviewPolicy(1));
 check((await deliver()).status,'cancelled','A changed policy cancels an earlier-policy weekly message');
 await store.del('policy:current');await enqueue();
 env.AGENT_LEARNING_ENABLED='false';check((await deliver()).status,'cancelled','The learning feature switch cancels pending weekly messages');
 check((await prepare()).status,'disabled','The same switch disables weekly work');delete env.AGENT_LEARNING_ENABLED;
 await enqueue();await store.set('monitor:pending',{kind:'risk',items:[]});
 check((await deliver()).status,'risk_delivery_first','Independent risk delivery retains priority');await store.del('monitor:pending');
 await enqueue();await store.set('automation:pending',(await store.get('automation:pending')).map(item=>({...item,text:item.text+' invented'})));
 check((await deliver()).status,'cancelled','Queued text must match the saved deterministic report');
 await enqueue();now+=8*DAY;
 check((await deliver()).status,'cancelled','An old week expires before a later week can be sent');
 await store.set(LEARNING_KEY,{days:[day(now,1.05)]});
 const next=await prepare();
 check(next.status,'ready','A missed Sunday is prepared on the next background check');
 check(next.report.periodId,'2026-11-22','Only the most recent due week is recovered');
 check((await store.get(WEEKLY_STATE)).previousReportId,original.reportId,'The earlier original remains the comparison baseline');
 await store.set('automation:controls',{schemaVersion:'agent-automation-v1',revision:1,enabled:true});
 const rebuilt=await prepare();
 check(rebuilt.report.controlsRevision,1,'A new controls revision rebuilds authorization without rewriting the old report');
 check((await store.get(WEEKLY_STATE)).previousReportId,original.reportId,'Same-week re-preparation retains the previous week’s baseline');
 check((await store.get(original.reportId)).reply,original.reply,'The original weekly evidence remains immutable');
 await enqueue(rebuilt.report);replace=true;
 // The single-part message is acknowledged before a recipient change is seen.
 // Completed parts stay durable; no second message follows the new recipient.
 check((await deliver()).status,'sent','A single acknowledged message completes its original recipient delivery');
 check(sent.at(-1).chat_id,'42','A replacement receives none of the old recipient’s text');
 await deliver();check(sent.length,2,'Completed parts never knowingly resend');
 check(await store.get('policy:current'),null,'Self-review never changes the strategy policy');
 check((await fixture.raw('SELECT COUNT(*) AS n FROM agent_usage'))[0].n,0,'Weekly reviews consume no model inference');
 console.log('Autonomous weekly learning summaries: '+count+' assertions passed; max '+maxQueries+' D1 calls/stage.');
}finally{globalThis.fetch=oldFetch;fixture.close();}
