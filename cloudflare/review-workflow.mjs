import { WorkflowEntrypoint } from 'cloudflare:workers';
import { executeReviewWorkflow } from '../api/_agent-review-workflow.mjs';
import { executeAutomaticWorkflow } from '../api/_agent-auto-workflow.mjs';

// Each callback is an independent Free-plan invocation (50 D1 queries, 10ms
// CPU). Durable D1 checkpoints, not Workflow's three-day log retention, own the
// journal. Only compact references are persisted in Workflow step results.
export class PortfolioReviewWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if(event.payload?.mode==='observe')return executeAutomaticWorkflow({env:this.env,params:event.payload,workflowId:event.instanceId,step});
    return executeReviewWorkflow({ env: this.env, params: event.payload, workflowId: event.instanceId, step });
  }
}
