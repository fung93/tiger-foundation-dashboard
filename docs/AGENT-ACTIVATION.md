# Activate the published agent

The code release is `ad80012` on `main`. Publishing source is complete; the real
Cloudflare database, inference, scheduling and Telegram path still need verification.
Use the existing Worker and database below. Keep Cloudflare Workers on Free.

Keep access keys and bot tokens in your provider settings or ignored private local
files. Never paste them into ChatGPT, GitHub files, screenshots or URL address bars.

## 1. Update the existing D1 database

Open Cloudflare → Storage & databases → D1 → `tiger-agent-private` → Console.
The existing database ID is `32405a9c-f592-4f18-88dd-fbdfb2f5db0c`.

Run this first to inspect table names, without reading private records:

```sql
SELECT name FROM sqlite_master
WHERE type = 'table'
AND name IN ('agent_state', 'agent_usage', 'agent_storage_metrics')
ORDER BY name;
```

If `agent_state` is absent, copy and run [0001_agent.sql](https://raw.githubusercontent.com/fung93/tiger-foundation-dashboard/main/cloudflare/migrations/0001_agent.sql).
Then open each script below, copy its entire contents and run it in Console, in order:

1. [0002_agent_usage.sql](https://raw.githubusercontent.com/fung93/tiger-foundation-dashboard/main/cloudflare/migrations/0002_agent_usage.sql)
2. [0003_agent_storage.sql](https://raw.githubusercontent.com/fung93/tiger-foundation-dashboard/main/cloudflare/migrations/0003_agent_storage.sql)

Rerun the table-name query. All three names should appear. These additive scripts
retain existing sessions, messages and private records. If Console reports an error,
stop at that script and share only the error text, with credentials removed.

If Console says No SQL statements detected, check whether copying collapsed line
breaks after a leading `--` comment. Remove full comment lines or preserve the raw
file's newlines before running it. Creation statements normally return no data;
the verification query confirms the tables exist.

If you already use authenticated Wrangler locally, the alternative is one command
from the updated repository root:

```sh
npx wrangler@4 d1 migrations apply tiger-agent-private --remote --config cloudflare/wrangler.jsonc
```

## 2. Check the existing Worker deployment

Open Workers & Pages → `tiger-foundation-dashboard` → Deployments. Check that the
latest successful build uses commit `ad80012` or a later descendant on `main`.
If a build failed before migrations were ready, rerun it after step 1.

For the connected GitHub build, use the repository root, an empty build command,
and this deploy command:

```sh
npx wrangler@4 deploy --config cloudflare/wrangler.jsonc
```

The Worker URL remains `https://tiger-foundation-dashboard.evalissol.workers.dev`.
A direct browser visit can return 401 or 404 because these routes require private
authentication. Test through the dashboard rather than treating that as a failure.

## 3. Confirm Worker bindings and settings

Under Bindings, confirm Workers AI has the name `AI`, and D1 has the name `AGENT_DB`
and points to `tiger-agent-private`. The repository config declares both bindings.

Under Settings → Variables and Secrets, confirm these text variables:

| Name | Value |
| --- | --- |
| `AGENT_ORIGIN` | `https://tiger-foundation-dashboard.vercel.app` |
| `AGENT_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` |
| `AGENT_INFERENCE_ENABLED` | `true` |
| `AGENT_RESEARCH_ENABLED` | `true` |
| `AGENT_STRATEGY_ENABLED` | `true` |
| `AGENT_DAILY_NEURON_LIMIT` | `5000` |
| `AGENT_DAILY_MESSAGE_LIMIT` | `40` |

Retain existing valid secret values. The required secret names are `AGENT_ACCESS_KEY`,
`AGENT_GATEWAY_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET`.
Owner, gateway, webhook and cron secrets must be distinct random values of at least 24
characters. For the webhook secret use letters, digits, underscores and hyphens.
The number of masking characters shown by Cloudflare does not reveal secret length.
Optional `TELEGRAM_BOT_USERNAME` is the bot username without `@`.

Save/deploy any settings changes. Cloudflare's Free-plan model allowance must be
available; the local cap is not a guarantee of remaining account-wide allowance.

## 4. Confirm the Vercel relay

Open Vercel → `tiger-foundation-dashboard` → Settings → Environment Variables.
For Production, set or confirm:

| Name | Value |
| --- | --- |
| `AGENT_WORKER_URL` | `https://tiger-foundation-dashboard.evalissol.workers.dev` |
| `AGENT_GATEWAY_SECRET` | Exactly the same private value as the Worker's gateway secret |

Redeploy Production if you changed environment variables. Confirm its deployment
includes `ad80012` or a later descendant. The agent access key is entered on the
private dashboard login; it is different from the gateway secret.

## 5. Test dashboard chat and verified calculations

Open [Agent](https://tiger-foundation-dashboard.vercel.app/agent.html), refresh the
page, and sign in with your `AGENT_ACCESS_KEY`. Open Connection & usage → Check
connection. Private storage/usage should be available, and the selected model should
be Qwen. A configured binding is not yet proof of a successful inference.

Ask `Check my lending health.` Then ask a concrete calculation such as
`How much would I need to repay on avKAT / KAT to reach health 1.5?`
This requests a read-only estimate; no transaction is submitted. Refresh Connection &
usage and check the last successful inference and usage. Missing/stale financial data
can legitimately block a calculation; keep that distinct from an inference failure.

If chat returns factual mode or an error, share the safe error category and component
statuses. Do not share keys, cookies or bot tokens. If Qwen availability is in doubt,
test that exact model in Workers AI Playground with `Reply with OK.` A playground
reply is an additional diagnosis, not a replacement for the dashboard test.

After the response-contract update, Connection & usage also shows Model output check,
Model finish and Model output tokens. If a new question still returns
invalid_model_output, share those three metadata fields. They contain no model prose
or secrets. A model/profile update requires a fresh successful-inference timestamp;
an older reply or cached failure cannot verify the new version.

## 6. Pair Telegram

If Telegram already shows Linked, use the existing private bot chat. Otherwise choose
Link Telegram, open the bot link and send its `/start CODE` message. Pairing codes
expire in 10 minutes. The bot should confirm the connection. Ask `Check my lending
health.` and `/journal` to test the shared owner path and durable journal.

If the bot does not respond, its webhook may need registration. On your own machine,
use an up-to-date checkout with Node installed. Copy `.env.agent.example` to ignored
`.env.agent.local` and privately set these three entries:

- `AGENT_WORKER_URL`: the existing workers.dev origin above.
- `TELEGRAM_BOT_TOKEN`: the token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: exactly the value saved on the Worker.

Then run from the repository root:

```sh
node --env-file=.env.agent.local scripts/agent-telegram-setup.mjs
node --env-file=.env.agent.local scripts/agent-telegram-setup.mjs --register
```

The first command checks local setup. The second checks bot identity, registers the
authenticated webhook and verifies its URL. Neither command prints the token. Return
to Link Telegram for a fresh pairing code after webhook setup.

## 7. Verify monitoring

Confirm the Worker's Cron Trigger is `*/5 * * * *`. After the next scheduled tick,
refresh Agent and inspect the last monitoring check. Check Connection & usage for
degraded sources, last success and pending Telegram delivery. The monitor uses zero
inference. Pause settings can intentionally pause checks; enable daily summaries only
if you want them. A successful deployment alone does not prove scheduling or delivery.

Finally review the separate Strategy policy, preview your preferences and confirm
them explicitly. Its persistent settings do not change Lending's per-visit defaults.
Research covers configured sources, comparisons remain conditional and wallet access
is read-only. Full reference and rollback instructions are in [AGENT-SETUP.md](AGENT-SETUP.md).
