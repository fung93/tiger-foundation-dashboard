/* Operational automation controls are independent of investment policy. Defaults
   are observational assumptions, never an inferred or auto-confirmed risk mandate. */
import { createHash } from 'node:crypto';
import { readAgentState } from './_agent-store.mjs';
import { getSettings } from './_agent-settings.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { httpError } from './_agent-http.mjs';

export const AUTO_SCHEMA = 'agent-automation-v1';
export const AUTO_DEFAULTS = Object.freeze({ enabled: true });
export const AUTO_LIMITS = Object.freeze({ intervalMs: 300000, positions: 30, poolSamples: 96, hours: 31 * 24,
  nearEdgePct: 10, hourlyMovePct: 3, hourlyVolatilityPct: 3, liquidityDropPct: 30, rewardDropPct: 25,
  alertCooldownMs: 3600000, proposalDays: 1, historyVersion: 1 });
export const autoHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const autoFresh = (ts, now) => Number.isFinite(Date.parse(ts)) && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) < 90000;
export const autoPaused = (settings, now) => !!settings.pausedUntil && Date.parse(settings.pausedUntil) > now;
export function automaticControls(saved) {
  if (!saved) return { schemaVersion: AUTO_SCHEMA, revision: 0, ...AUTO_DEFAULTS };
  if (saved.schemaVersion !== AUTO_SCHEMA || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.enabled !== 'boolean')
    throw httpError(503, 'Automatic tracking settings need checking.');
  return saved;
}
export async function automaticInputs(store, extras = []) {
  const raw = await readAgentState(store, [...new Set(['automation:controls','settings','policy:current',...extras])]);
  const view = { get: async key => raw[key] };
  return {raw,controls:automaticControls(raw['automation:controls']),settings:await getSettings(view),policy:await getAgentPolicy(view)};
}
export const automationEnabled = env => env.AGENT_AUTOMATION_ENABLED !== 'false';
export async function automaticStatus(store, env = {}, { now = Date.now() } = {}) {
  const {raw,controls,settings} = await automaticInputs(store,['automation:latest','automation:lastTick','automation:lastScheduledTick','automation:pending']);
  const latest = raw['automation:latest'], tick = raw['automation:lastTick'], configured = typeof env.PORTFOLIO_REVIEWS?.create === 'function';
  const schedulerConfigured = typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 24;
  const paused = !controls.enabled || autoPaused(settings,now);
  return {schemaVersion:AUTO_SCHEMA,controls,configured,schedulerConfigured,enabled:automationEnabled(env),
    status:!automationEnabled(env)?'disabled':paused?'paused':!configured?'setup_required'
      :!latest?'waiting_first_reading':now-Date.parse(latest.checkedAt)>Math.max(600000,(latest.intervalMinutes||5)*120000)?'stale':latest.status,
    lastAttempt:tick?.ts||null,lastScheduledAttempt:raw['automation:lastScheduledTick']?.ts||null,lastSuccess:latest?.lastSuccess||null,
    nextIntendedCheck:paused||!configured||!automationEnabled(env)||!schedulerConfigured?null:latest?.nextIntendedCheck|| (tick?.ts?new Date(Date.parse(tick.ts)+AUTO_LIMITS.intervalMs).toISOString():null),
    latest:latest?{...latest,current:now-Date.parse(latest.checkedAt)>=-30000&&now-Date.parse(latest.checkedAt)<Math.max(600000,(latest.intervalMinutes||5)*120000)}:null,
    intervalMinutes:latest?.intervalMinutes||5,
    queuedDelivery:(raw['automation:pending']||[]).length};
}
export async function saveAutomaticControls(store, body, { now = Date.now() } = {}) {
  if (!body || Object.keys(body).some(key=>!['enabled','expectedRevision'].includes(key)) || typeof body.enabled !== 'boolean'
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw httpError(400,'Reload automatic tracking before changing it.');
  const lease=await store.lock('owner',15);if(!lease)throw httpError(409,'A private update is finishing.');
  try{const current=automaticControls(await store.get('automation:controls'));
    if(current.revision!==body.expectedRevision)throw httpError(409,'Automatic tracking changed. Reload it.');
    await lease.commit([{key:'automation:controls',value:{...current,enabled:body.enabled,revision:current.revision+1,updatedAt:new Date(now).toISOString()}}]);
  }finally{await lease.release();}
}
export async function dispatchAutomaticObservation({env={},store,manual=false,now=Date.now()}={}) {
  if(!automationEnabled(env))return {status:'disabled',reply:'Automatic tracking is switched off.'};
  if(typeof env.PORTFOLIO_REVIEWS?.create!=='function')return {status:'setup_required',reply:'Deploy the existing background Workflow connection to start automatic tracking.'};
  const bucket=Math.floor(now/AUTO_LIMITS.intervalMs),id='observe-'+bucket+(manual?'-manual':'');
  const params={schemaVersion:1,mode:'observe',manual,requestId:id,...(manual&&store?{recipient:await store.get('telegram')||null}:{})};
  try{await env.PORTFOLIO_REVIEWS.create({id,params});}
  catch{try{await env.PORTFOLIO_REVIEWS.get(id);}catch{return {status:'dispatch_unverified',reply:'The automatic check could not be confirmed. The next scheduled check will retry.'};}}
  return {status:'queued',workflowId:id,reply:'I’m checking your live positions and LP markets. The short update will appear in Agent.'};
}
