/* Prospective price-containment memory, grouped by pool and policy version.
   Different wallets/NFTs on the same day do not become independent test days.
   This never claims hypothetical fees were earned or changes investment limits. */
import { readAgentState } from './_agent-store.mjs';
import { automaticControls, autoPaused, autoHash } from './_agent-auto-state.mjs';
import { getSettings } from './_agent-settings.mjs';

export function qualifiedRangeOutcome(proposal) {
  const elapsed=Date.parse(proposal.lastObservedAt)-Date.parse(proposal.createdAt),covered=proposal.coveredMs||0,unknown=proposal.unobservedMs||0;
  const shadow=proposal.shadowBands?.find(row=>row.days===14);
  return proposal.observations>=12&&elapsed>=21600000&&covered>=21600000&&covered/(covered+unknown)>=.8
    &&shadow?.observations>=12?{day:proposal.day,proposalId:proposal.id,observations:shadow.observations,outsideObservations:shadow.outsideObservations,
      createdAt:proposal.createdAt,lastObservedAt:proposal.lastObservedAt,coverage:covered/(covered+unknown),historyDays:14}:null;
}
export async function mergeRangeOutcome(store,position,positionRecordKey,proposal,revision,{now=Date.now()}={}) {
  if(!proposal)return {status:'empty'};
  const key='automation:pool:'+autoHash([position.chain,position.pool?.toLowerCase()]),marker='automation:learning-applied:'+proposal.id;
  const poolLease=await store.lock(key,30);if(!poolLease)throw Error('Learning update is busy');
  const positionLease=await store.lock(positionRecordKey,30);if(!positionLease){await poolLease.release();throw Error('Position update is busy');}
  try{
    const raw=await readAgentState(store,[key,marker,positionRecordKey,'automation:controls','settings']);
    const controls=automaticControls(raw['automation:controls']),settings=await getSettings({get:async()=>raw.settings});
    if(!controls.enabled||controls.revision!==revision||autoPaused(settings,now))return {status:'paused'};
    const state=raw[positionRecordKey];if(!state)return {status:'missing'};
    const entries=[{key:positionRecordKey,value:{...state,pendingOutcomes:(state.pendingOutcomes||[]).filter(value=>value.id!==proposal.id)}}];
    if(!raw[marker]){
      const measured=qualifiedRangeOutcome(proposal),pool=raw[key]||{},versions={...(pool.learning||{})};
      if(measured){
        const previous=versions[proposal.policyVersion]||{},sameDay=previous.recent?.find(row=>row.day===measured.day);
        const recent=sameDay&&sameDay.observations>=measured.observations?previous.recent:[...(previous.recent||[]).filter(row=>row.day!==measured.day),measured]
          .sort((a,b)=>a.day.localeCompare(b.day)).slice(-12);
        versions[proposal.policyVersion]={policyVersion:proposal.policyVersion,completedProposals:recent.length,
          observations:recent.reduce((n,row)=>n+row.observations,0),outsideObservations:recent.reduce((n,row)=>n+row.outsideObservations,0),recent,
          basis:'Later sampled containment of original 14-day shadow bands; one qualified pool/day cohort, not an investment win rate.'};
        const keep=Object.keys(versions).sort((a,b)=>Number(b)-Number(a)).slice(0,4);
        entries.push({key,value:{...pool,learning:Object.fromEntries(keep.map(version=>[version,versions[version]]))}});
      }
      entries.push({key:marker,value:{proposalId:proposal.id,appliedAt:new Date(now).toISOString(),status:measured?'qualified':'insufficient_coverage'},immutable:true});
    }
    await poolLease.commit(entries,{alsoOwned:[positionLease]});return {status:raw[marker]?'duplicate':'recorded'};
  }finally{await positionLease.release();await poolLease.release();}
}
