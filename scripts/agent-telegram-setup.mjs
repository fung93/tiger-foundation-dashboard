/* Explicit operator setup only. Normal development/tests never register a bot. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getAgentOrigin } from '../api/_agent-http.mjs';
import { agentWorkerOrigin } from '../api/_agent-gateway.mjs';

export async function setupTelegram({ env = process.env, register = false, fetcher = fetch } = {}) {
  const origin = env.AGENT_WORKER_URL ? agentWorkerOrigin(env) : getAgentOrigin(env);
  const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].filter(key => !env[key]);
  if (missing.length) throw Error('Set these server secrets first: ' + missing.join(', '));
  if (env.TELEGRAM_WEBHOOK_SECRET.length < 24 || !/^[A-Za-z0-9_-]+$/.test(env.TELEGRAM_WEBHOOK_SECRET)) throw Error('Use a webhook secret of at least 24 letters, numbers, underscores or hyphens.');
  if (!register) return { ready: true, webhook: origin + '/api/agent-telegram', registered: false };
  if (!origin.startsWith('https:')) throw Error('Telegram webhooks need your deployed HTTPS website.');
  async function call(method, body) {
    try {
      const response = await fetcher('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok || !value.ok) throw Error();
      return value.result;
    } catch { throw Error('Telegram setup failed. Check the bot credentials, website and network access.'); }
  }
  const bot = await call('getMe', {});
  await call('setWebhook', { url: origin + '/api/agent-telegram', secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  const webhook = await call('getWebhookInfo', {});
  if (webhook.url !== origin + '/api/agent-telegram') throw Error('Telegram did not confirm the expected webhook address.');
  return { ready: true, registered: true, username: bot.username, webhook: webhook.url };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await setupTelegram({ register: process.argv.includes('--register') }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
