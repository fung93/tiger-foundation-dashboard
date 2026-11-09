/* Build supported strategy choices before inference. The model can select these
   choices and their reasons; it cannot supply amounts, formulas or probabilities. */
import { createHash } from 'node:crypto';
import { runAgentTool, renderAgentToolResult } from './_agent-tools.mjs';
import { compareAgentStrategies, renderAgentStrategyResult, validateAgentComparison } from './_agent-scenarios.mjs';
import { agentNumber, agentReadingTime } from '../agent-language.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (stamp, now) => Number.isFinite(Date.parse(stamp)) && now - Date.parse(stamp) >= -30000 && now - Date.parse(stamp) < 90000;
const finite = value => Number.isFinite(value);
const allowed = (policy, type) => !Array.isArray(policy.constraints?.allowedAnalysisTypes) || policy.constraints.allowedAnalysisTypes.includes(type);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = (type, key) => type + ':' + digest(key).slice(0, 24);
const formatRange = (range, data) => agentNumber(range.lowerPrice, 6) + '–' + agentNumber(range.upperPrice, 6) + ' ' + data.quote + ' per ' + data.base;

export async function currentReviewObservation(context, now) {
  const risk = await runAgentTool('getLendingRisk', {}, { context, policy: null, now });
  const observation = { observedAt: new Date(now).toISOString(), sourceSnapshotId: context.snapshot?.snapshotId || null,
    loans: (risk.data.markets || []).filter(row => row.status === 'ready').map(row => ({ key: row.marketKey, market: row.market,
      health: row.health, ltv: row.ltv, debtRaw: row.debtRaw, noPosition: row.noPosition === true, observedAt: row.observedAt })),
    pools: [...(context.strategy?.pools || []), ...(context.strategy?.fee_pools || []),...(context.lpMarkets||[])].slice(0, 20)
      .filter(pool => ['fresh', 'partial'].includes(pool.status) && fresh(pool.ts, now) && Number.isInteger(pool.tick) && finite(pool.price))
      .map(pool => ({ pool: pool.pool,chain:pool.chain||'katana', pair: pool.base + '/' + pool.quote, tick: pool.tick, price: pool.price, observedAt: pool.ts })) };
  return { risk, observation };
}

export function observeReviewFollowUp(previous, observation) {
  if (!previous?.review?.watches?.length || Date.parse(observation.observedAt) <= Date.parse(previous.createdAt)) return [];
  const rows = [];
  for (const watch of previous.review.watches.slice(0, 8)) {
    let message, status = 'unavailable', values = null;
    if (watch.kind === 'loan') {
      const loan = observation.loans.find(row => row.key === watch.key);
      const newer = loan && Date.parse(loan.observedAt) > Date.parse(watch.observedAt);
      if (newer && finite(loan.health) && finite(watch.health)) {
        status = 'observed'; values = { beforeHealth: watch.health, health: loan.health, debtRaw: loan.debtRaw };
        message = loan.market + ': health moved from ' + agentNumber(watch.health) + ' to ' + agentNumber(loan.health)
          + (finite(watch.target) ? ' against the recorded target of ' + agentNumber(watch.target) : '')
          + '. This observation does not prove that a repayment or another transaction occurred.';
      } else if (newer && loan.noPosition) { status = 'observed'; message = loan.market + ' has no open loan in the new verified reading.'; }
    } else if (watch.kind === 'range') {
      const pool = observation.pools.find(row => row.pool === watch.pool&&(row.chain||'katana')===(watch.chain||'katana'));
      if (pool && Date.parse(pool.observedAt) > Date.parse(watch.observedAt) && Number.isInteger(watch.tickLower) && Number.isInteger(watch.tickUpper)) {
        const inside = pool.tick >= watch.tickLower && pool.tick < watch.tickUpper;
        status = 'observed'; values = { tick: pool.tick, price: pool.price, inside };
        message = 'The earlier ' + pool.pair + ' range candidate would be ' + (inside ? 'inside' : 'outside')
          + ' its band at this reading. Checks between reviews are not a complete time-in-range record.';
      }
    }
    if (!message) message = 'The earlier idea could not be checked against a matching fresh reading. Its outcome remains unknown.';
    rows.push({ id: id('lesson', [previous.reportId, watch.key, observation.observedAt]), kind: watch.kind, key: watch.key,
      sourceReportId: previous.reportId, baselineAt: previous.createdAt, observedAt: observation.observedAt,
      status, message, values, provenance: 'later_verified_reading', policyVersion: previous.policyVersion });
  }
  return rows.slice(0, 6);
}

