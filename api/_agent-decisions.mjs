/* Append-only owner journal. Acceptance records a review, never execution. */
import { createHash, randomUUID } from 'node:crypto';
import { httpError } from './_agent-http.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { amountsPerLiquidity } from '../strategy-core.mjs';
import { currentReviewObservation, observeReviewFollowUp } from './_agent-review-analysis.mjs';
const SCHEMA = 'agent-decision-v1';
const STATES = new Set(['proposed','accepted_for_review','rejected','deferred','superseded','invalidated']);
const hash = x => createHash('sha256').update(x).digest('hex');
const validId = id => typeof id === 'string' && /^decision:[0-9TZ:.\-]+:[0-9a-f]{32}$/.test(id);
const fail = message => { throw httpError(400, message); };
const text = (value, max = 2000) => value == null ? '' : typeof value === 'string' && value.length <= max ? value.trim() : fail('The journal text is too long or invalid.');
const idCheck = id => { if (!validId(id)) fail('Choose a saved decision.'); };
const eventPrefix = id => 'journal:event:' + id + ':';
export async function proposeAgentDecision(store, report) {
  if (report?.schemaVersion !== 'agent-report-v1' || !report.reportId || !Array.isArray(report.calculationIds))
    throw httpError(503, 'Only a validated saved brief can enter the journal.');
  const id = 'decision:' + report.createdAt + ':' + hash(report.reportId).slice(0,32), key = 'journal:' + id;
  const lease = await store.lock(id, 15);
  if (!lease) throw httpError(409, 'This journal entry is being saved.');
  try {
    const existing = await store.get(key); if (existing) return existing;
    const record = { schemaVersion: SCHEMA, decisionId: id, version: 1, state: 'proposed',
      createdAt: report.createdAt, updatedAt: report.createdAt, reportId: report.reportId,
      snapshotId: report.snapshotId, policyVersion: report.policyVersion, modelProfileVersion: report.modelProfileVersion,
      kind: report.kind, thesis: report.thesis || report.objective, catalysts: report.catalysts || [],
      invalidationConditions: report.invalidationConditions || [], reviewAt: report.result?.reviewAt || report.nextReviewAt,
      options: (report.options || []).map(option => ({ id: option.id, label: option.label, status: option.status, ...(option.key ? { key: option.key } : {}) })),
      assessment: report.assessment, sourceIds: report.sourceIds, calculationIds: report.calculationIds,
      execution: 'No transaction recorded. Acceptance is for review only.' };
    const event = { schemaVersion: SCHEMA, eventId: eventPrefix(id) + '000001', decisionId: id,
      version: 1, type: 'proposal', state: 'proposed', provenance: 'validated_report', ts: report.createdAt, baseline: record };
    await lease.commit([{ key, value: record }, { key: event.eventId, value: event, immutable: true }]);
    return record;
  } finally { await lease.release(); }
}
export async function listAgentDecisions(store, { cursor = null, limit = 10 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('Choose a journal page of at most twenty entries.');
  const page = await store.list('journal:decision:', { cursor, limit, reverse: true });
  const policy = await getAgentPolicy(store);
  return { ...page, items: page.items.map(({ value }) => ({ ...value,
    reviewStatus: value.policyVersion !== policy.version ? 'superseded_policy'
      : value.reviewAt && Date.parse(value.reviewAt) <= Date.now() ? 'due' : 'scheduled' })) };
}
export async function getAgentDecision(store, id, { cursor = null, limit = 20 } = {}) {
  idCheck(id); const decision = await store.get('journal:' + id);
  if (!decision) throw httpError(404, 'This journal entry was not found.');
  const events = await store.list(eventPrefix(id), { cursor, limit });
  return { decision, events: events.items.map(item => item.value), cursor: events.cursor };
}
export async function recordAgentDecision(store, input, { source = 'owner', now = Date.now() } = {}) {
  if (source !== 'owner') throw httpError(403, 'Only the owner can record a decision or transaction report.');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['decisionId','expectedVersion','state','choice','rationale','outcome','transaction','requestId'].includes(key))) fail('Choose valid journal fields.');
  idCheck(input.decisionId);
  if (!STATES.has(input.state) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('Choose a valid decision state and version.');
  if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 160) fail('A journal request reference is required.');
  const rationale = text(input.rationale), outcome = text(input.outcome), choice = text(input.choice, 160);
  // A free-text transaction report is explicitly owner-reported, never verified execution.
  const transaction = text(input.transaction, 1000);
  if (!rationale) fail('Add your rationale before recording the decision.');
  const lease = await store.lock(input.decisionId, 15);
  if (!lease) throw httpError(409, 'This decision is being updated.');
  try {
    const idemKey = 'journal:request:' + hash(input.requestId), digest = hash(JSON.stringify(input));
    const prior = await store.get(idemKey);
    if (prior) { if (prior.digest !== digest) throw httpError(409, 'Use a new journal request reference.'); return prior.result; }
    const key = 'journal:' + input.decisionId, record = await store.get(key);
    if (!record) throw httpError(404, 'This journal entry was not found.');
    if (record.version !== input.expectedVersion) throw httpError(409, 'Reload this decision; a newer event exists.');
    if (choice && !record.options.some(option => option.id === choice)) fail('Choose an option from the original brief.');
    const policy = await getAgentPolicy(store);
    if (input.state === 'accepted_for_review' && record.policyVersion !== policy.version)
      throw httpError(409, 'This brief used an older policy. Create a fresh comparison before accepting review.');
    const version = record.version + 1, ts = new Date(now).toISOString();
    const event = { schemaVersion: SCHEMA, decisionId: record.decisionId, version,
      eventId: eventPrefix(record.decisionId) + String(version).padStart(6,'0'), ts, type: 'owner_decision',
      state: input.state, choice: choice || null, rationale, outcome: outcome || null,
      transaction: transaction ? { provenance: 'owner_report', description: transaction, verified: false } : null,
      provenance: 'owner', acceptanceMeans: 'review_only' };
    const next = { ...record, version, state: input.state, updatedAt: ts, latestEvent: event.eventId };
    const result = { decision: next, event };
    const entries = [{ key, value: next }, { key: event.eventId, value: event, immutable: true },
      { key: idemKey, value: { digest, result }, immutable: true }];
    let feedbackLease;
    try {
      if (record.kind === 'portfolio_review') {
        feedbackLease = await store.lock('review:feedback', 15);
        if (!feedbackLease) throw httpError(409, 'Review feedback is being saved. Retry the same decision reference.');
        const memory = await store.get('review:feedback') || [];
        // Another policy can be confirmed while this owner note is saved.
        // Retain other decisions; readers select the applicable policy version.
        const retained = memory.filter(item => item.decisionId !== record.decisionId);
        if (['rejected', 'invalidated'].includes(input.state)) for (const option of record.options.filter(option => option.key && (!choice || option.id === choice)))
          retained.push({ decisionId: record.decisionId, key: option.key, state: input.state, policyVersion: record.policyVersion,
            rationale: rationale.slice(0, 500), updatedAt: ts });
        entries.push({ key: 'review:feedback', value: retained.slice(-64) });
      }
      await lease.commit(entries, { alsoOwned: feedbackLease ? [feedbackLease] : [] });
    } finally { await feedbackLease?.release(); }
    return result;
  } finally { await lease.release(); }
}

