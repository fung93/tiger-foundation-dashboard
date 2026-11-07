import assert from 'node:assert/strict';
import { buildReviewAnalysis, fallbackReviewSelection, observeReviewFollowUp, renderPortfolioReview, currentReviewObservation } from '../api/_agent-review-analysis.mjs';
import { validateReviewSelection, selectReviewStrategy } from '../api/_agent-review-ai.mjs';
import { createAgentModelRequest, getAgentModelProfile } from '../api/_agent-models.mjs';
import { AGENT_REVIEW_OUTPUT_SCHEMA } from '../api/_agent-review-schema.mjs';
import { runAgentTool } from '../api/_agent-tools.mjs';
import { reviewContext, reviewPolicy, reviewAI } from './fixtures/agent-review.mjs';

let count = 0; const check = (a, b, note) => { assert.deepEqual(a, b, note); count++; };
const now = Date.now() + 10000, context = await reviewContext(now), policy = reviewPolicy();
const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('No real provider in review analysis tests'); };
try {
  const original = JSON.stringify(context), analysis = await buildReviewAnalysis({ context, policy, now });
  check(analysis.candidates.some(row => row.kind === 'loan'), true, 'The analysis produces loan-specific choices from owner targets');
  check(analysis.candidates.some(row => row.kind === 'range'), true, 'The analysis produces real LP range comparisons');
  check(analysis.allocationBlocked, true, 'Incomplete portfolio coverage remains explicit without blocking a verified individual position');
  check(JSON.stringify(context), original, 'Reviewing never changes accounting, holdings or history');
  const target = await runAgentTool('calculateTargetHealth', { market: 'avkat-kat', targetHealth: 1.3 }, { context, policy, now });
  check(analysis.calculations.find(row => row.toolName === 'calculateTargetHealth').data.repay_raw, target.data.repay_raw, 'Repayment reuses the exact existing integer calculation');
  const stricter = structuredClone(policy); stricter.constraints.marketLimits['avkat-kat'].maxLtvPct = 50;
  const both = await buildReviewAnalysis({ context, policy: stricter, now });
  const expectedTarget = analysis.observation.loans.find(row => row.key === 'avkat-kat');
  check(both.watches.find(row => row.key === 'avkat-kat').target > 1.3, true, 'The stricter owner-confirmed LTV bound controls the repayment target');
  check(!!expectedTarget && both.calculations.find(row => row.toolName === 'calculateTargetHealth').data.policyCheck.status, 'within_market_limits', 'A combined health/LTV target respects both saved constraints');
  check(analysis.candidates.filter(row => row.kind === 'range')[0].detail.includes('trading fees go to the DAO'), true, 'The proposed comparison preserves staked fee routing');
  check(analysis.watches.some(row => row.kind === 'range'), true, 'A range idea records its original boundaries for future checks');
  check(analysis.lessons, [], 'The first review does not invent past learning or backtest success');
  const selection = fallbackReviewSelection(analysis);
  check(validateReviewSelection(selection, analysis), selection, 'The factual fallback uses the same reference constraints as AI');
  const report = { kind: 'portfolio_review', createdAt: analysis.createdAt, validUntil: analysis.validUntil, status: 'partial',
    review: { analysis, selection, mode: 'ai_review', watches: analysis.watches } };
  const reply = renderPortfolioReview(report, { now });
  check(reply.includes('Why:') && reply.includes('Reconsider when:'), true, 'The answer explains a supported choice and its invalidation conditions');
  check(reply.includes('calc:') || reply.includes('policy v') || reply.includes('Limitation:'), false, 'Private diagnostics do not clutter the strategy explanation');
  check(reply.includes('individual positions'), true, 'The report does not imply a complete portfolio allocation');
  check(renderPortfolioReview(report, { now: now + 100000, forDelivery: true }).includes('Open Agent'), true, 'Queued stale recommendations become a dated report notice');
  check(renderPortfolioReview(report, { now: now + 100000, forDelivery: true }).includes('repay at least'), false, 'Stale queued messages never deliver an actionable repayment amount');
  for (const mutate of [v => { v.choices[0].candidateId = 'invented'; }, v => { v.choices[0].reasonIds = ['invented']; },
    v => { v.choices[0].lessonIds = ['invented']; }, v => { v.prose = 'Buy now'; }, v => { v.choices.push(v.choices[0]); }]) {
    const bad = structuredClone(selection); mutate(bad); assert.throws(() => validateReviewSelection(bad, analysis)); count++;
  }
  const calls = [], settlements = [];
  const selected = await selectReviewStrategy({ analysis, policy, env: { AI: reviewAI(calls) }, inference: {
    reserve: async () => ({}), settle: async (_attempt, result) => settlements.push(result) } });
  check(calls.length, 1, 'A full strategy review uses one bounded inference');
  check(calls[0].request.response_format.json_schema, AGENT_REVIEW_OUTPUT_SCHEMA, 'Qwen receives the closed review selection grammar');
  check(settlements[0].outcome, 'succeeded', 'Only a supported selection records successful inference');
  check(selected.selection.choices.every(choice => analysis.candidates.some(candidate => candidate.id === choice.candidateId)), true, 'AI cannot invent a strategy or a financial amount');
  const glm = createAgentModelRequest(getAgentModelProfile({ AGENT_MODEL: '@cf/zai-org/glm-4.7-flash' }), [{ role: 'user', content: 'fixture' }], { purpose: 'portfolio_review' });
  check(glm.response_format.json_schema.name, 'tiger_portfolio_review', 'The explicit alternate retains its documented named-schema envelope');
  check(glm.chat_template_kwargs.enable_thinking, false, 'The explicit alternate keeps its documented thinking switch');
  const prior = { ...report, reportId: 'report:prior', policyVersion: policy.version };
  const later = structuredClone(analysis.observation);
  const watched = analysis.watches.find(row => row.kind === 'range');
  later.observedAt = new Date(now + 86400000).toISOString(); later.pools.find(row => row.pool === watched.pool).tick = watched.tickUpper;
  later.loans.forEach(row => { row.observedAt = later.observedAt; }); later.pools.forEach(row => { row.observedAt = later.observedAt; });
  const lessons = observeReviewFollowUp(prior, later);
  check(lessons.some(row => row.kind === 'range' && row.message.includes('outside')), true, 'A later price tests the original recorded candidate');
  check(lessons.every(row => row.sourceReportId === prior.reportId), true, 'Every follow-up retains its original source idea');
  check(lessons.some(row => row.message.includes('complete time-in-range')), true, 'Point checks never masquerade as continuous historical performance');
  const unknown = observeReviewFollowUp(prior, { observedAt: later.observedAt, loans: [], pools: [] });
  check(unknown.every(row => row.status === 'unavailable'), true, 'Unavailable later readings cannot become failed strategies or zero balances');
  const noTargets = await buildReviewAnalysis({ context, policy: { ...policy, constraints: { ...policy.constraints, marketLimits: {} } }, now });
  check(noTargets.calculations.some(row => row.toolName === 'calculateTargetHealth'), false, 'Notification defaults never become investment repayment targets');
  const rejected = await buildReviewAnalysis({ context, policy, now, feedback: [{ state: 'rejected', policyVersion: 1,
    keys: analysis.candidates.filter(row => row.kind === 'range').map(row => row.key) }] });
  check(rejected.candidates.some(row => row.kind === 'range'), false, 'An owner-rejected idea is not automatically recommended again under the same policy');
  const stale = structuredClone(context); stale.lending.status = 'stale'; stale.lending.markets.forEach(row => { row.status = 'stale'; });
  stale.strategy.status = 'stale'; stale.strategy.pools.forEach(row => { row.status = 'stale'; });
  const noFresh = await buildReviewAnalysis({ context: stale, policy, now });
  check(noFresh.hasFreshFinancialData, false, 'Stale data cannot support current strategy analysis');
  check(noFresh.candidates.every(row => row.kind === 'inputs'), true, 'Stale source failures never generate numeric investment suggestions');
  const observation = await currentReviewObservation(context, now);
  check(observation.risk.calculationId, analysis.calculations[0].calculationId, 'Follow-up observations reuse the same verified lending arithmetic');
  console.log('Recurring review analysis and closed AI selection: ' + count + ' assertions passed.');
} finally { globalThis.fetch = originalFetch; }