export async function buildReviewAnalysis({ context, policy, plans = [], previous = null, feedback = [], now = Date.now() }) {
  const calculations = [], findings = [], candidates = [], watches = [], planResults = [];
  const { risk, observation } = await currentReviewObservation(context, now);
  const addCalculation = value => { if (!calculations.some(row => row.calculationId === value.calculationId)) calculations.push(value); return value; };
  const addFinding = value => { findings.push(value); return value; };
  const addCandidate = value => { candidates.push({ status: 'conditional', reasonIds: Object.keys(value.reasons), watchIds: Object.keys(value.conditions), ...value }); return value; };
  // Critical risk facts remain independent of optional investment analysis and AI.
  // An excluded analysis type never authorizes target amounts or an allocation.
  addCalculation(risk);
  for (const loan of risk.data.markets || []) {
    if (loan.status !== 'ready') continue;
    const key = loan.marketKey, limit = policy.constraints?.marketLimits?.[key] || {};
    if (loan.noPosition || loan.debtRaw === '0') continue;
    const targets = [finite(limit.targetHealth) ? limit.targetHealth : null,
      finite(limit.maxLtvPct) && limit.maxLtvPct > 0 ? loan.lltv * 100 / limit.maxLtvPct : null].filter(finite);
    const target = targets.length ? Math.max(...targets) : null;
    const breached = finite(target) && loan.health < target || finite(limit.maxLtvPct) && loan.ltv * 100 > limit.maxLtvPct;
    const critical = loan.liquidatable === true;
    const fact = addFinding({ id: id('finding', ['loan', key]), key, kind: 'lending', severity: critical ? 'critical' : breached ? 'warning' : 'info',
      label: loan.market, text: loan.market + ': health ' + agentNumber(loan.health) + ', LTV ' + agentNumber(loan.ltv * 100, 2) + '%'
        + (critical ? '; below the liquidation boundary.' : breached ? '; outside your saved lending target.' : '.'),
      calculationId: risk.calculationId, observedAt: loan.observedAt, critical });
    watches.push({ kind: 'loan', key, health: loan.health, target, observedAt: loan.observedAt });
    if (!allowed(policy, 'lending')) continue;
    const memory=(context.portfolioLearning?.lessons||[]).find(row=>row.kind==='lending'&&row.key===key);
    const reasons = { current_risk: critical ? 'This loan is below the protocol liquidation boundary in the verified reading.'
      : target === null ? 'Your risk target is needed before I can compare repayment choices.'
        : breached ? 'This loan is outside the risk target you saved.' : 'This loan is within your saved target at this reading.',
      ...(memory?.trend==='falling'?{recorded_trend:memory.message+' '+memory.suggestion}:{}) };
    const conditions = { loan_changes: 'Review again if debt, collateral or the oracle ratio changes.', policy_changes: 'A change in your lending target requires a new calculation.' };
    if (target !== null && target >= 1 && target <= 100) {
      const calculation = addCalculation(await runAgentTool('calculateTargetHealth', { market: key, targetHealth: target }, { context, policy, now }));
      if (calculation.status !== 'blocked' && calculation.data.policyCheck?.status === 'within_market_limits' && calculation.data.status === 'repay')
        addCandidate({ id: id('choice', ['repay', key]), key, kind: 'loan', label: 'Review repayment for ' + loan.market,
          priority: critical ? 100 : breached ? 80 : 30, findingIds: [fact.id], calculationIds: [risk.calculationId, calculation.calculationId],
          detail: renderAgentToolResult(calculation), reasons, conditions,
          scope: 'One verified loan and the owner-selected target; available cash and portfolio allocation remain separate.' });
      else addCandidate({ id: id('choice', ['monitor', key]), key, kind: 'loan', label: 'Keep ' + loan.market + ' under review',
        priority: critical ? 100 : breached ? 75 : memory?.trend==='falling'?65:20, findingIds: [fact.id], calculationIds: [risk.calculationId],
        detail: fact.text + ' This does not recommend increasing borrowing.', reasons, conditions });
    } else addCandidate({ id: id('choice', ['target', key]), key, kind: 'inputs', label: 'Choose a lending target for ' + loan.market,
      priority: critical ? 100 : 45, findingIds: [fact.id], calculationIds: [risk.calculationId],
      detail: fact.text + ' Set your chosen health or maximum LTV in Strategy policy before I calculate a target repayment.', reasons, conditions });
  }
  if (allowed(policy, 'lp')) {
    const positions = (context.lp?.positions || []).filter(row => ['katana','robinhood','arc'].includes(row.canonical?.chain))
      .sort((a, b) => (b.canonical?.principalUsd || 0) - (a.canonical?.principalUsd || 0)).slice(0, 3);
    for (const row of positions) {
      const p = row.canonical, key = 'lp:' + p.chain + ':' + p.owner + ':' + (p.positionId || p.id);
      const calculation = addCalculation(await runAgentTool('analyzeLPRange', { positionId: String(p.positionId || p.id), chain: p.chain, owner: p.owner }, { context, policy, now }));
      const data = calculation.data, choice = data.startingPoint;
      if (calculation.status === 'blocked') continue;
      const outside = data.currentRange?.inRange === false, missingBuffer = choice?.currentCoversHistory === false;
      const fact = addFinding({ id: id('finding', key), key, kind: 'lp', severity: outside ? 'warning' : 'info',
        label: data.pair, text: data.pair + (outside ? ' is outside its current band.' : missingBuffer
          ? ': the current band does not cover the full observed ' + choice.days + '-day price move.' : ': current range and historical candidates checked.'),
        calculationId: calculation.calculationId, observedAt: calculation.observedAt, critical: false });
      if (data.feeAdvice) {
        addCandidate({id:id('choice',['range',key]),key,kind:'range',label:'Review '+data.pair+' on '+p.chain,
          priority:outside?75:35,findingIds:[fact.id],calculationIds:[calculation.calculationId],detail:renderAgentToolResult(calculation),
          reasons:{range_fit:data.learning?.applied?'Earlier price-containment evidence supports a wider comparison.':'The pool earns trading fees; its own price/fee history is used.'},
          conditions:{range_break:'Recheck at a range edge or a material fee/volatility change.'}});
        if(choice)watches.push({kind:'range',key,pool:data.pool,chain:p.chain,tickLower:choice.tickLower,tickUpper:choice.tickUpper,observedAt:data.poolObservation.observedAt});
      } else if (choice && data.withinAssetPreferences) {
        const detail = 'The ' + choice.days + '-day candidate is ' + formatRange(choice, data) + '.'
          + (data.currentRange ? ' Your current band is ' + formatRange(data.currentRange, data) + '.' : '')
          + (finite(choice.concentrationVsCurrent) ? ' At the same capital it gives about ' + agentNumber(choice.concentrationVsCurrent, 2) + '× the current band’s liquidity at this price.' : '')
          + (data.stakedTradingFeesToDao ? ' For this staked LP, compare KAT rewards; trading fees go to the DAO.' : '')
          + ' Compare gas, swap costs and future earning assumptions before moving; this range describes past moves.';
        addCandidate({ id: id('choice', ['range', key]), key, kind: 'range', label: (outside ? 'Reassess the out-of-range ' : 'Compare the range for ') + data.pair,
          priority: outside ? 75 : missingBuffer ? 55 : 25, findingIds: [fact.id], calculationIds: [calculation.calculationId], detail,
          reasons: { range_fit: outside ? 'An out-of-range LP may stop earning while the price remains outside.'
            : missingBuffer ? 'The existing band leaves less room than the observed price movement.' : 'The comparison makes the concentration-versus-buffer trade-off explicit.',
          review_cadence: data.reviewFrequencyDays === null ? 'The starting comparison assumes you can check at least weekly; your preference is still unspecified.'
            : 'The historical lookback follows your saved review interval of ' + data.reviewFrequencyDays + ' days.' },
          conditions: { range_break: 'Review if price leaves the candidate band.', rewards_change: 'Recheck costs, competing liquidity and campaign eligibility before acting.' } });
        watches.push({ kind: 'range', key, pool: data.pool,chain:p.chain, tickLower: choice.tickLower, tickUpper: choice.tickUpper, observedAt: data.poolObservation.observedAt });
      }
    }
  }
  if (allowed(policy, 'kat')) {
    const exposure = addCalculation(await runAgentTool('getKATExposure', {}, { context, policy, now }));
    if (exposure.status === 'ready' && finite(exposure.data.verifiedNetKat)) addFinding({ id: id('finding', 'kat'), key: 'kat', kind: 'exposure', severity: 'info',
      label: 'KAT exposure', text: renderAgentToolResult(exposure), calculationId: exposure.calculationId, observedAt: exposure.observedAt, critical: false });
  }
  for (const plan of plans.slice(0, 3)) {
    if (plan.policyVersion !== policy.version || Date.parse(plan.expiresAt) <= now || plan.provenance !== 'owner_confirmed_assumptions') continue;
    const input = structuredClone(validateAgentComparison(plan.input));
    // Old documentation is not silently promoted into current evidence. Financial
    // arithmetic remains valid independently; the original brief retains its sources.
    input.evidenceIds = [];
    const result = addCalculation(await compareAgentStrategies({ context, policy, input, now }));
    for (const nested of result.calculations || []) addCalculation(nested);
    planResults.push({ planId: plan.id, originalReportId: plan.reportId, confirmedAt: plan.confirmedAt, expiresAt: plan.expiresAt,
      input, result, evidenceBasis: 'Original documentation stays with the saved brief; fresh financial inputs are used here.' });
    const options = result.options.filter(option => !['blocked', 'outside_policy'].includes(option.status) && option.outcomes?.length);
    if (!options.length) continue;
    const key = 'plan:' + plan.id;
    const fact = addFinding({ id: id('finding', key), key, kind: 'comparison', severity: 'info', label: plan.label.slice(0, 240),
      text: 'Recalculated the owner-confirmed ' + input.kind + ' comparison over ' + input.horizonDays + ' days using its saved cost and path assumptions.',
      calculationId: result.calculationId, observedAt: result.observedAt, critical: false });
    const baseline = options.find(option => ['maintain', 'hold'].includes(option.id)) || options[0];
    for (const option of options.slice(0, 3)) {
      const optionKey = key + ':' + option.id;
      addCandidate({ id: id('choice', optionKey), key: optionKey, group: key, optionId: option.id, kind: 'comparison',
        label: option.label + ' — your saved ' + input.kind + ' case', priority: 50,
        findingIds: [fact.id], calculationIds: [result.calculationId],
        detail: renderAgentStrategyResult({ ...result, options: option === baseline ? [baseline] : [baseline, option] }),
        reasons: { explicit_assumptions: 'This option is compared on the same starting capital and horizon using the costs and assumptions you explicitly saved.' },
        conditions: { assumptions_expire: 'Reconfirm assumptions by ' + agentReadingTime(plan.expiresAt) + '.', inputs_change: 'Changes in rates, eligibility, prices or available cash can change these outcomes.' } });
    }
  }
  for(const memory of (context.portfolioLearning?.lessons||[]).filter(row=>['closed_lp','kat','locks','votes','holdings'].includes(row.kind)).slice(0,4)){
    addCandidate({id:id('choice',['memory',memory.id]),key:memory.key,kind:'monitor',label:'Review recorded '+memory.kind.replaceAll('_',' ')+' results',
      priority:memory.priority,findingIds:[],calculationIds:[],detail:memory.message+' '+memory.suggestion,
      reasons:{recorded_evidence:'This uses dated observations or the original accounting book; no return forecast or transaction is inferred.'},
      conditions:{new_reading:'Review when a new source reading or recorded outcome changes the evidence.'}});
  }
  const lessons = observeReviewFollowUp(previous, observation);
  const portfolioLessons = (context.portfolioLearning?.lessons||[]).slice(0,6)
    .map(row=>({id:row.id,key:row.key,status:'observed',message:row.message+' '+row.suggestion,
      observedAt:row.sourceTimes.at(-1),provenance:row.provenance}));
  for (const candidate of candidates) {
    candidate.lessonIds = lessons.filter(lesson => lesson.key === candidate.key && lesson.status === 'observed').map(lesson => lesson.id);
    const rejected = feedback.some(item => ['rejected', 'invalidated'].includes(item.state) && item.policyVersion === policy.version && item.keys?.includes(candidate.key));
    candidate.feedback = rejected ? 'Earlier idea rejected or invalidated by owner; do not automatically recommend it again.' : null;
    if (rejected) candidate.suppressed = true;
  }
  const missing = context.snapshot?.allocationBlocked !== false;
  if (!candidates.some(candidate => !candidate.suppressed)) {
    const key = 'complete_inputs';
    const rejectedIdeas = candidates.some(candidate => candidate.suppressed);
    addCandidate({ id: id('choice', key), key, kind: 'inputs', label: rejectedIdeas ? 'Revisit your earlier decision' : 'Complete the inputs for a useful strategy comparison', priority: 10,
      findingIds: [], calculationIds: [], detail: rejectedIdeas ? 'I have not repeated the ideas you rejected. The verified risk readings still apply. Revise your decision or save another comparison if you want different choices.'
        : 'Save your risk targets or a comparison with costs and price-path assumptions. I can then compare supported changes without guessing your preferences.',
      reasons: { missing_inputs: 'A strategy needs a stated goal and reliable inputs.' }, conditions: { new_inputs: 'Run another review after adding those inputs.' }, lessonIds: [] });
  }
  const active = candidates.filter(candidate => !candidate.suppressed).sort((a, b) => b.priority - a.priority).slice(0, 12);
  const sourceExpiries = calculations.filter(value => value.status !== 'blocked').map(value => Date.parse(value.validUntil)).filter(Number.isFinite);
  const result = { schemaVersion: 'agent-review-analysis-v1', createdAt: new Date(now).toISOString(), policyVersion: policy.version,
    snapshotId: context.snapshot?.snapshotId || null, findings: findings.slice(0, 12), candidates: active, calculations,
    observation, watches: watches.slice(0, 8), lessons,portfolioLessons, planResults, feedback: feedback.slice(0, 6), allocationBlocked: missing,
    validUntil: sourceExpiries.length ? new Date(Math.min(...sourceExpiries)).toISOString() : null,
    hasFreshFinancialData: observation.loans.length > 0 || observation.pools.length > 0,
    assumptions: ['Only owner-confirmed targets and comparison assumptions are used. No automatic transaction, policy change or model retraining occurs.',
      'Historical range candidates are cadence-based comparisons, not optimized price forecasts.',
      'Later readings test recorded conditions; they do not establish executed trades, realized net returns or a win rate.'] };
  return { ...result, calculationId: 'reviewcalc:' + digest(result) };
}

