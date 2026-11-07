/* Private recurring-review controls and owner-confirmed rolling comparisons.
   Operational choices never write investment policy or Lending page settings. */
import { createHash } from 'node:crypto';
import { httpError } from './_agent-http.mjs';
import { getSettings } from './_agent-settings.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { validateAgentComparison } from './_agent-scenarios.mjs';
import { mytDayAndTime } from './_agent-notifications.mjs';
import { renderPortfolioReview } from './_agent-review-analysis.mjs';
import { readAgentState } from './_agent-store.mjs';

export const REVIEW_SCHEMA = 'agent-recurring-review-v1';
export const REVIEW_LIMITS = Object.freeze({ automaticPerDay: 3, manualPerDay: 5, eventCooldownMs: 4 * 3600000,
  signalAgeMs: 30 * 60000, plans: 3, previousReviews: 3, findings: 12, candidates: 12, researchDocuments: 2 });
export const REVIEW_DEFAULTS = Object.freeze({ enabled: true, eventReviews: true, dailyTime: null, delivery: 'inherit', research: true });
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw httpError(400, message); };
export const reviewPaused = (settings, now) => !!settings.pausedUntil && Date.parse(settings.pausedUntil) > now;
export function reviewFeatureEnabled(env) { return env.AGENT_REVIEW_ENABLED !== 'false' && env.AGENT_STRATEGY_ENABLED !== 'false'; }
export function normalizeReviewControls(input, { partial = false } = {}) {
  if (!plain(input) || Object.keys(input).some(key => !Object.hasOwn(REVIEW_DEFAULTS, key))) fail('Choose valid automatic review settings.');
  const out = partial ? {} : { ...REVIEW_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (['enabled', 'eventReviews', 'research'].includes(key) && typeof value !== 'boolean') fail('Choose whether this review option is enabled.');
    if (key === 'dailyTime' && value !== null && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) fail('Choose a review time in MYT.');
    if (key === 'delivery' && !['inherit', 'dashboard', 'telegram'].includes(value)) fail('Choose where strategy reviews should appear.');
    out[key] = value;
  }
  return out;
}
export async function getReviewControls(store) {
  const saved = await store.get('review:controls');
  if (!saved) return { schemaVersion: REVIEW_SCHEMA, revision: 0, ...REVIEW_DEFAULTS };
  if (saved.schemaVersion !== REVIEW_SCHEMA || !Number.isSafeInteger(saved.revision) || saved.revision < 1)
    throw httpError(503, 'Automatic review settings could not be verified. Automatic analysis has stopped.');
  return { ...saved, ...normalizeReviewControls(Object.fromEntries(Object.keys(REVIEW_DEFAULTS).map(key => [key, saved[key]]))) };
}
export async function saveReviewControls(store, patch, expectedRevision, { now = Date.now() } = {}) {
  const changes = normalizeReviewControls(patch, { partial: true });
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Reload automatic review settings before saving.');
  const owner = await store.lock('owner', 15);
  if (!owner) throw httpError(409, 'A private update is finishing. Please try again.');
  try {
    const current = await getReviewControls(store);
    if (current.revision !== expectedRevision) throw httpError(409, 'Review settings changed. Reload them before saving.');
    const settings = { ...current, ...changes, revision: current.revision + 1, updatedAt: new Date(now).toISOString() };
    await owner.commit([{ key: 'review:controls', value: settings }]);
    return settings;
  } finally { await owner.release(); }
}
export async function getReviewPlans(store) {
  const saved = await store.get('review:plans');
  if (!saved) return { revision: 0, items: [] };
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || !Array.isArray(saved.items) || saved.items.length > REVIEW_LIMITS.plans)
    throw httpError(503, 'Saved comparison assumptions could not be verified.');
  return saved;
}
export async function loadReviewInputs(store, extra = []) {
  const raw = await readAgentState(store, [...new Set(['review:controls', 'review:plans', 'settings', 'policy:current', ...extra])]);
  const view = { get: async name => raw[name] };
  return { raw, controls: await getReviewControls(view), plans: await getReviewPlans(view),
    settings: await getSettings(view), policy: await getAgentPolicy(view) };
}
export async function saveReviewPlan(store, { reportId, days, expectedRevision }, { now = Date.now() } = {}) {
  if (typeof reportId !== 'string' || reportId.length > 160 || !/^report:[0-9TZ:.\-]+:[0-9a-f-]{36}$/.test(reportId)
    || !Number.isInteger(days) || days < 1 || days > 30 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    fail('Choose a recent comparison and assumption validity from 1 to 30 days.');
  const report = await store.get(reportId);
  if (report?.schemaVersion !== 'agent-report-v1' || report.kind !== 'strategy' || !report.comparisonInput)
    fail('Run a new comparison before saving its assumptions for recurring reviews.');
  const input = structuredClone(validateAgentComparison(report.comparisonInput));
  const policyLease = await store.lock('policy', 15), owner = policyLease && await store.lock('owner', 15);
  if (!owner || !policyLease) { await policyLease?.release(); throw httpError(409, 'A private update is finishing. Please try again.'); }
  try {
    const plans = await getReviewPlans(store), policy = await getAgentPolicy(store);
    if (plans.revision !== expectedRevision) throw httpError(409, 'Saved assumptions changed. Reload before saving.');
    if (policy.status !== 'confirmed' || report.policyVersion !== policy.version) fail('Confirm your policy and run a comparison with those preferences first.');
    const id = 'plan:' + hash(reportId).slice(0, 24), existing = plans.items.find(item => item.id === id);
    if (!existing && plans.items.length >= REVIEW_LIMITS.plans) fail('Keep at most three recurring comparisons. Remove an older one first.');
    const entry = { id, reportId, decisionId: 'decision:' + report.createdAt + ':' + hash(reportId).slice(0, 32),
      kind: input.kind, label: (report.thesis || 'Repeat ' + input.kind + ' comparison').slice(0, 240),
      input, policyVersion: policy.version, confirmedAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString(), provenance: 'owner_confirmed_assumptions' };
    const next = { revision: plans.revision + 1, items: [...plans.items.filter(item => item.id !== id), entry] };
    await owner.commit([{ key: 'review:plans', value: next }], { alsoOwned: [policyLease] });
    return next;
  } finally { await policyLease.release(); await owner.release(); }
}
export async function removeReviewPlan(store, id, expectedRevision) {
  if (typeof id !== 'string' || !/^plan:[0-9a-f]{24}$/.test(id) || !Number.isSafeInteger(expectedRevision)) fail('Choose a saved recurring comparison.');
  const owner = await store.lock('owner', 15);
  if (!owner) throw httpError(409, 'A private update is finishing. Please try again.');
  try {
    const current = await getReviewPlans(store);
    if (current.revision !== expectedRevision) throw httpError(409, 'Saved assumptions changed. Reload before removing one.');
    const next = { revision: current.revision + 1, items: current.items.filter(item => item.id !== id) };
    await owner.commit([{ key: 'review:plans', value: next }]); return next;
  } finally { await owner.release(); }
}
export function isPortfolioReviewQuestion(message) {
  if (typeof message !== 'string' || message.length > 4000) return false;
  const text = message.replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g, ' ').trim();
  if (/^\/(?:review|strategy)(?:@[a-z0-9_]+)?$/i.test(text)) return true;
  if (/strategy policy|如何使用|是什么/i.test(text) || /\bagent\b/i.test(text) && /how (?:does|can|do)|what (?:is|are|can)/i.test(text)) return false;
  return /\b(?:review|analyse|analyze|assess)\b.{0,35}\b(?:portfolio|investment strategy)\b/i.test(text)
    || /\b(?:give|suggest|recommend|develop)\b.{0,35}\b(?:investment|portfolio) strateg(?:y|ies)\b/i.test(text)
    || /\b(?:portfolio|holdings)\b/i.test(text) && /\b(?:strategy|strategies|advice|improve|should)\b/i.test(text)
    || /分析(?:一下)?(?:我的)?投资组合|检视(?:我的)?投资组合|cadangkan strategi pelaburan/iu.test(text);
}
export function reviewDue({ controls, notificationSettings, policy, state = {}, usage = {}, signals = [], now, manual = false }) {
  const day = mytDayAndTime(now), counts = usage.date === day.day ? usage : { date: day.day, automatic: 0, manual: 0 };
  if (![counts.automatic, counts.manual].every(value => Number.isSafeInteger(value) && value >= 0))
    throw httpError(503, 'The daily review counters could not be verified. Automatic analysis has stopped.');
  if (policy.status !== 'confirmed') return { due: false, reason: 'policy_required', day, counts };
  if (manual) return counts.manual >= REVIEW_LIMITS.manualPerDay ? { due: false, reason: 'manual_limit', day, counts }
    : { due: true, kind: 'manual', day, counts };
  if (!controls.enabled || reviewPaused(notificationSettings, now)) return { due: false, reason: 'paused', day, counts };
  if (counts.automatic >= REVIEW_LIMITS.automaticPerDay) return { due: false, reason: 'daily_limit', day, counts };
  const dailyTime = controls.dailyTime || notificationSettings.dailyTime;
  if (day.time >= dailyTime && state.dailyDate !== day.day) return { due: true, kind: 'daily', day, counts };
  const lastReview = state.lastReviewAt || state.lastAutomaticAt;
  if (!controls.eventReviews || (lastReview && now - Date.parse(lastReview) < REVIEW_LIMITS.eventCooldownMs))
    return { due: false, reason: 'not_due', day, counts };
  const recent = signals.filter(item => ['lending', 'lp', 'review'].includes(item.type) && item.status === 'active'
    && Date.parse(item.ts) > Date.parse(state.lastAutomaticAt || '1970-01-01') && now - Date.parse(item.ts) >= 0
    && now - Date.parse(item.ts) < REVIEW_LIMITS.signalAgeMs).slice(-6);
  return recent.length ? { due: true, kind: 'event', day, counts, signalIds: recent.map(item => item.id) }
    : { due: false, reason: 'not_due', day, counts };
}
export function nextReviewTime(controls, settings, state, now) {
  if (!controls.enabled || reviewPaused(settings, now)) return null;
  const day = mytDayAndTime(now), time = controls.dailyTime || settings.dailyTime;
  let at = Date.parse(day.day + 'T' + time + ':00+08:00');
  if (at <= now) at = state?.dailyDate === day.day ? at + 86400000 : now + 300000;
  return new Date(at).toISOString();
}
export async function reviewStatus(store, env = {}, { now = Date.now() } = {}) {
  const { controls, settings, policy, plans, raw } = await loadReviewInputs(store,
    ['review:state', 'review:usage', 'review:pending', 'monitor:pending', 'review:lastTick', 'review:dispatch']);
  const state = raw['review:state'], usage = raw['review:usage'], pending = raw['review:pending'],
    outbox = raw['monitor:pending'], tick = raw['review:lastTick'], dispatch = raw['review:dispatch'];
  const enabled = reviewFeatureEnabled(env), saved = state?.reportId ? await store.get(state.reportId) : null;
  const latest = saved && saved.policyVersion !== policy.version ? { ...saved, status: 'superseded' } : saved;
  const active = state?.activeJob ? await store.get(state.activeJob) : null;
  return { schemaVersion: REVIEW_SCHEMA, featureEnabled: enabled, controls,
    status: !enabled ? 'disabled' : policy.status !== 'confirmed' ? 'policy_required'
      : dispatch?.state === 'recovery_required' ? 'recovery_required' : active?.state === 'running' ? active.phase
        : dispatch && (controls.enabled || dispatch.params?.manual) && ['queued', 'dispatching'].includes(dispatch.state) && (!(state?.lastCompletedAt || state?.lastSuccess)
          || Date.parse(dispatch.createdAt) > Date.parse(state.lastCompletedAt || state.lastSuccess)) ? 'queued'
          : !controls.enabled ? 'paused' : state?.status || 'waiting_first_review',
    dailyTime: controls.dailyTime || settings.dailyTime, nextIntendedReview: enabled ? nextReviewTime(controls, settings, state, now) : null,
    usage: usage?.date === mytDayAndTime(now).day ? usage : { date: mytDayAndTime(now).day, automatic: 0, manual: 0 },
    limits: { automatic: REVIEW_LIMITS.automaticPerDay, manual: REVIEW_LIMITS.manualPerDay },
    lastAttempt: state?.lastAttempt || null, lastSuccess: state?.lastSuccess || null, lastDelivery: state?.lastDelivery || null,
    lastAutomaticSuccess: state?.lastAutomaticSuccess || null, lastSchedulerTick: tick?.ts || null,
    schedulerConfigured: typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 24,
    workflowConfigured: typeof env.PORTFOLIO_REVIEWS?.create === 'function',
    pendingDelivery: (Array.isArray(pending) ? pending.length : 0) + (outbox?.kind === 'strategy_reviews' ? Math.max(0, outbox.items.length - outbox.itemIndex) : 0),
    latestReport: latest?.kind === 'portfolio_review' ? latest : null,
    latestReply: latest?.kind === 'portfolio_review' ? renderPortfolioReview(latest, { now }) : null,
    decisionId: state?.decisionId || null, plans: { revision: plans.revision, items: plans.items.map(({ input, ...entry }) => ({ ...entry,
      status: entry.policyVersion !== policy.version ? 'preferences_changed' : Date.parse(entry.expiresAt) <= now ? 'expired' : 'active' })) } };
}
