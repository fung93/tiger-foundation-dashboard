/* Private agent auth/state and API boundaries, with no network or real secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAgentHandler } from '../api/agent.mjs';
import { processAgentMessage, normalizeSettings } from '../api/_agent-service.mjs';
import { getAgentOrigin, readJson, safeEqual } from '../api/_agent-http.mjs';
import { setupTelegram } from './agent-telegram-setup.mjs';

let checks = 0;
const check = (a, b, text) => { assert.deepEqual(a, b, text); checks++; };
const rejects = async (fn, text) => { await assert.rejects(fn, text); checks++; };
const env = { AGENT_ORIGIN: 'https://tiger.test', AGENT_ACCESS_KEY: 'fixture-owner-access-key-only-not-real',
  AI: { run: async () => { throw Error('This fixture uses an injected responder'); } }, AGENT_DB: { prepare() {}, batch() {} },
  TELEGRAM_BOT_TOKEN: 'fixture-bot-token', TELEGRAM_WEBHOOK_SECRET: 'fixture-webhook-secret-not-real', TELEGRAM_BOT_USERNAME: 'tiger_test_bot', CRON_SECRET: 'fixture-cron-secret-not-real' };
class MemoryStore {
  constructor() { this.values = new Map(); this.locks = new Set(); }
  async get(k) { return structuredClone(this.values.get(k) ?? null); }
  async set(k, v, opts = {}) { if (opts.nx && this.values.has(k)) return false; this.values.set(k, structuredClone(v)); return true; }
  async del(k) { return this.values.delete(k); }
  async take(k) { const v = await this.get(k); await this.del(k); return v; }
  async increment(k) { const n = (await this.get(k) || 0) + 1; await this.set(k, n); return n; }
  async setMany(entries) { for (const { key, value, remove } of entries) { if (remove) await this.del(key); else await this.set(key, value); } }
  async lock(k) { if (this.locks.has(k)) return null; this.locks.add(k); return { assertOwned: async () => {}, commit: entries => this.setMany(entries), release: async () => this.locks.delete(k) }; }
}
const store = new MemoryStore(); let modelCalls = 0;
const context = { sources: [{ name: 'lending', status: 'fresh', ts: '2030-01-01T00:00:00Z' }] };
const respond = async ({ message }) => { modelCalls++; return { reply: 'Verified answer to ' + message, action: null, sources: context.sources }; };
const messageOptions = { store, env, context, respond };
const handler = createAgentHandler({ env, storeFactory: () => store,
  processMessage: opts => processAgentMessage({ ...opts, context, respond }) });
async function request(method = 'GET', body, extra = {}, target = handler) {
  const req = { method, url: '/api/agent', headers: { host: 'tiger.test', origin: env.AGENT_ORIGIN, 'content-type': 'application/json', ...extra }, body };
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(n) { this.statusCode = n; return this; }, end(v) { this.body = JSON.parse(v); } };
  await target(req, res); return res;
}
const before = globalThis.fetch;
globalThis.fetch = () => { throw Error('Agent API tests must never access a network'); };
try {
  const notConfigured = createAgentHandler({ env: {} });
  let r = await request('GET', undefined, {}, notConfigured);
  check(r.body.configured, false, 'Missing credentials produce an honest unconfigured state');
  check(r.body.authenticated, false, 'Unconfigured agents cannot authenticate');
  r = await request('POST', { action: 'status' }, {}, notConfigured);
  check(r.statusCode, 200, 'Unconfigured private-status requests show setup rather than an error loop');
  check(r.body.configured, false, 'POST status honestly reports unconfigured state too');
  r = await request(); check(r.body.authenticated, false, 'A configured agent still requires owner sign-in');
  check(r.body.messages, undefined, 'Public status never exposes private conversation history');
  check(r.headers['cache-control'].includes('no-store'), true, 'Private API responses cannot be cached');
  check(r.headers['access-control-allow-origin'], undefined, 'The private API has no wildcard CORS');
  r = await request('POST', { action: 'chat', message: 'How is my LP?' }); check(r.statusCode, 401, 'Chat cannot spend model credits before authentication');
  r = await request('POST', { action: 'login', accessKey: env.AGENT_ACCESS_KEY }, { origin: 'https://attacker.test' });
  check(r.statusCode, 403, 'Cross-site login is rejected even with a correct access key');
  r = await request('POST', { action: 'login', accessKey: 'incorrect' }); check(r.statusCode, 401, 'Wrong owner keys are rejected');
  r = await request('POST', { action: 'login', accessKey: env.AGENT_ACCESS_KEY });
  check(r.statusCode, 200, 'The owner can sign in');
  const cookie = r.headers['set-cookie'].split(';')[0];
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api']) check(r.headers['set-cookie'].includes(flag), true, 'Session cookie includes ' + flag);
  check(cookie.includes(env.AGENT_ACCESS_KEY), false, 'The owner key is not used as the session cookie');
  const auth = { cookie };
  r = await request('GET', undefined, auth);
  check(r.body.messages, undefined, 'An old service worker cannot cache private history from an authenticated GET');
  check(r.body.authenticated, false, 'Public GET metadata never exposes a logged-in session');
  r = await request('POST', { action: 'status' }, auth); check(r.body.authenticated, true, 'A server-side session survives a separate status request');
  check(r.body.settings.healthThreshold, 1.2, 'Initial agent alerts use their own default threshold');
  check(JSON.stringify(r.body).includes(env.AGENT_ACCESS_KEY), false, 'Server credentials never enter status JSON');
  r = await request('POST', { action: 'settings', settings: { healthThreshold: 1.5, dailyTime: '09:30', dailyEnabled: true } }, auth);
  check(r.body.settings.healthThreshold, 1.5, 'Alert settings persist server-side');
  r = await request('POST', { action: 'settings', settings: { ltvThreshold: 101 } }, auth); check(r.statusCode, 400, 'Invalid LTV thresholds do not persist');
  check((await store.get('settings')).healthThreshold, 1.5, 'Invalid changes leave previously saved settings intact');
  r = await request('POST', { action: 'settings', settings: { accessKey: 'injection' } }, auth); check(r.statusCode, 400, 'Unknown settings cannot write secrets or other state');
  r = await request('POST', { action: 'chat', message: 'How is my LP?', requestId: 'dashboard:fixture-1' }, auth);
  check(r.body.reply, 'Verified answer to How is my LP?', 'The authenticated dashboard reaches the shared agent service');
  check(r.body.messages.length, 2, 'A question and response persist together');
  await request('POST', { action: 'chat', message: 'How is my LP?', requestId: 'dashboard:fixture-1' }, auth);
  check(modelCalls, 1, 'Retrying a request reuses the durable result without another model call');
  check((await store.get('messages')).length, 2, 'Retries do not duplicate shared history');
  await processAgentMessage({ ...messageOptions, message: 'Lending health please', source: 'telegram', requestId: 'telegram:fixture-2' });
  r = await request('POST', { action: 'status' }, auth);
  check(r.body.messages.at(-1).source, 'telegram', 'Dashboard history includes the same Telegram conversation');
  r = await request('POST', { action: 'pair' }, auth);
  check(/^[A-F0-9]{24}$/.test(r.body.code), true, 'Pair codes have 96 bits of random entropy');
  check(r.body.url.startsWith('https://t.me/tiger_test_bot?start='), true, 'Pairing links use only the configured Telegram bot');
  const old = createHash('sha256').update(r.body.code).digest('hex');
  check(!!await store.get('pair:' + old), true, 'Pair codes are stored only by their hash');
  r = await request('POST', { action: 'pair' }, auth);
  check(await store.get('pair:' + old), null, 'Issuing a new pairing code revokes the previous code');
  await store.set('telegram', { chatId: '123', userId: '123' });
  r = await request('POST', { action: 'pair' }, auth); check(r.statusCode, 409, 'A linked Telegram account cannot be silently replaced');
  r = await request('POST', { action: 'unlink' }, auth); check(await store.get('telegram'), null, 'Only an authenticated owner can unlink Telegram');
  check(await store.get('pair:active'), null, 'Unlinking revokes pending pairing codes too');
  r = await request('POST', { action: 'chat', message: 'x'.repeat(4001) }, auth); check(r.statusCode, 400, 'Oversized questions do not reach the model');
  r = await request('POST', { action: 'logout' }, auth); check(r.body.authenticated, false, 'Logout succeeds');
  r = await request('POST', { action: 'status' }, auth); check(r.body.authenticated, false, 'The old session cannot read history after logout');
  r = await request('POST', { action: 'login', accessKey: env.AGENT_ACCESS_KEY }, { 'content-type': 'text/plain' }); check(r.statusCode, 415, 'Simple cross-origin form content types are rejected');
  for (const value of [{ healthThreshold: .9 }, { pausedUntil: 'not-a-date' }, { dailyTime: '25:01' }, { alertsEnabled: 'true' }]) {
    assert.throws(() => normalizeSettings(value)); checks++;
  }
  assert.throws(() => getAgentOrigin({ AGENT_ORIGIN: 'http://untrusted.test' })); checks++;
  assert.throws(() => getAgentOrigin({ AGENT_ORIGIN: 'https://tiger.test/redirect?url=elsewhere' })); checks++;
  check(safeEqual('a', 'a'), true, 'Secret checks accept equal values'); check(safeEqual('a', 'b'), false, 'Secret checks reject different values');
  await rejects(() => readJson({ headers: { 'content-type': 'application/json', 'content-length': '99999' }, body: {} }), 'Body limits apply before parsing');

  const setupCalls = [];
  const setupFetch = async (url, init) => {
    setupCalls.push({ method: url.split('/').at(-1), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, result: setupCalls.at(-1).method === 'getMe'
      ? { username: 'tiger_test_bot' } : setupCalls.at(-1).method === 'getWebhookInfo' ? { url: env.AGENT_ORIGIN + '/api/agent-telegram' } : true }) };
  };
  await setupTelegram({ env, fetcher: setupFetch });
  check(setupCalls.length, 0, 'Default setup check never registers or contacts a real bot');
  const registration = await setupTelegram({ env, register: true, fetcher: setupFetch });
  check(registration.registered, true, 'Explicit registration verifies a fixture webhook');
  check(setupCalls.map(c => c.method), ['getMe', 'setWebhook', 'getWebhookInfo'], 'Registration verifies identity and the final webhook');
  check(setupCalls[1].body.secret_token, env.TELEGRAM_WEBHOOK_SECRET, 'Webhook authentication is configured with Telegram');
  check(JSON.stringify(registration).includes(env.TELEGRAM_BOT_TOKEN), false, 'Setup results do not expose the bot token');
  const listeners = {}, privateFetches = []; let offline = false;
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), {
    self: { location: { origin: env.AGENT_ORIGIN }, addEventListener: (name, fn) => { listeners[name] = fn; } }, URL,
    caches: { match: () => { throw Error('Private agent requests must never read an offline cache'); } },
    fetch: async (req, options) => { privateFetches.push({ req, options }); if (offline) throw Error('offline'); return { ok: true }; },
  });
  let privateResponse;
  const privateRequest = { method: 'GET', url: env.AGENT_ORIGIN + '/api/agent?action=status', mode: 'cors' };
  listeners.fetch({ request: privateRequest, respondWith: value => { privateResponse = value; } });
  await privateResponse;
  check(privateFetches.length, 1, 'The actual worker sends agent requests directly to the network');
  check(privateFetches[0].options.cache, 'no-store', 'The actual worker opts out of agent response caching');
  offline = true;
  listeners.fetch({ request: privateRequest, respondWith: value => { privateResponse = value; } });
  await rejects(() => privateResponse, 'An offline agent request fails rather than exposing cached private content');
  await rejects(() => processAgentMessage({ ...messageOptions, message: 'hello', respond: async () => { throw Error('upstream failed'); } }), 'A model failure is surfaced');
  check(store.locks.has('owner'), false, 'A failed model call releases the owner lock');
  console.log('Agent API and private state: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = before; }
