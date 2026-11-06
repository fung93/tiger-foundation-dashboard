/* Investment policy is separate from notification defaults and the Lending
   page's intentional per-visit settings. Only authenticated owner UI actions
   may draft and explicitly confirm a version; no model tool mutates policy. */
import { createHash, randomUUID } from 'node:crypto';
import { MARKETS } from '../morpho-core.mjs';
import { httpError } from './_agent-http.mjs';

export const AGENT_POLICY_SCHEMA = 'agent-policy.v1';
export const AGENT_ANALYSIS_TYPES = Object.freeze(['portfolio', 'lending', 'lp', 'kat', 'research', 'strategy']);
const FIELDS = new Set(['horizonDays', 'minLiquidReserveUsd', 'exposureLimits', 'eligibleAssets',
  'eligibleProtocols', 'marketLimits', 'lpReviewTriggers', 'allowedAnalysisTypes', 'reviewFrequencyDays']);
const CURRENT = 'policy:current', ACTIVE = 'policy:draft:active', DRAFT_TTL = 86400;
const bad = message => httpError(400, message || 'Choose valid strategy policy fields.');
const conflict = message => httpError(409, message);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = (value, lo, hi) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,63}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const versionKey = version => 'policy:version:' + String(version).padStart(12, '0');
const timestamp = now => {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value <= 0) throw bad('A valid policy time is required.');
  return value;
};
function authorize(source) {
  if (source !== 'owner') throw httpError(403, 'Only a direct authenticated owner request can change strategy policy.', 'authentication_failed');
}
function list(value, field) {
  if (!Array.isArray(value) || value.length > 30 || value.some(item => !identifier(item))) throw bad('Choose valid ' + field + '.');
  const rows = value.map(item => item.trim());
  if (new Set(rows.map(item => item.toLowerCase())).size !== rows.length) throw bad('Remove duplicate ' + field + '.');
  return rows;
}
function marketLimits(value) {
  if (!plain(value) || Object.keys(value).length > MARKETS.length) throw bad('Choose valid per-market policy limits.');
  const result = {};
  for (const [key, limits] of Object.entries(value)) {
    const market = MARKETS.find(row => row.key === key || row.id === key);
    if (!market || !plain(limits) || Object.keys(limits).some(field => !['targetHealth', 'maxLtvPct'].includes(field)))
      throw bad('Choose a known lending market and policy limit.');
    if (Object.hasOwn(result, market.key)) throw bad('Each lending market can appear only once.');
    const entry = {};
    if (limits.targetHealth !== undefined && limits.targetHealth !== null) {
      if (!finite(limits.targetHealth, 1, 100)) throw bad('Policy target health must be between 1 and 100.');
      entry.targetHealth = limits.targetHealth;
    }
    if (limits.maxLtvPct !== undefined && limits.maxLtvPct !== null) {
      if (!finite(limits.maxLtvPct, Number.MIN_VALUE, market.lltv * 100))
        throw bad('Policy maximum LTV must be positive and within this market\'s LLTV.');
      entry.maxLtvPct = limits.maxLtvPct;
    }
    result[market.key] = entry;
  }
  return result;
}
function normalizeField(field, value) {
  if (value === null) return null;
  if (['horizonDays', 'reviewFrequencyDays'].includes(field)) {
    if (!Number.isInteger(value) || value < 1 || value > 365) throw bad('Choose a policy horizon and review interval from 1 to 365 days.');
    return value;
  }
  if (field === 'minLiquidReserveUsd') {
    if (!finite(value, 0, 1e9)) throw bad('Choose a nonnegative liquid reserve in USD.');
    return value;
  }
  if (field === 'exposureLimits') {
    if (!plain(value) || Object.keys(value).length > 30) throw bad('Choose valid exposure percentage limits.');
    const result = {};
    for (const [asset, percent] of Object.entries(value)) {
      if (!identifier(asset) || !finite(percent, 0, 100)) throw bad('Exposure limits are percentages from 0 through 100.');
      const symbol = asset.toUpperCase();
      if (Object.hasOwn(result, symbol)) throw bad('Each exposure asset can appear only once.');
      result[symbol] = percent;
    }
    return result;
  }
  if (field === 'eligibleAssets' || field === 'eligibleProtocols') return list(value, field === 'eligibleAssets' ? 'eligible assets' : 'eligible protocols');
  if (field === 'allowedAnalysisTypes') {
    const types = list(value, 'analysis types');
    if (types.some(type => !AGENT_ANALYSIS_TYPES.includes(type))) throw bad('Choose supported analysis types.');
    return types;
  }
  if (field === 'marketLimits') return marketLimits(value);
  if (field === 'lpReviewTriggers') {
    const ranges = { priceMovePct: [Number.MIN_VALUE, 10000], rewardChangePct: [Number.MIN_VALUE, 10000], maxOutOfRangeHours: [0, 8760] };
    if (!plain(value) || Object.keys(value).some(key => key !== 'outOfRange' && !Object.hasOwn(ranges, key))) throw bad('Choose supported LP review triggers.');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null) continue;
      if (key === 'outOfRange') { if (typeof item !== 'boolean') throw bad('Choose whether to review out-of-range LPs.'); }
      else if (!finite(item, ...ranges[key])) throw bad('Choose valid LP review trigger values.');
      result[key] = item;
    }
    return result;
  }
  throw bad();
}
export function normalizeAgentPolicyPatch(patch) {
  if (!plain(patch) || Object.keys(patch).length > FIELDS.size || Object.keys(patch).some(key => !FIELDS.has(key))) throw bad();
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, normalizeField(field, value)]));
}
function validateConstraints(value) {
  const patch = normalizeAgentPolicyPatch(value);
  if (Object.values(patch).includes(null)) throw bad('A stored policy has invalid unset fields.');
  return patch;
}
export async function getAgentPolicy(store) {
  const policy = await store.get(CURRENT);
  if (!policy) return { schemaVersion: AGENT_POLICY_SCHEMA, version: 0, status: 'unconfirmed', constraints: {} };
  if (policy.schemaVersion !== AGENT_POLICY_SCHEMA || policy.status !== 'confirmed'
    || !Number.isSafeInteger(policy.version) || policy.version < 1 || !plain(policy.constraints))
    throw httpError(503, 'The saved strategy policy could not be verified.', 'data_unavailable');
  try { validateConstraints(policy.constraints); }
  catch { throw httpError(503, 'The saved strategy policy could not be verified.', 'data_unavailable'); }
  return policy;
}
const previewHash = draft => createHash('sha256').update(JSON.stringify({
  draftId: draft.draftId, baseVersion: draft.baseVersion, constraints: draft.constraints, changes: draft.changes,
})).digest('hex');
async function withPolicyLock(store, work) {
  const lock = await store.lock('policy', 30);
  if (!lock) throw conflict('Another strategy policy update is being saved. Try again shortly.');
  try { return await work(lock); } finally { await lock.release(); }
}
export async function draftAgentPolicy(store, patch, { expectedVersion, source, now = Date.now } = {}) {
  authorize(source);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw bad('Include the policy version you are editing.');
  const normalized = normalizeAgentPolicyPatch(patch), at = timestamp(now);
  return withPolicyLock(store, async lock => {
    const policy = await getAgentPolicy(store);
    if (policy.version !== expectedVersion) throw conflict('The strategy policy changed. Review its current version before drafting again.');
    const constraints = { ...policy.constraints }, changes = [];
    for (const [field, after] of Object.entries(normalized)) {
      const before = Object.hasOwn(constraints, field) ? constraints[field] : null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after === null) delete constraints[field]; else constraints[field] = after;
      changes.push({ field, before, after });
    }
    if (!changes.length) throw bad('Change at least one policy field before requesting a preview.');
    const draft = { schemaVersion: AGENT_POLICY_SCHEMA, draftId: randomUUID(), baseVersion: policy.version,
      status: 'draft', source: 'owner', constraints, changes, createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + DRAFT_TTL * 1000).toISOString() };
    draft.previewHash = previewHash(draft);
    await lock.commit([{ key: 'policy:draft:' + draft.draftId, value: draft, immutable: true, ttlSeconds: DRAFT_TTL },
      { key: ACTIVE, value: draft.draftId, ttlSeconds: DRAFT_TTL }]);
    return draft;
  });
}
export async function confirmAgentPolicy(store, draftId, { source, now = Date.now } = {}) {
  authorize(source);
  if (typeof draftId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId)) throw bad('Choose the policy preview to confirm.');
  const at = timestamp(now);
  return withPolicyLock(store, async lock => {
    const policy = await getAgentPolicy(store);
    if (policy.confirmedDraftId === draftId) return policy;
    const [active, draft] = await Promise.all([store.get(ACTIVE), store.get('policy:draft:' + draftId)]);
    if (active !== draftId || !draft || draft.draftId !== draftId || draft.source !== 'owner' || draft.status !== 'draft'
      || draft.schemaVersion !== AGENT_POLICY_SCHEMA || draft.baseVersion !== policy.version
      || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) <= at)
      throw conflict('This policy preview expired or was replaced. Create and review a new preview.');
    try { validateConstraints(draft.constraints); }
    catch { throw conflict('This policy preview could not be verified. Create a new preview.'); }
    if (draft.previewHash !== previewHash(draft)) throw conflict('This policy preview changed. Create a new preview.');
    if (policy.version === Number.MAX_SAFE_INTEGER) throw conflict('The strategy policy version limit has been reached.');
    const confirmed = { schemaVersion: AGENT_POLICY_SCHEMA, id: 'policy:' + (policy.version + 1), version: policy.version + 1,
      previousVersion: policy.version, status: 'confirmed', constraints: draft.constraints,
      createdAt: draft.createdAt, confirmedAt: new Date(at).toISOString(), confirmedDraftId: draftId,
      previewHash: draft.previewHash, source: 'owner' };
    await lock.commit([{ key: versionKey(confirmed.version), value: confirmed, immutable: true },
      { key: CURRENT, value: confirmed }, { key: ACTIVE, remove: true }]);
    return confirmed;
  });
}
export async function listAgentPolicies(store, options = {}) {
  const page = await store.list('policy:version:', { ...options, reverse: true });
  return { items: page.items.map(row => row.value), cursor: page.cursor };
}
