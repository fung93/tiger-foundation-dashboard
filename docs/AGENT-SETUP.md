# Free-plan dashboard and Telegram agent

The Agent button opens private chat from the dashboard pages. Dashboard and Telegram
share conversation history, preferences, lending/data alerts and MYT daily reports.
Wallet access stays read-only. The agent cannot trade, repay, vote, sign or edit code.
This ChatGPT conversation is separate.

## Cost and limits

The agent is designed for **Cloudflare Workers Free**, its included **Workers AI**
allowance, **D1** private storage and **Cron Triggers**, plus your existing Telegram bot.
Keep the existing dashboard hosting on its free plan too. No OpenAI account, paid model
API key, Redis subscription or separate paid scheduler is required. There is no paid
fallback and this code does not enable billing or upgrade a provider plan.

Free does not mean unlimited. Model, request, CPU, database and scheduling allowances
apply. On a Free account, exhausted allowances stop the affected feature until service
is available again; the agent never switches to a billed inference provider. Chat is
also capped locally at 40 questions per day by default (maximum configurable 100),
five per minute, two inference passes per question and 800 output tokens per pass.
Monitoring and daily summaries use calculations in code, without model inference.

**Confirm the Free plan and current model/allowance availability in your Cloudflare
account before activating.** Code cannot prevent charges if you deliberately choose
paid provider plans. Model schemas and neuron rates were checked against Cloudflare's official documentation
on 5 November 2026. This is not an account availability check or a guarantee of free
service; verify the account plan, available allowance and selected model before activation.

Publishing the code alone does not activate the agent: its Free-plan bindings and
private settings must be configured too. No account was created, bot registered, model
called or real Telegram message sent during development.

## Application inference budget and diagnostics

Every inference pass reserves its conservative maximum token cost atomically in D1
before calling AI. The default application cap is 5,000 neurons per UTC day (08:00 MYT
reset); this is not an entitlement or an account-wide billing limit. Other applications
using the same Cloudflare account consume the provider allowance independently.
Reported token usage settles the reservation. Missing usage and ambiguous timeouts retain
a conservative charge; repeating the same attempt cannot authorize a duplicate call.
The 40-question daily and five-question minute limits remain separate abuse controls.

Owner-authenticated POST `action: diagnostics` on `/api/agent` reports binding readiness,
selected profile/schema, budget/migration status, last successful inference and monitor
check, delivery state and safe error categories. It does not print credentials or chat
history and does not itself call AI. Configured bindings are not proof of live inference.
When only inference fails, replies use clearly labeled deterministic facts. Database or
financial-source failures retain their unavailable/degraded status.

Qwen is the first candidate for live evaluation; GLM is an explicit alternate profile,
not an automatic fallback. A previous playground greeting is not proof of a request
through this dashboard, its Worker binding, D1 and selected model.

## One free cloud account

1. Sign up for Cloudflare and select **Workers Free**. Do not enable a paid Workers plan.
2. Reuse the existing D1 database `tiger-agent-private`, whose ID is already recorded in
   `cloudflare/wrangler.jsonc`. Create a database only for a genuinely new installation;
   do not replace the existing database and its sessions, policies or journal.
3. Apply all migrations in `cloudflare/migrations/` to that database in order. The config binds it as
   `AGENT_DB` and binds the included AI service as `AI`.
4. Set the Worker secrets listed below. Keep `AGENT_ORIGIN` set to the exact existing
   dashboard origin, not the Worker address. The default model is
   `@cf/qwen/qwen3-30b-a3b-fp8`; verify it is available in your Free allowance.
5. Publish the Worker when deployment is authorised, then connect the dashboard relay.

For Cloudflare's GitHub import, select `fung93/tiger-foundation-dashboard` and the
`main` branch. Keep the working/root directory at the repository root, leave the build
command empty, and set the deploy command to
`npx wrangler@4 deploy --config cloudflare/wrangler.jsonc`. The config is in a subfolder,
so the default deploy command will not discover it. Keep the Workers Free plan.

Operator CLI equivalents (Wrangler is a setup tool, not a runtime dependency):

