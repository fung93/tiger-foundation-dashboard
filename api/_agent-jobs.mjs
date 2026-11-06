/* Synchronous, bounded jobs only. A lost invocation is never silently replayed.
   No waitUntil queue or Workflow runner is advertised. */
import { createHash } from 'node:crypto';
import { httpError } from './_agent-http.mjs';
export const JOB_RETENTION_SECONDS = 30 * 86400;
export const agentJobKey = id => 'job:' + createHash('sha256').update(id).digest('hex');
export async function beginAgentJob(store, lease, { id, kind, inputHash, policyVersion, now = Date.now() }) {
  const key = agentJobKey(id), prior = await store.get(key);
  if (prior) {
    if (prior.inputHash !== inputHash) throw httpError(409, 'Use a new request reference for changed input.');
    if (prior.state === 'running') {
      await lease.commit([{ key, value: { ...prior, state: 'interrupted', phase: 'outcome_unknown',
        updatedAt: new Date(now).toISOString() }, ttlSeconds: JOB_RETENTION_SECONDS }]);
    }
    throw httpError(409, 'This request already ran or was interrupted. No inference was repeated. Send a new request for a fresh review.');
  }
  const job = { schemaVersion: 'agent-job-v1', id, kind, inputHash, policyVersion, state: 'running',
    phase: 'collecting', execution: 'bounded_synchronous', attempts: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  await lease.commit([{ key, value: job, ttlSeconds: JOB_RETENTION_SECONDS }]);
  return { key, job };
}
export function jobWrite(handle, state, extra = {}) {
  return { key: handle.key, value: { ...handle.job, ...extra, state, phase: state,
    updatedAt: new Date().toISOString() }, ttlSeconds: JOB_RETENTION_SECONDS };
}
export async function agentJobPhase(lease, handle, phase) {
  if (!['collecting','retrieving','calculating','inference','validating','persisting'].includes(phase)) throw Error('Unknown job phase');
  handle.job = { ...handle.job, phase, updatedAt:new Date().toISOString() };
  await lease.commit([{key:handle.key,value:handle.job,ttlSeconds:JOB_RETENTION_SECONDS}]);
}
