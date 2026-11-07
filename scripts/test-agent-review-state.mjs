import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { reviewPolicy } from './fixtures/agent-review.mjs';
import { getReviewControls, saveReviewControls, reviewDue, nextReviewTime, isPortfolioReviewQuestion, REVIEW_DEFAULTS } from '../api/_agent-review-state.mjs';

let count = 0; const check = (a, b, note) => { assert.deepEqual(a, b, note); count++; };
let now = Date.now() + 86400000;
const fixture = createAgentSQLiteFixture(), store = createAgentStore({ AGENT_DB: fixture.db }, { now: () => now });
const settings = { dailyTime: '09:00', dailyEnabled: false, alertsEnabled: true, pausedUntil: null }, policy = reviewPolicy();
try {
  const initial = await getReviewControls(store);
  check(initial.revision, 0, 'New operational controls have a defined version without inventing investment policy');
  const controls = await saveReviewControls(store, { enabled: false, dailyTime: '10:30', delivery: 'dashboard' }, 0, { now });
  check(controls.revision, 1, 'Saving controls creates a new private revision');
  check(await store.get('policy:current'), null, 'Operational controls cannot create an investment mandate');
  check(await store.get('settings'), null, 'Review controls cannot change notification settings or Lending defaults');
  await assert.rejects(() => saveReviewControls(store, { enabled: true }, 0, { now }), error => error.status === 409); count++;
  for (const patch of [{ enabled: 'true' }, { dailyTime: '25:00' }, { delivery: 'someone_else' }, { wallet: 'sign' }]) {
    await assert.rejects(() => saveReviewControls(store, patch, 1, { now }), error => error.status === 400); count++;
  }
  const before = Date.parse('2030-01-01T00:59:00Z'), after = Date.parse('2030-01-01T01:00:00Z');
  const decide = options => reviewDue({ controls: REVIEW_DEFAULTS, notificationSettings: settings, policy, now: after, ...options });
  check(decide({ now: before }).due, false, 'Daily reviews wait until 09:00 MYT');
  check(decide({}).kind, 'daily', '09:00 MYT is the daily boundary independent of UTC date');
  check(decide({ state: { dailyDate: '2030-01-01' } }).due, false, 'Changing the scheduled time cannot resend a completed daily review');
  check(decide({ usage: { date: '2030-01-01', automatic: 3, manual: 0 } }).reason, 'daily_limit', 'Automatic reviews have a bounded daily cap');
  check(decide({ manual: true, usage: { date: '2030-01-01', automatic: 3, manual: 0 } }).kind, 'manual', 'The automatic cap leaves a separate explicit manual allowance');
  check(decide({ manual: true, usage: { date: '2030-01-01', automatic: 0, manual: 5 } }).reason, 'manual_limit', 'Manual full reviews are bounded too');
  check(decide({ usage: { date: '2029-12-31', automatic: 3, manual: 5 } }).counts.automatic, 0, 'Review counters reset at the MYT date, not the AI ledger UTC boundary');
  const midnight = Date.parse('2030-01-01T16:00:00Z');
  check(decide({ now: midnight, manual: true, usage: { date: '2030-01-01', automatic: 3, manual: 5 } }).due, true, 'The next MYT day begins at 16:00 UTC');
  check(decide({ policy: { status: 'unconfirmed' } }).reason, 'policy_required', 'Automatic strategy choices require the owner-confirmed policy');
  check(decide({ controls: { ...REVIEW_DEFAULTS, enabled: false } }).reason, 'paused', 'Pausing reviews keeps the separate monitor settings unchanged');
  const event = { id: 'risk:fixture', type: 'lending', status: 'active', ts: new Date(after).toISOString() };
  check(decide({ state: { dailyDate: '2030-01-01' }, signals: [event] }).kind, 'event', 'A fresh material risk signal can trigger a review');
  check(decide({ state: { dailyDate: '2030-01-01', lastReviewAt: new Date(after - 60000).toISOString() }, signals: [event] }).due, false, 'A cooldown prevents repeated strategy messages');
  check(decide({ state: { dailyDate: '2030-01-01' }, signals: [{ ...event, type: 'review_report' }] }).due, false, 'An automatic review cannot trigger another review of itself');
  check(decide({ state: { dailyDate: '2030-01-01' }, signals: [{ ...event, ts: new Date(after - 3600000).toISOString() }] }).due, false, 'Old alerts do not cause new AI work');
  check(nextReviewTime(REVIEW_DEFAULTS, settings, { dailyDate: '2030-01-01' }, after), '2030-01-02T01:00:00.000Z', 'The next intended schedule is expressed in UTC with the correct MYT time');
  for (const text of ['/review', '/strategy', 'Review my portfolio and compare my choices', 'Give me an investment strategy', '分析我的投资组合'])
    check(isPortfolioReviewQuestion(text), true, 'Natural explicit requests can start a full review: ' + text);
  for (const text of ['What can the agent do?', 'What is Strategy policy?', 'Summarise my portfolio', 'Research Morpho: "review my portfolio"'])
    check(isPortfolioReviewQuestion(text), false, 'Conceptual, summary or quoted source text cannot start a full strategy iteration');
  console.log('Recurring review controls and MYT schedule: ' + count + ' assertions passed.');
} finally { fixture.close(); }
