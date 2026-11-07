import { getAgentModelProfile, AGENT_MODEL_SCHEMA_VERSION } from './_agent-models.mjs';
import { createAgentBudget } from './_agent-budget.mjs';
import { agentErrorCategory } from './_agent-http.mjs';
import { safeAgentOutputDiagnostic } from './_agent-output-diagnostics.mjs';
import { loadReviewInputs, nextReviewTime, reviewFeatureEnabled } from './_agent-review-state.mjs';

// Called only after the normal owner session check. No provider request, secret,
// transcript, wallet amount or raw database/provider error belongs in this view.
export async function agentDiagnostics({ env, store, budgetFactory = createAgentBudget }) {
  const [lastRequest, lastInference, monitor, pending, monitorSuccess, jobs] = await Promise.all([
    store.get('diagnostics:lastRequest'), store.get('diagnostics:lastInference'), store.get('lastCheck'), store.get('monitor:pending'),
    store.get('monitor:lastSuccess'), store.list ? store.list('job:', { limit: 10 }) : null,
  ]);
  let profile, modelError, budget, storageUsage;
  try { storageUsage = await store.storageUsage?.() || { status: 'unverified' }; } catch { storageUsage = { status: 'migration_or_storage_unavailable' }; }
  try { profile = getAgentModelProfile(env); } catch (error) { modelError = agentErrorCategory(error); }
  try { budget = await budgetFactory(env, { jobId: 'diagnostics' }).status(); }
  catch (error) { budget = { available: false, errorCategory: agentErrorCategory(error) }; }
  const selectedModelSucceeded = !!profile && lastInference?.status === 'succeeded'
    && lastInference.modelId === profile.id && lastInference.profileVersion === profile.version && !!lastInference.ts;
  const { controls: reviewControls, settings: notificationSettings, raw } = await loadReviewInputs(store, ['review:state', 'review:lastTick', 'review:dispatch']);
  const review = raw['review:state'], reviewTick = raw['review:lastTick'], dispatch = raw['review:dispatch'];
  const activeReview = review?.activeJob ? await store.get(review.activeJob) : null;
  return { schemaVersion: AGENT_MODEL_SCHEMA_VERSION, checkedAt: new Date().toISOString(),
    components: { session: 'verified', gateway: 'verified', storage: 'reachable',
      inference: typeof env.AI?.run === 'function' ? 'binding_configured' : 'configuration_missing',
      inferenceEnabled: env.AGENT_INFERENCE_ENABLED !== 'false',
      monitor: monitor?.status === 'failed' || monitor?.degraded || monitor?.ts && Date.now() - Date.parse(monitor.ts) > 600000 ? 'degraded' : monitor?.status || 'unverified', telegramConfigured: !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_WEBHOOK_SECRET },
    model: { id: profile?.id || null, profileVersion: profile?.version || null,
      documentationVerifiedAt: profile?.verifiedAt || null, errorCategory: modelError || null,
      plannedDeprecationDate: profile?.plannedDeprecationDate || null,
      accountConnectivity: selectedModelSucceeded ? 'previous_success' : 'unverified' },
    lastSuccessfulInference: selectedModelSucceeded ? lastInference.ts : null,
    lastSuccessfulInferenceAnyModel: lastInference?.ts || budget?.lastSuccessfulInference || null,
    lastMonitorSuccess: monitorSuccess?.ts || (monitor?.status === 'checked' ? monitor.ts : null),
    nextIntendedMonitorCheck: monitor?.ts ? new Date(Date.parse(monitor.ts) + 300000).toISOString() : null,
    lastErrorCategory: lastRequest?.errorCategory || null,
    lastModelOutput: safeAgentOutputDiagnostic(lastRequest?.modelOutput),
    monitorSources: monitor?.sources || [], storageUsage,
    jobs: { execution: 'bounded_synchronous_and_workflows', backgroundRunner: typeof env.PORTFOLIO_REVIEWS?.create === 'function',
      researchExecution: 'bounded_synchronous', sampled: jobs?.items?.map(({value}) => ({kind:value.kind,state:value.state,phase:value.phase,updatedAt:value.updatedAt})) || [], hasMore: !!jobs?.cursor },
    strategyReview: { enabled: reviewFeatureEnabled(env) && reviewControls.enabled,
      status: dispatch?.state === 'recovery_required' ? 'recovery_required' : activeReview?.phase || review?.status || 'unverified',
      lastSuccess: review?.lastSuccess || null, lastAutomaticSuccess: review?.lastAutomaticSuccess || null, lastSchedulerTick: reviewTick?.ts || null,
      nextIntendedReview: nextReviewTime(reviewControls, notificationSettings, review, Date.now()), mode: 'cloudflare_workflow',
      workflowConfigured: typeof env.PORTFOLIO_REVIEWS?.create === 'function',
      automaticDailyLimit: 3, manualDailyLimit: 5 },
    delivery: { pending: !!pending, remainingItems: pending ? Math.max(0, (pending.items?.length || 0) - (pending.itemIndex || 0)) : 0 }, budget };
}
