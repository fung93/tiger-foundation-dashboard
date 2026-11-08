/* Closed local Workflow simulation with real SQLite, shared inference ledger,
   staged checkpoints and the documented Free D1 query ceiling per step. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { reviewPolicy, reviewAI, reviewLoaders, reviewFixtureFetcher, reviewContext } from './fixtures/agent-review.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { dispatchPortfolioReview } from '../api/_agent-review-dispatch.mjs';
import { executeReviewWorkflow } from '../api/_agent-review-workflow.mjs';
import { runPortfolioReview } from '../api/_agent-review-loop.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { createAgentBudget } from '../api/_agent-budget.mjs';
import { getAgentModelProfile, createAgentModelRequest } from '../api/_agent-models.mjs';
import { saveReviewControls, saveReviewPlan } from '../api/_agent-review-state.mjs';
import { compareAgentStrategies } from '../api/_agent-scenarios.mjs';
import { createStrategyReport, persistAgentReport } from '../api/_agent-reports.mjs';
import { recordAgentDecision } from '../api/_agent-decisions.mjs';

let assertions = 0, queries = 0, maxQueries = 0, now = Date.now() + 86400000;
const check = (a, b, note) => { assert.deepEqual(a, b, note); assertions++; };
const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = createAgentSQLiteFixture({ usage: true }), aiCalls = [], sourceCalls = [], instances = new Map();
const db = { prepare(sql) { const p = fixture.db.prepare(sql); return { bind(...values) {
  const s = p.bind(...values); return { ...s, ...Object.fromEntries(['first', 'all', 'run'].map(method => [method, async () => { queries++; return s[method](); }])) };
} }; }, batch: async statements => { queries++; return fixture.db.batch(statements); } };
const env = { AGENT_DB: db, AI: reviewAI(aiCalls), AGENT_ORIGIN: 'https://review.fixture.test', AGENT_AUTOMATION_ENABLED: 'false' };
const store = createAgentStore(env, { now: () => now });
let ambiguousCreate = false;
env.PORTFOLIO_REVIEWS = { create: async ({ id, params }) => {
  if (instances.has(id)) throw Error('fixture duplicate ID');
  const instance = { id, params, status: 'queued' }; instances.set(id, instance);
  if (ambiguousCreate) { ambiguousCreate = false; throw Error('fixture timeout after create'); }
  return { id };
}, get: async id => ({ status: async () => { const i = instances.get(id); if (!i) throw Error('fixture no instance'); return { status: i.status }; } }) };
const dependencies = () => ({ now: () => now, fetcher: reviewFixtureFetcher(now, sourceCalls), ...reviewLoaders(() => now, sourceCalls) });
const bounded = async (name, operation) => {
  queries = 0; const result = await operation();
  assert.ok(queries <= 50, name + ' exceeded Free D1 ceiling: ' + queries); assertions++;
  maxQueries = Math.max(maxQueries, queries); return result;
};
function steps() { const cache = new Map(); return { cache, do: async (name, options, operation) => {
  if (cache.has(name)) return cache.get(name);
  if (name === 'review-infer') check(options.retries.limit, 0, 'The AI step has no automatic inference retry');
  const result = await bounded(name, operation); cache.set(name, result);
  check(JSON.stringify(result).length < 1000, true, 'Workflow persists references rather than portfolio payloads'); return result;
} }; }
const dispatch = args => bounded('dispatch', () => dispatchPortfolioReview({ env, store, now: () => now, ...args }));
const finish = async (instance, extra = {}) => {
  instance.status = 'running';
  const result = await executeReviewWorkflow({ env, store, params: instance.params, workflowId: instance.id, step: steps(), dependencies: { ...dependencies(), ...extra } });
  instance.status = 'complete'; return result;
};
const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('No real provider in Workflow tests'); };
try {
  check((await dispatchPortfolioReview({ env: { ...env, PORTFOLIO_REVIEWS: undefined }, store, manual: true, requestId: 'missing' })).status,
    'setup_required', 'Missing Workflows never silently falls back to an oversized inline invocation');
  await store.set('policy:current', reviewPolicy());
  const first = await dispatch({ manual: true, requestId: 'first' });
  check(first.status, 'queued', 'Owner requests return immediately with a queued result');
  check(sourceCalls.length + aiCalls.length, 0, 'Dispatch reads no market APIs and spends no AI');
  await dispatch({ manual: true, requestId: 'first' });
  check(instances.size, 1, 'Duplicate clicks reuse one Workflow instance');
  await finish(instances.get(first.workflowId));
  check(aiCalls.length, 1, 'A staged review makes one accounted inference');
  const completed = await dispatch({ manual: true, requestId: 'first' });
  check(completed.report.kind, 'portfolio_review', 'Same-reference retries retrieve the durable report');
  check(instances.size, 1, 'Retrieving an existing result does not create another Workflow');
  check((await store.get('review:usage')).manual, 1, 'Six stages consume one manual allowance');

  const policy = reviewPolicy(), context = { ...await reviewContext(now), policy };
  for (let i = 0; i < 3; i++) {
    const input = { kind: 'lending', market: 'avkat-kat', targetHealth: 1.6 + i / 10, horizonDays: 7,
      annualRatePct: 5, cashUsd: 100000, gasUsd: 1, oracleMovesPct: [0, -10] };
    const result = await compareAgentStrategies({ context, input, policy, now });
    const report = createStrategyReport({ context, policy, input, result, now });
    await persistAgentReport(store, report, context.snapshot);
    await saveReviewPlan(store, { reportId: report.reportId, days: 7, expectedRevision: i }, { now });
  }
  check((await store.get('review:plans')).items.length, 3, 'Owner-confirmed cases fill the bounded recurring-plan allowance');
  now += 1000;

  // With ordinary automatic observations disabled, the existing advanced
  // full portfolio review retains its shared asynchronous runner.
  const reply = await processAgentMessage({ env, store, message: 'Review my portfolio', requestId: 'chat-review',
    loadContext: () => { throw Error('Chat must queue before reading financial APIs'); } });
  check(reply.status, 'queued', 'Natural language dashboard/Telegram reviews use asynchronous delivery');
  const chatInstance = [...instances.values()].at(-1); await finish(chatInstance);
  check((await store.get('messages')).some(m => m.source === 'review'), true, 'Background results appear in the shared conversation');

  // Simulate a process loss after a selected result was durably checkpointed.
  const resume = await dispatch({ manual: true, requestId: 'resume-selected' }), resumed = instances.get(resume.workflowId);
  for (const phase of ['prepare', 'collect', 'research', 'paper', 'infer']) await bounded(phase, () => runPortfolioReview({ env, store,
    manual: true, requestId: resumed.params.requestId, phase, ...dependencies() }));
  const beforeResume = aiCalls.length; resumed.status = 'errored';
  const recovery = await dispatch({ manual: false });
  check(recovery.workflowId.endsWith('-r1'), true, 'A known failed Workflow gets a bounded recovery instance');
  await finish(instances.get(recovery.workflowId));
  check(aiCalls.length, beforeResume, 'A restart reuses the validated selection without a second model call');

  // A policy change during inference invalidates publication and delivery.
  const changed = await dispatch({ manual: true, requestId: 'policy-race' });
  const priorReportId = (await store.get('review:state')).reportId;
  await finish(instances.get(changed.workflowId), { select: async args => {
    await store.set('policy:current', reviewPolicy(2));
    return { selection: { thesis: 'preserve_cash', choices: [] } };
  } });
  check((await store.get('review:state')).reportId, priorReportId, 'Changed preferences cannot publish an active recommendation');
  check((await store.get('review:state')).status, 'preferences_changed', 'The owner sees why the result was superseded');

  // Lost inference dispatch: retain the reserved charge and finish factually.
  now += 86400000;
  const lost = await dispatch({ manual: true, requestId: 'unknown-inference' }), lostInstance = instances.get(lost.workflowId);
  for (const phase of ['prepare', 'collect', 'research', 'paper']) await bounded(phase, () => runPortfolioReview({ env, store,
    manual: true, requestId: lostInstance.params.requestId, phase, ...dependencies() }));
  const state = await store.get('review:state'), job = await store.get(state.activeJob), profile = getAgentModelProfile(env);
  const messages = [{ role: 'user', content: 'fixture reserved interrupted review' }], request = createAgentModelRequest(profile, messages, { purpose: 'portfolio_review' });
  const ledger = createAgentBudget(env, { jobId: job.id, now: () => now });
  const attempt = await ledger.reserve({ profile, messages, request, maxOutputTokens: profile.maxOutputTokens, round: 0 });
  await store.set(job.key, { ...job, phase: 'inference_started', reservationId: attempt.reservationId });
  const beforeUnknown = aiCalls.length; lostInstance.status = 'errored';
  const recoverUnknown = await dispatch({ manual: false }); await finish(instances.get(recoverUnknown.workflowId));
  check(aiCalls.length, beforeUnknown, 'An unknown AI outcome is never dispatched again');
  check((await store.get('review:state')).status, 'verified_checks', 'Verified choices remain available without AI');
  check((await ledger.status()).reservedAttempts, 1, 'Unknown inference cost remains reserved across recovery');

  // Controls edited while work is in progress also invalidate the result.
  const controlsRace = await dispatch({ manual: true, requestId: 'controls-race' });
  await finish(instances.get(controlsRace.workflowId), { select: async () => {
    await saveReviewControls(store, { enabled: false }, 0, { now });
    return { selection: { thesis: 'preserve_cash', choices: [] } };
  } });
  check((await store.get('review:state')).status, 'preferences_changed', 'A pause cancels the in-flight result');

  // An ambiguous create always looks up the same deterministic instance.
  ambiguousCreate = true;
  const ambiguous = await dispatch({ manual: true, requestId: 'ambiguous' });
  const size = instances.size; await dispatch({ manual: true, requestId: 'ambiguous' });
  check(instances.size, size, 'An ambiguous network outcome cannot create a second Workflow');
  await finish(instances.get(ambiguous.workflowId));

  // Counts follow MYT, while the shared inference ledger remains in UTC.
  await store.set('review:usage', { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(now), automatic: 3, manual: 5 });
  check((await dispatch({ manual: true, requestId: 'over-limit' })).status, 'manual_limit', 'The fifth full manual review is the daily ceiling');
  check((await dispatch({ manual: false })).status, 'paused', 'Automatic pause is independent of manual review limits');
  check(await store.get('request:' + hash('unrelated')), null, 'The review runner touches no unrelated request cache');

  // A source outage consumes one logical daily review, with two bounded data
  // recoveries. A completed blocked report cannot fake a verified success.
  now += 86400000;
  await saveReviewControls(store, { enabled: true }, 1, { now });
  const unavailable = { loadContext: async () => ({ sources: [], lending: { status: 'unavailable', markets: [] },
    lp: { status: 'unavailable', positions: [] } }) };
  const beforeOutage = aiCalls.length, successBefore = (await store.get('review:state')).lastAutomaticSuccess;
  let outage = await dispatch({ manual: false }); await finish(instances.get(outage.workflowId), unavailable);
  check((await store.get((await store.get('review:state')).activeJob)).phase, 'waiting_data', 'Missing sources wait without AI');
  now += 300000; outage = await dispatch({ manual: false }); await finish(instances.get(outage.workflowId), unavailable);
  now += 300000; outage = await dispatch({ manual: false }); await finish(instances.get(outage.workflowId), unavailable);
  const blockedState = await store.get('review:state');
  check(blockedState.status, 'blocked', 'Repeated unavailable readings eventually finish as explicitly blocked');
  check(blockedState.lastAutomaticSuccess, successBefore, 'Unavailable readings cannot advance the last verified automatic success');
  check((await store.get('review:usage')).automatic, 1, 'Data retries consume one daily review, not three');
  check(aiCalls.length, beforeOutage, 'No source failure can spend inference on invented data');

  // Workflow failures have a separate recovery ceiling. The owner can start a
  // fresh manual review after a known terminal job exhausts that allowance.
  const exhausted = await dispatch({ manual: true, requestId: 'exhausted' });
  await bounded('exhaust-prepare', () => runPortfolioReview({ env, store, manual: true, requestId: 'exhausted', phase: 'prepare', ...dependencies() }));
  const oldJobKey = (await store.get('review:state')).activeJob;
  let crashed = instances.get(exhausted.workflowId); crashed.status = 'errored';
  for (let i = 0; i < 2; i++) { const resume = await dispatch({ manual: false }); crashed = instances.get(resume.workflowId); crashed.status = 'errored'; }
  check((await dispatch({ manual: false })).status, 'recovery_required', 'Workflow failures cannot cause unlimited recovery instances');
  const fresh = await dispatch({ manual: true, requestId: 'fresh-after-exhaustion' });
  check((await store.get(oldJobKey)).state, 'interrupted', 'A fresh owner request retires only the confirmed terminal job');
  await finish(instances.get(fresh.workflowId));
  check((await store.get('review:state')).status, 'completed', 'The owner can recover without editing private SQL or changing policy');

  // Owner feedback survives beyond the transient conversation and is loaded
  // through the original journal rather than inferred from price changes.
  const latest = await store.get('review:state'), decision = await store.get('journal:' + latest.decisionId);
  const rejected = decision.options.find(option => option.key === 'avkat-kat');
  check(!!rejected, true, 'A repayment proposal has a stable owner-feedback identity');
  await recordAgentDecision(store, { decisionId: decision.decisionId, expectedVersion: decision.version, state: 'rejected',
    choice: rejected.id, rationale: 'Use my other verified cash plan first.', requestId: 'reject-review-fixture' }, { now });
  now += 86400000;
  const learned = await dispatch({ manual: true, requestId: 'with-owner-feedback' }); await finish(instances.get(learned.workflowId));
  const learnedReport = await store.get((await store.get('review:state')).reportId);
  check(learnedReport.review.analysis.candidates.some(option => option.key === rejected.key), false, 'The next review does not repeat an owner-rejected idea');
  check(learnedReport.review.analysis.feedback.some(entry => entry.state === 'rejected'), true, 'The new immutable analysis retains the rejection provenance');
  now += 1000;
  const afterObservation = await dispatch({ manual: true, requestId: 'after-owner-observation' }); await finish(instances.get(afterObservation.workflowId));
  const followupReport = await store.get((await store.get('review:state')).reportId);
  check(followupReport.review.analysis.candidates.some(option => option.kind === 'range'), true, 'Observing one rejected choice cannot silently reject the owner’s unrelated LP ideas');
  check(followupReport.review.analysis.candidates.some(option => option.key === rejected.key), false, 'The exact rejection survives after the original journal gains follow-up observations');
  const prunedId = (await store.get('review:dispatch')).workflowId;
  instances.delete(prunedId);
  const afterPrune = await dispatch({ manual: true, requestId: 'after-workflow-retention' });
  check(afterPrune.workflowId !== prunedId && instances.has(afterPrune.workflowId), true, 'Pruned Workflow history cannot strand the durable review runner');
  await finish(instances.get(afterPrune.workflowId));
  check((await store.get('policy:current')).version, 2, 'Learning never edits the confirmed investment policy');
  console.log('Recurring review Workflow, recovery and Free D1 ceiling: ' + assertions + ' assertions passed (max ' + maxQueries + ' D1 calls/step).');
} finally { globalThis.fetch = oldFetch; fixture.close(); }
