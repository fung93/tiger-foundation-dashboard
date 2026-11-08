/* Authenticated operational actions only. No investment form or model authority. */
import { automaticStatus, saveAutomaticControls, dispatchAutomaticObservation, automationEnabled, autoFresh } from './_agent-auto-state.mjs';
import { httpError } from './_agent-http.mjs';

export async function automaticAction(body,{env,store}={}) {
  if(!['automaticStatus','automaticRun','automaticSettings','automaticHistory','automaticEvidence'].includes(body.action))return null;
  if(body.action==='automaticStatus')return automaticStatus(store,env);
  if(body.action==='automaticSettings'){
    await saveAutomaticControls(store,{enabled:body.enabled,expectedRevision:body.expectedRevision});
    return automaticStatus(store,env);
  }
  if(body.action==='automaticHistory'){
    const prefix={days:'automation:day:',closed:'automation:closed-latest:',proposals:'automation:proposal:',claims:'automation:claim:'}[body.kind||'days'];
    if(!prefix)throw httpError(400,'Choose portfolio history or recorded LP outcomes.');
    return store.list(prefix,{limit:20,reverse:true,cursor:body.cursor??null});
  }
  if(body.action==='automaticEvidence'){
    if(!/^automation:position:[0-9a-f]{64}$/.test(body.key||''))throw httpError(400,'Choose a tracked position.');
    const record=await store.get(body.key);if(!record)throw httpError(404,'This position observation was not found.');
    return {record};
  }
  const status=await automaticStatus(store,env);
  if(status.status==='paused')return {status:'paused',reply:'Automatic tracking is paused. Resume it to check again.'};
  if(automationEnabled(env)&&status.latest&&autoFresh(status.latest.checkedAt,Date.now()))
    return {status:status.latest.status,mode:'automatic_review',reply:status.latest.reply,automatic:status};
  if(await store.increment('automation:manual:minute',60)>3)throw httpError(429,'A live check is already queued. Please wait a minute.');
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  if(await store.increment('automation:manual:day:'+day,172800)>5)throw httpError(429,'Today’s manual checks have reached their limit. Automatic tracking continues.');
  return {...await dispatchAutomaticObservation({env,store,manual:true}),mode:'automatic_review',automatic:status};
}
