/* Portable orchestration; production step.do is Cloudflare's durable runner.
   Dependencies below are injected only by closed local fixtures. */
import { createAgentStore } from './_agent-store.mjs';
import { runPortfolioReview, linkReviewFollowUp } from './_agent-review-loop.mjs';
import { deliverReviewNotices } from './_agent-review-delivery.mjs';
import { checkpointReviewDispatch } from './_agent-review-dispatch.mjs';

export async function executeReviewWorkflow({ env, params, workflowId, step, store = createAgentStore(env), dependencies = {} }) {
  if (params?.schemaVersion !== 1 || !['review', 'delivery'].includes(params.mode)
    || typeof params.manual !== 'boolean' || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 160)
    throw Error('Invalid private review invocation');
  let jobKey;
  if (params.mode === 'review') {
    for (const phase of ['prepare', 'collect', 'research', 'paper', 'infer', 'publish']) {
      const result = await step.do('review-' + phase, { retries: { limit: phase === 'infer' ? 0 : 2, delay: '5 seconds', backoff: 'linear' },
        timeout: '60 seconds' }, async () => {
        const value = await runPortfolioReview({ ...dependencies, env, store, manual: params.manual, requestId: params.requestId,
          phase, ...(jobKey ? { expectedJobKey: jobKey } : {}) });
        if (value.status !== 'queued') await checkpointReviewDispatch(store, workflowId);
        return { status: value.status, jobKey: value.reviewJobKey || null, reportId: value.report?.reportId || null };
      });
      if (result.jobKey) jobKey = result.jobKey;
      if (result.status !== 'queued') {
        if (!result.reportId) return result;
        break;
      }
    }
    await step.do('link-original-reasoning', { retries: { limit: 2, delay: '5 seconds' } }, () => linkReviewFollowUp({ store, jobKey }));
  }
  return step.do('deliver-review', { retries: { limit: 0, delay: '5 seconds' }, timeout: '60 seconds' },
    async () => {
      const result = await deliverReviewNotices({ ...dependencies, store, env });
      await checkpointReviewDispatch(store, workflowId);
      return result;
    });
}
