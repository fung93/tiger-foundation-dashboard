/* LP range geometry and optional gross KAT income-target planning. All amounts
   use deterministic pool arithmetic; no forecast, allocation mandate or writes. */
import { priceAtTick, liquidityForCapital } from '../strategy-core.mjs';
import { agentPrice, agentNumber, agentReadingTime } from '../agent-language.mjs';
import { analyzeLPIncomeTarget,renderLPIncomeTarget } from './_agent-lp-income.mjs';
import { buildLPAdvice, renderLPAdvice } from './_agent-lp-advice.mjs';

export const AGENT_LP_RANGE_VERSION = 'agent-lp-range-v3';
export function isLPRangeQuestion(message) {
  const selecting = /suitable|best|recommend|suggest|choose|widen|narrow|adjust|change|select|合适|合適|建议|建議|sesuai/iu.test(message || '');
  return typeof message === 'string' && (selecting || !/\b(?:in|out(?: of)?|outside)\s+(?:the\s+)?range\b/iu.test(message))
    && /\branges?\b|区间|範圍|范围|\bjulat\b/iu.test(message)
    && /\bLP\b|liquidity|pool|\b(?:btc|bitcoin|wbtc|vbwbtc|eth|kat|usdc|usdt)\b|流动性|流動性|做市/iu.test(message);
}
export function requestedLPReviewDays(message) {
  if (typeof message !== 'string') return null;
  const text = message.trim().replace(/[.!。！]+$/, '');
  const day = value => ({ daily: 1, 'every day': 1, weekly: 7, 'once a week': 7, monthly: 30, 'once a month': 30,
    '每天': 1, '每日': 1, '每周': 7, '每週': 7, '每月': 30, harian: 1, mingguan: 7, bulanan: 30 })[value.toLowerCase()] ?? null;
  if (day(text) !== null) return day(text);
  const match = text.match(/\b(?:I\s+(?:can\s+|will\s+)?(?:check|review|monitor|rebalance))\s+(?:(?:my|this|the)\s+LP\s+)?(daily|weekly|monthly|every day|once a week|once a month|every (\d{1,3}) days?)\b/i);
  return match ? match[2] ? Number(match[2]) >= 1 && Number(match[2]) <= 365 ? Number(match[2]) : null : day(match[1]) : null;
}
export function requestedLPPair(message) {
  const match = typeof message === 'string' && message.match(/\b([a-z][a-z0-9]{1,11})\s*[/／]\s*([a-z][a-z0-9]{1,11})\b/i);
  return match ? match[1] + '/' + match[2] : null;
}
const asset = symbol => ({ WBTC: 'BTC', VBWBTC: 'BTC', BITCOIN: 'BTC', WETH: 'ETH', VBETH: 'ETH', VBUSDC: 'USDC', VBUSDT: 'USDT' })[String(symbol).toUpperCase()] || String(symbol).toUpperCase();
export const lpPairKey = value => typeof value === 'string' && value.split('/').length === 2
  ? value.split('/').map(part => asset(part.trim())).sort().join('/') : null;
const pairKey=lpPairKey;
const current = (ts, now) => Number.isFinite(Date.parse(ts)) && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) < 90000;
const positive = n => Number.isFinite(n) && n > 0;
const tick = n => Number.isInteger(n) && Math.abs(n) <= 887272;
const unavailable = (reason, message, data = {}) => ({ status: 'blocked', stamps: [], data: { reason, message, ...data }, limitations: [message] });
const quoteRange = (lo, hi, pool) => {
  const a = priceAtTick(lo, pool), b = priceAtTick(hi, pool);
  return { tickLower: lo, tickUpper: hi, lowerPrice: Math.min(a, b), upperPrice: Math.max(a, b) };
};

