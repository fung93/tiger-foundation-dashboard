/* Called after the existing owner session/origin checks, never by model output. */
import { reviewStatus, saveReviewControls, saveReviewPlan, removeReviewPlan } from './_agent-review-state.mjs';
import { dispatchPortfolioReview } from './_agent-review-dispatch.mjs';

export async function reviewAction(body, { env, store, loadContext } = {}) {
  if (!['reviewStatus', 'reviewSettings', 'reviewRun', 'reviewPlanSave', 'reviewPlanRemove'].includes(body.action)) return null;
  if (body.action === 'reviewStatus') return reviewStatus(store, env);
  if (body.action === 'reviewSettings') {
    await saveReviewControls(store, body.settings, body.expectedRevision);
    return reviewStatus(store, env);
  }
  if (body.action === 'reviewPlanSave') {
    await saveReviewPlan(store, { reportId: body.reportId, days: body.days, expectedRevision: body.expectedRevision });
    return reviewStatus(store, env);
  }
  if (body.action === 'reviewPlanRemove') {
    await removeReviewPlan(store, body.id, body.expectedRevision);
    return reviewStatus(store, env);
  }
  const result = await dispatchPortfolioReview({ env, store, manual: true, requestId: body.requestId });
  return { ...result, review: await reviewStatus(store, env) };
}
