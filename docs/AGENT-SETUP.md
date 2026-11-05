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
paid provider plans. Current pricing/model pages could not be independently fetched
from this development environment because its egress proxy returned HTTP 403. No
specific current allowance amount or unlimited availability is promised.

Publishing the code alone does not activate the agent: its Free-plan bindings and
private settings must be configured too. No account was created, bot registered, model
called or real Telegram message sent during development.

## One free cloud account

1. Sign up for Cloudflare and select **Workers Free**. Do not enable a paid Workers plan.
2. Create a D1 database named `tiger-agent-private` and copy its database ID into the
   placeholder in `cloudflare/wrangler.jsonc`. This ID is not an access credential.
3. Apply `cloudflare/migrations/0001_agent.sql` to that database. The config binds it as
   `AGENT_DB` and binds the included AI service as `AI`.
4. Set the Worker secrets listed below. Keep `AGENT_ORIGIN` set to the exact existing
   dashboard origin, not the Worker address. The default model is
   `@cf/meta/llama-3.1-8b-instruct`; verify it is available in your Free allowance.
5. Publish the Worker when deployment is authorised, then connect the dashboard relay.

For Cloudflare's GitHub import, select `fung93/tiger-foundation-dashboard` and the
`main` branch. Keep the working/root directory at the repository root, leave the build
command empty, and set the deploy command to
`npx wrangler@4 deploy --config cloudflare/wrangler.jsonc`. The config is in a subfolder,
so the default deploy command will not discover it. Keep the Workers Free plan.

Operator CLI equivalents (Wrangler is a setup tool, not a runtime dependency):

```sh
npx wrangler login
npx wrangler d1 create tiger-agent-private --config cloudflare/wrangler.jsonc
# Put the returned database ID in cloudflare/wrangler.jsonc before applying migrations.
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

Privately populate ignored `.env.agent.local` from `.env.agent.example` for operator
setup. Its `AGENT_WORKER_URL` must be the deployed Worker address. Check without any
registration or provider calls:

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

## Privacy and accuracy

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
