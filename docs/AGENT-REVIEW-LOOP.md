# Recurring portfolio strategy reviews

The agent can now check positions, calculate supported choices, explain its priorities,
save the original reasoning and revisit those ideas with later readings. Dashboard and
Telegram use the same private reports, journal, preferences and AI allowance.

It remembers owner decisions and tests recorded conditions. This does not retrain the
model or establish investment performance. Wallet access remains read-only.

## Activate the new runner

1. Deploy the updated existing `tiger-foundation-dashboard` Worker using
   `cloudflare/wrangler.jsonc`. Its entry point is now `cloudflare/runtime.mjs`.
   The deployment includes the named export `PortfolioReviewWorkflow` and binding
   `PORTFOLIO_REVIEWS` → `tiger-portfolio-review`. Wrangler provisions the Workflow;
   an older Worker deployment without this binding cannot run full reviews.
2. Keep **Workers Free**, the existing `AI` and `AGENT_DB` bindings and five-minute
   Cron `*/5 * * * *`. No new database, migration, paid provider or secret is needed.
   Keep the existing gateway, access, Telegram and Cron secrets private.
3. Open **Agent → Connection & usage → Check connection**. Check **Strategy review
   runner**, **Last scheduled review tick**, **Last automatic review** and
   **Next intended review**. A configured binding does not prove that a scheduled
   review or Telegram delivery has succeeded.
4. Confirm your chosen **Strategy policy**. Blank targets stay unspecified. The
   Lending page still resets its own per-visit settings; this agent policy is separate.
5. Open **Portfolio strategy review → Automatic reviews**. Choose the MYT time and
   delivery. **Follow notification preferences** uses daily-summary preferences for
   daily reviews and alert preferences for event/manual reviews. Choose **Dashboard
   and Telegram** to request review delivery independently of those two switches.
   The global notification pause and Telegram unlink still stop delivery.
6. Click **Run review now**, or send `/review`, `/strategy` or “Review my portfolio”
   to the linked bot. The acknowledgment appears immediately. The result arrives in
   the shared conversation and review card, with Telegram delivery when enabled.
   Status polling refreshes the dashboard; **Check status** refreshes it immediately.
7. Read **Why** and **Reconsider when**. Open **Sources and assumptions** for source
   dates and documentation. Use **Review this decision in the journal** to record
   your decision and rationale. Acceptance is for review; no transaction is executed.

To stop automatic analysis, clear **Enable automatic strategy reviews** and save.
Existing risk alerts retain their separate settings. Explicit manual reviews still
work while automatic reviews are paused. `AGENT_REVIEW_ENABLED=false` disables the
review feature; `AGENT_STRATEGY_ENABLED=false` also disables new strategy reviews.
`AGENT_INFERENCE_ENABLED=false` retains deterministic reviews without AI selection.

## What it analyses

| Area | Supported review |
| --- | --- |
| Lending | Current health/LTV, independent liquidation warnings and exact repayment calculations against confirmed owner targets; both health and LTV constraints are respected |
| Katana LPs | Up to three current positions, verified range history, present band and equal-capital liquidity concentration; staked fees remain DAO earnings |
| KAT | Verified exposure observations when the existing tool has sufficient coverage |
| Saved comparisons | Up to three explicitly confirmed cases, recalculated with fresh financial readings and the original costs, price paths and rate assumptions |
| Follow-up | Compare later loan health and pool ticks with the original recorded conditions, retaining links to the original report and calculation |
| Research | Relevant bounded official Morpho/Sushi documentation; source dates/citations retained privately and shown in details |

Unknown costs and missing holdings remain unknown. The agent cannot size a complete
portfolio allocation from incomplete coverage. A historical price band is a starting
comparison, not a price forecast or an optimized profit claim. A later point reading
does not establish continuous time in range, an executed trade, realized P&L or a win rate.

To reuse a cost-aware case, run **Compare strategies** with your explicit assumptions.
Then select **Include in recurring reviews** and its validity, from 1–30 days. Those
displayed assumptions are saved with their original report and policy version. Expired
assumptions and cases from an earlier policy do not generate new recommendations.
Remove them under **Recurring comparisons**. No model can add a case or revise its costs.

An owner rejection/invalidation suppresses that idea in subsequent reviews under the
same policy. Critical risk facts remain visible. Revising your journal decision can
clear that rejection; changing policy starts a new preference context. Memory is
bounded to 64 feedback entries and the latest three report contexts, while original
reports, calculations, source evidence and journal events remain durable in D1.

## Schedule and limits

- The existing five-minute Cron finishes deterministic risk checks, then cheaply queues
  a review Workflow. It never waits for strategy inference.
- One daily review runs at or after the chosen MYT time. Fresh material lending/LP
  alerts can trigger additional reviews, with a four-hour cooldown.
- At most **3 automatic** and **5 manual** full reviews per MYT day. Full reviews use
  at most one inference; retries of a completed reference reuse the saved result.
- Automatic analysis leaves 500 neurons of the shared application allowance for
  ordinary questions. All inference shares the existing 5,000-neuron UTC-day budget;
  ordinary chat also retains its existing message/rate limits. Application budgets
  cannot account for other applications in the same Cloudflare account.
- Qwen `@cf/qwen/qwen3-30b-a3b-fp8` remains selected. There is no paid fallback or
  automatic model switch. Its documented planned retirement is 20 November 2026;
  the explicit GLM candidate still needs real-account acceptance before selecting it.

