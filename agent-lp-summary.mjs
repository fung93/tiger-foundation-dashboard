/* Read-only presentation of calculated LP outcomes. No forecasts, new earnings,
   policy changes or probability estimates are introduced by this summary. */
import { agentMoney } from './agent-language.mjs';

const IDS = ['maintain', 'widen', 'reposition', 'hold'];
const LABELS = { maintain: 'Keep current range', widen: 'Wider range', reposition: 'Proposed range', hold: 'Just hold the tokens' };
const CENT = .005;
const money = value => agentMoney(Math.abs(value) < CENT ? 0 : value);
const signed = value => value >= CENT ? '+' + money(value) : money(value);
const interval = values => values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
const span = range => !range ? 'Unavailable' : Math.abs(range.max - range.min) < CENT
  ? signed(range.min) : signed(range.min) + ' to ' + signed(range.max);
const outside = option => option.status === 'outside_policy' || option.policyChecks?.some(check => check.status === 'fail');

export function summarizeLPComparison(result = {}) {
  const title = Number.isInteger(result.horizonDays) ? result.horizonDays + '-day LP summary' : 'LP comparison summary';
  const view = { title, points: [], rows: [], notes: [], alerts: [], scope: '', holdingText: '', scenarios: [], leaderIds: [], comparableCases: 0 };
  if (result.status === 'blocked' || result.status === 'superseded') {
    view.points.push({ label: 'Next step', text: result.status === 'superseded'
      ? 'Run a new comparison with your current saved preferences.'
      : 'Refresh the live inputs and fill any missing cash or cost assumptions, then compare again.' });
    return view;
  }
  const options = IDS.map(id => (result.options || []).find(option => option.id === id)).filter(Boolean);
  const hold = options.find(option => option.id === 'hold');
  const cases = Array.isArray(result.scenarios) ? result.scenarios : [];
  // Match outcomes by case index AND label. Repeated owner labels must not pair
  // one price path with a different path merely because the labels look alike.
  const outcome = (option, index) => {
    const value = option?.outcomes?.[index];
    return option?.status !== 'blocked' && value?.scenario === cases[index]?.id && Number.isFinite(value?.netUsd) ? value : null;
  };
  for (const option of options) {
    const outcomes = cases.map((_, index) => outcome(option, index));
    const deltas = outcomes.map((value, index) => {
      const benchmark = outcome(hold, index);
      return value && benchmark ? value.netUsd - benchmark.netUsd : null;
    });
    const numbers = deltas.filter(Number.isFinite), range = interval(numbers);
    const complete = cases.length > 0 && outcomes.every(Boolean);
    view.rows.push({ id: option.id, label: LABELS[option.id], status: outside(option) ? 'outside_policy' : complete ? 'priced' : 'incomplete',
      statusText: outside(option) ? 'Outside saved limits' : complete ? '' : 'Incomplete result',
      costUsd: Number.isFinite(option.cashRequiredUsd) ? option.cashRequiredUsd : null,
      costText: Number.isFinite(option.cashRequiredUsd) ? money(option.cashRequiredUsd) : 'Unavailable',
      minAdvantageUsd: range?.min ?? null, maxAdvantageUsd: range?.max ?? null,
      advantageText: option.id === 'hold' && range ? 'Baseline' : span(range),
      comparedCases: numbers.length, complete, outcomes, deltas });
  }
  const eligible = view.rows.filter(row => row.complete && row.status === 'priced');
  const lpEligible = eligible.some(row => row.id !== 'hold');
  const holdingPriced = view.rows.some(row => row.id === 'hold' && row.complete);
  if (!holdingPriced) view.points.push({ label: 'Takeaway', text: 'The holding benchmark is unavailable; refresh the missing inputs before comparing.' });
  else if (eligible.length > 1 && lpEligible) {
    const winners = cases.map((_, index) => {
      const best = Math.max(...eligible.map(row => row.outcomes[index].netUsd));
      return eligible.filter(row => best - row.outcomes[index].netUsd < CENT).map(row => row.id);
    });
    view.comparableCases = winners.length;
    view.leaderIds = eligible.filter(row => winners.every(ids => ids.includes(row.id))).map(row => row.id);
    const names = view.leaderIds.map(id => LABELS[id]);
    const qualifier = view.rows.some(row => !row.complete) ? 'Among fully priced options, ' : '';
    view.points.push({ label: 'Takeaway', text: qualifier + (names.length === 1
      ? names[0] + ' leads in every tested case.'
      : names.length > 1 ? names.join(' and ') + ' tie for the lead in every tested case.'
        : 'There is no single winner; the better option depends on price and rewards.') });
  } else view.points.push({ label: 'Takeaway', text: eligible.length && lpEligible
    ? 'Only one option has a complete result within the checked limits; there is no full comparison yet.'
    : 'A complete comparison within the checked limits is not available yet.' });

  const current = view.rows.find(row => row.id === 'maintain');
  if (current?.comparedCases) view.points.push({ label: 'Your LP vs holding',
    text: span({ min: current.minAdvantageUsd, max: current.maxAdvantageUsd }) + ' across ' + current.comparedCases + ' tested cases'
      + (current.comparedCases < cases.length ? ' with available readings' : '') + '.' });
  // Only attribute a changed outcome to incentives when the price path AND
  // reward-price assumption match. Different price paths cannot establish this.
  const matchingRewardSwitch = current?.deltas.some((delta, index) => Number.isFinite(delta) && delta < -CENT
    && cases[index].rewardFactor === 0 && cases.some((other, second) => other.rewardFactor > 0
      && JSON.stringify(other.path) === JSON.stringify(cases[index].path)
      && other.rewardPriceUsd === cases[index].rewardPriceUsd && current.deltas[second] > CENT));
  const inRange = current?.outcomes.filter(value => value && Number.isFinite(value.timeInRangeDays)) || [];
  const leavesRange = inRange.filter(value => value.timeInRangeDays < result.horizonDays - 1e-6).length;
  view.points.push({ label: 'Watch', text: matchingRewardSwitch
    ? 'Removing incentives makes your current LP fall behind holding in some otherwise matching cases.'
    : leavesRange ? 'Your current LP spends time out of range in ' + leavesRange + ' of ' + inRange.length + ' tested cases.'
      : 'Future fees and rewards can change; these cases assume the stated rates.' });
  view.holdingText = 'Holding = keep the current token amounts; closing gas is included.';
  view.scope = 'What-if cases ' + (result.comparisonBasis === 'before_financing' ? 'before borrowing costs.' : 'after stated costs.')
    + ' Future rates are assumptions, not future facts.';
  view.notes.push('Holding means closing this LP now and keeping its current token amounts. Closing gas is included.');
  view.notes.push(result.comparisonBasis === 'before_financing'
    ? 'What-if estimates before borrowing costs; rates and price paths are assumptions, not future facts.'
    : 'What-if estimates using the stated costs; rates and price paths are assumptions, not future facts.');
  if (view.rows.some(row => row.status === 'outside_policy')) view.alerts.push('Options outside saved limits are excluded.');
  if (options.some(option => option.policyChecks?.some(check => check.status === 'unknown'))) view.alerts.push('Some portfolio or saved-limit checks still need verifying.');
  if (view.rows.some(row => !row.complete)) view.alerts.push('Incomplete options are not ranked.');
  view.notes.push(...view.alerts);
  view.scenarios = cases.map((item, index) => ({ label: item.id, rows: view.rows.map(row => ({
    option: row.label, statusText: row.statusText, finalValue: row.outcomes[index] ? money(row.outcomes[index].netUsd) : 'Unavailable',
    advantage: Number.isFinite(row.deltas[index]) ? row.id === 'hold' ? 'Baseline' : signed(row.deltas[index]) : 'Unavailable',
  })) }));
  return view;
}

export function renderLPComparisonSummary(result) {
  const view = summarizeLPComparison(result), lines = [view.title];
  lines.push(...view.points.map(point => '• ' + point.label + ': ' + point.text));
  const costs = view.rows.filter(row => row.id !== 'maintain').map(row => row.label + ' ' + row.costText);
  if (costs.length) lines.push('• Upfront costs: ' + costs.join('; ') + '.');
  if (view.holdingText) lines.push(view.holdingText);
  if (view.scope) lines.push(view.scope);
  lines.push(...view.alerts);
  return lines.join('\n');
}
