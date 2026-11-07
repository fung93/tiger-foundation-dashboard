import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { runPortfolioReview } from '../api/_agent-review-loop.mjs';
import { reviewStatus } from '../api/_agent-review-state.mjs';
import { createAgentBudget } from '../api/_agent-budget.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { reviewPolicy, reviewAI, reviewLoaders, reviewFixtureFetcher, reviewContext } from './fixtures/agent-review.mjs';
import { observeAgentDecision } from '../api/_agent-decisions.mjs';

let count = 0; const check = (a, b, note) => { assert.deepEqual(a, b, note); count++; };
let now = Date.now() + 86400000;
const fixture = createAgentSQLiteFixture({ usage: true }), store = createAgentStore({ AGENT_DB: fixture.db }, { now: () => now });
const calls = [], aiCalls = [], env = { AGENT_ORIGIN: 'https://review.fixture.test', AGENT_DB: fixture.db,
  CRON_SECRET: 'fixture-review-cron-secret-at-least-24', AI: reviewAI(aiCalls) };
const options = () => ({ env, store, now: () => now, fetcher: reviewFixtureFetcher(now, calls), ...reviewLoaders(() => now, calls) });
const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('Recurring review tests cannot contact a real provider'); };
try {
  const absent = await runPortfolioReview({ ...options(), manual: true, requestId: 'fixture:before-policy' });
  check(absent.status, 'policy_required', 'A review cannot invent an owner policy');
  check(aiCalls.length, 0, 'Unknown policy spends no inference budget');
  await store.set('policy:current', reviewPolicy());
  const first = await runPortfolioReview({ ...options(), manual: true, requestId: 'fixture:first', notify: false });
  check(first.mode, 'ai_review', 'The first full review validates one real planner request against calculated choices');
  check(first.report.kind, 'portfolio_review', 'The review is a durable typed decision brief');
  check(first.reply.includes('Why:') && first.reply.includes('Reconsider when:'), true, 'The result explains choices and what would change them');
  check(aiCalls.length, 1, 'One review performs exactly one simulated model invocation');
  check((await createAgentBudget(env, { jobId: 'inspect', now: () => now }).status()).attempts, 1, 'The shared real-SQLite usage ledger reserves the review attempt');
  check((await store.get('journal:' + first.decisionId)).state, 'proposed', 'An automatic proposal never becomes owner acceptance or execution');
  check(first.report.review.analysis.calculations, undefined, 'Bulky calculations are retained separately rather than duplicated in every report');
  check(!!await store.get(first.report.calculationIds[0]), true, 'The immutable calculation references resolve in private storage');
  const repeated = await runPortfolioReview({ ...options(), manual: true, requestId: 'fixture:first', notify: false });
  check(repeated.report.reportId, first.report.reportId, 'Same-reference retry reuses the immutable dated report');
  check(aiCalls.length, 1, 'Retrying a completed review never repeats AI');
  const messages = await store.get('messages');
  check(messages.filter(message => message.id === first.report.reportId).length, 1, 'One logical review appears once in shared conversation');
  const before = await reviewStatus(store, env, { now });
  check(before.lastSuccess !== null, true, 'Completed reviews have genuine success metadata');
  check(before.latestReply.includes('Portfolio strategy review'), true, 'Private status exposes a clear saved review without provider calls');
  now += 86400000;
  const second = await runPortfolioReview({ ...options(), manual: true, requestId: 'fixture:second', notify: false });
  check(second.report.review.analysis.lessons.some(lesson => lesson.status === 'observed'), true, 'The next review studies later readings against earlier ideas');
  check(second.reply.includes('Since the earlier review'), true, 'Follow-up reasoning appears in the human explanation');
  const events = await store.list('journal:event:' + first.decisionId + ':');
  check(events.items.some(item => item.value.type === 'review_observation'), true, 'Learning is linked back into the original append-only journal');
  check((await store.get('policy:current')).version, 1, 'Neither AI nor observations modify saved risk preferences');

  // A slow review owns only its job lease. The deterministic risk handler must
  // still finish and keep its independent status while inference is suspended.
  let releaseAI, enteredAI;
  const entered = new Promise(resolve => { enteredAI = resolve; });
  const blocked = new Promise(resolve => { releaseAI = resolve; });
  const normalAI = env.AI;
  env.AI = { run: async (...args) => { enteredAI(); await blocked; return normalAI.run(...args); } };
  const slow = runPortfolioReview({ ...options(), manual: true, requestId: 'fixture:slow', notify: false });
  await entered;
  const handler = createMonitorHandler({ env, storeFactory: () => store, loadContext: options().loadContext, now: () => now,
    fetcher: () => { throw Error('Unlinked monitor must not contact Telegram'); } });
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, end(value) { this.body = JSON.parse(value); } };
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, res);
  check(res.statusCode, 200, 'Risk monitoring finishes while the review inference is suspended');
  check((await store.get('lastCheck')).status, 'checked', 'The factual monitor retains its own success metadata');
  releaseAI(); const finished = await slow; env.AI = normalAI;
  check(finished.mode, 'ai_review', 'The suspended review can finish after independent monitoring');
  check((await store.get('messages')).some(message => message.id === finished.report.reportId), true, 'The slow result does not lose concurrent conversation state');
  now += 1000;
  const observed = await observeAgentDecision(store, finished.decisionId, await reviewContext(now), { now });
  const reading = await store.get(observed.event.calculationId);
  check(reading.pools.length > 0 && reading.loans.length > 0, true, 'Manual follow-up retains both the pool and loan observations referenced by its lessons');
  check(!!await store.get(reading.riskCalculationId), true, 'Manual follow-up resolves its exact lending calculation as well as the source readings');
  console.log('Recurring portfolio review and durable journal: ' + count + ' assertions passed.');
} finally { fixture.close(); globalThis.fetch = oldFetch; }