One normal full review executes eight steps, so the full-review ceilings allow 64 base
steps/day, plus bounded recovery and delivery resumes. Check the account's current
Workflows, Workers, AI and D1 allowances; other account workloads share those quotas.
Quota exhaustion stops affected work. Do not enable a paid plan to work around it.

## Checkpoints and delivery

| Workflow step | Work |
| --- | --- |
| Prepare | Validate current preferences; reserve one daily review allowance |
| Collect | Read first-party APIs, calculate choices and load prior decisions |
| Research | Retrieve relevant configured official evidence |
| Paper | Recheck the original saved comparison cases |
| Infer | Reserve shared AI budget and validate one closed selection of calculated choices |
| Publish | Persist immutable calculations/report, proposed journal record and conversation |
| Follow up | Link genuinely newer observations back to the original journal |
| Deliver | Use the existing monitor outbox and acknowledged Telegram chunk cursor |

Each stage has its own invocation and short fenced commits. D1 `batch()` reduces query
calls; no stage holds the shared owner lock during network/model work. Inference has
no automatic step retry. If dispatch was interrupted, retain its charge and finish
from verified calculations. A validated selection is reused after restart.

Cloudflare Workflow state has only three days' retention on Free. Final reports,
evidence, original cases and decisions remain in private D1 without cache TTL.
Operational review jobs/request checkpoints retain 30 days. An errored Workflow can
get at most two recovery instances for the same logical job. After exhaustion,
Connection & usage reports that attention is required; a fresh explicit manual request
can retire a confirmed terminal job and start a new bounded review.
Terminal analysis/delivery also checkpoints dispatch metadata in D1, so pruning an
old Workflow instance cannot strand the next review or erase its saved report.

Strategy notices share `monitor:pending` and its exclusive monitor lease. A risk tick
requeues unfinished strategy notices with their chunk cursor before sending alarms.
Risk delivery attempts at most two notices per invocation, retaining unsent items;
new critical alarms take priority. Failed Telegram delivery cannot prevent newly
critical conditions from appearing on the dashboard; delivery remains degraded and
queued. Strategy delivery handles one notice and at most
three chunks per invocation. Subsequent Cron dispatch resumes delivery without AI.
Recipient, notification pause, preferences, policy version and freshness are checked
again immediately before each chunk. Expired reviews deliver a dated report link,
without actionable repayment amounts. A provider timeout after Telegram accepts a
message can still cause a duplicate because Telegram offers no send idempotency key.

## Validation and real-account gate

Network-closed SQLite and native workerd tests cover genuine Workflow execution,
inference reservation/recovery, policy races, delivery fencing, saved comparisons and
independent risk monitoring. Chromium checks cover both themes at 360/1366 widths,
queued completion, form-version conflicts, saved assumptions, safe links and logout.
Run `npm run check` for all local regressions.

Optional native validation, with Miniflare/esbuild installed outside the repository:

```sh
node scripts/check-agent-review-runtime.mjs /path/to/validation/node_modules
node scripts/check-agent-telegram-runtime.mjs /path/to/validation/node_modules
```

The tested native stages use at most 29 D1 calls; the stressed risk-plus-dispatch
fixture uses at most 48, within the Free ceiling of 50 per invocation. Native local
success does **not** measure the real account's 10ms Free CPU allowance per step.
Confirm Workflow creation, step CPU/latency, AI usage, D1 rows/storage, scheduled
cadence, a new review and its Telegram delivery in the actual account. No live
Cloudflare credentials are available in the implementation workspace.

## Changed files

| Area | Files |
| --- | --- |
| Review controls, calculations, AI selection, scheduling and delivery | `api/_agent-review-*.mjs` |
| Shared settings, storage and inference allowance | `api/_agent-settings.mjs`, `api/_agent-store.mjs`, `api/_agent-budget.mjs`, `api/_agent-models.mjs` |
| Owner routes, conversations, reports and journal | `api/agent.mjs`, `api/_agent-actions.mjs`, `api/_agent-service.mjs`, `api/_agent-reports.mjs`, `api/_agent-decisions.mjs` |
| Independent risk monitoring and private diagnostics | `api/agent-monitor.mjs`, `api/_agent-notifications.mjs`, `api/_agent-diagnostics.mjs` |
| Cloudflare runner/configuration | `cloudflare/runtime.mjs`, `cloudflare/review-workflow.mjs`, `cloudflare/worker.mjs`, `cloudflare/wrangler.jsonc`, `.env.agent.example` |
| Dashboard and cache | `agent.html`, `agent.js`, `agent.css`, `agent-language.mjs`, `sw.js` (156) |
| Local regressions | `scripts/test-agent-review-*.mjs`, `scripts/check-agent-review-runtime.mjs`, review/SQLite fixtures, existing budget/job/project checks |
| Instructions, progress and operator guides | `AGENTS.md`, `TIGER_AGENT_PROGRESS.md`, the Agent setup/activation/implementation/acceptance guides and this guide |

No Lending page, LP rollover/accounting, public financial JSON/history or Portfolio
copy changes are part of this release. The supplied implementation plan is unchanged.

Official limits: [Workflows](https://developers.cloudflare.com/workflows/reference/limits/),
[pricing](https://developers.cloudflare.com/workflows/reference/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/limits/) and
[Workers](https://developers.cloudflare.com/workers/platform/limits/).