```sh
npx wrangler login
# Reuse the existing configured tiger-agent-private database.
npx wrangler d1 migrations apply tiger-agent-private --remote --config cloudflare/wrangler.jsonc
npx wrangler secret put AGENT_ACCESS_KEY --config cloudflare/wrangler.jsonc
npx wrangler secret put AGENT_GATEWAY_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN --config cloudflare/wrangler.jsonc
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put CRON_SECRET --config cloudflare/wrangler.jsonc
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

Secret commands prompt privately. Do not paste secret values in chat or command arguments.
Use distinct random values of at least 24 characters for the owner access key, gateway,
webhook and cron secrets. The webhook secret accepts letters, numbers, `_` and `-`.
The bot token comes from @BotFather. Set optional `TELEGRAM_BOT_USERNAME` to the bot name
without `@`, enabling one-click pairing links.

| Setting | Where it belongs |
| --- | --- |
| `AGENT_ORIGIN` | Worker variable: exact dashboard origin, e.g. `https://tiger-foundation-dashboard.vercel.app` |
| `AGENT_MODEL` | Optional Worker variable: supported Workers AI model, never an external paid API |
| `AGENT_INFERENCE_ENABLED` | Worker variable: `false` disables AI explanations while retaining available factual tools |
| `AGENT_RESEARCH_ENABLED` | Worker variable: `false` disables configured-source research |
| `AGENT_STRATEGY_ENABLED` | Worker variable: `false` disables new strategy comparisons; factual tools and saved records remain available |
| `AGENT_DAILY_NEURON_LIMIT` | Worker variable: application cap, default 5,000 neurons per UTC day |
| `AGENT_DAILY_MESSAGE_LIMIT` | Optional Worker variable: default 40, maximum 100 |
| `AGENT_ACCESS_KEY` | Worker secret: owner sign-in key, 24+ characters |
| `AGENT_GATEWAY_SECRET` | Same 24+ character secret in Worker and dashboard hosting settings |
| `TELEGRAM_BOT_TOKEN` | Worker secret: existing bot token |
| `TELEGRAM_BOT_USERNAME` | Optional Worker variable: bot name without `@` |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret: authenticate Telegram webhooks |
| `CRON_SECRET` | Worker secret: authenticate internal monitoring |
| `AGENT_WORKER_URL` | Dashboard hosting variable: exact deployed Worker HTTPS origin |
| `AI`, `AGENT_DB` | Worker bindings configured by Wrangler; no model/database API keys |

The existing Vercel dashboard needs **only `AGENT_WORKER_URL` and
`AGENT_GATEWAY_SECRET`**. Its first-party `/api/agent` relay forwards to that fixed
HTTPS Worker, with no redirects or public CORS. Session cookies stay on your dashboard
origin. The Worker rejects unverified gateway calls before model or storage access.
Deploy the dashboard changes only after an explicit push/publish instruction.

## Connect your existing Telegram bot

Save TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET privately on the Worker first.
After deployment, sign in to Agent and choose **Check Telegram setup** in the Telegram
card. This makes bounded identity/webhook reads only. Review the bot username and
Worker destination, then explicitly choose **Connect webhook**. An existing connection
to another service requires replacement consent. No secrets are sent to the browser;
raw provider destinations/error text are never displayed or stored. Setup actions are
owner-authenticated, same-origin and limited to three checks/connects each per minute.
They are not model tools, scheduled actions or AI calls.

After registration choose **Link Telegram** for a fresh invitation. Open the bot link
or send the new `/start CODE` privately. Connection revokes pending old invitations,
preserves an existing linked human/history and keeps queued Telegram updates. A
registered webhook is configuration evidence only; confirm a fresh bot reply. If
already Linked, test with a new question. No schema migration is needed for setup;
previews expire after 10 minutes in private agent_state. Credential/destination drift,
expired previews and uncertain registration require a new check.

For the optional command-line alternative, privately populate ignored `.env.agent.local`
from `.env.agent.example`. Its `AGENT_WORKER_URL` must be the deployed Worker address.
Check without any registration or provider calls:

```sh
node --env-file=.env.agent.local scripts/agent-telegram-setup.mjs
```

Register the webhook explicitly after authorised deployment:

```sh
node --env-file=.env.agent.local scripts/agent-telegram-setup.mjs --register
```

