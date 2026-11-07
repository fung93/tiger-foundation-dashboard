/* Only queues bounded Workflows. Never collect holdings or invoke AI in the
   authenticated request or risk Cron invocation. IDs are deterministic on retry. */
import { createHash } from 'node:crypto';
import { createAgentStore } from './_agent-store.mjs';
import { getAgentReport } from './_agent-reports.mjs';
import { renderPortfolioReview } from './_agent-review-analysis.mjs';
import { httpError } from './_agent-http.mjs';
import { loadReviewInputs, reviewDue, reviewFeatureEnabled } from './_agent-review-state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const answer = (status, reply, rest = {}) => ({ status, mode: 'queued_review', reply, action: null, sources: [], ...rest });
const queued = rest => answer('queued', 'Your portfolio review is queued. I’ll save the analysis in Agent and send it to Telegram if your delivery settings allow it.', rest);
const activeStatuses = new Set(['queued', 'running', 'waiting', 'paused', 'waitingForPause']);
const reasons = { policy_required: 'Confirm your Strategy policy first so I can review choices against your goals.',
  paused: 'Automatic strategy reviews are paused.', not_due: 'The next strategy review is not due yet.',
  daily_limit: 'Today’s automatic reviews have reached their limit. Risk monitoring continues.',
  manual_limit: 'Today’s full manual reviews have reached their limit. You can still ask ordinary questions.' };

// Record terminal analysis/delivery inside its existing bounded step. Free
// Workflows discard instance history after three days; that must not strand D1.
export async function checkpointReviewDispatch(store, workflowId) {
  if (!workflowId) return;
  const lease = await store.lock('review:dispatch', 15);
  if (!lease) throw httpError(409, 'A review dispatch update is finishing.');
  try {
    const current = await store.get('review:dispatch');
    if (current?.workflowId === workflowId) await lease.commit([{ key: 'review:dispatch',
      value: { ...current, state: 'checkpointed' } }]);
  } finally { await lease.release(); }
}

