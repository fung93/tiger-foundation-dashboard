/* Shared display copy only. Financial values and eligibility are supplied by
   deterministic readers; this module never changes calculations or policy. */
export const agentNumber = (value, places = 4) => Number.isFinite(value)
  ? value.toLocaleString('en-US', value !== 0 && Math.abs(value) < 10 ** -places
    ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: places }) : 'unavailable';
export const agentMoney = value => Number.isFinite(value)
  ? (value < 0 ? '-$' : '$') + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'unavailable';
export const agentPrice = value => Number.isFinite(value) && value !== 0 && Math.abs(value) < 0.01
  ? (value < 0 ? '-$' : '$') + Math.abs(value).toLocaleString('en-US', { maximumSignificantDigits: 6 }) : agentMoney(value);
export function agentReadingTime(value) {
  const at = typeof value === 'number' ? value < 1e12 ? value * 1000 : value : Date.parse(value);
  return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' MYT' : '';
}
export function agentLabel(value) {
  return ({ ready: 'Ready', partial: 'Some details need checking', blocked: 'More information needed',
    superseded: 'Preferences changed', proposed: 'Awaiting review', deferred: 'Deferred', accepted_for_review: 'Accepted for review',
    rejected: 'Rejected', invalidated: 'No longer applicable', superseded_policy: 'Uses earlier preferences', due: 'Review due', scheduled: 'Review scheduled',
    proposal: 'Brief saved', owner_decision: 'Your decision', owner: 'You', validated_report: 'Saved brief',
    paper_observation: 'Paper check', review_observation: 'Later reading checked', observed: 'Observed', conditional: 'What-if estimate', outside_policy: 'Outside your saved limits' })[value]
    || String(value || '').replace(/_/g, ' ');
}
export function friendlyAgentNotes(notes = [], { partial = false, blocked = false, kind = '' } = {}) {
  const text = (Array.isArray(notes) ? notes.filter(value => typeof value === 'string') : []).join(' ');
  const result = [];
  if (/excluded.*policy|analysis type.*excluded/i.test(text)) result.push('Your saved preferences do not include this type of review. You can change that in Strategy policy.');
  else if (blocked) {
    if (/select|choose|identified|ambiguous|more than one/i.test(text)) result.push('Choose the exact market or position so I can check it.');
    else if (/rate|interest assumption|assumption|horizon|cost/i.test(text)) result.push('Add the missing interest, cash or cost assumptions, then compare again.');
    else result.push('I need a fresh, complete reading before I can give you a reliable amount. Please refresh and try again.');
  } else if (partial) result.push(kind === 'portfolio'
    ? 'Some positions are not fully verified, so this is a partial total.'
    : kind === 'kat' ? 'Some holdings are not fully verified, so your total KAT exposure may be higher or lower.'
      : kind === 'strategy' ? 'These are what-if results. Some portfolio details or assumptions still need checking.'
        : 'Some details still need checking; the figures above cover what I could verify.');
  if (!blocked && /outside.*(?:limits|policy)|target.*(?:breach|violate)/i.test(text)) result.push('This target falls outside your saved lending limits.');
  return [...new Set(result)].slice(0, 2);
}

const MORPHO_MARKETS = 'https://raw.githubusercontent.com/morpho-org/morpho-blue/main/src/interfaces/IMorpho.sol';
const MORPHO_OVERVIEW = 'https://raw.githubusercontent.com/morpho-org/morpho-blue/main/README.md';
export function researchExplanation(report = {}) {
  const ids = new Set(report.sourceIds || []);
  const facts = (report.facts || []).filter(fact => ids.has(fact.evidenceId) && typeof fact.passage === 'string');
  const protocol = report.sourceCoverage?.protocol;
  if (!facts.length || report.status === 'blocked') return {
    text: 'I could not retrieve enough reliable source information to answer this question. Please try again shortly.', evidenceIds: [], complete: false,
  };
  if (/latest|today|recent|announcements?|governance|proposals?|current incentives|新闻|最新|公告|治理/i.test(report.objective || '')) return {
    text: 'I could not verify the latest news or changes from the sources available to me. The documents I found explain how the protocol works, but do not establish what has happened recently.',
    evidenceIds: [], complete: false,
  };
  const market = facts.find(fact => fact.sourceId === 'morpho-blue-markets' && fact.url === MORPHO_MARKETS
    && ['struct MarketParams', 'loanToken', 'collateralToken', 'oracle', 'irm', 'lltv', 'function position'].every(word => fact.passage.includes(word)));
  if (market) return {
    text: 'On Morpho, an isolated market is a separate lending pool with its own borrowed token, collateral token, price feed, interest-rate model and liquidation limit.\n\n'
      + 'Your collateral and debt are recorded separately for each market. Adding collateral to one market does not automatically protect a loan in another.\n\n'
      + 'For example, an avKAT/KAT loan and a KAT/vbUSDC loan each need their own collateral and risk check.', evidenceIds: [market.evidenceId], complete: true,
  };
  const overview = facts.find(fact => fact.sourceId === 'morpho-blue-readme' && fact.url === MORPHO_OVERVIEW
    && /non-custodial lending protocol/i.test(fact.passage));
  if (overview) return {
    text: 'Morpho is a lending protocol run through smart contracts on Ethereum-compatible blockchains.\n\n'
      + (/isolated|markets?/i.test(report.objective || '')
        ? 'The introduction I retrieved does not explain how individual markets are separated. I need the detailed market source to answer that part reliably.'
        : 'The official introduction links to its whitepaper for the detailed lending design. This short source alone does not establish the risks of a particular loan.'),
    evidenceIds: [overview.evidenceId], complete: !/isolated|markets?/i.test(report.objective || ''),
  };
  const passage = facts[0].passage;
  if (protocol === 'sushi' && /periphery|liquidity|pool/i.test(passage)) return {
    text: 'The Sushi source I found describes the contracts used to interact with liquidity pools. It provides protocol background; checking your own earnings or range needs the current LP reading.',
    evidenceIds: [facts[0].evidenceId], complete: true,
  };
  if (protocol === 'merkl' && /distribut|reward|claim/i.test(passage)) return {
    text: 'The Merkl source describes its reward-distribution contracts. Your actual reward entitlement and claimable amount still come from the current reward reading, rather than this general documentation.',
    evidenceIds: [facts[0].evidenceId], complete: true,
  };
  return { text: 'I found official documentation, but the retrieved passages do not explain this question clearly enough. You can inspect the sources below or ask a narrower question about the protocol.', evidenceIds: [], complete: false };
}