export function analyzeLPRange(args, context, policy, now, positions = []) {
  if (args.chain && args.chain !== 'katana') return unavailable('unsupported_chain', 'I currently have verified range history for configured Katana pools. Which Katana pair would you like to compare?');
  const requested = args.pair ? pairKey(args.pair) : null;
  if (args.pair && !requested) return unavailable('choose_pair', 'Tell me the two tokens, for example BTC/USDC, so I can compare their ranges.');
  const selected = args.positionId ? positions.filter(p => [p.id, p.positionId, p.assetId].some(id => String(id) === args.positionId.replace(/^#/, ''))
    && p.chain === 'katana' && (!args.owner || p.owner?.toLowerCase() === args.owner.toLowerCase())) : [];
  if (args.positionId && selected.length !== 1) return unavailable('choose_position', 'I could not identify one Katana LP from that position. Specify its position ID and wallet.');
  const allPools = [...(context.strategy?.pools || []), ...(context.strategy?.fee_pools || [])];
  let pools = allPools.filter(pool => (pool.chain||'katana')==='katana' && (!requested || pairKey(pool.base + '/' + pool.quote) === requested)
    && (!selected.length || selected[0].pool?.toLowerCase() === pool.pool?.toLowerCase()));
  // A pair with several fee tiers can use the owner's existing pool only when
  // exactly one pool is identified. Never guess between several owned pools.
  if (!args.positionId && pools.length > 1) {
    const owned = pools.filter(pool => positions.some(p => p.chain === 'katana' && p.pool?.toLowerCase() === pool.pool?.toLowerCase()));
    if (owned.length === 1) pools = owned;
  }
  if (pools.length !== 1) return unavailable(pools.length ? 'choose_pool' : 'history_unavailable', pools.length
    ? 'There is more than one pool for this pair. Which LP position or fee tier should I use?'
    : 'I do not have verified price history for that pool yet, so I cannot give you a defensible numeric range. A narrower range concentrates earnings but needs more frequent checks; a wider one leaves more room for price moves.');
  const pool = pools[0], base = pool.baseIndex === 0 ? pool.token0 : pool.token1, quote = pool.baseIndex === 0 ? pool.token1 : pool.token0;
  if (!['fresh', 'partial'].includes(context.strategy?.status) || !['fresh', 'partial'].includes(pool.status) || !current(pool.ts, now))
    return unavailable('stale', 'I need a fresh pool price and price history before suggesting numeric ranges. Please refresh and try again.');
  if (![0, 1].includes(pool.baseIndex) || ![pool.token0, pool.token1].every(token => token && /^0x[0-9a-f]{40}$/i.test(token.address)
    && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36 && positive(token.usd))
    || base.symbol !== pool.base || quote.symbol !== pool.quote || !tick(pool.tick) || !Number.isInteger(pool.tickSpacing)
    || pool.tickSpacing < 1 || pool.tickSpacing > 32767 || !positive(pool.sqrtPrice) || !positive(pool.price))
    return unavailable('units', 'The pool price or token units could not be verified. I will not invent range prices from an incomplete reading.');
  const rawPrice = pool.sqrtPrice ** 2 * 10 ** (pool.token0.decimals - pool.token1.decimals);
  const price = pool.baseIndex === 0 ? rawPrice : 1 / rawPrice;
  // Strategy's displayed quote uses its integer tick; sqrtPrice retains the
  // within-tick precision. Their legitimate difference is at most one tick.
  if (!positive(price) || Math.abs(Math.log(price / pool.price) / Math.log(1.0001)) > 1.01
    || Math.abs(Math.log(pool.sqrtPrice) * 2 / Math.log(1.0001) - pool.tick) > 1.01)
    return unavailable('price_mismatch', 'The pool price and tick disagree. I need a consistent reading before comparing ranges.');
  const owned=positions.filter(p=>p.chain==='katana'&&p.pool?.toLowerCase()===pool.pool?.toLowerCase()
    &&(!args.owner||p.owner?.toLowerCase()===args.owner.toLowerCase()));
  if((args.dailyRewardTargetUsd!==undefined||args.analysisFocus)&&!args.positionId&&owned.length>1)return unavailable('choose_position',
    'You have several LPs in this pool. Which position should I use for the daily income target?');
  const position = selected[0] || owned[0];
  const own = position?.raw, sameTokens = own && [0, 1].every(i => own['token' + i]?.address?.toLowerCase() === pool['token' + i].address.toLowerCase()
    && own['token' + i]?.decimals === pool['token' + i].decimals);
  const ownCurrent = position && context.lp?.status === 'fresh' && current(position.observedAt, now) && position.status === 'observed';
  const ownRange = ownCurrent && sameTokens && tick(own.lowerTick) && tick(own.upperTick) && own.lowerTick < own.upperTick
    ? { ...quoteRange(own.lowerTick, own.upperTick, pool), inRange: pool.tick >= own.lowerTick && pool.tick < own.upperTick } : null;
  const perDollar = range => liquidityForCapital(1, range.tickLower, range.tickUpper, pool)?.liquidity;
  const windows = [];
  for (const days of [7, 14, 30]) {
    const history = pool.recent?.[days];
    if (history?.complete !== true || !tick(history.lowTick) || !tick(history.highTick) || history.lowTick > pool.tick || history.highTick < pool.tick
      || !Number.isSafeInteger(history.swaps) || history.swaps < 1) continue;
    const edge = Math.floor(887272 / pool.tickSpacing) * pool.tickSpacing;
    const lo = Math.floor(history.lowTick / pool.tickSpacing) * pool.tickSpacing;
    const hi = (Math.floor(history.highTick / pool.tickSpacing) + 1) * pool.tickSpacing;
    // Round outward, with an exclusive upper tick. Do not clamp away a history extreme.
    if (lo < -edge || hi > edge || hi <= lo) continue;
    const range = quoteRange(lo, hi, pool), liquidity = perDollar(range);
    if (![range.lowerPrice, range.upperPrice, liquidity].every(positive)) continue;
    const previous = windows.at(-1);
    if (previous && (lo > previous.tickLower || hi < previous.tickUpper))
      return unavailable('history_mismatch', 'The recorded history windows disagree. I need a consistent history before choosing a range.');
    windows.push({ days, ...range, historyLowTick: history.lowTick, historyHighTick: history.highTick, swaps: history.swaps, historyComplete: true,
      currentCoversHistory: ownRange ? ownRange.tickLower <= history.lowTick && ownRange.tickUpper > history.highTick : null,
      downsidePct: (price - range.lowerPrice) / price * 100,
      upsidePct: (range.upperPrice - price) / price * 100,
      concentrationVsCurrent: ownRange?.inRange && positive(perDollar(ownRange)) ? liquidity / perDollar(ownRange) : null });
  }
  if (!windows.length&&args.dailyRewardTargetUsd===undefined&&!args.analysisFocus) return unavailable('history_incomplete', 'I can read this pool, but its recent price history is incomplete. I can explain the narrow-versus-wide trade-off, but a numeric recommendation would be a guess.');
  const constraints = policy?.status === 'confirmed' ? policy.constraints || {} : {};
  const review = args.reviewFrequencyDays ?? (Number.isInteger(constraints.reviewFrequencyDays) ? constraints.reviewFrequencyDays : null);
  const horizon = Number.isInteger(constraints.horizonDays) ? constraints.horizonDays : null;
  const preferredDays = review === null ? 14 : review <= 1 ? 7 : review <= 7 ? 14 : 30;
  const startingPoint = windows.find(row => row.days === preferredDays) || null;
  const eligible = (!Array.isArray(constraints.eligibleAssets) || [base.symbol, quote.symbol].every(symbol => constraints.eligibleAssets.some(value => value.toUpperCase() === symbol.toUpperCase())))
    && (!Array.isArray(constraints.eligibleProtocols) || constraints.eligibleProtocols.some(value => /^(?:sushi v3|sushiswap v3)$/i.test(value)));
  const output={ status: 'ready', stamps: [pool.ts, ...(ownRange ? [position.observedAt] : [])],
    data: { schemaVersion: AGENT_LP_RANGE_VERSION, chain: 'katana', pool: pool.pool, pair: pool.base + '/' + pool.quote, base: pool.base, quote: pool.quote,
      fee: pool.fee, price, quoteUsd: quote.usd, windows, currentRange: ownRange, positionId: ownRange ? position.positionId : null,
      startingPoint: eligible ? startingPoint : null, preferredDays, reviewFrequencyDays: review, horizonDays: horizon,
      reviewBasis: args.reviewFrequencyDays != null ? 'request' : review !== null ? 'policy' : 'unspecified',
      poolObservation: { source: '/api/strategy', observedAt: pool.ts, tick: pool.tick, sqrtPrice: pool.sqrtPrice, reportedPrice: pool.price,
        tickSpacing: pool.tickSpacing, baseIndex: pool.baseIndex, token0: pool.token0, token1: pool.token1, valuationBlockPinned: false },
      withinAssetPreferences: eligible, stakedTradingFeesToDao: ownCurrent && position.feesMine === false,
      historicalOnly: true, profitRankingAvailable: false },
    units: { price: pool.quote + ' per ' + pool.base, offsets: 'percent from observed pool price', concentration: 'liquidity per equal USD at the observed price' },
    assumptions: ['Candidates enclose observed swap-tick extrema, rounded outward to usable pool ticks; hourly buckets can extend the window by up to one hour.',
      'Lookback selection is a review-cadence heuristic, not an optimized range or calibrated probability of remaining in range.',
      'No future fees, rewards, return, net-profit ranking or portfolio allocation is inferred. Rebalancing costs are not supplied.',
      'The pool quote has its original time; the source does not independently pin a valuation block.'], limitations: [] };
  if(args.dailyRewardTargetUsd!==undefined||args.analysisFocus){
    output.data.incomeGoal=analyzeLPIncomeTarget({targetUsd:args.dailyRewardTargetUsd??null,pool,position,rangeData:output.data,
      katUsd:context.strategy?.kat_usd,katObservedAt:context.strategy?.ts,now});
    const goal=output.data.incomeGoal;
    if(args.dailyRewardPeriodAssumed)goal.periodAssumption='daily';
    output.status=goal.status==='ready'?'ready':'partial';
    if(goal.status==='ready'){
      output.stamps.push(context.strategy.ts);
      output.validUntil=new Date(goal.campaign.end*1000).toISOString();
      output.data.historicalOnly=false;
      output.data.rewardEstimatesConditional=true;
      output.data.capitalAllocationVerified=false;
      output.assumptions=output.assumptions.filter(value=>!value.startsWith('No future fees'));
      output.assumptions.push('New gross KAT reward rates assume current price, emissions and competing liquidity; gas, swaps, borrowing costs and actual capital availability are not verified by this rate calculation.');
    }
    output.assumptions.push(goal.basis||goal.message);
    output.data.advice=buildLPAdvice({data:output.data,context,position,pool,args,now});
    if(output.data.advice.priceCaseUnavailable)output.status='partial';
    if(output.data.advice.market.kat)output.stamps.push(output.data.advice.market.kat.observedAt);
    if(output.data.advice.reset?.funding)output.stamps.push(output.data.advice.reset.funding.observedAt,context.lpAdviceFunding.priceObservedAt);
    output.assumptions.push('Reset token mix uses the same LP capital before costs; 0.5% slippage is an illustrative allowance, not a live route quote. Recorded native rewards and current campaign-share rates are different observations.');
  }
  return output;
}

export function renderLPRangeAnalysis(output) {
  const d = output.data || {};
  if (output.status === 'blocked') return d.message || 'Your saved preferences do not include LP analysis. You can change that in Strategy policy.';
  if(d.advice)return renderLPAdvice(d);
  if(d.incomeGoal)return renderLPIncomeTarget(d);
  const format = price => (['USDC', 'USDT', 'DAI', 'USDG'].includes(asset(d.quote)) && d.quoteUsd === 1 ? agentPrice(price) : agentNumber(price, 6) + ' ' + d.quote);
  const range = row => format(row.lowerPrice) + '–' + format(row.upperPrice);
  const lines = ['For ' + d.pair + ' on Katana' + (Number.isInteger(d.fee) ? ' (the ' + agentNumber(d.fee / 10000, 3) + '% pool)' : '')
    + ', I would compare these ranges around the current price of ' + format(d.price) + ':'];
  for (const row of d.windows) lines.push('\n' + row.days + '-day history: ' + range(row) + ' (' + agentNumber(row.downsidePct, 1) + '% below to ' + agentNumber(row.upsidePct, 1) + '% above today’s price).');
  if (d.currentRange) lines.push('\nYour current range is ' + range(d.currentRange) + (d.currentRange.inRange ? '.' : ', and the price is currently outside it.'));
  if (!d.withinAssetPreferences) lines.push('\nThis pair or protocol is outside your saved eligible list, so I am not suggesting a starting choice.');
  else if (d.startingPoint) {
    lines.push('\nMy starting point for comparison: ' + range(d.startingPoint) + ', using the ' + d.startingPoint.days + '-day price history'
      + (d.reviewFrequencyDays === null ? ', if you can check this LP at least weekly.' : ', based on ' + (d.reviewBasis === 'policy' ? 'your saved review interval' : 'the review interval you gave for this question') + ' of ' + d.reviewFrequencyDays + ' day' + (d.reviewFrequencyDays === 1 ? '.' : 's.')));
    if (d.startingPoint.currentCoversHistory === false) lines.push('Your current band would not cover the full price move seen in that period. This candidate leaves room for those observed moves.');
    else if (d.startingPoint.currentCoversHistory === true) lines.push('Your current band already covers that period’s observed moves. Narrowing it would concentrate liquidity, but gives up some of that buffer.');
    if (positive(d.startingPoint.concentrationVsCurrent)) lines.push('At the same capital, this provides about ' + agentNumber(d.startingPoint.concentrationVsCurrent, 2) + '× your current range’s liquidity at today’s price; future earnings do not scale automatically.');
  } else lines.push('\nI do not have a complete ' + d.preferredDays + '-day history to support my usual starting comparison, so I would not choose a range for you from the shorter sample alone.');
  lines.push('A tighter range concentrates liquidity but can stop earning sooner when price leaves it. A wider range gives price more room and spreads the same capital more thinly.');
  if (d.stakedTradingFeesToDao) lines.push('For your staked Sushi position, the earning to compare is KAT rewards; trading fees go to the DAO.');
  lines.push('These ranges describe past price moves, not a forecast. Check gas, swaps and slippage before deciding to move.');
  if (d.reviewFrequencyDays === null && d.withinAssetPreferences) lines.push('\nHow often do you want to check and rebalance this LP: daily, weekly, or less often?');
  const stamp = agentReadingTime(output.observedAt); if (stamp) lines.push('\nPrice and history checked: ' + stamp + '.');
  return lines.join('\n');
}
