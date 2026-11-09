/* Weekly evidence review, not an owner task or a claim of investment skill.
   Runs only in the existing background Workflow; no inference or wallet writes. */
import {createHash} from 'node:crypto';
import {automaticInputs,autoPaused,automationEnabled} from './_agent-auto-state.mjs';
import {LEARNING_KEY,derivePortfolioLessons} from './_agent-portfolio-learning.mjs';
import {agentReadingTime} from '../agent-language.mjs';
export const WEEKLY_STATE='learning:weekly-state';
const DAY=86400000,WEEK=7*DAY,hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function weeklyPeriod(now,time='09:00'){
 const local=new Date(now+8*3600000),date=local.toISOString().slice(0,10),sunday=new Date(Date.parse(date+'T00:00:00+08:00')-local.getUTCDay()*DAY);
 let end=Date.parse(new Date(sunday.getTime()+8*3600000).toISOString().slice(0,10)+'T'+time+':00+08:00');
 if(end>now)end-=WEEK;
 return {periodId:new Date(end+8*3600000).toISOString().slice(0,10),startAt:new Date(end-WEEK).toISOString(),endAt:new Date(end).toISOString()};
}
export function weeklyDue(state,settings,now){
 if(!settings.weeklyEnabled||!state?.activeSince)return false;
 const p=weeklyPeriod(now,settings.dailyTime);
 return Date.parse(p.endAt)>=Date.parse(state.activeSince)&&(!state.preparedPeriod||state.preparedPeriod<p.periodId)
   &&(!state.deliveredPeriod||state.deliveredPeriod<p.periodId);
}
function capture(latest,period,policyVersion){
 const at=Date.parse(latest?.checkedAt),end=Date.parse(period.endAt),start=Date.parse(period.startAt);
 const pools=new Map();
 if(latest?.policyVersion===policyVersion&&at>start&&at<=end)for(const item of latest.positions||[]){
  if(item.current!==true||!item.position?.chain||!item.position?.pair)continue;
  const key=item.position.pool?item.position.chain+':'+item.position.pool.toLowerCase():item.identity||item.key;if(!key)continue;
  pools.set(key,{key,pair:item.position.pair,days:item.range?.selected?.days||null,applied:item.range?.learningApplied===true,
    qualified:item.lessons?.completedProposals||0,observations:item.lessons?.observations||0});
 }
 return {policyVersion,observedAt:latest?.checkedAt||null,pools:[...pools.values()].slice(0,30)};
}
export function buildWeeklyLearningReport({memory,latest,previous,policy={version:0},controlsRevision=0,period,now=Date.now()}={}){
 const start=Date.parse(period.startAt),end=Math.min(now,Date.parse(period.periodId+'T23:59:59.999+08:00')),
   evidenceThroughAt=new Date(end).toISOString(),days=(memory?.days||[]).filter(day=>Date.parse(day.observedAt)>start&&Date.parse(day.observedAt)<=end).slice(-8);
 const current=days.at(-1),summary=derivePortfolioLessons({days,current,policy,now}),lessons=[];
 // Keep the weekly message short, covering distinct areas of the portfolio.
 for(const row of summary.lessons||[])if(lessons.length<3&&!lessons.some(lesson=>lesson.kind===row.kind))lessons.push(row);
 const snapshot=capture(latest,{...period,endAt:evidenceThroughAt},policy.version),improvements=[];
 if(previous?.periodId<period.periodId&&previous.policyVersion===policy.version)for(const row of snapshot.pools){
  const old=previous.capture?.pools?.find(item=>item.key===row.key);
  if(old&&row.applied&&row.qualified>=3&&row.observations>=36&&row.qualified>old.qualified&&row.days&&old.days&&row.days!==old.days)
    improvements.push(row.pair+': I now compare '+row.days+'-day history instead of '+old.days+' days, supported by more qualified later observations.');
 }
 const partial=!current||days.some(day=>!day.coverage?.lpComplete||!day.coverage?.lendingComplete||(day.coverage?.walletChains||[]).length<4);
 const lines=['Your weekly learning update','Week ending '+period.periodId+' (MYT).'];
 if(lessons.length)lines.push('',...lessons.slice(0,3).map(row=>'• '+row.message));
 else lines.push('','I don’t have enough comparable recorded observations in this period to identify a reliable new pattern.');
 lines.push('',improvements.length?improvements.slice(0,2).join(' '):'I haven’t established a new improvement in decision quality this week. I’m keeping the original ideas and checking them against later readings.');
 if(improvements.length)lines.push('This improves the evidence used in comparisons; it does not yet prove better net investment returns.');
 lines.push('Based on '+days.length+' dated portfolio records.'+(partial?' Some sources were incomplete, so these lessons cover the verified readings.':''));
 if(current)lines.push('Latest recorded observation: '+agentReadingTime(current.observedAt)+'.');
 if(lessons.some(row=>row.kind==='lp'))lines.push('Position-book results use their original tracking baselines; they are not calculated weekly investment returns.');
 const relevant=new Set(lessons.map(row=>row.key));
 const evidence=days.map(day=>({day:day.day,observedAt:day.observedAt,coverage:day.coverage,
   loans:(day.loans||[]).filter(row=>relevant.has(row.key)).slice(0,3),lps:(day.lps||[]).filter(row=>relevant.has(row.identity)).slice(0,3),
   closed:(day.closed||[]).filter(row=>relevant.has([row.chain,row.pool||row.pair].join(':'))).slice(0,100),
   ...(relevant.has('trade-book')?{kat:day.kat||null}:{}),...(relevant.has('vote-rewards')?{votes:day.votes||null}:{}),
   ...(relevant.has('known-locks')?{locks:(day.locks||[]).slice(0,40)}:{}),
   ...(relevant.has('balance-changes')?{balances:(day.balances||[]).slice(0,160)}:{})}));
 const report={schemaVersion:'agent-weekly-learning-v1',...period,evidenceThroughAt,createdAt:new Date(now).toISOString(),policyVersion:policy.version,controlsRevision,
  status:partial?'partial':'recorded',lessons,improvements,capture:snapshot,evidence,
  sourceRecords:days.map(day=>'learning:day:'+day.day),reply:lines.join('\n'),validUntil:new Date(end+WEEK).toISOString(),
  evidenceBasis:'Exact dated rows are embedded in this immutable report; daily working records may advance independently.',
  basis:'Dated observations and qualified containment changes. No model retraining, policy changes, hypothetical earnings or investment win rate.'};
 report.reportId='learning:weekly-report:'+period.periodId+':'+hash(report);return report;
}
export async function prepareWeeklyLearning({store,env={},now=Date.now()}={}){
 if(!automationEnabled(env)||env.AGENT_LEARNING_ENABLED==='false')return {status:'disabled'};
 const lease=await store.lock('learning:weekly',20);if(!lease)throw Error('Weekly learning review is busy');
 let owner;
 try{
  // Delivery also writes this state under the owner lease. Serialize the read
  // and commit so a concurrent preparation cannot erase a delivery checkpoint.
  owner=await store.lock('owner',15);if(!owner)throw Error('Private update in progress');
  const input=await automaticInputs(store,[WEEKLY_STATE,LEARNING_KEY,'automation:latest']),state=input.raw[WEEKLY_STATE];
  if(!input.controls.enabled||autoPaused(input.settings,now)||!input.settings.weeklyEnabled)return {status:'paused'};
  if(!state){await lease.commit([{key:WEEKLY_STATE,value:{activeSince:new Date(now).toISOString()}}],{alsoOwned:[owner]});return {status:'collecting'};}
  const period=weeklyPeriod(now,input.settings.dailyTime);
  if(Date.parse(period.endAt)<Date.parse(state.activeSince)||state.deliveredPeriod>=period.periodId||state.preparedPeriod>period.periodId)return {status:'not_due'};
  const existing=state.reportId?await store.get(state.reportId):null;
  if(existing?.periodId===period.periodId&&existing.policyVersion===input.policy.version&&existing.controlsRevision===input.controls.revision)
    return {status:'ready',report:existing};
  const previousReportId=existing?.periodId<period.periodId?state.reportId:state.previousReportId;
  const previous=previousReportId===state.reportId?existing:previousReportId?await store.get(previousReportId):null;
  const report=buildWeeklyLearningReport({memory:input.raw[LEARNING_KEY],latest:input.raw['automation:latest'],previous,policy:input.policy,controlsRevision:input.controls.revision,period,now});
  await lease.commit([{key:report.reportId,value:report,immutable:true},{key:WEEKLY_STATE,value:{...state,previousReportId:previousReportId||null,
    preparedPeriod:period.periodId,reportId:report.reportId}}],{alsoOwned:[owner]});
  return {status:'ready',report};
 }finally{if(owner)await owner.release();await lease.release();}
}
