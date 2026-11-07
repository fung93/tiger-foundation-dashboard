/* Telegram transport failures, freshness and recipient fencing. Every source,
   bot response and financial value belongs to an isolated local fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { reviewAI, reviewPolicy, reviewLoaders, reviewFixtureFetcher } from './fixtures/agent-review.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { runPortfolioReview } from '../api/_agent-review-loop.mjs';
import { deliverReviewNotices, yieldReviewOutbox } from '../api/_agent-review-delivery.mjs';
import { getReviewControls, saveReviewControls } from '../api/_agent-review-state.mjs';

let assertions = 0, now = Date.now() + 86400000, queries = 0, maxQueries = 0;
const check = (a, b, note) => { assert.deepEqual(a, b, note); assertions++; };
const fixture = createAgentSQLiteFixture({ usage: true });
const db = { prepare(sql) { return { bind(...params) { const s = fixture.db.prepare(sql).bind(...params);
  return { ...s, ...Object.fromEntries(['first', 'all', 'run'].map(name => [name, async () => { queries++; return s[name](); }])) };
} }; }, batch: async statements => { queries++; return fixture.db.batch(statements); } };
const env = { AGENT_DB: db, AGENT_ORIGIN: 'https://review.fixture.test', AI: reviewAI(), TELEGRAM_BOT_TOKEN: 'fixture-bot-token' };
const store = createAgentStore(env, { now: () => now }), sent = [];
const binding = { chatId: '123456', userId: '123456' };
let attempts = 0, failAt = 0, replaceAfterFirst = false;
const fetcher = async (url, options) => {
  check(String(url).startsWith('https://api.telegram.org/'), true, 'Delivery uses only the fixed Telegram destination');
  attempts++;
  if (attempts === failAt) throw Error('PRIVATE fixture bot failure');
  const body = JSON.parse(options.body); sent.push(body);
  if (replaceAfterFirst && attempts === 1) await store.set('telegram', { chatId: '654321', userId: '654321' });
  return Response.json({ ok: true, result: { message_id: attempts } });
};
const deliver = async () => {
  queries = 0; const result = await deliverReviewNotices({ env, store, fetcher, now: () => now });
  check(queries <= 50, true, 'A delivery step fits the Free D1 query ceiling (' + queries + ')');
  maxQueries = Math.max(maxQueries, queries); return result;
};
const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('No real provider allowed in delivery tests'); };
try {
  await store.set('policy:current', reviewPolicy());
  const original = (await runPortfolioReview({ env, store, manual: true, requestId: 'delivery-baseline', notify: false,
    now: () => now, ...reviewLoaders(() => now), fetcher: reviewFixtureFetcher(now) })).report;
  const seed = async ({ long = false, expired = false } = {}) => {
    attempts = 0; sent.length = 0; failAt = 0; replaceAfterFirst = false;
    await store.del('monitor:pending'); await store.del('review:pending'); await store.del('settings');
    await store.set('telegram', binding);
    const report = structuredClone(original); report.reportId = 'report:' + report.createdAt + ':' + randomUUID();
    report.validUntil = new Date(now + (expired ? -1000 : 60000)).toISOString();
    if (long) for (const candidate of report.review.analysis.candidates)
      candidate.detail = Array.from({ length: 45 }, () => 'This is a hypothetical scenario with explicitly confirmed assumptions.').join('\n');
    await store.putImmutable(report.reportId, report);
    const controls = await getReviewControls(store);
    const item = { reportId: report.reportId, policyVersion: report.policyVersion, controlsRevision: controls.revision,
      trigger: 'manual', ...binding, createdAt: new Date(now).toISOString() };
    await store.set('review:pending', [item]);
    return { report, item };
  };
  let seeded = await seed();
  check((await deliver()).status, 'sent', 'A current private review is delivered');
  check(sent[0].chat_id, binding.chatId, 'Only the originally linked private recipient receives the review');
  check((await store.get('review:state')).lastDelivery.status, 'sent', 'Success is recorded only after Telegram acknowledges it');
  await deliver(); check(sent.length, 1, 'A completed outbox cannot resend the same report');

  seeded = await seed({ long: true }); failAt = 2;
  check((await deliver()).status, 'queued', 'A mid-message provider outage leaves a resumable outbox');
  check((await store.get('monitor:pending')).sentParts, 1, 'Acknowledged chunks have a durable cursor');
  const firstText = sent[0].text; failAt = 0;
  await deliver();
  check(sent.length > 1, true, 'The next bounded delivery resumes remaining chunks');
  check(sent.filter(row => row.text === firstText).length, 1, 'Acknowledged first chunks are never knowingly replayed');

  await seed({ long: true }); replaceAfterFirst = true;
  await deliver(); await deliver();
  check(sent.length, 1, 'Replacing the recipient between chunks stops further disclosure');
  check(sent.some(row => row.chat_id === '654321'), false, 'An old notice never follows a newly linked account');

  await seed(); await store.del('telegram');
  check((await deliver()).status, 'cancelled', 'Unlinking cancels a staged notice');
  check(sent.length, 0, 'Unlinked recipients receive no provider call');

  await seed(); await store.set('settings', { pausedUntil: new Date(now + 60000).toISOString() });
  check((await deliver()).status, 'cancelled', 'The global notification pause applies immediately before delivery');
  check(sent.length, 0, 'Pausing sends no financial text');

  await saveReviewControls(store, { enabled: false }, 0, { now });
  await seed(); check((await deliver()).status, 'sent', 'Pausing automatic reviews still permits explicitly requested manual delivery');
  const automatic = await seed(); await store.set('review:pending', [{ ...automatic.item, trigger: 'daily' }]);
  check((await deliver()).status, 'cancelled', 'Automatic delivery remains paused');
  await saveReviewControls(store, { enabled: true }, 1, { now });

  await seed({ expired: true }); await deliver();
  check(sent[0].text.includes('Open Agent'), true, 'An old review sends a dated saved-review link');
  check(sent[0].text.includes('Repay'), false, 'Expired repayment amounts are not pushed as actionable suggestions');

  await seed(); await store.set('policy:current', reviewPolicy(2));
  check((await deliver()).status, 'cancelled', 'A new policy cancels earlier-policy delivery');
  await store.set('policy:current', reviewPolicy());

  seeded = await seed();
  const critical = { kind: 'risk', items: [{ type: 'lending', text: 'Critical fixture' }], itemIndex: 0, sentParts: 0 };
  await store.set('monitor:pending', critical);
  check((await deliver()).status, 'queued', 'Critical risk alerts take priority over a strategy notice');
  check(await store.get('monitor:pending'), critical, 'The strategy sender cannot overwrite the risk outbox');
  check(sent.length, 0, 'A busy risk outbox spends zero Telegram calls on strategy');
  await store.set('monitor:pending', { kind: 'strategy_reviews', items: [seeded.item], itemIndex: 0, sentParts: 1 });
  await store.del('review:pending');
  const lease = await store.lock('monitor', 90); await yieldReviewOutbox(store, lease); await lease.release();
  check(await store.get('monitor:pending'), null, 'An unfinished strategy outbox yields to the next risk tick');
  check((await store.get('review:pending'))[0].sentParts, 1, 'Risk preemption retains the acknowledged strategy cursor');
  check((await store.get('policy:current')).version, 1, 'Delivery does not change investment settings');
  console.log('Recurring review Telegram delivery and fencing: ' + assertions + ' assertions passed (max ' + maxQueries + ' D1 calls/step).');
} finally { fixture.close(); globalThis.fetch = oldFetch; }
