/* Cross-channel integration with the real handlers, service and AI tool protocol.
   Every external provider is a local fixture; no model/bot/RPC is contacted. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentHandler } from '../api/agent.mjs';
import { createTelegramHandler } from '../api/agent-telegram.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { processAgentMessage } from '../api/_agent-service.mjs';
import { respondAgent } from '../api/_agent-brain.mjs';
import { forwardAgentRequest } from '../api/_agent-gateway.mjs';
import { createAgentWorker } from '../cloudflare/worker.mjs';
import { loadAgentContext, calculateAgentLending } from '../api/_agent-context.mjs';

let checks = 0;
const check = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const lending = JSON.parse(readFileSync(new URL('../morpho-history.json', import.meta.url))).samples.at(-1);
const NOW = lending.ts * 1000 + 10000, ORIGIN = 'https://agent.integration.test';
const env = { AGENT_ORIGIN: ORIGIN, AGENT_ACCESS_KEY: 'fixture-private-access-key-12345', AI: { run: async () => { throw Error('Fixture model not initialised'); } },
  AGENT_DB: { prepare() {}, batch() {} }, AGENT_GATEWAY_SECRET: 'fixture-private-gateway-secret',
  TELEGRAM_BOT_TOKEN: 'fixture-telegram', TELEGRAM_WEBHOOK_SECRET: 'fixture-webhook-private-secret', CRON_SECRET: 'fixture-cron-private-secret' };
const success = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const values = new Map(), locks = new Set();
const store = {
  get: async key => structuredClone(values.get(key) ?? null),
  set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
  del: async key => values.delete(key),
  take: async key => { const value = await store.get(key); values.delete(key); return value; },
  increment: async key => { const n = (values.get(key) || 0) + 1; values.set(key, n); return n; },
  setMany: async entries => { for (const e of entries) { if (e.remove) values.delete(e.key); else values.set(e.key, structuredClone(e.value)); } },
  lock: async key => {
    if (locks.has(key)) return null; locks.add(key);
    return { release: async () => locks.delete(key), assertOwned: async () => { assert.ok(locks.has(key)); },
      commit: async entries => { assert.ok(locks.has(key)); await store.setMany(entries); } };
  },
};
const oldFetch = globalThis.fetch, oldNow = Date.now;
globalThis.fetch = () => { throw Error('Integration fixtures must not access any network'); };
Date.now = () => NOW;
try {
  const lp = { generated: new Date(NOW - 1000).toISOString(), cards: { value_usd: 100, pnl_usd: -2, fees_usd: 5, net_usd: 3, unclaimed_usd: 4, open: 1 },
    live: [], health: { errors: {}, behind: { katana: 0, robinhood: 0 }, unread: [], unpriced: [] } };
  const context = await loadAgentContext({ origin: ORIGIN, now: NOW, fetcher: async url => {
    const path = new URL(url).pathname;
    return success(path === '/api/morpho' ? { ...structuredClone(lending), full: true }
      : path === '/api/lpbook' ? lp : JSON.parse(readFileSync(new URL(path === '/data.json' ? '../data.json' : '../history.json', import.meta.url))));
  } });
  const market = context.lending.markets.find(m => m.key === 'avkat-kat');
  const expected = calculateAgentLending(context, { market: market.key, targetHealth: 1.5 });
  check(expected.available, true, 'The recorded fixture supports a verified lending calculation');
  let modelCalls = 0;
  const question = 'How much should I repay on avKAT / KAT to reach health 1.5?';
  const preference = 'Let me know when health goes below 1.3.';
  const model = async (name, body) => {
    check(name, '@cf/meta/llama-3.1-8b-instruct', 'Only the included Workers AI model is used');
    modelCalls++;
    check(body.max_tokens, 800, 'Free inference has a bounded output allowance');
    const calculation = body.messages.find(m => m.role === 'user' && m.content.startsWith('Verified lending calculation result'));
    if (calculation) {
      const result = JSON.parse(calculation.content.split('\n')[1]);
      check(result.repay_raw, expected.repay_raw, 'The free model receives the exact shared repayment calculation');
      return { response: JSON.stringify({ reply: 'Fixture repayment: ' + result.repay_amount + ' ' + result.loan_token, preferenceChanges: [] }) };
    }
    if (body.messages.some(m => m.role === 'user' && m.content === question))
      return { response: JSON.stringify({ calculation: { market: market.key, targetHealth: 1.5 } }) };
    return { response: JSON.stringify({ reply: 'I will save the health alert at 1.3.',
      preferenceChanges: [{ key: 'healthThreshold', value: '1.3', evidence: preference }] }) };
  };
  env.AI = { run: model };
  const shared = args => processAgentMessage({ ...args, context, respond: opts => respondAgent(opts) });
  const localWeb = createAgentHandler({ env, storeFactory: () => store, processMessage: shared });
  const worker = createAgentWorker({ agentFactory: () => localWeb });
  const web = async (req, res) => {
    const forwarded = await forwardAgentRequest(req, res, { env: { AGENT_WORKER_URL: 'https://fixture.workers.dev', AGENT_GATEWAY_SECRET: env.AGENT_GATEWAY_SECRET },
      fetcher: (url, init) => worker.fetch(new Request(url, init), env) });
    check(forwarded, true, 'Dashboard traffic crosses the authenticated free Worker relay');
  };
  const sends = [];
  const telegram = createTelegramHandler({ env, storeFactory: () => store, processMessage: shared, now: () => NOW,
    fetcher: async (url, init) => { assert.match(url, /^https:\/\/api\.telegram\.org\/botfixture-telegram\/sendMessage$/); sends.push(JSON.parse(init.body)); return success({ ok: true, result: { message_id: sends.length } }); } });
  const monitor = createMonitorHandler({ env, storeFactory: () => store, loadContext: async () => context,
    now: () => NOW, fetcher: async (_url, init) => { sends.push(JSON.parse(init.body)); return success({ ok: true, result: { message_id: sends.length } }); } });
  async function call(handler, body, headers = {}) {
    const res = { headers: {}, code: null, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, end(value) { this.body = JSON.parse(value); } };
    await handler({ method: 'POST', url: '/api/agent', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body }, res);
    return res;
  }
  let result = await call(web, { action: 'login', accessKey: env.AGENT_ACCESS_KEY });
  check(result.code, 200, 'The private dashboard signs in through the real API');
  const auth = { cookie: result.headers['set-cookie'].split(';')[0] };
  result = await call(web, { action: 'pair' }, auth);
  const update = (id, text) => ({ update_id: id, message: { text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
  const telegramAuth = { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET };
  result = await call(telegram, update(1, '/start ' + result.body.code), telegramAuth);
  check(result.code, 200, 'A dashboard-issued invitation pairs through the actual Telegram handler');
  check((await store.get('telegram')).chatId, '42', 'The private owner is durably bound');
  result = await call(telegram, update(2, preference), telegramAuth);
  check(result.code, 200, 'Free-form Telegram preferences use the real AI/service pipeline');
  result = await call(web, { action: 'status' }, auth);
  check(result.body.settings.healthThreshold, 1.3, 'The dashboard sees the Telegram preference change');
  check(result.body.messages.at(-1).source, 'telegram', 'Both channels read the same conversation');
  result = await call(web, { action: 'chat', message: question, requestId: 'integration:web:question' }, auth);
  check(result.code, 200, 'Dashboard lending questions execute through the real tool protocol');
  check(result.body.reply, 'Fixture repayment: ' + expected.repay_amount + ' ' + market.loan_token, 'The final answer uses verified token amounts');
  const beforeRetry = modelCalls;
  await call(web, { action: 'chat', message: question, requestId: 'integration:web:question' }, auth);
  check(modelCalls, beforeRetry, 'Retrying an answered dashboard question spends no extra model call');
  result = await call(telegram, update(2, preference), telegramAuth);
  check(result.body.duplicate, true, 'Telegram retries reuse the completed update without repeating the preference');
  await call(web, { action: 'settings', settings: { dailyEnabled: true, dailyTime: '00:00', alertsEnabled: false } }, auth);
  result = await call(monitor, {}, { authorization: 'Bearer ' + env.CRON_SECRET });
  check(result.code, 200, 'The authenticated background monitor runs through the actual handler');
  check(result.body.daily, true, 'A due MYT report is generated');
  result = await call(web, { action: 'status' }, auth);
  check(result.body.messages.at(-1).source, 'monitor', 'The scheduled report appears in the shared dashboard conversation');
  check(sends.some(s => s.text.includes('Tiger Foundation summary')), true, 'The paired Telegram transport receives that report');
  check(modelCalls, beforeRetry, 'Deterministic monitoring and reports do not spend model calls');
  check(locks.size, 0, 'All cross-channel owner and update locks are released');
  console.log('Agent dashboard/Telegram integration: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = oldFetch; Date.now = oldNow; }