The setup script verifies bot identity, registers the Worker endpoint
`/api/agent-telegram` with Telegram's secret header and verifies its final URL. It prints
no credentials. Open Agent on the dashboard, sign in and choose **Link Telegram**. Open
the link or send `/start CODE` privately to your bot. Codes expire in 10 minutes, are
single-use, and are revoked when replaced. Groups and other Telegram users cannot invoke
the AI or read your history. Unlink through the dashboard before pairing another owner.

## Automatic monitoring

The Worker config includes a five-minute Cron Trigger. It runs the same authenticated
monitor internally, without GitHub Actions runner minutes, external paid scheduling or
self-HTTP calls. Monitoring begins only after the Worker and its bindings/secrets are
actually deployed. Free request/CPU/database limits and provider availability still apply;
last-check time shows actual checks, not guaranteed real-time protection.

Alerts include lending thresholds, critical health, stale/unavailable data and recovery.
Daily reports use MYT and appear once per date after your chosen time. They appear on
the dashboard even before Telegram is paired. Pauses and current preferences apply to
queued notifications, and old risk messages are rechecked before delivery. Delivery state
and update IDs prevent repeated model calls/settings writes on retries. Telegram can still
duplicate a message if it accepts it but the network loses its acknowledgment.

Confirmed per-market policy limits supplement notification preferences. Critical health
below 1 is immediate; exactly 1 is not below liquidation. Recovery uses a small boundary
margin. Verified LP range, material campaign/price changes and reconciliation mismatches
use two observations before warning. Campaign and pool checks run only when the policy
requests them and the producer supplies reliable current fields. Missing pinning or
coverage makes monitoring degraded. Journal reviews are scanned in bounded pages of 20
per tick, so large journals can require multiple ticks. Policy changes reset LP baselines.

Slow chat/research uses separate job leases; owner/policy leases cover short database
commits only. Monitoring has an independent lease and uses zero inference. Connection &
usage shows last success, next intended check, degraded sources, pending delivery and
private payload storage. A configured schedule is not proof of a running deployment.

## Privacy and accuracy

### Strategy policy and verified tools

Strategy constraints are stored separately from alert preferences. Unknown fields stay
unset. Use the policy editor to prepare a preview, review changed fields, then explicitly
confirm the new version. Confirmed versions are immutable and paginated in private D1
using the existing `agent_state` schema. Old previews expire or are replaced; changing a
policy invalidates older cached answers. Notification defaults are never an investment mandate.

The Lending page still opens with its intentional 70% / 35% / 35% maximum-LTV defaults;
its edits apply only to that visit. Agent policy persists independently across sessions.

Portfolio, lending-risk, target-health, LP-position and KAT-exposure tools validate source
times, identity, units and raw amounts. Calculations reuse the shared Morpho core and
render trusted results on the server. Missing accrued-interest or block provenance blocks
actionable lending amounts. An unrelated failed source does not invalidate a separately
verified market. Current incomplete portfolio coverage blocks allocation sizing.

Free-word questions select a closed verified tool or a server-authored conceptual
explanation. Arbitrary model-written financial prose is not treated as a verified answer.
Lending targets require explicit owner intent or an exact confirmed market-policy target.
Unsupported requests ask for clarification. Model output, research and quoted commands
cannot confirm policy or authorize wallet actions.

### Configured-source research

Use Research a protocol or explicitly ask to research one configured protocol. Sources
are fixed official URLs with bounded retrieval and excerpts; no paid or general web
search is used. The current registry includes verified official Morpho, Sushi and Merkl
repository documents. Unverified or blocked documentation remains visible as unavailable.
README background material cannot establish current announcements, governance changes or
incentive changes; those questions show the missing feed/API coverage explicitly.

Each quotation retains its immutable evidence ID, content hash, real URL, retrieval time
and publication time only if the source actually supplies one. The first research release
uses exact excerpts without model-generated factual claims and consumes no AI neurons.
Source instructions cannot change policy, settings or tool authority.

Reports and their source snapshots are private immutable D1 records. A retry of the same
request reference reuses one report. Older reports retain their original dates; policy
changes mark them superseded, and expired evidence marks them partial. These are bounded
synchronous requests; there is no claimed background runner.

D1 keeps sessions, pairing, the latest 24 shared messages, preferences and delivery state
separate from public financial JSON. The model sees at most four short previous messages
and compact verified context. Review Cloudflare's current data-processing and model terms
for your account. There is no external paid inference request or third-party Redis token.

