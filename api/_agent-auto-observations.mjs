/* Durable private observations. Each write is bounded and source-monotonic;
   daily records keep first/last readings, while recent samples remain bounded. */
import { AUTO_LIMITS, autoHash, autoFresh, automaticInputs, autoPaused } from './_agent-auto-state.mjs';
import { trackedIdentity, positionMarket, updatePoolHistory, lpRisk, chooseAutomaticRange } from './_agent-auto-analysis.mjs';
import { mytDayAndTime } from './_agent-notifications.mjs';
import { mergeRangeOutcome } from './_agent-auto-learning.mjs';

export const poolKey = p => 'automation:pool:' + autoHash([p.chain,p.pool?.toLowerCase()]);
export const positionKey = p => 'automation:position:' + autoHash(trackedIdentity(p));
export async function recordAutomatic(store, key, revision, names, make, {now=Date.now()}={}) {
  const lease=await store.lock(key,30);if(!lease)throw Error('Observation update is busy');
  try{const input=await automaticInputs(store,names);
    if(!input.controls.enabled||input.controls.revision!==revision||autoPaused(input.settings,now))return {status:'paused'};
    const result=await make(input);if(result.entries?.length)await lease.commit(result.entries);
    return result.value||{status:'recorded'};
  }finally{await lease.release();}
}
export async function recordWalletObservation(store,chain,sample,revision,{now=Date.now()}={}) {
  const key='automation:wallet:'+chain,day=mytDayAndTime(now).day,daily='automation:wallet-day:'+chain+':'+day;
  return recordAutomatic(store,key,revision,[key,daily],({raw})=>{
    const before=raw[key];
    const valid=sample?.schemaVersion==='agent-wallet-observation-v1'&&sample.chain===chain&&autoFresh(sample.observedAt,now)
      &&Number.isSafeInteger(sample.block)&&Array.isArray(sample.balances)&&sample.balances.length<=60;
    if(!valid)return {entries:[{key,value:{...before,chain,status:before?.observedAt?'stale':'unavailable',lastAttempt:new Date(now).toISOString()}}],value:{status:'unavailable'}};
    if(before?.observedAt&&Date.parse(before.observedAt)>=Date.parse(sample.observedAt))return {value:{status:'duplicate'}};
    const balances=sample.balances.map(row=>{
      const good=row.chain===chain&&row.status==='observed'&&typeof row.owner==='string'&&typeof row.raw==='string'
        &&/^\d{1,160}$/.test(row.raw)&&Number.isInteger(row.decimals)&&row.decimals>=0&&row.decimals<=36
        &&row.block===sample.block&&autoFresh(row.observedAt,now)&&Number.isFinite(row.amount)&&row.amount>=0;
      return good?row:{...row,raw:null,amount:null,valueUsd:null,status:'unavailable'};
    });
    const next={...sample,balances,status:balances.every(row=>row.status==='observed')?'fresh':'partial',lastAttempt:new Date(now).toISOString()};
    const prior=raw[daily];
    return {entries:[{key,value:next},{key:daily,value:{schemaVersion:'agent-wallet-day-v1',chain,day,first:prior?.first||next,last:next,
      observations:(prior?.observations||0)+1,basis:'Observed balances, not flow-adjusted investment performance.'}}],value:{status:next.status}};
  },{now});
}
export async function recordPoolObservation(store,position,market,revision,{now=Date.now()}={}) {
  const key=poolKey(position);
  return recordAutomatic(store,key,revision,[key],({raw})=>{
    const before=raw[key]||{},verified=positionMarket(position,market,now);
    if(!verified)return {value:{status:'unavailable'}};
    const history=updatePoolHistory(before.history,verified,now);
    if(history===before.history)return {value:{status:'duplicate'}};
    return {entries:[{key,value:{...before,schemaVersion:'agent-market-state-v1',current:verified,history}}],value:{status:'recorded'}};
  },{now});
}
export async function recordPositionObservation(store,position,revision,{now=Date.now(),strategyEnabled=true}={}) {
  const identity=trackedIdentity(position);if(!identity)return {status:'unavailable'};
  const key=positionKey(position),marketKey=poolKey(position),day=mytDayAndTime(now).day,daily='automation:lp-day:'+autoHash(identity)+':'+day;
  // Read the current policy first only to select its feedback key; revalidate the
  // version inside the fenced update before treating a rejection as applicable.
  const {policy:feedbackPolicy}=await automaticInputs(store);
  const feedbackKey='automation:feedback:'+autoHash([identity,feedbackPolicy.version]);
  return recordAutomatic(store,key,revision,[key,marketKey,daily,feedbackKey],({raw,policy})=>{
    const before=raw[key],marketState=raw[marketKey],market=positionMarket(position,marketState?.current,now);
    if(!autoFresh(position.observedAt,now)||position.status!=='observed')return {value:{status:'unavailable'}};
    const stamp=Date.parse(position.observedAt);
    if(before?.position?.observedAt&&Date.parse(before.position.observedAt)>=stamp)return {value:{status:'duplicate',key,pendingOutcome:before.pendingOutcomes?.[0]||null}};
    const risk=lpRisk(position,market,marketState?.history||{},now),lessons={...(marketState?.learning?.[policy.version]|| (before?.lessons?.policyVersion===policy.version?before.lessons
      :{policyVersion:policy.version,completedProposals:0,observations:0,outsideObservations:0,gaps:0}))};
    let proposal=before?.proposal||null;
    if(proposal&&market&&Date.parse(market.ts)>Date.parse(proposal.lastObservedAt||proposal.createdAt)
      &&Date.parse(market.ts)-Date.parse(proposal.lastObservedAt||proposal.createdAt)>=150000){
      const gap=Date.parse(market.ts)-Date.parse(proposal.lastObservedAt||proposal.createdAt),inside=market.tick>=proposal.tickLower&&market.tick<proposal.tickUpper;
      const covered=gap<=Math.max(900000,(marketState?.history?.samplingIntervalMinutes||5)*90000);
      proposal={...proposal,lastObservedAt:market.ts,observations:proposal.observations+Number(covered),outsideObservations:proposal.outsideObservations+Number(covered&&!inside),
        coveredMs:(proposal.coveredMs||0)+(covered?gap:0),unobservedMs:(proposal.unobservedMs||0)+(covered?0:gap),
        shadowBands:(proposal.shadowBands||[]).map(band=>({...band,observations:band.observations+Number(covered),
          outsideObservations:band.outsideObservations+Number(covered&&(market.tick<band.tickLower||market.tick>=band.tickUpper))})),
        gaps:proposal.gaps+Number(!covered),maxGapMs:Math.max(proposal.maxGapMs||0,gap)};
    }
    let range=chooseAutomaticRange({position,market,history:marketState?.history||{},risk,lessons,policy,now});
    if(!strategyEnabled)range={...range,status:'disabled',selected:null,reason:'Range comparisons are switched off; live risk monitoring continues.'};
    const feedback=raw[feedbackKey];
    if(feedback?.policyVersion===policy.version&&['rejected','invalidated'].includes(feedback.state))range={...range,
      status:'owner_declined',selected:null,reason:'You declined this position’s range suggestion. I’ll keep monitoring its live risks.'};
    const selected=range.selected,proposalId=autoHash([identity,day,policy.version]);
    const events=[];let newProposal=null,oldProposal=null;
    // At most one original band per position/day/policy. Later samples only
    // assess that recorded band; they never retrofit its original boundaries.
    if(selected&&proposal?.id!==proposalId){
      if(proposal){oldProposal={...proposal,closedAt:new Date(now).toISOString(),status:'evaluated'};
      }
      proposal={id:proposalId,positionIdentity:identity,createdAt:market.ts,day,policyVersion:policy.version,
        tickLower:selected.tickLower,tickUpper:selected.tickUpper,lowerPrice:selected.lowerPrice,upperPrice:selected.upperPrice,
        historyDays:selected.days,historyBasis:selected.historyBasis,observations:0,outsideObservations:0,gaps:0,maxGapMs:0,coveredMs:0,unobservedMs:0,
        shadowBands:range.candidates.map(band=>({...band,observations:0,outsideObservations:0})),
        lastObservedAt:market.ts,status:'observing',basis:'Automatic observational range; no trade or owner investment decision is inferred.'};
      newProposal=proposal;
    }
    if(!before)events.push({type:'discovered',observedAt:position.observedAt});
    else if(before.position?.raw?.liquidity!==position.raw?.liquidity)events.push({type:'liquidity_changed',observedAt:position.observedAt,
      beforeRaw:before.position.raw?.liquidity??null,afterRaw:position.raw?.liquidity??null});
    if(before&&typeof position.staked==='boolean'&&typeof before.position.staked==='boolean'&&position.staked!==before.position.staked)
      events.push({type:'staking_changed',observedAt:position.observedAt,before:before.position.staked,after:position.staked});
    if(before&&position.performance?.claimedTokens&&before.position.performance?.claimedTokens
      &&JSON.stringify(position.performance.claimedTokens)!==JSON.stringify(before.position.performance.claimedTokens))
      events.push({type:'claimed_token_amount_changed',observedAt:position.observedAt,tokens:position.performance.claimedTokens,
        basis:'Observed native-token claim accounting changed; no change is inferred from dollar repricing.'});
    const conditions={...(before?.conditions||{})},pendingSignals={...(before?.pendingSignals||{})},newSignals=[];
    for(const kind of ['out_of_range','near_edge','volatility','liquidity','rewards','campaign']){
      const signal=risk.signals.find(row=>row.kind===kind),prior=conditions[kind]||{},isNew=!!signal&&(!prior.lastSourceAt||Date.parse(market.ts)>Date.parse(prior.lastSourceAt));
      if(!market||risk.status==='unavailable')continue; // Missing data cannot clear an existing warning.
      const consecutive=signal?(prior.consecutive||0)+Number(isNew):0,active=!!signal&&(signal.immediate||consecutive>=2);
      const notify=active&&(!prior.active||now-(prior.notifiedAt||0)>=AUTO_LIMITS.alertCooldownMs);
      conditions[kind]={active,consecutive,lastSourceAt:market.ts,notifiedAt:notify?now:prior.notifiedAt||0,
        signature:signal?autoHash([kind,identity]):prior.signature||null};
      if(notify){const event={...signal,id:autoHash([identity,kind,market.ts]),positionKey:key,condition:kind,observedAt:market.ts};
        newSignals.push(event);pendingSignals[kind]=event;}
    }
    const next={schemaVersion:'agent-position-observation-v1',identity,policyVersion:policy.version,position,market,risk,range,lessons,proposal,conditions,pendingSignals,status:'open',
      pendingOutcomes:[...(before?.pendingOutcomes||[]),...(oldProposal?[oldProposal]:[])].slice(-8),
      firstSeenAt:before?.firstSeenAt||position.observedAt,lastCheckedAt:new Date(now).toISOString(),events:[...(before?.events||[]),...events].slice(-32)};
    const prior=raw[daily],daySample={observedAt:position.observedAt,principalUsd:position.principalUsd,
      performance:position.performance||null,market:market?{price:market.price,tick:market.tick,observedAt:market.ts,block:market.block??null}:null};
    const entries=[{key,value:next},{key:daily,value:{schemaVersion:'agent-lp-day-v1',identity,day,first:prior?.first||daySample,last:daySample,
      observations:(prior?.observations||0)+1,insideObservations:(prior?.insideObservations||0)+Number(risk.inRange===true),
      unavailableObservations:(prior?.unavailableObservations||0)+Number(risk.status==='unavailable'),events:[...(prior?.events||[]),...events].slice(-32),
      basis:'Sampled range status and LP Book accounting at original reading times; no inferred cash-flow-adjusted return.'}}];
    if(newProposal)entries.push({key:'automation:proposal:'+newProposal.createdAt+':'+newProposal.id,value:newProposal,immutable:true});
    if(oldProposal)entries.push({key:'automation:outcome:'+oldProposal.createdAt+':'+oldProposal.id,value:oldProposal,immutable:true});
    return {entries,value:{status:'recorded',key,newSignals,proposal:newProposal?.id||null,pendingOutcome:next.pendingOutcomes[0]||null}};
  },{now});
}
export async function markAbsentPositions(store,oldKeys,liveKeys,revision,{complete,observedAt,now=Date.now()}={}) {
  if(!complete||!autoFresh(observedAt,now))return {status:'unverified'};
  for(const key of oldKeys.filter(key=>!liveKeys.includes(key)).slice(0,AUTO_LIMITS.positions)){
    const result=await recordAutomatic(store,key,revision,[key],({raw})=>{
      const before=raw[key];if(!before||Date.parse(before.position.observedAt)>=Date.parse(observedAt))return {value:{status:'duplicate'}};
      if(before.status==='no_longer_owned')return {value:{position:before.position,pendingOutcome:before.pendingOutcomes?.[0]||null}};
      const outcome=before.proposal?{...before.proposal,status:'evaluated',closedAt:observedAt,
        endBasis:'No longer owned; later price checks do not imply continued LP execution.'}:null;
      const pending=[...(before.pendingOutcomes||[]),...(outcome?[outcome]:[])].slice(-8);
      const entries=[{key,value:{...before,status:'no_longer_owned',noLongerObservedAt:observedAt,pendingOutcomes:pending,
        disappearanceBasis:'Absent from a complete current owned-position enumeration; realised accounting comes from the closed LP Book.'}}];
      if(outcome)entries.push({key:'automation:outcome:'+outcome.createdAt+':'+outcome.id,value:outcome,immutable:true});
      return {entries,value:{position:before.position,pendingOutcome:pending[0]||null}};
    },{now});
    if(result.pendingOutcome)await mergeRangeOutcome(store,result.position,key,result.pendingOutcome,revision,{now});
  }
  return {status:'recorded'};
}
