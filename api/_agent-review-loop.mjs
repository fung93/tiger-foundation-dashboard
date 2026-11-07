/* Bounded Workflow review stages with durable checkpoints. Risk monitoring
   uses its own lease and never waits on this inference or a long owner lock. */
import { createHash, randomUUID } from 'node:crypto';
import { createAgentStore } from './_agent-store.mjs';
import { getSettings } from './_agent-settings.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { getAgentOrigin, httpError, agentErrorCategory } from './_agent-http.mjs';
import { loadAgentContext, loadAgentSupplementalContext } from './_agent-context.mjs';
import { createAgentBudget } from './_agent-budget.mjs';
import { researchProtocol } from './_agent-evidence.mjs';
import { createResearchReport, persistAgentReport, getAgentReport } from './_agent-reports.mjs';
import { observeAgentDecision, recordReviewObservation } from './_agent-decisions.mjs';
import { buildReviewAnalysis, fallbackReviewSelection, renderPortfolioReview } from './_agent-review-analysis.mjs';
import { selectReviewStrategy } from './_agent-review-ai.mjs';
import { deliverReviewNotices, reviewDeliveryAllowed } from './_agent-review-delivery.mjs';
import { getReviewControls, reviewDue, reviewFeatureEnabled, loadReviewInputs, REVIEW_SCHEMA, REVIEW_LIMITS } from './_agent-review-state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clockValue = now => typeof now === 'function' ? now() : now;
const phaseMeta = job => ({ id: job.id, kind: 'portfolio_review', execution: 'cloudflare_workflow', phase: job.phase,
  state: job.state, policyVersion: job.policyVersion, createdAt: job.createdAt, updatedAt: job.updatedAt,
  attempts: 1, ...(job.reportId ? { reportId: job.reportId } : {}) });
const noReview = (status, reply) => ({ status, mode: 'verified_review', reply, action: null, sources: [] });
const reasonText = { policy_required: 'Confirm your Strategy policy first, so I can review choices against your own goals.',
  paused: 'Automatic strategy reviews are paused. Your existing risk monitoring keeps its own settings.',
  daily_limit: 'Today’s automatic strategy reviews have reached their limit. Risk checks and ordinary questions remain available.',
  manual_limit: 'Today’s full manual reviews have reached their limit. Ordinary questions and risk checks remain available.',
  not_due: 'The next strategy review is not due yet.' };

function reportFromDraft(job, origin) {
  const { analysis, research, snapshot, selection, mode, modelProfileVersion, modelId, outputDiagnostic, errorCategory } = job.draft;
  const selected = selection || fallbackReviewSelection(analysis);
  const reportId = 'report:' + analysis.createdAt + ':' + job.uuid;
  const options = selected.choices.map(choice => analysis.candidates.find(row => row.id === choice.candidateId)).filter(Boolean);
  const report = { schemaVersion: 'agent-report-v1', reportId, jobId: job.id, createdAt: analysis.createdAt,
    snapshotId: snapshot?.snapshotId || analysis.snapshotId, policyVersion: job.policyVersion,
    modelProfileVersion: modelProfileVersion || 'deterministic-recurring-review-v1', modelId: modelId || null,
    kind: 'portfolio_review', status: !analysis.hasFreshFinancialData ? 'blocked' : analysis.allocationBlocked ? 'partial' : 'ready',
    objective: 'Review verified portfolio choices and revisit earlier ideas', horizon: job.horizonDays,
    sourceCoverage: { scope: 'verified_positions_and_owner_confirmed_cases', sources: job.draft.sources || [],
      portfolioStatus: snapshot?.status || 'unavailable' }, facts: analysis.findings.map(finding => ({ ...finding, kind: 'calculation_reference' })),
    options, assessment: 'Review calculated choices using confirmed preferences; later readings test earlier assumptions.',
    assumptions: analysis.assumptions, invalidationConditions: ['Source readings expire or current conditions change.',
      'Your policy or saved comparison assumptions change.', 'A recorded candidate no longer fits its stated conditions.'],
    validUntil: analysis.validUntil, nextReviewAt: new Date(Date.parse(analysis.createdAt) + 86400000).toISOString(),
    sourceIds: research?.sourceIds || [], calculationIds: [analysis.calculationId, ...analysis.calculations.map(row => row.calculationId)],
    ownerDecisionState: 'proposed', limitations: analysis.allocationBlocked ? ['Complete portfolio allocation remains unavailable where source coverage is incomplete.'] : [],
    review: { schemaVersion: REVIEW_SCHEMA, trigger: job.trigger, mode: mode || 'verified_review', selection: selected, analysis,
      previousReportId: job.draft.previousReportId || null, watches: analysis.watches,
      dashboardUrl: origin + '/agent.html#agentReview', research: research || null, outputDiagnostic: outputDiagnostic || null,
      errorCategory: errorCategory || null } };
  report.assessment = renderPortfolioReview(report, { now: Date.parse(analysis.createdAt) });
  return report;
}