Private history uses same-origin POST, because old service workers cache GET API bodies.
The current worker excludes `/api/agent*` from all caching. Sign-in uses an opaque Secure,
HttpOnly, SameSite=Strict cookie; no keys or transcripts are stored in localStorage. Logout
revokes the session. To revoke all sessions, an operator can delete private `agent_state`
rows whose keys begin `tiger:agent:v1:session:`. Never share access keys or bot tokens here.

Financial readings and exact lending calculations come from the existing dashboard APIs.
Stale readings cannot produce actionable borrowing/repayment amounts. KAT carry allocation
stays included in rewards and excluded from the replacement APR. Historical dollars are
not rewritten. Agent preferences never change on-chain LLTV or Lending's visit settings.

## Local checks

### Strategy comparisons and decision journal

Compare strategies uses explicit owner assumptions and deterministic code. Lending
uses accrued integer debt, the protocol oracle ratio, cash, interest and gas assumptions.
LP alternatives start with the same principal and cash, include gas/swap/slippage costs,
and model explicit price paths and campaign eligibility/dilution/end dates. Staked Sushi
fees route to the DAO; inherited rewards never become projected new income. Blank costs,
prices or unsupported liquidity coverage block affected outcomes. Nothing submits trades.
Use canonical protocol identifiers such as `Morpho`, `Sushi V3` and `Wallet spot conversion`
when setting eligibility; an unknown or unmatched mandate is not silently approved.

Every saved research/strategy brief creates a durable proposed journal entry. Choose
Review decisions to read its original thesis, evidence, snapshot, policy and calculations.
Record an option, state and rationale explicitly; acceptance means review only. Outcome
notes and transaction reports are labeled owner-reported and unverified. The original
thesis and brief are immutable. Policy changes supersede earlier assessments.

Save paper observation keeps a prospective point-in-time record. With matching fresh
LP quotes it marks the original range alternatives and holding benchmark using the same
starting capital and initial cost assumptions. These are price marks before income:
missing fees, rewards, financing, cash flows and actual execution prevent realized net
performance, ranking or win-rate claims. Insufficient matching data produces a blocked
observation rather than an invented result. Telegram `/decisions` or `/journal` reads
the same private journal and links back to dashboard review; no model call is required.

Research remains bounded synchronous execution (up to four configured documents).
There is no Workflow/background research runner in this release. Durable job records
preserve phase/completion/failure; lost invocations are marked interrupted on retry,
and an ambiguous inference is never blindly repeated. Use a new request for a fresh
review. Completed requests reuse the original dated report; expiry does not renew data.

### Storage, migrations and rollback

Apply migrations in order: 0001 private state, 0002 atomic inference usage, 0003 storage
metrics. Policy versions, snapshots, evidence, reports, calculations and journal events
reuse private indexed `agent_state` keys; prefix pagination bounds history reads. Journal
events and their required evidence/baselines have no cache expiry. Operational jobs keep
30 days, request caches 1 day, sessions 7 days, and ordinary fetch caches use source-specific
expiry. Existing financial histories receive no new retention rule. Expired operational
rows are removed in bounded batches by the existing counters.

Migration 0003 maintains private payload bytes/rows with triggers. Diagnostics and the
monitor warn at 80 MiB against a local 100 MiB soft budget. This is not the account's D1
remaining allowance: inspect Cloudflare's total database/index/usage-ledger size and
free quotas separately. No automatic deletion of decision evidence is performed.
Missing metrics migration is visible and degrades monitoring; factual lending checks
continue where source data is available. Inference requires the usage migration.

For rollback, disable inference/research/strategy independently or restore the previous
Worker bundle. Keep the additive migrations and private records. Do not drop usage
reservations, policy versions, decisions or financial history. Older code may ignore
new fields but must never label an old policy/report as current.

### Sign-in works, but questions fail

In Cloudflare, open **AI → Workers AI → Playground**, select the same model as
`AGENT_MODEL` (default `@cf/qwen/qwen3-30b-a3b-fp8`) and send **Hello**. A model
availability, account or free-allowance error there needs to be resolved in Cloudflare
before dashboard questions can work. Share only the error text, never secret values.
Also check the deployed Worker's **Bindings** includes Workers AI named `AI`.

