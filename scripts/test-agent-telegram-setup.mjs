/* Real SQLite, fake Telegram: owner-only configuration, drift/expiry, bounded
   failures and preserved conversations. No bot registration or real messages. */
import assert from 'node:assert/strict';
import { createAgentHandler } from '../api/agent.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { telegramSetupAction, telegramConfigured } from '../api/_agent-telegram-setup.mjs';
import { AGENT_TOOL_NAMES } from '../api/_agent-tools.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const fixture = createAgentSQLiteFixture();
const env = { AGENT_DB: fixture.db, AGENT_ORIGIN: 'https://dashboard.fixture.test',
  AGENT_ACCESS_KEY: 'fixture-owner-private-key-at-least-24', TELEGRAM_BOT_TOKEN: '12345:fixture_bot_token',
  TELEGRAM_WEBHOOK_SECRET: 'fixture_webhook_secret_at_least_24', TELEGRAM_BOT_USERNAME: 'outdated_bot' };
const workerOrigin = 'https://worker.fixture.test', target = workerOrigin + '/api/agent-telegram';
const store = createAgentStore(env), calls = [];
let at = Date.now(), webhook = '', deliveryError = '', updates, mode, hold, entered;
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Telegram setup tests cannot access a real network'); };
const fetcher = async (url, options) => {
  const method = new URL(url).pathname.split('/').at(-1), body = JSON.parse(options.body);
  calls.push({ method, body });
  check(url, 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, 'Only the fixed Telegram Bot API is contacted');
  check(options.redirect, 'manual', 'Token-bearing requests reject redirects using the Workers-supported mode');
  check(await store.get('lock:owner'), null, 'No owner lock spans a Telegram network call');
  if (hold) { entered(); await hold; }
  if (mode === 'throw') throw Error('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/PRIVATE');
  if (mode === 'unauthorized') return new Response('PRIVATE provider body', { status: 401 });
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://PRIVATE.fixture.test/token' } });
  if (mode === 'rate_limit') return Response.json({ ok: false, description: 'PRIVATE provider text' }, { status: 429 });
  if (mode === 'server_error') return new Response('PRIVATE provider body', { status: 502 });
  if (mode === 'api_unauthorized') return Response.json({ ok: false, error_code: 401, description: 'PRIVATE provider text' });
  if (mode === 'api_rejected') return Response.json({ ok: false, error_code: 'PRIVATE' });
  if (mode === 'oversized') return new Response('x'.repeat(17000));
  if (mode === 'oversized_stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17000)); controller.close(); } }));
  if (mode === 'malformed') return new Response('{invalid');
  let result;
  if (method === 'getMe') result = mode === 'not_bot' ? { id: 123, is_bot: false, username: 'fixture_bot' }
    : { id: 123, is_bot: true, username: 'fixture_bot' };
  else if (method === 'getWebhookInfo') result = { url: webhook, pending_update_count: 2,
    ...(updates ? { allowed_updates: updates } : {}), ...(deliveryError ? { last_error_message: deliveryError } : {}) };
  else if (method === 'setWebhook') {
    if (mode === 'uncertain_write') throw Error('Unknown provider outcome ' + env.TELEGRAM_BOT_TOKEN);
    if (mode !== 'wrong_destination') webhook = body.url;
    updates = body.allowed_updates; result = true;
  } else throw Error('Unexpected provider method');
  return Response.json({ ok: true, result });
};
const handler = createAgentHandler({ env, storeFactory: () => store, workerOrigin, telegramFetcher: fetcher });
let cookie = '';
async function request(body, { authenticated = true, origin = env.AGENT_ORIGIN, method = 'POST' } = {}) {
  const req = { method, url: '/api/agent', headers: { origin, 'content-type': 'application/json',
    ...(authenticated ? { cookie } : {}) }, body };
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; }, end(v) { this.body = JSON.parse(v); } };
  await handler(req, res); return res;
}
const action = (body, options = {}) => telegramSetupAction(body, { env, store, workerOrigin, fetcher, now: () => at, ...options });
const preview = async () => {
  await store.del('telegram:setup:checks'); await store.del('telegram:setup:connects');
  return (await action({ action: 'telegramCheck' })).setup;
};
const connect = setup => ({ action: 'telegramConnect', draftId: setup.draftId });
async function rejects(fn, status, note) { await assert.rejects(fn, error => error.status === status, note); checks++; }
try {
  for (const name of ['telegramCheck', 'telegramConnect']) {
    check((await request({ action: name }, { authenticated: false })).statusCode, 401, 'Setup requires an owner session');
    check((await request({ action: name }, { origin: 'https://attacker.fixture.test' })).statusCode, 403, 'Cross-origin setup is rejected');
  }
  check(calls.length, 0, 'Rejected setup requests do no provider work');
  let r = await request({ action: 'login', accessKey: env.AGENT_ACCESS_KEY }); cookie = r.headers['set-cookie'].split(';')[0];
  for (const body of [{ action: 'telegramCheck', url: 'https://attacker.fixture.test' },
    { action: 'telegramConnect', draftId: 'a'.repeat(48), secret: 'injected' },
    { action: 'telegramConnect', draftId: 'a'.repeat(48), replaceExisting: 'true' }]) {
    check((await request(body)).statusCode, 400, 'Caller-supplied destinations, credentials and invalid confirmations are rejected');
  }
  check(calls.length, 0, 'Invalid setup bodies stop before Telegram');
  check((await request({ action: 'telegramConnect', draftId: 'a'.repeat(48) })).statusCode, 409, 'Registration requires a live preview');
  check(AGENT_TOOL_NAMES.includes('telegramConnect'), false, 'Webhook registration is outside the closed financial tool registry');

  r = await request({ action: 'telegramCheck' });
  check(r.statusCode, 200, 'The authenticated owner can check Telegram from the dashboard');
  let setup = r.body.setup;
  check(calls.map(call => call.method), ['getMe', 'getWebhookInfo'], 'Check is read-only: identity and webhook metadata only');
  check(setup.botUsername, 'fixture_bot', 'Bot identity comes from Telegram, not the optional old username');
  check(setup.targetWebhookUrl, target, 'The actual Worker origin is used instead of the dashboard or caller headers');
  check(setup.webhookStatus, 'missing', 'A missing webhook is distinguished from a pairing failure');
  check(setup.deliveryVerified, false, 'Configuration checks never imply message delivery');
  check(setup.registered, false, 'Checking cannot claim registration');
  check(r.headers['cache-control'].includes('no-store'), true, 'Private setup metadata is never cacheable');
  const invitation = await request({ action: 'pair' });
  check(invitation.body.url.startsWith('https://t.me/fixture_bot?start='), true, 'Fresh codes open the provider-verified bot');
  const active = await store.get('pair:active');
  const conversation = [{ role: 'user', content: 'Private fixture conversation' }];
  const binding = { chatId: '123', userId: '123', connectedAt: new Date().toISOString() };
  await store.set('messages', conversation); await store.set('telegram', binding);
  r = await request(connect(setup));
  check(r.statusCode, 200, 'An explicit Connect registers the previewed webhook');
  check(calls.filter(call => call.method === 'setWebhook').map(call => call.body), [{ url: target,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }], 'Registration preserves queued messages and uses the saved server secret');
  check(r.body.setup.registered, true, 'Registration is verified by a subsequent provider metadata read');
  check(r.body.setup.deliveryVerified, false, 'A real bot reply remains necessary after registration');
  check(await store.get('pair:active'), null, 'Connecting revokes the old active invitation');
  check(await store.get('pair:' + active), null, 'The old invitation itself is revoked before pending messages arrive');
  check(await store.get('messages'), conversation, 'Webhook changes preserve shared history');
  check(await store.get('telegram'), binding, 'Webhook changes preserve an already linked human');
  const count = calls.length;
  check((await request(connect(setup))).body.setup.registered, true, 'Retrying a confirmed setup returns its stored result');
  check(calls.length, count, 'A duplicate Connect does not repeat provider writes');

  const privateURL = 'https://unrelated.fixture.test/PRIVATE_PATH?token=PRIVATE_URL_TOKEN';
  webhook = privateURL; deliveryError = 'Wrong response 401 ' + privateURL + ' ' + env.TELEGRAM_BOT_TOKEN;
  updates = ['edited_message']; setup = await preview();
  check(setup.webhookStatus, 'different', 'Existing webhook destinations require a replacement decision');
  check(setup.requiresReplacement, true, 'The preview explicitly indicates replacement');
  check(setup.deliveryError, 'unauthorized', 'Provider error text becomes a fixed safe category');
  check(setup.updatesStatus, 'missing_messages', 'A webhook with incompatible message filters is diagnosed');
  const snapshot = JSON.stringify([setup, await store.get('telegram:setup:draft'), await store.get('telegram:setup:last')]);
  for (const secret of [privateURL, 'PRIVATE_PATH', 'PRIVATE_URL_TOKEN', env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET]) {
    check(snapshot.includes(secret), false, 'Setup records contain no raw provider destinations, errors or credentials');
  }
  const writes = calls.filter(call => call.method === 'setWebhook').length;
  await rejects(() => action(connect(setup)), 409, 'A foreign webhook cannot be overwritten without explicit replacement confirmation');
  check(calls.filter(call => call.method === 'setWebhook').length, writes, 'Missing replacement consent performs no write');
  check((await action({ ...connect(setup), replaceExisting: true })).setup.registered, true, 'Confirmed replacement connects the previewed bot');

  deliveryError = ''; setup = await preview(); webhook = 'https://another.fixture.test/hook';
  await rejects(() => action(connect(setup)), 409, 'Webhook drift invalidates a reviewed preview');
  webhook = target; setup = await preview();
  const secret = env.TELEGRAM_WEBHOOK_SECRET; env.TELEGRAM_WEBHOOK_SECRET += '_changed';
  await rejects(() => action(connect(setup)), 409, 'Credential changes require a new preview'); env.TELEGRAM_WEBHOOK_SECRET = secret;
  await rejects(() => action(connect(setup), { workerOrigin: 'https://changed.fixture.test' }), 409, 'Worker destination changes require a new preview');
  at += 600001;
  await rejects(() => action(connect(setup)), 409, 'Expired previews cannot configure Telegram'); at = Date.now();
  const first = await preview(); await preview();
  await rejects(() => action(connect(first)), 409, 'A new preview invalidates an older confirmation');

  setup = await preview(); mode = 'uncertain_write';
  await rejects(() => action(connect(setup)), 503, 'An unknown registration outcome stops with a safe error'); mode = null;
  const beforeRetry = calls.length;
  await rejects(() => action(connect(setup)), 409, 'An uncertain write requires a fresh check');
  check(calls.length, beforeRetry, 'An uncertain setup is not blindly retried');
  webhook = ''; setup = await preview(); mode = 'wrong_destination';
  await rejects(() => action(connect(setup)), 503, 'Provider acknowledgement without the expected webhook fails verification'); mode = null;

  for (const failure of ['throw', 'unauthorized', 'redirect', 'rate_limit', 'server_error', 'api_unauthorized', 'api_rejected', 'oversized', 'oversized_stream', 'malformed', 'not_bot']) {
    await store.del('telegram:setup:checks'); mode = failure;
    r = await request({ action: 'telegramCheck' });
    check(r.statusCode >= 400, true, 'Provider failure is safely bounded: ' + failure);
    check(JSON.stringify(r.body).includes(env.TELEGRAM_BOT_TOKEN), false, 'Provider failure never returns a token: ' + failure);
    check(JSON.stringify(r.body).includes('PRIVATE'), false, 'Provider failure never returns raw error text: ' + failure);
    if (failure !== 'not_bot') check(r.body.error.includes('getMe'), true, 'Provider failures identify the safe method name: ' + failure);
    const expected = { throw: 'could not be reached', unauthorized: 'HTTP 401', redirect: 'redirect (HTTP 302)',
      rate_limit: 'HTTP 429', server_error: 'HTTP 502', api_unauthorized: 'API 401', api_rejected: 'did not accept',
      oversized: 'unreadable response', oversized_stream: 'unreadable response', malformed: 'unreadable response' }[failure];
    if (expected) check(r.body.error.includes(expected), true, 'Failure classification is actionable without provider prose: ' + failure);
  }
  mode = null;
  await store.del('telegram:setup:checks');
  await rejects(() => action({ action: 'telegramCheck' }, { fetcher: () => new Promise(() => {}), timeoutMs: 15 }), 503, 'A stalled provider is bounded even if it ignores abort');
  for (const options of [{ env: { ...env, TELEGRAM_BOT_TOKEN: 'bad/token' } },
    { env: { ...env, TELEGRAM_WEBHOOK_SECRET: 'short' } }, { workerOrigin: 'https://user:password@bad.fixture.test' },
    { workerOrigin: 'http://plain.fixture.test' }, { workerOrigin: 'https://bad.fixture.test/other?secret=x' }]) {
    await assert.rejects(() => action({ action: 'telegramCheck' }, options)); checks++;
  }
  check(telegramConfigured({ ...env, TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(257) }), false, 'Webhook secrets respect the provider header length limit');

  await store.del('telegram:setup:checks');
  let release; hold = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const pending = action({ action: 'telegramCheck' }); await started;
  r = await request({ action: 'settings', settings: { healthThreshold: 1.6 } });
  check(r.statusCode, 200, 'A slow Telegram check does not block saving agent preferences');
  await rejects(() => action({ action: 'telegramCheck' }), 409, 'Concurrent setup checks use an independent lease');
  hold = null; release(); await pending;
  await store.del('telegram:setup:checks');
  for (let i = 0; i < 3; i++) await action({ action: 'telegramCheck' });
  const beforeLimited = calls.length;
  await rejects(() => action({ action: 'telegramCheck' }), 429, 'Repeated setup checks are rate limited');
  check(calls.length, beforeLimited, 'Rate-limited checks do no external work');
  check(await store.get('messages'), conversation, 'Failure paths also preserve conversation history');
  console.log('Private Telegram setup: ' + checks + ' assertions passed. No real provider was contacted.');
} finally { fixture.close(); globalThis.fetch = savedFetch; }