export async function runPortfolioReview({ env = process.env, store: suppliedStore, manual = false, requestId,
  phase = 'all', expectedJobKey,
  context: suppliedContext, publishConversation = true, notify = true, monitoringSucceeded = true,
  loadContext = loadAgentContext, loadSupplementalContext = loadAgentSupplementalContext, fetcher = fetch,
  budgetFactory = createAgentBudget, select = selectReviewStrategy, now = Date.now } = {}) {
  if (!reviewFeatureEnabled(env)) return noReview('disabled', 'Automatic strategy analysis is switched off. Your factual tools and risk checks remain available.');
  if (!['all', 'prepare', 'collect', 'research', 'paper', 'infer', 'publish'].includes(phase)) throw Error('Unknown private review stage');
  if ((manual || requestId !== undefined) && (typeof requestId !== 'string' || !requestId || requestId.length > 160)) throw httpError(400, 'Send a valid review request reference.');
  const clock = () => clockValue(now), origin = getAgentOrigin(env), store = suppliedStore || createAgentStore(env, { now: clock });
  if (!manual && phase === 'all') await store.set('review:lastTick', { ts: new Date(clock()).toISOString() });
  const requestKey = requestId ? 'review:request:' + hash(requestId) : null;
  const cached = requestKey && await store.get(requestKey);
  if (cached?.reportId) {
    const report = await getAgentReport(store, cached.reportId, { now: clock });
    return { status: report.status, mode: report.review.mode, report, reply: renderPortfolioReview(report, { now: clock() }),
      action: null, sources: report.sourceCoverage.sources, snapshotId: report.snapshotId, calculationIds: report.calculationIds,
      reviewJobKey: cached.jobKey };
  }
  const lease = await store.lock('review:runner', 90);
  if (!lease) return noReview('running', 'A strategy review is already running. Its result will appear here when it finishes.');
  const deadline = Date.now() + 40000;
  let job, report, completed = false;
  const checkpoint = async phase => {
    job = { ...job, phase, updatedAt: new Date(clock()).toISOString() };
    await lease.commit([{ key: job.key, value: job, ttlSeconds: 30 * 86400 },
      { key: 'job:' + hash(job.id), value: phaseMeta(job), ttlSeconds: 30 * 86400 }]);
  };
  const queued = () => ({ status: 'queued', phase: job.phase, reviewJobKey: job.key, sources: [], action: null,
    reply: 'Your strategy review is running in the background. The result will appear in Agent when it finishes.' });
  const ownerCommit = async callback => {
    const policyLease = await store.lock('policy', 15), owner = policyLease && await store.lock('owner', 15);
    if (!policyLease || !owner) { await policyLease?.release(); throw httpError(409, 'A private update is finishing. Please retry this review reference.'); }
    try { const entries = await callback(); await lease.commit(entries, { alsoOwned: [policyLease, owner] }); }
    finally { await owner.release(); await policyLease.release(); }
  };
  try {
    const { controls, settings, policy, plans, raw } = await loadReviewInputs(store, ['review:state', 'review:usage', 'alerts']);
    const priorState = raw['review:state'], usage = raw['review:usage'], alerts = raw.alerts;
    const state = priorState || {};
    const active = state.activeJob && await store.get(state.activeJob);
    if (expectedJobKey && active?.key !== expectedJobKey) return noReview('superseded', 'This review has ended or was replaced. Start a new review for the current settings.');
    if (active?.state === 'running' && (active.policyVersion !== policy.version || active.controlsRevision !== controls.revision || active.plansRevision !== plans.revision)) {
      active.state = 'superseded'; active.phase = 'superseded';
      await ownerCommit(async () => [{ key: active.key, value: active, ttlSeconds: 30 * 86400 },
        { key: 'job:' + hash(active.id), value: phaseMeta(active), ttlSeconds: 30 * 86400 },
        { key: 'review:state', value: { ...await store.get('review:state'), activeJob: null, status: 'preferences_changed' } }]);
    }
    if (active && active.state === 'running' && active.policyVersion === policy.version
      && active.controlsRevision === controls.revision && active.plansRevision === plans.revision) {
      if (manual && active.requestKey !== requestKey) return noReview('running', 'Another strategy review is finishing. Read its result before starting a new one.');
      job = active;
      if (job.phase === 'waiting_data' && clock() < Date.parse(job.nextRetryAt)) return noReview('waiting_data', 'The review is waiting for fresh readings. Risk checks continue on their normal schedule.');
    } else {
      const due = reviewDue({ controls, notificationSettings: settings, policy, state, usage: usage || {}, signals: alerts || [], now: clock(), manual });
      if (!due.due) return noReview(due.reason, reasonText[due.reason] || 'A strategy review is not due yet.');
      if (!manual && !monitoringSucceeded) return noReview('waiting_data', 'The risk reading needs recovery before an automatic strategy review.');
      const runId = manual ? 'review:manual:' + hash(requestId) : 'review:' + due.kind + ':' + due.day.day + ':'
        + hash(JSON.stringify([policy.version, controls.revision, due.signalIds || []])).slice(0, 24);
      const key = 'review:job:' + hash(runId), existing = await store.get(key);
      if (existing?.state === 'completed' && existing.reportId) {
        report = await getAgentReport(store, existing.reportId, { now: clock });
        return { report, reply: renderPortfolioReview(report, { now: clock() }), status: report.status, mode: report.review.mode, action: null, sources: report.sourceCoverage.sources };
      }
      if (existing?.state === 'running' && existing.policyVersion === policy.version && existing.controlsRevision === controls.revision && existing.plansRevision === plans.revision) job = existing;
      else if (existing) return noReview('interrupted', 'This review reference already ran with earlier preferences. Start a new review for the current settings.');
      else {
        job = { key, id: runId, uuid: randomUUID(), state: 'running', phase: 'collecting', trigger: due.kind,
          policyVersion: policy.version, controlsRevision: controls.revision, plansRevision: plans.revision,
          horizonDays: policy.constraints?.horizonDays ?? null, requestKey, publishConversation, notify,
          createdAt: new Date(clock()).toISOString(), updatedAt: new Date(clock()).toISOString(), dataAttempts: 0 };
        await ownerCommit(async () => {
          if ((await getAgentPolicy(store)).version !== policy.version || (await getReviewControls(store)).revision !== controls.revision)
            throw httpError(409, 'Your preferences changed. Start a fresh strategy review.');
          const current = await store.get('review:state') || {}, counts = { ...due.counts,
            [manual ? 'manual' : 'automatic']: (due.counts[manual ? 'manual' : 'automatic'] || 0) + 1 };
          return [{ key, value: job, ttlSeconds: 30 * 86400 }, { key: 'job:' + hash(runId), value: phaseMeta(job), ttlSeconds: 30 * 86400 },
            { key: 'review:usage', value: counts }, { key: 'review:state', value: { ...current, activeJob: key, status: 'collecting',
              lastAttempt: job.createdAt, lastReviewAt: job.createdAt,
              ...(!manual ? { lastAutomaticAt: job.createdAt } : {}), ...(due.kind === 'daily' ? { dailyDate: due.day.day } : {}) } }];
        });
      }
    }
    if (phase === 'prepare') return queued();
    if (!job.draft && !['all', 'collect'].includes(phase)) throw httpError(409, 'The review needs its preceding data step.');
    if (!job.draft) {
      await checkpoint('collecting');
      let context = suppliedContext || await loadContext({ origin, fetcher, timeoutMs: 6000, now: clock });
      context = { ...context, policy };
      const needsStrategy = (context.lp?.positions || []).some(row => row.canonical?.chain === 'katana') || plans.items.some(item => item.kind === 'lp');
      if (needsStrategy && !context.strategy) context = await loadSupplementalContext({ origin, needs: ['strategy'], context, fetcher, timeoutMs: 6000, now: clock });
      const previous = state.reportId ? await store.get(state.reportId) : null;
      const history = store.list ? await store.list('review:index:', { limit: REVIEW_LIMITS.previousReviews, reverse: true }) : { items: [] };
      const priorIds = [...new Set([previous?.reportId, ...history.items.map(item => item.value.reportId)].filter(Boolean))].slice(0, REVIEW_LIMITS.previousReviews);
      const feedback = [];
      for (const reportId of priorIds) {
        const prior = reportId === previous?.reportId ? previous : await store.get(reportId);
        if (!prior || prior.policyVersion !== policy.version) continue;
        const decision = await store.get('journal:decision:' + prior.createdAt + ':' + hash(reportId).slice(0, 32));
        const event = decision?.latestEvent ? await store.get(decision.latestEvent) : null;
        // A later observation is not an owner choice. Specific rejected keys
        // survive in review:feedback; never expand a missing choice to all ideas.
        if (decision && event?.type === 'owner_decision') feedback.push({ state: decision.state, policyVersion: prior.policyVersion,
          keys: prior.options.filter(option => !event?.choice || option.id === event.choice).map(option => option.key), rationale: event?.rationale || '' });
      }
      for (const item of (await store.get('review:feedback') || []).slice(-64)) if (item.policyVersion === policy.version)
        feedback.push({ state: item.state, policyVersion: item.policyVersion, keys: [item.key], rationale: item.rationale });
      const analysis = await buildReviewAnalysis({ context, policy, plans: plans.items,
        previous: previous?.policyVersion === policy.version ? previous : null, feedback, now: clock() });
      job.dataAttempts++;
      if (!analysis.hasFreshFinancialData && !manual && job.dataAttempts < 3) {
        job.nextRetryAt = new Date(clock() + 300000).toISOString();
        await checkpoint('waiting_data');
        return noReview('waiting_data', 'The review is waiting for fresh readings. Risk checks continue on their normal schedule.');
      }
      job.draft = { analysis, snapshot: context.snapshot || null, sources: context.sources || [],
        previousReportId: previous?.reportId || null, previousDecisionId: state.decisionId || null };
      await checkpoint('research');
    }
    if (phase === 'collect') return queued();
    if (!job.draft.researchChecked && ['all', 'research'].includes(phase)) {
      const analysis = job.draft.analysis;
      let research = null;
      if (controls.research && env.AGENT_RESEARCH_ENABLED !== 'false' && analysis.hasFreshFinancialData
        && (!Array.isArray(policy.constraints?.allowedAnalysisTypes) || policy.constraints.allowedAnalysisTypes.includes('research'))) {
        const protocol = analysis.candidates.some(row => row.kind === 'loan') ? 'morpho' : analysis.candidates.some(row => row.kind === 'range') ? 'sushi' : null;
        if (protocol) try {
          const query = protocol === 'morpho' ? 'Explain isolated lending markets' : 'Explain liquidity pool fee interactions';
          const evidence = await researchProtocol({ store, protocol, query, fetcher, now: clock });
          research = createResearchReport({ context: { snapshot: job.draft.snapshot, sources: job.draft.sources }, policy, research: evidence, query, now: clock });
        } catch { /* Source failures never authorize unsupported facts or stop risk monitoring. */ }
      }
      Object.assign(job.draft, { research, researchChecked: true });
      await checkpoint('paper');
    }
    if (phase === 'research') return queued();
    if (!job.draft.paperChecked && ['all', 'paper'].includes(phase)) {
      const eligible = plans.items.filter(item => item.decisionId && item.policyVersion === policy.version && Date.parse(item.expiresAt) > clock()).slice(0, 3);
      if (eligible.length) {
        let context = { ...(suppliedContext || await loadContext({ origin, fetcher, timeoutMs: 6000, now: clock })), policy };
        if (!context.strategy && eligible.some(plan => plan.kind === 'lp')) context = await loadSupplementalContext({ origin, context, needs: ['strategy'], fetcher, timeoutMs: 6000, now: clock });
        // Paper observations stay in their original cases and never prove execution.
        for (const plan of eligible) try { await observeAgentDecision(store, plan.decisionId, context, { now: clock() }); }
        catch { /* A matching-source gap remains unknown; do not infer a win. */ }
      }
      job.draft.paperChecked = true; await checkpoint('ready_for_inference');
    }
    if (phase === 'paper') return queued();
    if (!job.report && ['all', 'infer'].includes(phase)) {
      const analysis = job.draft.analysis;
      if (job.phase === 'inference_started') {
        // A Worker restart after dispatch cannot know whether the model ran.
        // Its reservation is retained; finish from verified facts without retry.
        job.draft.mode = 'verified_review'; job.draft.errorCategory = 'timeout';
        await checkpoint('inference_finished');
      }
      if (!job.draft.mode) {
        if (analysis.hasFreshFinancialData && analysis.candidates.some(row => row.kind !== 'inputs')
          && analysis.validUntil && Date.parse(analysis.validUntil) > clock() && Date.now() < deadline) {
          try {
            const inference = budgetFactory(env, { jobId: job.id, now: clock, holdbackNeurons: manual ? 0 : 500 });
            const selected = await select({ analysis, policy, research: job.draft.research, env, inference, deadline,
              beforeInference: async attempt => { job.reservationId = attempt.reservationId; await checkpoint('inference_started'); },
              afterSelection: async result => { Object.assign(job.draft, result, { mode: 'ai_review' }); await checkpoint('inference_finished'); } });
            Object.assign(job.draft, selected, { mode: 'ai_review' });
          } catch (error) {
            job.draft.mode = 'verified_review'; job.draft.errorCategory = agentErrorCategory(error);
            job.draft.outputDiagnostic = error.outputDiagnostic || null;
          }
        } else { job.draft.mode = 'verified_review'; job.draft.errorCategory = 'data_unavailable'; }
        await checkpoint('inference_finished');
      }
      job.report = reportFromDraft(job, origin); await checkpoint('publishing');
    }
    if (phase === 'infer') return queued();
    if (!job.report) throw httpError(409, 'The review needs its preceding inference step.');
    await lease.assertOwned();
    report = await persistAgentReport(store, job.report, job.draft.snapshot);
    if (phase === 'all' && job.draft.analysis.lessons.length && job.draft.previousDecisionId) await recordReviewObservation(store, job.draft.previousDecisionId, {
      measurementId: report.reportId, calculationId: job.draft.analysis.calculationId,
      observedAt: job.draft.analysis.createdAt, lessons: job.draft.analysis.lessons });
    const decisionId = 'decision:' + report.createdAt + ':' + hash(report.reportId).slice(0, 32), publishedAt = new Date(clock()).toISOString();
    await ownerCommit(async () => {
      const { policy: latestPolicy, controls: latestControls, plans: latestPlans, settings: notificationSettings, raw: saved } = await loadReviewInputs(store,
        ['review:state', 'messages', 'alerts', 'telegram', 'review:pending']);
      const current = saved['review:state'] || {};
      if (latestPolicy.version !== job.policyVersion || latestControls.revision !== job.controlsRevision || latestPlans.revision !== job.plansRevision) {
        job.state = 'superseded'; job.phase = 'superseded';
        return [{ key: job.key, value: job, ttlSeconds: 30 * 86400 }, { key: 'job:' + hash(job.id), value: phaseMeta(job), ttlSeconds: 30 * 86400 },
          { key: 'review:state', value: { ...current, activeJob: null, status: 'preferences_changed' } }];
      }
      job.state = 'completed'; job.phase = 'completed'; job.reportId = report.reportId;
      const entries = [{ key: job.key, value: job, ttlSeconds: 30 * 86400 }, { key: 'job:' + hash(job.id), value: phaseMeta(job), ttlSeconds: 30 * 86400 },
        { key: 'review:index:' + report.createdAt + ':' + job.uuid, value: { reportId: report.reportId, policyVersion: report.policyVersion } },
        { key: 'review:state', value: { ...current, activeJob: null,
          status: report.status === 'blocked' ? 'blocked' : report.review.mode === 'ai_review' ? 'completed' : 'verified_checks',
          reportId: report.reportId, decisionId, policyVersion: report.policyVersion, lastCompletedAt: publishedAt,
          ...(job.draft.analysis.hasFreshFinancialData ? { lastSuccess: publishedAt,
            ...(job.trigger !== 'manual' ? { lastAutomaticSuccess: publishedAt } : {}) } : {}) } }];
      if (job.requestKey) entries.push({ key: job.requestKey, value: { reportId: report.reportId, jobKey: job.key }, ttlSeconds: 30 * 86400 });
      if (job.publishConversation) {
        const messages = saved.messages || [];
        if (!messages.some(item => item.id === report.reportId)) entries.push({ key: 'messages', value: [...messages,
          { role: 'assistant', content: renderPortfolioReview(report, { now: clock() }), ts: publishedAt, source: 'review', id: report.reportId }].slice(-24) });
      }
      const recentAlerts = saved.alerts || [];
      if (!recentAlerts.some(item => item.reportId === report.reportId)) entries.push({ key: 'alerts', value: [...recentAlerts,
        { id: 'review:' + job.uuid, type: 'review_report', title: 'Strategy review ready', message: 'Open the strategy review for the calculated choices and follow-up observations.',
          reportId: report.reportId, ts: publishedAt, status: 'review', telegramSent: false }].slice(-30) });
      const binding = saved.telegram;
      if (job.notify && (latestControls.enabled || job.trigger === 'manual') && binding && env.TELEGRAM_BOT_TOKEN && reviewDeliveryAllowed(latestControls, notificationSettings, job.trigger)) {
        const pending = saved['review:pending'] || [];
        if (!pending.some(item => item.reportId === report.reportId)) entries.push({ key: 'review:pending', value: [...pending,
          { reportId: report.reportId, policyVersion: report.policyVersion, controlsRevision: latestControls.revision, trigger: job.trigger,
            chatId: String(binding.chatId), userId: String(binding.userId), createdAt: publishedAt }].slice(-10), ttlSeconds: 7 * 86400 });
      }
      if (report.review.mode === 'ai_review') entries.push({ key: 'diagnostics:lastInference', value: { ts: publishedAt, status: 'succeeded',
        modelId: report.modelId, profileVersion: report.modelProfileVersion } });
      entries.push({ key: 'diagnostics:lastReview', value: { ts: publishedAt, mode: report.review.mode,
        errorCategory: report.review.errorCategory, modelOutput: report.review.outputDiagnostic } });
      return entries;
    });
    if (job.state === 'superseded') return noReview('superseded', 'Your preferences changed while this review was being prepared. Run a new review with the current settings.');
    completed = true;
  } finally { try { await lease.release(); } catch {} }
  if (phase === 'all' && completed && job.notify) await deliverReviewNotices({ store, env, fetcher, now: clock });
  return { status: report.status, mode: report.review.mode, report, reply: renderPortfolioReview(report, { now: clock() }), action: null,
    reviewJobKey: job.key, sources: report.sourceCoverage.sources, snapshotId: report.snapshotId, calculationIds: report.calculationIds, decisionId: 'decision:' + report.createdAt + ':' + hash(report.reportId).slice(0, 32) };
}

export async function linkReviewFollowUp({ store, jobKey }) {
  if (!jobKey) return { status: 'idle' };
  const job = await store.get(jobKey), draft = job?.draft;
  if (job?.state !== 'completed' || !draft?.analysis?.lessons?.length || !draft.previousDecisionId) return { status: 'idle' };
  await recordReviewObservation(store, draft.previousDecisionId, { measurementId: job.reportId,
    calculationId: draft.analysis.calculationId, observedAt: draft.analysis.createdAt, lessons: draft.analysis.lessons });
  return { status: 'linked' };
}