The agent distinguishes AI connection failures, timeouts, free-allowance exhaustion and
incomplete answers. These messages do not expose raw provider errors. Rejected model
text is never saved as an accepted answer or applied as a settings change. A clearly
labeled deterministic factual fallback may enter shared conversation history.

The model uses Cloudflare's documented direct JSON Schema format:
`response_format: {type: 'json_schema', json_schema: <closed planning schema>}`.
One schema permits five read-only tool selectors or reviewed explanation/preferences
selectors. No competing native-tool declaration is sent. JSON strings and structured
response objects still pass the same strict intent and financial-calculation validation.
Qwen receives its documented `/no_think` prompt hint; no unsupported binding flag is
invented, reasoning is never shown, and incomplete output still fails closed.

For invalid_model_output, open Connection & usage after sending a new question. Model
output check shows normalization/parsing/selection failure or accepted selection;
Model finish and Model output tokens distinguish a truncated answer from malformed
content. These are bounded metadata only. Neither provider text nor reasoning is saved.
Rejected prose settles its usage attempt as failed and cannot establish a successful
inference timestamp. Existing reservations and history remain intact.

Workers AI can return one completion in both `choices` and a legacy `response`
field. The adapter accepts matching bounded JSON aliases (including reordered object
keys), empty compatibility fields and nullable/empty tool-call metadata. Conflicting
answers or additional real calls fail closed. Separate reasoning is discarded. A
Model response format of `hybrid` describes this wrapper and can accompany an accepted
answer. Model profile shows which response adapter is deployed.

The owner observed `normalize · invalid_envelope` with one stopped choice, a valid
121-character JSON string and 83 output tokens. Its wrapper was classified ambiguous
by the previous adapter. Compatibility handling and specific failure reasons were
added; the financial selector/intent checks and 800-token cap remain unchanged.

The owner-reported first live failure used 262 of 800 output tokens, so raising the cap
was not supported by that evidence. The request/response contract was corrected instead;
the live outcome still requires a new authenticated test after deployment.

Cloudflare's [Qwen catalog](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/qwen3-30b-a3b-fp8.json)
lists planned deprecation on 15 November 2026. Diagnostics display that date. Recheck
availability and evaluate the explicit GLM alternate before retirement; no automatic
model or paid-provider switch is enabled. The prompt hint is documented in
[Qwen's official README](https://github.com/QwenLM/Qwen3/blob/main/README.md#quickstart).

Only explicit locally tested Qwen and GLM profiles are accepted; there is no automatic
model switch. The retired Llama identifier is rejected with a model-unavailable category.

### Run the checks

```sh
npm run dev
npm run check
```

Without a configured relay the UI honestly shows setup is needed. Tests inject the free
AI binding, Telegram transport and Worker requests; no real inference or messages occur.
The D1 tests use Python 3's standard-library SQLite to exercise real atomic SQL, races,
expiry and rollback (Python is a test dependency only, never a production dependency).
Use a separate development D1 database/bot if testing real bindings. Fixture screenshots
are not proof of live provider activation. The integration test exercises dashboard relay,
Worker, shared history, free AI calculation protocol and Telegram together.

## Local implementation and real release gates

See `TIGER_AGENT_IMPLEMENTATION_PLAN.md` and `TIGER_AGENT_PROGRESS.md` for the ordered
implementation and evidence. The new usage migration must be applied before inference;
existing sessions and financial history are retained. Keep all production secrets on the
same hosts as before. `keep_vars` preserves dashboard-only Worker variables across builds.

The configuration targets the owner's existing `tiger-foundation-dashboard` Worker at
`https://tiger-foundation-dashboard.evalissol.workers.dev`. Keep the Vercel relay pointed
at that origin and reuse the configured private database. Workspace Wrangler authentication
is not available; this does not mean the deployed Worker's saved secrets are missing.

After explicit publication authorization, verify one real Qwen answer and one lending
calculation, migration/read/write, browser login/relay, scheduled checks and Telegram.
Record latency, CPU, subrequests, rows read/written and inference usage. Until those pass,
report locally tested capability and unverified production connectivity separately.
Rollback by disabling inference; preserve usage reservations, policy versions and journals.