export async function dispatchPortfolioReview({ env = process.env, store: suppliedStore, manual = false, requestId,
  monitoringSucceeded = true, now = Date.now } = {}) {
  const clock = () => typeof now === 'function' ? now() : now;
  const store = suppliedStore || createAgentStore(env, { now: clock });
  if (manual && (typeof requestId !== 'string' || !requestId || requestId.length > 160)) throw httpError(400, 'Send a valid review request reference.');
  if (!manual) await store.set('review:lastTick', { ts: new Date(clock()).toISOString() });
  if (!reviewFeatureEnabled(env)) return answer('disabled', 'Recurring strategy analysis is switched off.');
  if (typeof env.PORTFOLIO_REVIEWS?.create !== 'function' || typeof env.PORTFOLIO_REVIEWS?.get !== 'function')
    return answer('setup_required', 'The background review connection is missing. Deploy the configured PortfolioReviewWorkflow binding before starting a review.');
  if (manual) {
    const cached = await store.get('review:request:' + hash(requestId));
    if (cached?.reportId) {
      const report = await getAgentReport(store, cached.reportId, { now: clock });
      return answer(report.status, renderPortfolioReview(report, { now: clock() }), { report, mode: report.review.mode });
    }
  }
  const lease = await store.lock('review:dispatch', 15);
  if (!lease) return queued();
  try {
    const { controls, settings, policy, plans, raw } = await loadReviewInputs(store,
      ['review:state', 'review:usage', 'alerts', 'review:dispatch', 'review:pending', 'monitor:pending']);
    const state = raw['review:state'] || {}, current = raw['review:dispatch'];
    let descriptor;
    if (current) {
      let status;
      const published = current.params.mode === 'review' && !state.activeJob && state.lastCompletedAt
        && Date.parse(state.lastCompletedAt) >= Date.parse(current.createdAt);
      try { status = current.state === 'checkpointed' || published ? 'complete'
        : (await (await env.PORTFOLIO_REVIEWS.get(current.workflowId)).status()).status; }
      catch {
        // A timed-out create may already have reached Cloudflare. Reuse exactly
        // the same instance ID; never manufacture a fresh inference on timeout.
        if (current.state === 'dispatching') {
          try { await env.PORTFOLIO_REVIEWS.create({ id: current.workflowId, params: current.params }); } catch {}
        }
        return queued({ workflowId: current.workflowId });
      }
      if (activeStatuses.has(status)) return queued({ workflowId: current.workflowId });
      const active = state.activeJob && await store.get(state.activeJob);
      if (active?.state === 'running' && current.params.mode !== 'delivery') {
        if (active.nextRetryAt && clock() < Date.parse(active.nextRetryAt)) return answer('waiting_data', 'The review is waiting for fresh readings; risk monitoring continues.');
        const attempts = current.recoveryAttempts || 0;
        if (attempts < 2) descriptor = { ...current, recoveryAttempts: attempts + 1,
          workflowId: current.baseId + '-r' + (attempts + 1), state: 'dispatching' };
        else if (manual && requestId !== current.params.requestId) {
          // A fresh owner request can retire a terminal, exhausted job. Never
          // do this to a running/unknown Workflow or replay its inference ID.
          const runner = await store.lock('review:runner', 90), owner = runner && await store.lock('owner', 15);
          if (!runner || !owner) { await runner?.release(); return queued(); }
          try {
            const latest = await store.get('review:state') || {};
            if (latest.activeJob !== active.key) return queued();
            await runner.commit([{ key: active.key, value: { ...active, state: 'interrupted', phase: 'recovery_exhausted' }, ttlSeconds: 30 * 86400 },
              { key: 'job:' + hash(active.id), value: { id: active.id, kind: 'portfolio_review', state: 'interrupted', phase: 'recovery_exhausted',
                createdAt: active.createdAt, updatedAt: new Date(clock()).toISOString() }, ttlSeconds: 30 * 86400 },
              { key: 'review:state', value: { ...latest, activeJob: null, status: 'interrupted' } }], { alsoOwned: [owner] });
            state.activeJob = null;
          } finally { await owner.release(); await runner.release(); }
        }
        else {
          await lease.commit([{ key: 'review:dispatch', value: { ...current, state: 'recovery_required', checkedAt: new Date(clock()).toISOString() } }]);
          return answer('recovery_required', 'This review stopped after its recovery limit. Check Connection & usage before starting another review; risk alerts keep their own schedule.');
        }
      }
    }
    if (!descriptor) {
      const outbox = raw['monitor:pending'];
      const pendingDelivery = (raw['review:pending'] || []).length || outbox?.kind === 'strategy_reviews';
      const due = reviewDue({ controls, notificationSettings: settings, policy, state,
        usage: raw['review:usage'] || {}, signals: raw.alerts || [], now: clock(), manual });
      const deliverOnly = !manual && pendingDelivery && !due.due;
      if (!due.due && !deliverOnly) return answer(due.reason, reasons[due.reason] || 'A strategy review is not due yet.');
      if (!manual && !monitoringSucceeded) return answer('waiting_data', 'The risk reading needs recovery before an automatic strategy review.');
      const logicalId = deliverOnly ? 'delivery:' + Math.floor(clock() / 300000) : manual ? requestId : 'automatic:'
        + hash(JSON.stringify([due.day.day, due.kind, policy.version, controls.revision, plans.revision, due.signalIds || []]));
      const baseId = 'review-' + hash(logicalId).slice(0, 48);
      descriptor = { baseId, workflowId: baseId, recoveryAttempts: 0, state: 'dispatching',
        params: { schemaVersion: 1, mode: deliverOnly ? 'delivery' : 'review', manual, requestId: logicalId },
        createdAt: new Date(clock()).toISOString() };
    }
    await lease.commit([{ key: 'review:dispatch', value: descriptor }]);
    try {
      await env.PORTFOLIO_REVIEWS.create({ id: descriptor.workflowId, params: descriptor.params });
      await lease.commit([{ key: 'review:dispatch', value: { ...descriptor, state: 'queued' } }]);
    } catch { /* A same-ID retry resolves ambiguous dispatch without duplicate jobs. */ }
    return queued({ workflowId: descriptor.workflowId });
  } finally { await lease.release(); }
}
