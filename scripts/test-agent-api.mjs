/* Private agent auth/state and API boundaries, with no network or real secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAgentHandler } from '../api/agent.mjs';
import { processAgentMessage, normalizeSettings } from '../api/_agent-service.mjs';
import { getAgentOrigin, readJson, safeEqual } from '../api/_agent-http.mjs';
import { setupTelegram } from './agent-telegram-setup.mjs';
import { agentDiagnostics } from '../api/_agent-diagnostics.mjs';
import { getAgentModelProfile } from '../api/_agent-models.mjs';
import { summarizeAgentModelOutput } from '../api/_agent-output-diagnostics.mjs';

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
const store = new MemoryStore(); let modelCalls = 0, contextReads = 0;
const context = { sources: [{ name: 'lending', status: 'fresh', ts: new Date(Date.now() - 1000).toISOString() }] };
const respond = async ({ message }) => { modelCalls++; return { reply: 'Verified answer to ' + message, action: null, sources: context.sources }; };
const messageOptions = { store, env, context, respond };
const handler = createAgentHandler({ env, storeFactory: () => store,
  processMessage: opts => processAgentMessage({ ...opts, context, respond }), loadContext: async () => { contextReads++; return context; } });
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
  check(r.body.model, undefined, 'Public readiness does not expose the private configured model');
  check(r.headers['cache-control'].includes('no-store'), true, 'Private API responses cannot be cached');
  check(r.headers['access-control-allow-origin'], undefined, 'The private API has no wildcard CORS');
  r = await request('POST', { action: 'chat', message: 'How is my LP?' }); check(r.statusCode, 401, 'Chat cannot spend model credits before authentication');
  r = await request('POST', { action: 'diagnostics' }); check(r.statusCode, 401, 'Operational diagnostics require an owner session');
  r = await request('POST', { action: 'login', accessKey: env.AGENT_ACCESS_KEY }, { origin: 'https://attacker.test' });
  check(r.statusCode, 403, 'Cross-site login is rejected even with a correct access key');
  r = await request('POST', { action: 'login', accessKey: 'incorrect' }); check(r.statusCode, 401, 'Wrong owner keys are rejected');
  r = await request('POST', { action: 'login', accessKey: env.AGENT_ACCESS_KEY });
  check(r.statusCode, 200, 'The owner can sign in');
  const cookie = r.headers['set-cookie'].split(';')[0];
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api']) check(r.headers['set-cookie'].includes(flag), true, 'Session cookie includes ' + flag);
  check(cookie.includes(env.AGENT_ACCESS_KEY), false, 'The owner key is not used as the session cookie');
  const auth = { cookie };
  r = await request('POST', { action: 'tool', tool: 'transfer_tokens', args: {} }, auth);
  check(r.statusCode, 400, 'Unknown financial actions cannot enter the closed read-only registry');
  check(contextReads, 0, 'Tool authorization happens before any financial-source request');
  r = await request('POST', { action: 'policy' }, auth);
  check(r.body.version, 0, 'Alert defaults do not create a confirmed strategy policy');
  r = await request('POST', { action: 'policyDraft', patch: { horizonDays: 30, minLiquidReserveUsd: 100 }, expectedVersion: 0 }, auth);
  const draftId = r.body.draftId;
  check(r.body.status, 'draft', 'An owner policy change is previewed before confirmation');
  check(r.body.changes.length, 2, 'The policy preview names only the changed constraints');
  r = await request('POST', { action: 'policy' }, auth);
  check(r.body.version, 0, 'Previewing a policy does not silently confirm it');
  r = await request('POST', { action: 'policyConfirm', draftId }, auth);
  check(r.body.version, 1, 'An explicit confirmation creates a persistent policy version');
  check(r.body.constraints.minLiquidReserveUsd, 100, 'Confirmed strategy constraints survive a separate request');
  r = await request('POST', { action: 'diagnostics' }, auth);
  check(r.statusCode, 200, 'The owner can inspect diagnostics without making a model call');
  check(r.body.components.session, 'verified', 'Diagnostics distinguish verified session flow from configured bindings');
  check(r.body.model.accountConnectivity, 'unverified', 'Configured model is not claimed to be live before an inference succeeds');
  check(r.body.budget.available, false, 'A missing usage migration remains a visible diagnostic blocker');
  check(JSON.stringify(r.body).includes(env.AGENT_ACCESS_KEY), false, 'Diagnostics never expose the owner key');
  await store.set('diagnostics:lastRequest',{errorCategory:'invalid_model_output',modelOutput:{
    ...summarizeAgentModelOutput({choices:[{message:{role:'assistant',content:'PRIVATE rejected content',reasoning_content:'PRIVATE reasoning'},finish_reason:'length'}]},
      {stage:'normalize',reason:'truncated'}),secret:'PRIVATE_SECRET'}});
  r=await request('POST',{action:'diagnostics'},auth);
  check(r.body.lastModelOutput.reason,'truncated','Authenticated diagnostics expose the bounded failure reason');
  check(r.body.lastModelOutput.finishReason,'length','A capped response can be distinguished from invalid JSON');
  check(JSON.stringify(r.body.lastModelOutput).includes('PRIVATE'),false,'Raw content and unknown stored fields never enter diagnostic responses');
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
  r = await request('POST', { action: 'chat', message: 'A different question', requestId: 'dashboard:fixture-1' }, auth);
  check(r.statusCode, 409, 'A message reference cannot reuse an answer for different inputs');
  const realNow = Date.now;
  try {
    const later = realNow() + 90001; Date.now = () => later;
    r = await request('POST', { action: 'chat', message: 'How is my LP?', requestId: 'dashboard:fixture-1' }, auth);
    check(r.body.errorCategory, 'data_stale', 'An expired financial response is never replayed as a fresh recommendation');
  } finally { Date.now = realNow; }
  r = await request('POST', { action: 'policyDraft', patch: { horizonDays: 45 }, expectedVersion: 1 }, auth);
  await request('POST', { action: 'policyConfirm', draftId: r.body.draftId }, auth);
  r = await request('POST', { action: 'chat', message: 'How is my LP?', requestId: 'dashboard:fixture-1' }, auth);
  check(r.body.errorCategory, 'data_stale', 'A newly confirmed policy invalidates an older cached financial response');
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

  const budgetFixture = () => ({ status: async () => ({ lastSuccessfulInference: '2026-11-01T00:00:00Z' }) });
  const diagnosticStore = new MemoryStore(), selected = getAgentModelProfile(env);
  await diagnosticStore.set('diagnostics:lastInference', { ts: '2026-11-01T00:00:00Z', status: 'succeeded' });
  let diagnostic = await agentDiagnostics({ env, store: diagnosticStore, budgetFactory: budgetFixture });
  check(diagnostic.model.accountConnectivity, 'unverified', 'An old success without model provenance cannot verify the newly selected model');
  check(diagnostic.lastSuccessfulInference, null, 'A different or unknown model success is not the selected model success');
  check(diagnostic.lastSuccessfulInferenceAnyModel, '2026-11-01T00:00:00Z', 'Historical provider success remains separately labeled');
  await diagnosticStore.set('diagnostics:lastInference', { ts: '2026-11-01T00:00:00Z', status: 'succeeded', modelId: selected.id, profileVersion: selected.version });
  diagnostic = await agentDiagnostics({ env, store: diagnosticStore, budgetFactory: budgetFixture });
  check(diagnostic.model.accountConnectivity, 'previous_success', 'Only an exact model and profile version match verifies previous connectivity');
  diagnostic = await agentDiagnostics({ env: { ...env, AGENT_MODEL: '@cf/zai-org/glm-4.7-flash' }, store: diagnosticStore, budgetFactory: budgetFixture });
  check(diagnostic.model.accountConnectivity, 'unverified', 'Changing the configured model requires new provider evidence');

  const clock = Date.now, at = clock();
  try {
    Date.now = () => at;
    const nearStore = new MemoryStore(); let calls = 0;
    const nearContext = { sources: [{ name: 'lending', status: 'fresh', ts: new Date(at - 89000).toISOString() },
      { name: 'history', status: 'fresh', ts: '2020-01-01T00:00:00Z' }] };
    const nearOptions = { store: nearStore, env, context: nearContext, message: 'Check my health', requestId: 'near-expiry',
      respond: async () => { calls++; return { reply: 'A verified current result.', action: null }; } };
    await processAgentMessage(nearOptions);
    await processAgentMessage(nearOptions);
    check(calls, 1, 'A recent result can still be replayed before its original source expires; historical data does not expire the current source');
    Date.now = () => at + 1001;
    await rejects(() => processAgentMessage(nearOptions), /expired/, 'Cached financial data expires with its original source time, not model completion time');
    check(calls, 1, 'An expired idempotent request cannot silently repeat inference');
    Date.now = () => at;
    await rejects(() => processAgentMessage({ ...nearOptions, env: { ...env, AGENT_MODEL: '@cf/zai-org/glm-4.7-flash' } }), /configuration has changed/, 'A model or profile change invalidates the old result without rerunning the same job');
    await rejects(() => processAgentMessage({ ...nearOptions, env: { ...env, AGENT_INFERENCE_ENABLED: 'false' } }), /configuration has changed/, 'Disabling inference cannot replay an AI result from the enabled configuration');
    const key = 'request:' + createHash('sha256').update('near-expiry').digest('hex');
    const legacy = await nearStore.get(key); delete legacy.configurationHash; await nearStore.set(key, legacy);
    await rejects(() => processAgentMessage(nearOptions), /configuration has changed/, 'A cache record from an older schema cannot verify its model fingerprint');

    const slowStore = new MemoryStore();
    const expired = await processAgentMessage({ store: slowStore, env, context: { asOf: new Date(at).toISOString(),
      sources: [{ name: 'lending', status: 'fresh', ts: new Date(at - 89000).toISOString() }],
      lending: { status: 'fresh', ts: new Date(at - 89000).toISOString(), markets: [{ status: 'fresh', label: 'avKAT / KAT',
        ts: new Date(at - 89000).toISOString(), debt_amount: 1, health: 1.4, debt_usd: 100 }] } },
    message: 'How much should I repay?', requestId: 'slow-reply', respond: async () => {
      Date.now = () => at + 2000;
      return { reply: 'Repay exactly 123 KAT now.', action: { type: 'settings', settings: { healthThreshold: 2 } } };
    } });
    check(expired.mode, 'facts_only', 'A model reply whose source expires during inference becomes dated deterministic facts');
    check(expired.errorCategory, 'data_stale', 'Expiry during inference is visible as stale data');
    check(expired.sources[0].status, 'stale', 'Source freshness is rechecked at completion');
    check(expired.reply.includes('123'), false, 'An expired generated repayment amount is never returned');
    check(expired.settings.healthThreshold, 1.2, 'A discarded expired reply cannot apply its proposed settings action');
    check(await slowStore.get('diagnostics:lastInference'), null, 'An injected fixture responder cannot falsely attest a real model invocation');
    Date.now = () => at;
    const independent = await processAgentMessage({ store: new MemoryStore(), env,
      context: { sources: [{ name: 'lp', status: 'fresh', ts: new Date(at - 89000).toISOString() }] },
      message: 'Review the verified lending market', respond: async () => {
        Date.now = () => at + 2000;
        return { reply: 'Verified selected market result.', toolResults: [{ status: 'ready', validUntil: new Date(at + 90000).toISOString() }] };
      } });
    check(independent.reply, 'Verified selected market result.', 'An unrelated expired LP source cannot discard a separately verified market result');
    check(independent.sources[0].status, 'stale', 'Unrelated source freshness is still rechecked independently');
  } finally { Date.now = clock; }

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
  const fallbackStore = new MemoryStore();
  const factual = await processAgentMessage({ store: fallbackStore, message: 'Check my lending health.',
    env: { ...env, AI: undefined }, context, requestId: 'missing-ai' });
  check(factual.mode, 'facts_only', 'An AI-only outage preserves a clearly labeled deterministic response');
  check(factual.errorCategory, 'configuration_missing', 'The deterministic response explains missing inference setup');
  check(factual.reply.includes('current readings unavailable'), true, 'Missing source readings stay unavailable in a fallback');
  const badOutputStore=new MemoryStore(),settlements=[];
  const malformed=await processAgentMessage({store:badOutputStore,context,requestId:'bad-model-output',message:'Hello',
    env:{...env,AI:{run:async()=>({response:'{PRIVATE malformed JSON'})}},budgetFactory:()=>({reserve:async()=>({id:'malformed'}),settle:async(_attempt,outcome)=>settlements.push(outcome)})});
  check(malformed.errorCategory,'invalid_model_output','Malformed model output still produces the deterministic fallback');
  check((await badOutputStore.get('diagnostics:lastRequest')).modelOutput.reason,'invalid_json','Failure metadata survives the fallback and fenced shared-state commit');
  check(await badOutputStore.get('diagnostics:lastInference'),null,'Malformed output cannot mark the selected model successful');
  check(settlements[0].outcome,'failed','The rejected model answer settles its attempt once as failed');
  check(JSON.stringify(await badOutputStore.get('diagnostics:lastRequest')).includes('PRIVATE'),false,'Persisted model metadata cannot retain provider content');
  const storageDown = new MemoryStore(); storageDown.get = async () => { throw Error('private database failure'); };
  await rejects(() => processAgentMessage({ store: storageDown, message: 'Hello', env, context }),
    'A database outage is never disguised as an AI-only fallback');
  console.log('Agent API and private state: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = before; }
