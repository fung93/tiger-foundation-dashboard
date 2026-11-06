/* Private Telegram and scheduled-agent behavior, using the real handlers and
   deterministic local transport/storage. No Telegram, model or RPC calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTelegramHandler } from '../api/agent-telegram.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { telegramParts, telegramRequest, monitorConditions, mytDayAndTime } from '../api/_agent-notifications.mjs';
import { DEFAULT_SETTINGS, processAgentMessage } from '../api/_agent-service.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const clone = value => value == null ? value : structuredClone(value);
const NOW = Date.parse('2026-11-05T01:00:00Z');
const env = { AGENT_ORIGIN: 'https://dashboard.invalid', TELEGRAM_BOT_TOKEN: 'fixture-token',
  TELEGRAM_WEBHOOK_SECRET: 'fixture-secret-at-least-twenty-four', CRON_SECRET: 'fixture-cron-at-least-twenty-four', AI: { run: async () => { throw Error('An injected responder must handle this fixture'); } } };
const binding = { chatId: '42', userId: '42', username: 'owner' };
function memory(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)])), locks = new Set();
  return {
    values, locks,
    get: async key => clone(values.get(key) ?? null),
    set: async (key, value, options = {}) => { if (options.nx && values.has(key)) return false; values.set(key, clone(value)); return true; },
    del: async key => values.delete(key),
    take: async key => { const value = clone(values.get(key) ?? null); values.delete(key); return value; },
    increment: async key => { const value = (values.get(key) || 0) + 1; values.set(key, value); return value; },
    setMany: async entries => { for (const entry of entries) { if (entry.remove) values.delete(entry.key); else values.set(entry.key, clone(entry.value)); } },
    lock: async key => { if (locks.has(key)) return null; locks.add(key); return {
      release: async () => locks.delete(key),
      assertOwned: async () => { if (!locks.has(key)) throw Object.assign(Error('Lease expired'), { status: 409 }); },
      commit: async entries => { if (!locks.has(key)) throw Object.assign(Error('Lease expired'), { status: 409 });
        for (const entry of entries) { if (entry.remove) values.delete(entry.key); else values.set(entry.key, clone(entry.value)); } },
    }; },
  };
}
function response() {
  return { headers: {}, code: null, body: null, setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; }, end(body) { this.body = JSON.parse(body); } };
}
async function call(handler, body = {}, { method = 'POST', secret = true, headers = {} } = {}) {
  const req = { method, headers: { 'content-type': 'application/json',
    ...(secret ? { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET,
      authorization: 'Bearer ' + env.CRON_SECRET } : {}), ...headers }, body };
  const res = response(); await handler(req, res); return res;
}
function update(id, text, user = 42, extra = {}) {
  return { update_id: id, message: { text, from: { id: user, username: user === 42 ? 'owner' : 'outsider' },
    chat: { id: user, type: 'private' }, ...extra } };
}
function fixtureContext(extra = {}) {
  const ts = new Date(NOW - 1000).toISOString();
  return { asOf: new Date(NOW).toISOString(), sources: [{ name: 'lending', status: 'fresh', ts }, { name: 'lp', status: 'fresh', ts }],
    lending: { status: 'fresh', ts, markets: [{ id: 'loan', key: 'avkat-kat', label: 'avKAT / KAT',
      health: 1.3, ltv: .6, debt_amount: 10, no_position: false }] }, ...extra };
}
function transport() {
  const calls = [];
  let fail = false;
  return { calls, failNext() { fail = true; }, fetcher: async (url, init) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/botfixture-token\/(sendMessage|answerCallbackQuery)$/);
    const method = url.slice(url.lastIndexOf('/') + 1), body = JSON.parse(init.body);
    calls.push({ method, body });
    if (fail && method === 'sendMessage') { fail = false; return { ok: false, status: 503 }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  } };
}
const realFetch = globalThis.fetch, realNow = Date.now;
Date.now = () => NOW;
globalThis.fetch = () => { throw Error('Agent tests must not contact external services'); };
try {
  check(telegramParts('😀'.repeat(7001)).map(x => Array.from(x).length), [3500,3500,1], 'Telegram chunks retain complete Unicode characters');
  check(telegramParts('<b>hello</b>')[0], '<b>hello</b>', 'HTML-like content remains ordinary plain text');
  check(telegramParts('x'.repeat(20000)).join('').length, 16000, 'Oversized generated notifications have a bounded delivery size');
  check(mytDayAndTime(Date.parse('2026-11-05T16:03:00Z')), { day: '2026-11-06', time: '00:03' }, 'Daily scheduling follows the MYT day boundary');
  await assert.rejects(telegramRequest('sendMessage', { chat_id: '42', text: 'test' }, { env, timeoutMs: 5,
    fetcher: async () => ({ ok: true, json: () => new Promise(() => {}) }) }), /in time/); checks++;

  let store = memory(), network = transport(), questions = [];
  const handler = createTelegramHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    processMessage: async request => { questions.push(request); return { reply: 'A verified answer.' }; } });
  check((await call(handler, update(1, 'hello'), { secret: false })).code, 401, 'Unverified webhook requests fail before processing');
  check(network.calls.length, 0, 'An unverified request sends no Telegram message');
  check((await call(handler, update(2, 'hello'))).body.ignored, true, 'An unpaired private user cannot access the agent');
  check(questions.length, 0, 'An unpaired user cannot spend model usage');
  const digest = createHash('sha256').update('ABCDEF1234567890ABCDEF12').digest('hex');
  await store.set('pair:' + digest, { issuedAt: new Date(NOW).toISOString() });
  await store.set('pair:active', digest);
  let result = await call(handler, update(3, '/start abcdef1234567890abcdef12'));
  check(result.code, 200, 'A valid one-time dashboard code pairs a private account');
  check((await store.get('telegram')).userId, '42', 'Pairing binds the Telegram sender identity');
  check((await store.get('telegram')).chatId, '42', 'Pairing binds the private chat identity');
  check(await store.get('pair:' + digest), null, 'The invitation is atomically consumed');
  check(await store.get('pair:active'), null, 'The active invitation marker is revoked after pairing');
  check(network.calls.length, 1, 'Successful pairing sends one welcome message');
  check(network.calls[0].body.parse_mode, undefined, 'Telegram does not interpret generated HTML/Markdown');
  check(network.calls[0].body.reply_markup.inline_keyboard[1][1].url, env.AGENT_ORIGIN + '/agent.html', 'The dashboard shortcut uses the configured canonical origin');
  result = await call(handler, update(3, '/start ABCDEF1234567890ABCDEF12'));
  check(result.body.duplicate, true, 'Telegram retries of a completed update are deduplicated');
  check(network.calls.length, 1, 'A duplicate pairing update sends no repeated welcome');
  await call(handler, update(4, 'Show my lending', 99));
  check(questions.length, 0, 'Another private account remains blocked after pairing');
  await call(handler, update(5, 'Show my lending', 42, { chat: { id: -5, type: 'group' } }));
  check(questions.length, 0, 'A group cannot use the owner agent even when the owner sends the message');
  await call(handler, update(6, 'Show my lending'));
  check(questions[0].message, 'Show my lending', 'Free-word questions reach the shared agent service');
  check(questions[0].source, 'telegram', 'Conversation records identify their Telegram source');
  check(questions[0].requestId, 'telegram:6', 'Shared conversation processing has a durable idempotency reference');
  const asked = questions.length;
  await call(handler, update(7, 'x'.repeat(4001)));
  check(questions.length, asked, 'Oversized owner questions cannot start a model call');
  const callback = { update_id: 8, callback_query: { id: 'callback', data: 'lending', from: { id: 42 },
    message: { chat: { id: 42, type: 'private' } } } };
  await call(handler, callback);
  check(questions.at(-1).message, 'Check my lending health and risks.', 'The lending shortcut becomes an ordinary shared-agent question');
  check(network.calls.some(x => x.method === 'answerCallbackQuery'), true, 'Approved shortcut callbacks are acknowledged');
  const beforeUnknown = network.calls.length;
  await call(handler, { ...callback, update_id: 9, callback_query: { ...callback.callback_query, data: 'untrusted' } });
  check(network.calls.length, beforeUnknown, 'Unknown callback data cannot trigger a model call or send');
  check((await call(handler, {}, { method: 'GET' })).code, 405, 'The webhook only accepts POST');
  check((await call(handler, update(10, 'x'), { headers: { 'content-length': '20000' } })).code, 413, 'Oversized webhook bodies fail clearly');
  check((await call(handler, update(11, 'x'), { headers: { 'content-type': 'text/plain' } })).code, 415, 'The webhook requires JSON');
  const weakWebhook = createTelegramHandler({ env: { ...env, TELEGRAM_WEBHOOK_SECRET: 'too-short' }, storeFactory: () => store });
  check((await call(weakWebhook, update(90, 'hello'))).code, 503, 'A weak webhook secret cannot activate the endpoint');

  // A failed delivery reuses the prepared answer rather than spending another model call.
  network.failNext();
  const priorQuestions = questions.length;
  check((await call(handler, update(12, 'Explain my LP'))).code, 503, 'Failed Telegram delivery remains retryable');
  check(!!await store.get('telegram:update:12:pending'), true, 'A prepared reply survives a transport failure');
  check((await call(handler, update(12, 'Explain my LP'))).code, 200, 'A later Telegram retry can finish delivery');
  check(questions.length, priorQuestions + 1, 'A delivery retry does not repeat the model call');
  await store.set('telegram:update:13:pending', { chatId: '42', userId: '42', reply: 'old queued reply', sentParts: 0 });
  await store.del('telegram');
  const beforeUnlinked = network.calls.length;
  await call(handler, update(13, 'old question'));
  check(network.calls.length, beforeUnlinked, 'Unlinking blocks a delayed prepared message');

  store = memory({ ['pair:' + digest]: { issuedAt: new Date(NOW).toISOString() }, 'pair:active': 'a newer digest' });
  await call(handler, update(14, '/start ABCDEF1234567890ABCDEF12'));
  check(await store.get('telegram'), null, 'A superseded code cannot pair an account');
  check(!!await store.get('pair:' + digest), true, 'A superseded invitation is not consumed by an attempt');

  // The actual shared service persists the answer/request atomically before delivery.
  store = memory({ telegram: binding }); network = transport(); let modelCalls = 0;
  const realServiceHandler = createTelegramHandler({ env, storeFactory: () => store, fetcher: network.fetcher,
    processMessage: options => processAgentMessage({ ...options, context: fixtureContext(), respond: async () => {
      modelCalls++; return { reply: 'Your health was checked.', action: { type: 'settings', settings: { healthThreshold: 1.4 } } };
    } }) });
  network.failNext(); await call(realServiceHandler, update(15, 'Warn below health 1.4'));
  await store.del('telegram:update:15:pending'); // Simulate interruption before pending-write persistence.
  await call(realServiceHandler, update(15, 'Warn below health 1.4'));
  check(modelCalls, 1, 'An interrupted webhook recovers the durable shared service result');
  check((await store.get('messages')).length, 2, 'A retried shared request records its conversation once');
  check((await store.get('settings')).healthThreshold, 1.4, 'Telegram preferences are the same stored settings used by the dashboard');
  const limited = createTelegramHandler({ env, storeFactory: () => store, fetcher: network.fetcher,
    processMessage: async () => { throw Object.assign(Error('limit'), { status: 429 }); } });
  check((await call(limited, update(16, 'Another question'))).code, 200, 'A reached message budget returns a useful owner reply rather than a retry loop');
  check(network.calls.at(-1).body.text.includes('message limit'), true, 'The Telegram owner can see why a budget-limited question was not answered');
  check(!!await store.get('telegram:update:16:done'), true, 'A budget-limited question is not unexpectedly answered on a later day');

  const settings = { ...DEFAULT_SETTINGS };
  let context = fixtureContext();
  check(monitorConditions(context, settings)['lending:loan'].active, false, 'A healthy market produces no warning');
  context.lending.markets[0].health = 1.2; context.lending.markets[0].ltv = .7;
  check(monitorConditions(context, settings)['lending:loan'].active, false, 'Exact chosen health and LTV limits are allowed');
  context.lending.markets[0].health = 1;
  check(monitorConditions(context, settings)['lending:loan'].severity, 'warning', 'Health exactly one is not below the liquidation boundary');
  context.lending.markets[0].health = .99;
  check(monitorConditions(context, settings)['lending:loan'].severity, 'critical', 'A verified health below one is critical');
  context.lending.status = 'stale';
  check(monitorConditions(context, settings)['lending:loan'], undefined, 'A stale health reading cannot produce or clear a lending condition');
  context.lending.markets[0].status = 'fresh'; context.lending.markets[0].ts = context.lending.ts;
  context.lending.markets.push({ id: 'failed-market', status: 'unavailable', error: 'Oracle read failed' });
  const partial = monitorConditions(context, settings);
  check(partial['lending:loan'].severity, 'critical', 'One unreadable market cannot suppress another market\'s verified critical health');
  check(partial['lending:loan'].sourceTs, context.lending.markets[0].ts, 'A partial reading preserves the healthy market\'s own source time');
  check(partial['lending:failed-market'], undefined, 'The unreadable market cannot produce a fabricated risk or recovery');

  store = memory({ telegram: binding }); network = transport(); let timestamp = NOW, loads = 0;
  context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const monitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => timestamp,
    loadContext: async () => { loads++; return clone(context); }, summarize: () => 'A recorded daily summary.' });
  check((await call(monitor, {}, { secret: false })).code, 401, 'Monitoring requires the separate cron credential');
  check(loads, 0, 'An unauthenticated monitoring request cannot read the portfolio');
  result = await call(monitor);
  check(result.body.alerts, 1, 'The first verified health breach produces one alert');
  check((await store.get('alerts')).length, 1, 'The dashboard receives the same warning');
  check((await store.get('alerts'))[0].telegramSent, true, 'Accepted Telegram delivery is marked in the shared alert');
  check((await store.get('alerts'))[0].sourceTs, context.lending.ts, 'The warning retains its original source timestamp');
  check((await store.get('lastCheck')).sources[0].ts, context.lending.ts, 'Monitoring does not retimestamp source data');
  const firstSends = network.calls.length;
  timestamp += 5 * 60000;
  check((await call(monitor)).body.alerts, 0, 'An unchanged warning is not sent every five minutes');
  check(network.calls.length, firstSends, 'Duplicate scheduled checks spend no Telegram sends');
  context.lending.markets[0].health = .99;
  check((await call(monitor)).body.alerts, 1, 'A deterioration below liquidation escalates immediately');
  context.lending.status = 'unavailable'; context.sources[0].status = 'unavailable';
  await call(monitor);
  check((await store.get('monitor:state')).conditions['lending:loan'].active, true, 'A read failure retains the outstanding health warning');
  check((await store.get('alerts')).at(-1).type, 'data', 'The agent separately reports the failed reading');
  context = fixtureContext();
  check((await call(monitor)).body.alerts, 2, 'Complete recovery can clear both data and health warnings');
  check((await store.get('alerts')).slice(-2).every(x => x.status === 'recovered'), true, 'Recovery is recorded as recovery rather than zero balances');
  await store.set('settings', { ...DEFAULT_SETTINGS, pausedUntil: new Date(timestamp + 3600000).toISOString() });
  const beforePause = loads, sendsBeforePause = network.calls.length;
  check((await call(monitor)).body.skipped, 'paused', 'An owner pause suppresses the whole notification pass');
  check(loads, beforePause, 'A paused pass does not spend remote data reads');
  check(network.calls.length, sendsBeforePause, 'A paused pass sends no notifications');
  await store.set('settings', { ...DEFAULT_SETTINGS });
  store.locks.add('monitor');
  check((await call(monitor)).body.skipped, 'busy', 'A concurrent monitor cannot duplicate the same risk pass');
  store.locks.delete('monitor');

  store = memory(); network = transport(); context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const offlineMonitor = createMonitorHandler({ env: { ...env, TELEGRAM_BOT_TOKEN: '' }, storeFactory: () => store,
    fetcher: network.fetcher, now: () => NOW, loadContext: async () => context });
  check((await call(offlineMonitor)).body.telegram, false, 'Dashboard monitoring does not require a Telegram connection');
  check((await store.get('alerts')).length, 1, 'Healthy infrastructure still persists dashboard alerts without Telegram');
  check(network.calls.length, 0, 'An unlinked dashboard alert never attempts a Telegram send');
  store = memory({ settings: { ...DEFAULT_SETTINGS, dailyEnabled: true } }); network = transport();
  const dashboardDaily = createMonitorHandler({ env: { ...env, TELEGRAM_BOT_TOKEN: '' }, storeFactory: () => store,
    fetcher: network.fetcher, now: () => NOW, loadContext: async () => fixtureContext(), summarize: () => 'Dashboard daily report.' });
  check((await call(dashboardDaily)).body.daily, true, 'Daily summaries work in the dashboard before Telegram is linked');
  check((await store.get('messages'))[0].content, 'Dashboard daily report.', 'A dashboard daily report enters shared conversation history');
  check((await store.get('alerts'))[0].type, 'daily', 'A dashboard daily report is available alongside alerts');
  check(network.calls.length, 0, 'Dashboard daily reporting does not attempt an unconfigured outbound channel');

  store = memory({ telegram: binding }); network = transport(); context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const retryMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher,
    now: () => NOW, loadContext: async () => context });
  network.failNext();
  check((await call(retryMonitor)).code, 503, 'A monitoring delivery failure is observable to the scheduler');
  check(!!await store.get('monitor:pending'), true, 'Prepared monitor delivery remains durable for retry');
  check((await call(retryMonitor)).code, 200, 'A scheduled retry can deliver the prepared warning');
  check((await store.get('alerts')).length, 1, 'A transport retry does not duplicate dashboard alert history');
  check((await store.get('alerts'))[0].telegramSent, true, 'Retry recovery marks the original alert delivered');
  check(await store.get('monitor:pending'), null, 'Acknowledged monitor delivery clears its outbox');

  store = memory({ telegram: binding, settings: { ...DEFAULT_SETTINGS, dailyEnabled: true } }); network = transport();
  context = fixtureContext(); timestamp = NOW;
  const dailyMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => timestamp,
    loadContext: async () => context, summarize: () => 'Summary with the original reading times.' });
  check((await call(dailyMonitor)).body.daily, true, 'A linked daily summary is due at the chosen MYT time');
  check((await store.get('messages'))[0].source, 'monitor', 'The same daily report enters shared dashboard and Telegram conversation context');
  check((await call(dailyMonitor)).body.daily, false, 'The daily report is generated only once per MYT day');
  timestamp += 86400000;
  check((await call(dailyMonitor)).body.daily, true, 'The next MYT day receives its own report');
  check((await store.get('messages')).length, 2, 'Daily report history contains one entry per reported day');

  store = memory({ telegram: binding, settings: { ...DEFAULT_SETTINGS, dailyEnabled: true } }); network = transport();
  const cancelledDaily = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => fixtureContext(), summarize: () => 'Daily summary awaiting delivery.' });
  network.failNext(); await call(cancelledDaily);
  check(!!await store.get('monitor:pending'), true, 'An unsuccessful daily summary has a pending delivery');
  await store.set('settings', { ...DEFAULT_SETTINGS, dailyEnabled: false });
  const beforeDailyCancel = network.calls.length;
  check((await call(cancelledDaily)).code, 200, 'Turning daily reports off cancels their pending delivery');
  check(network.calls.length, beforeDailyCancel, 'A disabled daily report is not sent on a later retry');
  check((await store.get('alerts'))[0].deliveryCancelled, true, 'The retained dashboard record explains cancellation');

  store = memory({ telegram: binding, settings: { ...DEFAULT_SETTINGS, dailyEnabled: true } }); network = transport();
  context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const mixedMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => context, summarize: () => 'This daily summary should be cancelled.' });
  network.failNext(); await call(mixedMonitor);
  check((await store.get('monitor:pending')).items.length, 2, 'A failed mixed pass retains independently typed delivery items');
  await store.set('settings', { ...DEFAULT_SETTINGS, dailyEnabled: false });
  await call(mixedMonitor);
  check(network.calls.slice(1).filter(x => x.method === 'sendMessage').length, 1, 'A mixed retry sends the still-enabled risk item only');
  check(network.calls.at(-1).body.text.includes('daily summary'), false, 'A disabled daily item cannot leak through a risk batch');
  check((await store.get('alerts')).find(x => x.type === 'daily').deliveryCancelled, true, 'Mixed cancellation preserves accurate daily-delivery state');

  store = memory({ telegram: binding, settings: { ...DEFAULT_SETTINGS, dailyEnabled: true } }); network = transport();
  context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const disableRisk = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => context, summarize: () => 'The daily report remains enabled.' });
  network.failNext(); await call(disableRisk);
  await store.set('settings', { ...DEFAULT_SETTINGS, alertsEnabled: false, dailyEnabled: true });
  await call(disableRisk);
  check(network.calls.slice(1).filter(x => x.method === 'sendMessage').length, 1, 'Disabling risk alerts cancels their pending item while retaining the daily report');
  check(network.calls.at(-1).body.text.includes('daily report remains'), true, 'The still-enabled daily item is delivered independently');
  check((await store.get('alerts')).find(x => x.type === 'lending').deliveryCancelled, true, 'Disabled pending risk alerts are marked cancelled');

  store = memory({ telegram: binding }); network = transport(); context = fixtureContext(); timestamp = NOW;
  context.lending.markets[0].health = 1.1;
  const resumeMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => timestamp,
    loadContext: async () => context });
  network.failNext(); await call(resumeMonitor);
  await store.set('settings', { ...DEFAULT_SETTINGS, pausedUntil: new Date(NOW + 3600000).toISOString() });
  await call(resumeMonitor);
  context = fixtureContext(); timestamp = NOW + 2 * 3600000;
  await call(resumeMonitor);
  check((await store.get('alerts'))[0].deliveryCancelled, true, 'A queued health warning is cancelled after recovery during a pause');
  check(network.calls.slice(1).every(x => !x.body.text.includes('health 1.1000')), true, 'Resuming alerts cannot replay the outdated low-health value');
  check(network.calls.at(-1).body.text.includes('within your alert limits'), true, 'The owner receives the current recovery instead');

  store = memory({ telegram: binding }); network = transport(); context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const unknownMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => context });
  network.failNext(); await call(unknownMonitor);
  context.lending.status = 'unavailable'; context.sources[0].status = 'unavailable';
  await call(unknownMonitor);
  check((await store.get('alerts'))[0].deliveryCancelled, true, 'An unverified current loan cannot justify sending an old queued value');
  check(network.calls.slice(1).every(x => !x.body.text.includes('health 1.1000')), true, 'Missing readings do not replay an old risk as current');
  check((await store.get('monitor:state')).conditions['lending:loan'].active, true, 'Suppressing outdated delivery does not silently clear the outstanding condition');
  context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const recoveredRead = await call(unknownMonitor);
  check(recoveredRead.body.alerts, 2, 'A complete fresh read can reissue the still-active risk and clear the data warning');

  store = memory({ telegram: binding }); network = transport(); context = fixtureContext(); context.lending.markets[0].health = 1.1;
  const expiredLeaseMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => { store.locks.delete('monitor'); return context; } });
  check((await call(expiredLeaseMonitor)).code, 503, 'An expired monitor lease cannot persist a completed check');
  check(await store.get('alerts'), null, 'An expired monitor cannot overwrite another owner’s alert state');
  check(network.calls.length, 0, 'An expired monitor does not send notifications');
  const weakCron = createMonitorHandler({ env: { ...env, CRON_SECRET: 'short' }, storeFactory: () => store });
  check((await call(weakCron)).code, 503, 'A weak cron secret cannot activate background monitoring');

  store = memory({ telegram: binding }); network = transport(); context = fixtureContext(); context.lending.markets[0].health = .99;
  const escalationMonitor = createMonitorHandler({ env, storeFactory: () => store, fetcher: network.fetcher, now: () => NOW,
    loadContext: async () => context });
  await call(escalationMonitor);
  context.lending.markets[0].health = 1.1;
  check((await call(escalationMonitor)).body.alerts, 0, 'Improvement from critical to warning does not spam another risk message');
  check((await store.get('monitor:state')).conditions['lending:loan'].severity, 'warning', 'The stored current severity still follows a verified improvement');
  context.lending.markets[0].health = .98;
  check((await call(escalationMonitor)).body.alerts, 1, 'A second deterioration below one escalates immediately rather than waiting six hours');
  console.log('Agent Telegram and monitoring: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = realFetch; Date.now = realNow; }
