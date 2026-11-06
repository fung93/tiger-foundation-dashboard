/* Free Worker adapter and Cron boundaries, without Cloudflare or any provider. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentWorker } from '../cloudflare/worker.mjs';
import { readJson, json } from '../api/_agent-http.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const env = { AGENT_GATEWAY_SECRET: 'fixture-gateway-secret-at-least-24', CRON_SECRET: 'fixture-cron-secret-at-least-24',
  TELEGRAM_BOT_TOKEN: 'fixture-bot-token', TELEGRAM_WEBHOOK_SECRET: 'fixture-webhook-secret-at-least-24',
  AGENT_ORIGIN: 'https://dashboard.fixture.test', AI: { run() { throw Error('No model call is permitted'); } }, AGENT_DB: {} };
const calls = [], reports = [];
let broken = false;
const factory = name => options => async (req, res) => {
  check(options.env, env, 'The Worker passes its actual AI/database bindings to the handler');
  if (name === 'agent') check(options.workerOrigin, 'https://worker.fixture.test', 'The gateway supplies the actual Worker origin for Telegram registration');
  else check(options.workerOrigin, undefined, 'Telegram and monitoring cannot select a webhook destination');
  calls.push({ name, req });
  if (broken) throw Error('upstream failed with secret fixture-private-secret');
  if (name === 'agent') {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    res.setHeader('set-cookie', 'tiger_agent_session=fixture-session; HttpOnly; SameSite=Strict; Secure; Path=/api');
    res.setHeader('vary', 'Cookie, Origin');
    json(res, 200, { action: body?.action || req.query.action, private: true });
  } else {
    json(res, name === 'monitor' ? 202 : 200, { ok: true });
  }
};
const worker = createAgentWorker({ agentFactory: factory('agent'), telegramFactory: factory('telegram'), monitorFactory: factory('monitor'), report: message => reports.push(message) });
const request = (path = '/api/agent', { method = 'POST', body = JSON.stringify({ action: 'status' }), gateway = true, headers = {} } = {}) => new Request('https://worker.fixture.test' + path, {
  method, headers: { 'content-type': 'application/json', origin: env.AGENT_ORIGIN,
    ...(gateway ? { 'x-agent-gateway-secret': env.AGENT_GATEWAY_SECRET } : {}), ...headers },
  ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
});
const oldFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Worker tests cannot contact any external provider'); };
try {
  let response = await worker.fetch(request('/api/agent', { gateway: false }), env);
  check(response.status, 401, 'A direct dashboard request without the relay secret is rejected');
  check(calls.length, 0, 'Rejected gateway traffic reaches no state, model or route handler');
  response = await worker.fetch(request('/api/agent', { headers: { 'x-agent-gateway-secret': 'incorrect' } }), env);
  check(response.status, 401, 'An incorrect relay secret is rejected');
  response = await worker.fetch(request(), { ...env, AGENT_GATEWAY_SECRET: 'short' });
  check(response.status, 503, 'A weak or missing relay secret cannot enable the gateway');
  check(calls.length, 0, 'Gateway configuration failures consume no provider work');

  response = await worker.fetch(request('/api/agent?mode=fixture', { headers: { cookie: 'tiger_agent_session=opaque', 'cf-connecting-ip': '192.0.2.1' } }), env);
  check(response.status, 200, 'An authenticated first-party relay request reaches the private handler');
  check(await response.json(), { action: 'status', private: true }, 'JSON bodies reach the existing Node-style API contract');
  check(calls.at(-1).req.headers.origin, env.AGENT_ORIGIN, 'The dashboard origin is preserved for same-origin checks');
  check(calls.at(-1).req.headers.cookie, 'tiger_agent_session=opaque', 'Opaque owner sessions survive the relay');
  check(calls.at(-1).req.query.mode, 'fixture', 'Query parameters are preserved');
  check(calls.at(-1).req.socket.remoteAddress, '192.0.2.1', 'Worker source address is available to rate limiting');
  check(response.headers.get('set-cookie').includes('HttpOnly; SameSite=Strict; Secure'), true, 'First-party session flags are preserved');
  check(response.headers.get('cache-control').includes('no-store'), true, 'Private Worker responses cannot be cached');
  check(response.headers.get('access-control-allow-origin'), null, 'The Worker never adds wildcard CORS');

  response = await worker.fetch(request('/api/agent?action=status', { method: 'GET' }), env);
  check((await response.json()).action, 'status', 'Public readiness requests preserve their query contract through the authenticated relay');
  const beforeUnverified = calls.length;
  response = await worker.fetch(request('/api/agent-telegram', { gateway: false }), env);
  check(response.status, 401, 'Unauthenticated Telegram requests stop before reading provider state');
  response = await worker.fetch(request('/api/agent-monitor', { gateway: false }), env);
  check(response.status, 401, 'Unauthenticated monitor requests stop at the Worker boundary');
  check(calls.length, beforeUnverified, 'Rejected public webhook/monitor traffic reaches no handler');
  response = await worker.fetch(request('/api/agent-telegram', { gateway: false, headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET } }), env);
  check(response.status, 200, 'Telegram reaches its own secret-checked handler without the dashboard relay secret');
  check(calls.at(-1).name, 'telegram', 'The webhook routes to the Telegram handler');
  check(calls.at(-1).req.headers['x-telegram-bot-api-secret-token'], env.TELEGRAM_WEBHOOK_SECRET, 'Telegram authentication headers are not discarded');
  response = await worker.fetch(request('/api/agent-monitor', { gateway: false, headers: { authorization: 'Bearer ' + env.CRON_SECRET } }), env);
  check(response.status, 202, 'External monitor calls retain the handler response code');
  check(calls.at(-1).req.headers.authorization, 'Bearer ' + env.CRON_SECRET, 'External monitor authentication is preserved');

  const before = calls.length;
  response = await worker.fetch(request('/api/unknown', { gateway: false }), env);
  check(response.status, 404, 'Unknown routes are not delegated to another service');
  check(calls.length, before, 'Unknown routes perform no provider work');
  response = await worker.fetch(request('/api/agent', { headers: { 'content-length': '20000' } }), env);
  check(response.status, 413, 'An oversized declared body is rejected before the handler reads state');
  check(calls.length, before, 'Oversized bodies do not invoke route handlers');
  response = await worker.fetch(request('/api/agent', { body: 'x'.repeat(17000) }), env);
  check(response.status, 413, 'Streaming bodies are bounded without trusting Content-Length');
  check(calls.length, before, 'Streaming overflow also stops before provider work');
  broken = true;
  response = await worker.fetch(request(), env);
  check(response.status, 503, 'Provider/handler failures become temporary unavailability');
  check((await response.text()).includes('fixture-private-secret'), false, 'Thrown provider details and secrets never leak');
  broken = false;

  const pending = [];
  await worker.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: promise => pending.push(promise) });
  check(pending.length, 1, 'Cron work is registered with waitUntil');
  await pending[0];
  check(calls.at(-1).name, 'monitor', 'Cron invokes the existing shared monitor');
  check(calls.at(-1).req.headers.authorization, 'Bearer ' + env.CRON_SECRET, 'Internal Cron calls authenticate exactly like external checks');
  check(calls.at(-1).req.method, 'POST', 'Cron uses an explicit authenticated POST');
  const previous = calls.length;
  await worker.scheduled({}, { ...env, CRON_SECRET: '' }, { waitUntil: promise => pending.push(promise) });
  check(calls.length, previous, 'Missing scheduler configuration performs no model or database work');
  check(reports.at(-1), 'Agent monitoring is not configured.', 'Unconfigured schedules report a generic operator message');
  broken = true;
  await assert.rejects(worker.scheduled({}, env, { waitUntil: promise => pending.push(promise) }), /did not complete/); checks++;
  await assert.rejects(pending.at(-1), /did not complete/); checks++;
  check(reports.at(-1).includes('fixture-private-secret'), false, 'Cron failure reports are sanitized too');

  const config = JSON.parse(readFileSync(new URL('../cloudflare/wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  check(config.ai.binding, 'AI', 'The deployed runtime uses the included Workers AI binding');
  check(config.d1_databases[0].binding, 'AGENT_DB', 'Private state uses D1 rather than a paid Redis provider');
  check(config.triggers.crons, ['*/5 * * * *'], 'Background checks use Workers Cron');
  check(config.compatibility_flags.includes('nodejs_compat'), true, 'The runtime supports the shared Node crypto primitives');
  check(config.vars.OPENAI_API_KEY, undefined, 'The configuration contains no paid AI provider credential');
  check(config.usage_model, undefined, 'No paid usage model is enabled by the config');
  console.log('Free agent Worker: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = oldFetch; }