export function fallbackReviewSelection(analysis) {
  const groups = new Set();
  const choices = analysis.candidates.filter(candidate => { const group = candidate.group || candidate.key;
    if (groups.has(group)) return false; groups.add(group); return true; }).slice(0, 3);
  return { thesis: analysis.findings.some(row => row.critical) ? 'risk_first' : analysis.candidates.some(row => row.kind === 'range') ? 'range_review' : 'review_choices',
    choices: choices.map(candidate => ({ candidateId: candidate.id, reasonIds: candidate.reasonIds.slice(0, 1),
      watchIds: candidate.watchIds.slice(0, 1), lessonIds: candidate.lessonIds?.slice(0, 1) || [] })) };
}
export function renderPortfolioReview(report, { now = Date.now(), forDelivery = false } = {}) {
  const review = report.review;
  if (!plain(review) || !plain(review.analysis)) return 'This saved review could not be verified. Please run a fresh review.';
  const analysis = review.analysis, selection = review.selection || fallbackReviewSelection(analysis);
  const stamp = agentReadingTime(report.createdAt), expired = !report.validUntil || Date.parse(report.validUntil) <= now;
  if (forDelivery && (expired || report.status === 'superseded')) return 'Your strategy review from ' + stamp
    + ' is saved. Open Agent to read it and refresh the readings before using any amounts.\n' + (review.dashboardUrl || '');
  const lines = ['Portfolio strategy review · ' + stamp];
  if (report.status === 'superseded') lines.push('Your saved preferences changed. This is an earlier review; run a fresh one before using it.');
  else if (expired) lines.push('These are dated readings. Refresh before using repayment amounts or making a change.');
  if (review.mode !== 'ai_review') lines.push('The AI review was unavailable. These are the checks and comparisons I can verify.');
  lines.push(({ risk_first: 'My first priority is the borrowing risk.', range_review: 'My focus is whether your LP bands fit the observed price moves and your review schedule.',
    preserve_cash: 'I would review the cash required before changing exposure.', review_choices: 'I would focus on the following choices and the assumptions behind them.' })[selection.thesis] || 'Here is what I would review.');
  for (const finding of analysis.findings.filter(row => row.critical)) lines.push('\nNeeds attention: ' + finding.text);
  for (const selected of selection.choices.slice(0, 3)) {
    const candidate = analysis.candidates.find(row => row.id === selected.candidateId);
    if (!candidate) continue;
    let detail = candidate.detail;
    if (detail.length > 2200) { const rows = [];
      for (const line of detail.split('\n')) { if (rows.join('\n').length + line.length > 2200) break; rows.push(line); }
      detail = rows.join('\n') + '\nThis uses your saved scenario assumptions. Full case details remain in the original comparison.';
    }
    lines.push('\n' + candidate.label, detail,
      'Why: ' + selected.reasonIds.map(reason => candidate.reasons[reason]).filter(Boolean).join(' '));
    const watches = selected.watchIds.map(watch => candidate.conditions[watch]).filter(Boolean);
    if (watches.length) lines.push('Reconsider when: ' + watches.join(' '));
  }
  const lessons = analysis.lessons.filter(lesson => lesson.status === 'observed').slice(0, 2);
  if (lessons.length) lines.push('\nSince the earlier review:', ...lessons.map(lesson => lesson.message));
  else if (!review.previousReportId) lines.push('\nThis is the first recorded review. Future reviews will check these ideas against later readings.');
  if(analysis.portfolioLessons?.length)lines.push('\nFrom portfolio memory:',...analysis.portfolioLessons.slice(0,2)
    .map(row=>row.message+' Recorded '+agentReadingTime(row.observedAt)+'.'));
  if (analysis.allocationBlocked) lines.push('\nSome holdings are not fully verified, so I have kept this to individual positions and stated scenarios rather than portfolio allocation amounts.');
  return lines.join('\n').slice(0, 11500);
}