export async function observeAgentDecision(store, id, context, { now = Date.now() } = {}) {
  idCheck(id);
  const record = await store.get('journal:' + id);
  if (!record) throw httpError(404, 'This decision was not found.');
  if (now <= Date.parse(record.createdAt)) fail('An outcome observation must follow the recorded baseline.');
  const current = context.snapshot, baseline = record.snapshotId ? await store.get(record.snapshotId) : null;
  if (!current?.snapshotId) throw httpError(503, 'No canonical observation is available.');
  await store.putImmutable(current.snapshotId, current);
  const identity = snapshot => (snapshot?.assets || []).map(asset => asset.identity || asset.assetId || asset.id).sort();
  const comparable = baseline?.status === 'complete' && current.status === 'complete'
    && JSON.stringify(identity(baseline)) === JSON.stringify(identity(current));
  const report = await store.get(record.reportId), basis = report?.result?.paperBaseline;
  if (report?.kind === 'portfolio_review') {
    const { risk, observation } = await currentReviewObservation(context, now);
    await store.putImmutable(risk.calculationId, risk);
    const reading = { schemaVersion: 'agent-review-observation-v1', ...observation, riskCalculationId: risk.calculationId,
      sources: context.sources || [] };
    const calculationId = 'reviewobs:' + hash(JSON.stringify(reading));
    await store.putImmutable(calculationId, { ...reading, calculationId });
    return recordReviewObservation(store, id, { measurementId: current.snapshotId, calculationId,
      observedAt: observation.observedAt, lessons: observeReviewFollowUp(report, observation) });
  }
  let calculation = null;
  const pool = basis && [...(context.strategy?.pools || []),...(context.strategy?.fee_pools || [])].find(pool => pool.pool === basis.pool);
  if (report?.kind === 'strategy' && report.result.kind === 'lp' && basis && pool?.status === 'fresh'
    && now - Date.parse(pool.ts) >= 0 && now - Date.parse(pool.ts) < 90000
    && [pool.token0?.usd,pool.token1?.usd,pool.sqrtPrice].every(number => Number.isFinite(number) && number > 0)
    && ['token0','token1'].every(key => pool[key].address === basis[key].address && pool[key].decimals === basis[key].decimals)) {
    const holdUsd = basis.initialAmounts.amount0 * pool.token0.usd + basis.initialAmounts.amount1 * pool.token1.usd + basis.cashUsd;
    const marks = [];
    for (const option of report.result.options) {
      if (option.status === 'blocked' || !Number.isFinite(option.cashRequiredUsd)) continue;
      let amount;
      if (option.id === 'hold') amount = basis.initialAmounts;
      else if (option.range && Number.isFinite(option.initialLiquidity) && option.initialLiquidity > 0) {
        const unit = amountsPerLiquidity(option.range.tickLower,option.range.tickUpper,pool.sqrtPrice,pool.token0.decimals,pool.token1.decimals);
        amount = { amount0: unit.amount0 * option.initialLiquidity, amount1: unit.amount1 * option.initialLiquidity };
      }
      if (!amount) continue;
      const principalUsd = amount.amount0 * pool.token0.usd + amount.amount1 * pool.token1.usd;
      const paperMarkBeforeEarningsUsd = principalUsd + basis.cashUsd - option.cashRequiredUsd;
      if (![principalUsd,paperMarkBeforeEarningsUsd,holdUsd].every(Number.isFinite)) continue;
      marks.push({ optionId:option.id,amounts:amount,principalUsd,assumedInitialCostUsd:option.cashRequiredUsd,paperMarkBeforeEarningsUsd,
        holdBenchmarkUsd:holdUsd,differenceBeforeEarningsUsd:paperMarkBeforeEarningsUsd-holdUsd });
    }
    if (marks.length) {
      const body = { schemaVersion:'agent-paper-mark-v1',reportId:report.reportId,baselineCalculationId:report.result.calculationId,
        baselineCreatedAt:report.createdAt,observedAt:pool.ts,pool,marks,convention:'Same original principal and cash; current token quotes; original initial-cost assumptions; income and realized trades excluded.' };
      calculation = { ...body,calculationId:'paper:'+hash(JSON.stringify(body)) };
      await store.putImmutable(calculation.calculationId,calculation);
    }
  }
  const event = { schemaVersion: SCHEMA, decisionId: id, eventId: eventPrefix(id) + 'observation:' + hash(JSON.stringify([current.snapshotId,calculation?.calculationId||null])).slice(0,32),
    type: 'paper_observation', ts: new Date(now).toISOString(), provenance: 'canonical_snapshot',
    baselineSnapshotId: record.snapshotId, snapshotId: current.snapshotId, policyVersion: record.policyVersion,
    status: comparable || calculation ? 'partial' : 'blocked', calculationId:calculation?.calculationId||null, marks:calculation?.marks||[],
    measurement: 'Point-in-time paper observation; no executed transaction or realized return inferred.',
    limitations: [comparable ? 'Cash flows, realized fees and matching alternative paths remain unverified; no excess return or win rate is calculated.'
      : 'Complete portfolio outcome comparison is blocked by unmatched coverage.'],
    ...(calculation ? { convention:calculation.convention,
      earningsLimit:'Paper price marks exclude unverified fees, rewards, financing and actual execution costs; no net-performance ranking or win rate.' } : {}) };
  await store.putImmutable(event.eventId, event);
  return { event: await store.get(event.eventId) };
}

export async function recordReviewObservation(store, id, { measurementId, calculationId, observedAt, lessons }) {
  idCheck(id);
  const record = await store.get('journal:' + id);
  if (!record || record.kind !== 'portfolio_review' || !Array.isArray(lessons)
    || lessons.some(lesson => lesson.sourceReportId !== record.reportId) || !Number.isFinite(Date.parse(observedAt))
    || Date.parse(observedAt) <= Date.parse(record.createdAt)) throw httpError(400, 'Choose a later verified observation for this strategy review.');
  const eventId = eventPrefix(id) + 'review-observation:' + hash(String(measurementId));
  const event = { schemaVersion: SCHEMA, eventId, decisionId: id, type: 'review_observation', provenance: 'later_verified_reading',
    ts: observedAt, status: lessons.some(lesson => lesson.status === 'observed') ? 'partial' : 'blocked',
    calculationId, baselineSnapshotId: record.snapshotId, sourceReportId: record.reportId, lessons,
    measurement: lessons.map(lesson => lesson.message).join('\n') || 'A matching later reading is not available.',
    limitations: ['These are point-in-time checks of recorded ideas; execution, realized net performance and win rates are not inferred.'] };
  await store.putImmutable(eventId, event);
  return { event: await store.get(eventId) };
}
