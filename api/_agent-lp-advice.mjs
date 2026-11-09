/* Evidence-driven LP judgment. Deterministic comparisons, never model maths,
   guaranteed returns, invented support levels or an executable trading plan. */
import { amountsPerLiquidity, liquidityForCapital, estimateReward, priceAtTick, tickAtPrice } from '../strategy-core.mjs';
import { agentMoney, agentNumber, agentPrice, agentReadingTime } from '../agent-language.mjs';

export const LP_ADVICE_FOCUSES = Object.freeze(['balanced', 'income', 'reset', 'reward_price', 'market']);
const positive = n => Number.isFinite(n) && n > 0;
const fresh = (ts, now) => Number.isFinite(Date.parse(ts)) && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) < 90000;
const cleanQuestion = text => String(text || '').replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g, ' ');
export function requestedLPAdviceFocus(message) {
  const text = cleanQuestion(message);
  if (/\b(?:reset|recenter|re-centre|rebalance|reposition|worth (?:it|moving)|move (?:my|the|this) (?:LP|position)|keep (?:my|the|this|current) (?:LP|range)|leave it)\b/i.test(text)) return 'reset';
  if (/\b(?:KAT|reward)\b.{0,35}\b(?:falls?|drops?|rises?|crashes?|price|floor|sensitivity)|\b(?:price|how low)\b.{0,30}\bKAT\b|\bfloor\s*\$/i.test(text)) return 'reward_price';
  if (/\b(?:market situation|market conditions|volatil(?:e|ity)|market risk)\b|\b(?:BTC|WBTC|bitcoin|ETH)\b.{0,25}\b(?:drops?|falls?|rises?|gains?)\b/i.test(text)) return 'market';
  if(/\bwhy (?:this|that|so) (?:range|band|narrow|wide)|\bsame capital\b/i.test(text))return 'balanced';
  return null;
}
export function requestedLPPriceCase(message){
  const text=cleanQuestion(message),cases=[];
  if(/\b(?:or|and|to)\s*\d+(?:\.\d+)?\s*%/i.test(text))return null;
  const alias=s=>/^(?:BTC|WBTC|VBWBTC|BITCOIN)$/i.test(s)?'BTC':/^(?:ETH|VBETH|WETH)$/i.test(s)?'ETH':'KAT';
  for(const row of text.matchAll(/\b(KAT|BTC|WBTC|vbWBTC|bitcoin|ETH|vbETH|WETH)\s+(?:price\s+)?(?:drops?|falls?|declines?|rises?|gains?|increases?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi)){
    const pct=Number(row[2])*(/drop|fall|decline/i.test(row[0])?-1:1);
    if(pct<=-100||pct>1000)return null;
    cases.push({symbol:alias(row[1]),changePct:pct});
  }
  for(const row of text.matchAll(/\bKAT\s+(?:price\s+)?(?:at|to|is|of|=)\s*\$\s*(\d+(?:\.\d+)?)\b/gi)){
    if(positive(Number(row[1]))&&Number(row[1])<=1e6)cases.push({symbol:'KAT',priceUsd:Number(row[1])});
  }
  return cases.length===1?cases[0]:null;
}
export function requestedLPRewardFloor(message) {
  const text = cleanQuestion(message), values = [...text.matchAll(/\b(?:floor|minimum daily (?:income|rewards?)|at least)\s*(?:of|is|:|=)?\s*\$\s*(\d+(?:\.\d+)?)\b|\$\s*(\d+(?:\.\d+)?)\s*(?:\/day\s*)?floor\b/gi)]
    .map(row => Number(row[1] || row[2]));
  return values.length && new Set(values).size === 1 && positive(values[0]) && values[0] <= 1e9 ? values[0] : null;
}

function recordedPace(row, now) {
  const pace = row?.rewardPace;
  if (!pace || pace.carryExcluded !== true || pace.source !== '/api/lpbook'
    || ![pace.start, pace.end, pace.hours, pace.katEarned].every(Number.isFinite)
    || pace.katEarned < 0 || pace.hours < 6 || pace.hours > 26 || pace.end <= pace.start
    || Math.abs((pace.end - pace.start) / 3600 - pace.hours) > .0001 || !fresh(new Date(pace.end * 1000).toISOString(), now)) return null;
  return { ...pace, katPerDay: pace.katEarned * 24 / pace.hours,
    basis: 'Recorded native rewards over the full interval, including any time out of range; not a spot in-range forecast.' };
}
export function resetComparison(current, candidate, pool, goal, funding, position, now) {
  const capital=goal.capitalUsd;
  if (!current || !candidate || !positive(capital)) return null;
  const currentL = Number(position?.raw?.liquidity), next = liquidityForCapital(capital, candidate.tickLower, candidate.tickUpper, pool);
  if (!positive(currentL) || !positive(next?.liquidity)) return null;
  const old = amountsPerLiquidity(current.tickLower, current.tickUpper, pool.sqrtPrice, pool.token0.decimals, pool.token1.decimals);
  const tokens = [0, 1].map(i => {
    const token = pool['token' + i], before = old['amount' + i] * currentL, after = next['amount' + i];
    return { symbol: token.symbol, address: token.address, before, after, delta: after - before,
      deltaUsd: (after - before) * token.usd };
  });
  // Capital is conserved at this quote; count the sold side once, not both legs.
  const swapUsd = tokens.reduce((sum, token) => sum + Math.max(0, -token.deltaUsd), 0);
  const poolFeeUsd = swapUsd * pool.fee / 1e6, slippageCaseBps = 50, slippageCaseUsd = swapUsd * slippageCaseBps / 10000;
  const validFunding = funding?.schemaVersion === 'agent-lp-funding-v1' && funding.chain === position.chain
    && funding.owner?.toLowerCase() === position.owner?.toLowerCase() && fresh(funding.observedAt, now)
    && fresh(funding.priceObservedAt, now) && Number.isSafeInteger(funding.block) && funding.block >= 0
    && Number.isSafeInteger(funding.gasUnits) && funding.gasUnits > 0 && /^\d{1,78}$/.test(funding.gasPriceWei || '')
    && positive(funding.nativePriceUsd) && Number.isFinite(funding.gasUsd) && funding.gasUsd >= 0
    && Math.abs(funding.gasUsd-Number(BigInt(funding.gasPriceWei))*funding.gasUnits/1e18*funding.nativePriceUsd)<=.00000101;
  const gasUsd = validFunding ? funding.gasUsd : null;
  const costs = gasUsd === null ? null : gasUsd + poolFeeUsd + slippageCaseUsd;
  let afterCosts=null;
  if(costs!==null&&capital>costs&&pool.kind==='rewards'){
    const reading=estimateReward({...pool,eligible:{...pool.eligible,liquidity:goal.otherEligibleLiquidity,amount0:0,amount1:0}},
      {capitalUsd:capital-costs,lowerPrice:candidate.lowerPrice,upperPrice:candidate.upperPrice},
      {now:now/1000,katUsd:goal.katUsd,rewardStart:pool.campaign.start,rewardEnd:pool.campaign.end});
    if(!reading.error&&Number.isFinite(reading.usdPerDay))afterCosts=reading.usdPerDay;
  }
  const gain = afterCosts===null?null:afterCosts-current.usdPerDay;
  return { tokens, swapUsd, poolFeeUsd, slippageCaseBps, slippageCaseUsd, gasUsd,
    costEstimateUsd: costs, capitalAfterCostsUsd:costs===null?null:Math.max(0,capital-costs),
    grossUsdPerDayAfterCosts:afterCosts, reachesTargetAfterCosts:afterCosts===null||!positive(goal.targetUsdPerDay)?null:afterCosts>=goal.targetUsdPerDay,
    incrementalGrossUsdPerDay: gain,
    staticPaybackDays: costs !== null && gain > 0 ? costs / gain : null,
    funding: validFunding ? { observedAt: funding.observedAt, block: funding.block, gasUnits: funding.gasUnits,
      gasPriceWei: funding.gasPriceWei, nativePriceUsd: funding.nativePriceUsd } : null,
    basis: 'Same LP capital at the observed spot; indicative token mix and pool fee, planning gas plus an illustrative 0.5% slippage allowance. Costs reduce redeposited capital and income; no live route quote, idle-time or financing estimate.' };
}

export function buildLPAdvice({ data, context, position, pool, args, now }) {
  const goal = data.incomeGoal, focus = args.analysisFocus || 'balanced';
  const matching = context.lp?.positions?.filter(row => row.canonical?.chain === position?.chain
    && String(row.canonical.positionId) === String(position?.positionId)
    && row.canonical.owner?.toLowerCase() === position?.owner?.toLowerCase()
    && row.canonical.contract?.toLowerCase() === position?.contract?.toLowerCase());
  const pace = position && context.lp?.status === 'fresh' && fresh(position.observedAt, now) && matching?.length === 1 ? recordedPace(matching[0], now) : null;
  const kat = positive(context.strategy?.kat_usd) && fresh(context.strategy?.ts, now) ? context.strategy.kat_usd : null;
  const advice = { schemaVersion: 'agent-lp-advice-v1', focus, recordedPace: pace, katUsd: kat,
    current: goal?.status === 'ready' ? goal.current : null, candidate: null, reset: null, sensitivity: null,
    judgment: null, judgmentBasis: 'Read-only review heuristic from the calculated gap, current range, observed history and cost scenario; no new saved risk limit.',
    market: { kat: null, currentDownsidePct: data.currentRange ? (data.price - data.currentRange.lowerPrice) / data.price * 100 : null,
      currentUpsidePct: data.currentRange ? (data.currentRange.upperPrice - data.price) / data.price * 100 : null,
      observedBand: data.windows.find(row => row.days === 7) || null },
    mcp: context.katanaMCP ? {...context.katanaMCP,gauges:context.katanaMCP.gauges?.filter(row=>row.pool===pool.pool.toLowerCase())||[]} : null, mcpComparison: null };
  const day=pool.recent?.[1];
  if(day?.complete===true&&[day.lowTick,day.highTick].every(n=>Number.isInteger(n)&&Math.abs(n)<=887272)
    &&day.lowTick<=pool.tick&&day.highTick>=pool.tick&&Number.isSafeInteger(day.swaps)&&day.swaps>0){
    const prices=[priceAtTick(day.lowTick,pool),priceAtTick(day.highTick,pool)];
    if(prices.every(positive))advice.market.observedDay={lowerPrice:Math.min(...prices),upperPrice:Math.max(...prices),
      spanPct:(Math.max(...prices)-Math.min(...prices))/data.price*100,
      basis:'Observed 24-hour swap-tick envelope; hourly buckets may extend by up to one hour.'};
  }
  const market = context.kat?.market;
  if (market && fresh(market.observedAt, now) && positive(market.currentUsd) && kat
    && Math.abs(market.currentUsd / kat - 1) <= .02 && Number.isFinite(market.change24hPct)) advice.market.kat = market;
  const mcpGauge = advice.mcp?.status === 'ready' ? advice.mcp.gauges?.find(row => row.pool === pool.pool.toLowerCase()) : null;
  if (mcpGauge) advice.mcpComparison = { ...mcpGauge, referenceOnly: true,
    sourceTimeCurrent: fresh(mcpGauge.observedAt, now),
    campaignRateDiffers: Number.isFinite(mcpGauge.katPerDay) && Number.isFinite(pool.katPerDay)
      ? Math.abs(mcpGauge.katPerDay - pool.katPerDay) > Math.max(.01, pool.katPerDay * .1) : null,
    priority: 'Existing chain/Merkl campaign is used for calculations, even if the MCP index disagrees.' };
  // Observed pace remains useful when the current eligible-liquidity read fails;
  // it cannot by itself establish current competition or price a replacement band.
  const rate = advice.current?.katPerDay ?? pace?.katPerDay;
  if (Number.isFinite(rate) && rate >= 0 && kat) advice.sensitivity = {
    basis: advice.current ? 'Current campaign share; KAT price alone changes.' : 'Recorded reward pace; KAT price alone changes.',
    scenarios: [-10, 0, 10].map(changePct => ({ changePct, katUsd: kat * (1 + changePct / 100), usdPerDay: rate * kat * (1 + changePct / 100) })),
    targetPriceUsd: positive(rate) && positive(goal?.targetUsdPerDay) ? goal.targetUsdPerDay / rate : null,
    floorUsdPerDay: args.dailyRewardFloorUsd ?? null,
    floorPriceUsd: positive(rate) && positive(args.dailyRewardFloorUsd) ? args.dailyRewardFloorUsd / rate : null,
  };
  if(args.priceCase&&Number.isFinite(rate)&&rate>=0){
    const spec=args.priceCase;
    if(spec.symbol==='KAT'&&kat){
      const price=spec.priceUsd??kat*(1+spec.changePct/100);
      if(positive(price))advice.priceCase={...spec,kind:'reward',priceUsd:price,katPerDay:rate,usdPerDay:rate*price,
        basis:advice.current?'Current campaign share; only KAT price changes.':'Recorded reward pace; only KAT price changes.'};
    }else if(goal?.status==='ready'&&({vbWBTC:'BTC',WBTC:'BTC',BTC:'BTC',vbETH:'ETH',WETH:'ETH',ETH:'ETH'})[pool.base]===spec.symbol&&Number.isFinite(spec.changePct)){
      const ratio=1+spec.changePct/100,quote=data.price*ratio,tick=tickAtPrice(quote,pool);
      if(tick>=-887272&&tick<=887272){
        const sqrt=pool.sqrtPrice*(pool.baseIndex===0?Math.sqrt(ratio):1/Math.sqrt(ratio)),L=Number(position.raw.liquidity);
        const units=amountsPerLiquidity(goal.current.tickLower,goal.current.tickUpper,sqrt,pool.token0.decimals,pool.token1.decimals);
        const old=amountsPerLiquidity(goal.current.tickLower,goal.current.tickUpper,pool.sqrtPrice,pool.token0.decimals,pool.token1.decimals);
        const prices=[pool.token0.usd,pool.token1.usd];prices[pool.baseIndex]*=ratio;
        advice.priceCase={...spec,kind:'base',price:quote,inRange:tick>=goal.current.tickLower&&tick<goal.current.tickUpper,
          principalUsd:L*(units.amount0*prices[0]+units.amount1*prices[1]),
          holdingUsd:L*(old.amount0*prices[0]+old.amount1*prices[1]),
          basis:'Only the base token changes; quote token USD value stays fixed. Principal versus holding the same current LP tokens, excluding rewards/costs. Future competing liquidity is unknown.'};
      }
    }
  }
  if(args.priceCase&&!advice.priceCase)advice.priceCaseUnavailable=true;
  if (goal?.status !== 'ready') return advice;
  const hasTarget = positive(goal.targetUsdPerDay);
  advice.candidate = goal.historicalChoice || (focus === 'reset' && goal.current.reachesTarget ? goal.preferred : goal.targetOnlyRange || goal.preferred);
  advice.candidateKind=advice.candidate&&advice.candidate===goal.targetOnlyRange?'target_only':'historical';
  if(advice.candidate){advice.candidateRoom={downPct:(data.price-advice.candidate.lowerPrice)/data.price*100,
    upPct:(advice.candidate.upperPrice-data.price)/data.price*100};}
  advice.shortfallUsdPerDay = hasTarget ? Math.max(0, goal.targetUsdPerDay - goal.current.usdPerDay) : null;
  advice.targetShare = positive(goal.poolBudgetUsd) && hasTarget ? goal.targetUsdPerDay / goal.poolBudgetUsd : null;
  advice.currentShare = positive(pool.eligible?.liquidity)&&positive(pool.katPerDay) ? goal.current.katPerDay / pool.katPerDay : null;
  advice.reset = resetComparison(goal.current, advice.candidate, pool, goal, context.lpAdviceFunding, position, now);
  const out = !goal.current.inRange;
  const nearEdge = !out && Math.min(advice.market.currentDownsidePct, advice.market.currentUpsidePct) < 1;
  advice.judgment = out ? 'review_range_exit' : nearEdge ? 'monitor_edge'
    : data.learning?.applied ? 'compare_history'
    : hasTarget && goal.current.reachesTarget ? 'keep_goal_met'
      : hasTarget && advice.shortfallUsdPerDay <= goal.targetUsdPerDay * .1 ? 'keep_small_gap'
        : hasTarget && !goal.historicalChoice ? 'do_not_chase'
          : !hasTarget&&goal.preferred?.currentCoversHistory===true?'keep_history':'compare_history';
  if (advice.reset?.staticPaybackDays != null && advice.reset.staticPaybackDays >= goal.campaign.remainingDays
    && !out && !nearEdge && !goal.current.reachesTarget) advice.judgment = 'costs_exceed_campaign_gain';
  return advice;
}

export function renderLPAdvice(d) {
  const g = d.incomeGoal, a = d.advice, target = positive(g?.targetUsdPerDay) ? agentMoney(g.targetUsdPerDay) + '/day' : null;
  const stable = ['USDC', 'VBUSDC', 'USDT', 'VBUSDT', 'DAI', 'USDG'].includes(String(d.quote).toUpperCase()) && d.quoteUsd === 1;
  const price = n => stable ? agentPrice(n) : agentNumber(n, 6) + ' ' + d.quote;
  const band = row => price(row.lowerPrice) + '–' + price(row.upperPrice);
  const rate = row => agentNumber(row.katPerDay, 1) + ' KAT/day (' + agentMoney(row.usdPerDay) + '/day)';
  if(a.priceCaseUnavailable)return 'I could not validate that price case for '+d.pair+'. I need a matching base-token price move or a KAT reward-price case before calculating its effect.';
  if (!g || g.status !== 'ready') {
    const lines = [(target ? 'For ' + target + ': ' : '') + (g?.message || 'I need a verified reward campaign to compare the earnings.')];
    if (a.recordedPace) lines.push('Recorded recently: ' + agentNumber(a.recordedPace.katPerDay, 1) + ' KAT/day over '
      + agentNumber(a.recordedPace.hours, 1) + ' hours' + (a.katUsd ? ', about ' + agentMoney(a.recordedPace.katPerDay * a.katUsd) + '/day at today’s KAT price' : '')
      + '. This includes any time out of range; it cannot price a new band without current competition data.');
    if(g?.periodAssumption==='daily')lines.unshift('Assuming you mean that amount per day.');
    return lines.join('\n');
  }
  // A follow-up should answer its chosen case, not repeat the whole earlier
  // range report. All original observations remain in the private tool result.
  if(a.priceCase||a.focus==='reward_price'&&a.sensitivity?.floorPriceUsd!=null){
    const s=a.priceCase,lines=[];
    if(s?.kind==='reward'){
      lines.push('At KAT '+agentPrice(s.priceUsd)+', the same reward pace is about '+agentMoney(s.usdPerDay)+'/day'+(target?' versus your '+target+' goal.':'.'));
      lines.push('• Current share: '+agentNumber(s.katPerDay,1)+' KAT/day while the price is in your range. KAT is '+agentPrice(g.katUsd)+' at this reading.');
      if(target)lines.push('• That goal would need '+agentNumber(g.targetUsdPerDay/s.priceUsd,1)+' KAT/day at the scenario price.');
      if(a.sensitivity?.floorUsdPerDay!=null)lines.push('• Your '+agentMoney(a.sensitivity.floorUsdPerDay)+'/day floor '+(s.usdPerDay>=a.sensitivity.floorUsdPerDay?'still holds':'would be missed')+' in this case.');
      lines.push('Suggestion: review the income gap together with your range buffer; moving the BTC band does not protect KAT’s dollar price.');
    }else if(s?.kind==='base'){
      lines.push(s.symbol+' '+(s.changePct>0?'+':'')+agentNumber(s.changePct,1)+'% puts the pool around '+price(s.price)+': '
        +(s.inRange?'your current LP stays in range in this scenario.':'your current LP leaves its range and stops earning KAT under the current rules.'));
      lines.push('• Current band: '+band(g.current)+'.');
      lines.push('• At that price: LP principal '+agentMoney(s.principalUsd)+' versus '+agentMoney(s.holdingUsd)+' holding your current tokens; rewards/costs excluded.');
      lines.push(s.inRange?'Suggestion: watch the remaining room to the edge. The future reward rate also depends on which other positions are active then.'
        :'Suggestion: review repositioning if that price is reached; refresh the pool and competition before choosing a new band.');
    }else{
      const sens=a.sensitivity;
      lines.push('At the current reward pace, your '+agentMoney(sens.floorUsdPerDay)+'/day floor needs KAT around '+agentPrice(sens.floorPriceUsd)+' or higher.');
      lines.push('• Today: '+rate(g.current)+' at KAT '+agentPrice(g.katUsd)+'.');
      lines.push('• KAT −10%: '+agentMoney(sens.scenarios[0].usdPerDay)+'/day; +10%: '+agentMoney(sens.scenarios[2].usdPerDay)+'/day, with the same KAT/day.');
      lines.push('Suggestion: monitor both KAT’s price and your LP’s range; the floor depends on the reward pace continuing.');
    }
    lines.push('Conditional gross rewards, before transaction and borrowing costs. Campaign ends '+agentReadingTime(new Date(g.campaign.end*1000).toISOString())
      +(g.campaign.remainingDays<1?' (less than one full day remains).':'.'));
    return lines.join('\n');
  }
  const lines = [];
  const verdict = ({ keep_goal_met: 'I would keep the current range for now: it already meets the current reward-rate estimate.',
    keep_small_gap: 'I would keep monitoring rather than reset just to close this small income gap.',
    monitor_edge: 'Watch the nearby range edge closely; moving solely for income is not the first priority.',
    review_range_exit: 'Review repositioning: your LP is outside its range and earns no KAT under the current campaign rules.',
    do_not_chase: 'I would not tighten the range solely to force the income target.',
    compare_history: 'Compare a band with room for the observed price moves before deciding to reset.',
    keep_history:'Your current range already covers the relevant observed price moves; I see no history-based reason to reset from this reading.',
    costs_exceed_campaign_gain: 'I would not reset for this reward increase: the cost scenario takes longer to recover than the campaign has left.' })[a.judgment];
  const rewardCase=a.priceCase?.kind==='reward';
  lines.push(rewardCase?'At KAT '+agentPrice(a.priceCase.priceUsd)+', the same reward pace is about '+agentMoney(a.priceCase.usdPerDay)+'/day'
    +(target?' versus your '+target+' goal.':'.')
    :a.priceCase?.kind==='base'?a.priceCase.symbol+' '+(a.priceCase.changePct>0?'+':'')+agentNumber(a.priceCase.changePct,1)+'% puts the pool around '+price(a.priceCase.price)+': '
      +(a.priceCase.inRange?'your current LP stays in range in this scenario.':'your current LP leaves its range and stops earning KAT under the current rules.')
      :a.focus==='reward_price'&&a.sensitivity?.floorPriceUsd!==null&&a.sensitivity?.floorPriceUsd!==undefined
        ?'At the current reward pace, your '+agentMoney(a.sensitivity.floorUsdPerDay)+'/day floor needs KAT around '+agentPrice(a.sensitivity.floorPriceUsd)+' or higher.'
        :(target ? 'For ' + target + ': ' : '') + verdict);
  if(a.priceCase?.kind==='base')lines.push('• At that price: LP principal '+agentMoney(a.priceCase.principalUsd)+' versus '+agentMoney(a.priceCase.holdingUsd)+' holding your current tokens; rewards/costs excluded.');
  lines.push((rewardCase?'• Today, at KAT '+agentPrice(g.katUsd)+': ':'• Current ') + band(g.current) + ': about ' + rate(g.current)
    +(g.current.inRange?'. Room: '+agentNumber(a.market.currentDownsidePct, 2) + '% down / ' + agentNumber(a.market.currentUpsidePct, 2) + '% up.':'; price is outside this band.'));
  const displayKat=rewardCase?a.priceCase.priceUsd:g.katUsd,shortfall=rewardCase?Math.max(0,g.targetUsdPerDay-a.priceCase.usdPerDay):a.shortfallUsdPerDay;
  if (target && shortfall > 0) lines.push('• Goal: ' + agentNumber(g.targetUsdPerDay/displayKat, 1) + ' KAT/day at KAT ' + agentPrice(displayKat)
    + '; '+(rewardCase?'scenario':'current')+' shortfall ' + agentMoney(shortfall) + '/day.');
  const candidate = a.focus==='reward_price'?null:a.candidate;
  if (candidate) {
    const targetOnly = a.candidateKind === 'target_only';
    lines.push('• Compare ' + (targetOnly ? 'target-only band ' : '') + band(candidate)
      + (candidate.days ? ' (' + candidate.days + '-day history)' : '') + ': about ' + rate(candidate)
      + (targetOnly && candidate.coversPreferredHistory === false ? '; it misses part of the observed price moves.' : '.'));
    if(a.candidateRoom)lines.push('  Room: '+agentNumber(a.candidateRoom.downPct,2)+'% down / '+agentNumber(a.candidateRoom.upPct,2)+'% up.'
      +(positive(a.targetShare)&&a.targetShare<1&&a.currentShare!==null?' Goal needs '+agentNumber(a.targetShare*100,2)+'% of pool rewards versus '+agentNumber(a.currentShare*100,2)+'% now.':''));
  }
  if(a.focus!=='reward_price'&&!g.targetOnlyRange&&!g.historicalChoice&&!g.current.reachesTarget&&g.maxDailyRewardAtCapitalUsd!==null&&target)
    lines.push('• Even the tightest usable band estimates ' + agentMoney(g.maxDailyRewardAtCapitalUsd) + '/day with this capital.');
  if (g.poolBudgetUsd < g.targetUsdPerDay || g.poolBudgetUsd === g.targetUsdPerDay && g.otherEligibleLiquidity > 0)
    lines.push('• The whole pool’s reward budget is about ' + agentMoney(g.poolBudgetUsd) + '/day; that target is unsupported at the current competition.');
  else if (!g.preferred && target) lines.push('• The history needed for a defensible ' + d.preferredDays + '-day range is incomplete.');
  if (a.focus !== 'reward_price' && a.reset) {
    const changed = a.reset.tokens.filter(row => Math.abs(row.deltaUsd) >= .01 && !['USDC', 'VBUSDC', 'USDT', 'VBUSDT', 'DAI', 'USDG'].includes(row.symbol.toUpperCase()));
    const mix = changed.map(row => (row.delta < 0 ? 'sell about ' : 'buy about ') + agentMoney(Math.abs(row.deltaUsd)) + ' of ' + row.symbol).join(' and ');
    lines.push('• Reset: ' + (mix || 'little change to the token mix')
      + (a.reset.costEstimateUsd === null ? '; gas is unverified, so cost recovery is unknown.'
        : '; roughly ' + agentMoney(a.reset.costEstimateUsd) + ' costs with a 0.5% slippage allowance'
          + (a.reset.staticPaybackDays !== null ? ', about ' + agentNumber(a.reset.staticPaybackDays, 1) + ' days of extra gross rewards to recover' : '; this band has no extra gross reward to recover costs') + '.')
      + ' Same capital before costs.');
    if(a.reset.reachesTargetAfterCosts===false)lines.push('  Paying that cost from this LP leaves about '+agentMoney(a.reset.grossUsdPerDayAfterCosts)+'/day; below the target at these inputs.');
  }
  if (a.recordedPace && a.focus !== 'reward_price') lines.push('• Recorded pace: ' + agentNumber(a.recordedPace.katPerDay, 1) + ' KAT/day over '
    + agentNumber(a.recordedPace.hours, 1) + ' hours, including any time out of range; separate from the current share estimate.');
  if (a.sensitivity) {
    const s = a.sensitivity, [down, , up] = s.scenarios;
    lines.push('• KAT price alone: −10% → ' + agentMoney(down.usdPerDay) + '/day; +10% → ' + agentMoney(up.usdPerDay) + '/day.'
      + (s.floorPriceUsd !== null ? ' Your ' + agentMoney(s.floorUsdPerDay) + '/day floor needs KAT around ' + agentPrice(s.floorPriceUsd) + ' or higher.'
        : s.targetPriceUsd !== null ? ' At the same reward pace, ' + target + ' needs KAT around ' + agentPrice(s.targetPriceUsd) + '.' : ''));
  }
  if (a.market.kat) lines.push('• Market: KAT ' + (a.market.kat.change24hPct >= 0 ? '+' : '') + agentNumber(a.market.kat.change24hPct, 1)
    + '% over approximately 24 hours from recorded pool prices.');
  if(d.learning?.message)lines.push('• Memory: '+d.learning.message);
  if(a.focus==='market'&&a.market.observedDay)lines.push('• Pool over roughly 24 hours: '+band(a.market.observedDay)
    +' ('+agentNumber(a.market.observedDay.spanPct,1)+'% price span). Past moves are a risk check, not a forecast.');
  if (!g.historicalChoice && g.capitalRequiredForPreferredUsd !== null && ['income','balanced'].includes(a.focus))
    lines.push('• The ' + g.preferred.days + '-day band needs about ' + agentMoney(g.capitalRequiredForPreferredUsd) + ' total LP capital for this rate; cash availability is not assumed.');
  lines.push('Recheck if price leaves ' + band(g.current) + ', KAT price/emissions/competition change, or before the campaign ends '
    + agentReadingTime(new Date(g.campaign.end * 1000).toISOString()) + (g.campaign.remainingDays < 1 ? ' (less than one full day remains).' : '.'));
  lines.push('Conditional gross KAT rewards, before transaction and borrowing costs; current-share rates assume staying in range.');
  if(g.periodAssumption==='daily')lines.unshift('Assuming you mean '+target+' in KAT rewards.');
  return lines.join('\n');
}
