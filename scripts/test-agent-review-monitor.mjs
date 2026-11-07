/* Risk and review dispatch share a Cron invocation but never an inference or
   long lock. Stress the Free D1 ceiling and retain unsent critical notices. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { reviewPolicy, reviewContext } from './fixtures/agent-review.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { dispatchPortfolioReview } from '../api/_agent-review-dispatch.mjs';

let queries = 0, assertions = 0, now = Date.now() + 86400000;
const check = (a,b,n) => { assert.deepEqual(a,b,n); assertions++; };
const fixture = createAgentSQLiteFixture();
const db = { prepare(sql) { return { bind(...params) { const s = fixture.db.prepare(sql).bind(...params);
  return { ...s, ...Object.fromEntries(['first','all','run'].map(name => [name, () => { queries++; return s[name](); }])) };
} }; }, batch: statements => { queries++; return fixture.db.batch(statements); } };
const store = createAgentStore({ AGENT_DB: db }, { now: () => now }), sent = [], workflows = [];
const env = { AGENT_DB: db, AGENT_ORIGIN: 'https://review.fixture.test', CRON_SECRET: 'fixture-monitor-secret-at-least-24',
  TELEGRAM_BOT_TOKEN: 'fixture-bot', PORTFOLIO_REVIEWS: { create: async value => { workflows.push(value); return { id: value.id }; },
    get: async () => ({ status: async () => ({ status: 'running' }) }) }, AI: { run: () => { throw Error('Risk invocation cannot call AI'); } } };
const source = await reviewContext(now);
let failDelivery = false;
// Hypothetical independent alarm readings. This is never a financial writer.
for (const row of source.lending.markets) Object.assign(row, { health: 0.9, ltv: .9, debt_amount: 1, no_position: false });
const response = () => ({ setHeader(){}, status(code){this.code=code;return this;},end(text){this.value=JSON.parse(text);} });
const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('No real provider in Cron tests'); };
try {
  await store.set('policy:current', reviewPolicy()); await store.set('settings', { dailyEnabled: true, dailyTime: '00:00' });
  await store.set('telegram', { chatId: '123', userId: '123' });
  await store.set('monitor:pending', { kind: 'strategy_reviews', items: [{ reportId: 'report:fixture-preempted-review',
    chatId: '123', userId: '123', policyVersion: 1, controlsRevision: 0 }], itemIndex: 0, sentParts: 1 });
  const handler = createMonitorHandler({ env, storeFactory: () => store, loadContext: async () => {
    const current = structuredClone(source), stamp = new Date(now).toISOString();
    current.asOf = stamp; current.sources.forEach(row => { row.ts = stamp; });
    current.lending.ts = stamp; current.lending.markets.forEach(row => { row.ts = stamp; });
    return current;
  }, now: () => now,
    fetcher: async (_url, options) => { if (failDelivery) throw Error('Fixture Telegram outage'); sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: { message_id: sent.length } }); } });
  queries = 0; let res = response(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, res);
  check(res.code, 200, 'Multiple alarms still complete the deterministic risk pass');
  await dispatchPortfolioReview({ env, store, now: () => now });
  check(queries <= 50, true, 'Risk plus review dispatch respects the Free D1 ceiling (' + queries + ')');
  const firstQueries = queries;
  check(workflows.length, 1, 'A bounded Workflow is queued after risk checks finish');
  check((await store.get('review:pending'))[0].sentParts, 1, 'The real risk pass yields a strategy notice without losing its chunk cursor');
  check(sent.length, 2, 'Only two notices are attempted per risk invocation');
  const pending = await store.get('monitor:pending');
  check(pending.items.length - pending.itemIndex >= 1, true, 'Unsent alarms stay in the original durable outbox');
  const ids = (await store.get('alerts')).map(item => item.id);
  now += 300000; queries = 0; res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, res);
  check(res.code, 200, 'The next risk tick resumes the retained outbox');
  await dispatchPortfolioReview({ env, store, now: () => now });
  check(queries <= 50, true, 'A risk-delivery resume plus dispatch stays bounded (' + queries + ')');
  check((await store.get('alerts')).map(item => item.id), ids, 'A resume never invents duplicate dashboard alerts');
  check(await store.get('monitor:pending'), null, 'All acknowledged risk notices eventually clear the outbox');
  check(sent.length, ids.length, 'Every generated risk/daily notice is delivered once in this fixture');
  check((await store.get('monitor:lastSuccess')).ts, new Date(now).toISOString(), 'Monitor success belongs to real risk work, not AI completion');

  // A failed older notice must not hide newly critical conditions from the
  // dashboard or lose the newer alert behind its delivery retry.
  await store.set('monitor:state', { policyVersion: 1, conditions: {}, dailyDate: null });
  await store.set('alerts', []);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(now);
  await store.set('monitor:pending', { chatId: '123', items: [{ type: 'daily', day, key: 'daily:' + day, text: 'Older queued daily fixture' }], itemIndex: 0, sentParts: 0 });
  failDelivery = true; now += 300000; queries = 0; res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, res);
  check(res.code, 503, 'Provider delivery failure remains visible to the scheduler');
  check((await store.get('alerts')).some(alert => alert.severity === 'critical'), true, 'New critical dashboard alarms are recorded even while older Telegram delivery fails');
  check((await store.get('monitor:pending')).items[0].severity, 'critical', 'New critical notices go before an older failed daily notice');
  check(queries <= 50, true, 'An outage/recovery pass also remains within the Free D1 ceiling');
  console.log('Independent bounded review/risk Cron: ' + assertions + ' assertions passed (max ' + Math.max(firstQueries,queries) + ' D1 calls/invocation).');
} finally { globalThis.fetch = oldFetch; fixture.close(); }
