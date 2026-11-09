/* Fee-paying V3 analysis. Observed fee growth supports conditional share cases,
   never a promised fee yield or a KAT campaign on another chain. */
import { liquidityForCapital,amountsPerLiquidity,tickAtPrice } from '../strategy-core.mjs';
import { resetComparison } from './_agent-lp-advice.mjs';
import { agentMoney,agentNumber,agentPrice,agentReadingTime } from '../agent-language.mjs';
const positive=n=>Number.isFinite(n)&&n>0;

export function analyzeLPFees({data,pool,position,context,args,now}) {
  const current=data.currentRange,capital=position?.principalUsd,L=Number(position?.raw?.liquidity),active=pool.activeLiquidity;
  const summary={schemaVersion:'agent-fee-advice-v1',current:null,candidate:data.startingPoint,
    judgment:current?.inRange===false?'review_exit':data.learning?.ownerDeclined?'owner_declined':data.learning?.applied?'compare_wider':'keep_monitoring',
    feeRate:null,reset:null,targetUsdPerDay:args.dailyRewardTargetUsd??null,feeUnavailableReason:'A sufficiently complete fee-growth window is still being collected.',
    basis:'Historical price coverage and a conditional constant-volume/competing-liquidity fee scenario. No KAT campaign or guaranteed earnings.'};
  if(position?.feesMine!==true){summary.feeUnavailableReason=position?.chain==='katana'&&position?.feesMine===false
    ?'Staked Sushi trading fees belong to the DAO.' : 'Owner fee routing is not verified for this position.';return summary;}
  if(!current||!positive(capital)||!positive(L)||!positive(active)){summary.feeUnavailableReason='Current capital, owned liquidity or pool liquidity could not be reconciled.';return summary;}
  const units=amountsPerLiquidity(current.tickLower,current.tickUpper,pool.sqrtPrice,pool.token0.decimals,pool.token1.decimals);
  const value=L*(units.amount0*pool.token0.usd+units.amount1*pool.token1.usd);
  if(!positive(value)||Math.abs(value-capital)>Math.max(.02,capital*.005)){summary.feeUnavailableReason='The liquidity-derived value and LP Book capital need reconciling.';return summary;}
  const currentEligible=current.inRange?L:0;
  if(currentEligible>active*(1+1e-9)){summary.feeUnavailableReason='The owned liquidity exceeds the reported active liquidity; a new reading is needed.';return summary;}
  if(args.priceCase){
    const spec=args.priceCase,base=({WETH:'ETH',ETH:'ETH',vbETH:'ETH',WBTC:'BTC',vbWBTC:'BTC',BTC:'BTC'})[pool.base];
    if(spec.symbol===base&&Number.isFinite(spec.changePct)){
      const ratio=1+spec.changePct/100,price=data.price*ratio,tick=tickAtPrice(price,pool);
      if(Number.isFinite(tick)&&Math.abs(tick)<=887272){
        const sqrt=pool.sqrtPrice*(pool.baseIndex===0?Math.sqrt(ratio):1/Math.sqrt(ratio)),prices=[pool.token0.usd,pool.token1.usd];prices[pool.baseIndex]*=ratio;
        const next=amountsPerLiquidity(current.tickLower,current.tickUpper,sqrt,pool.token0.decimals,pool.token1.decimals);
        summary.priceCase={symbol:spec.symbol,changePct:spec.changePct,price,inRange:tick>=current.tickLower&&tick<current.tickUpper,
          principalUsd:L*(next.amount0*prices[0]+next.amount1*prices[1]),holdingUsd:L*(units.amount0*prices[0]+units.amount1*prices[1]),
          basis:'Only the base-token price changes; quote USD value stays fixed. Current-token holding benchmark; fees and costs excluded.'};
      }
    }
    if(!summary.priceCase)summary.priceCaseUnavailable=true;
  }
  const fees=pool.fees,valid=fees&&Number.isFinite(fees.usd_per_day)&&fees.usd_per_day>=0
    &&fees.window_days>=1&&fees.window_days<=1.05&&fees.start&&fees.end
    &&now-Date.parse(fees.end)>=-30000&&now-Date.parse(fees.end)<90000
    &&Array.isArray(fees.sourceBlocks)&&fees.sourceBlocks.every(Number.isSafeInteger);
  if(valid)summary.feeRate={poolUsdPerDay:fees.usd_per_day,windowDays:fees.window_days,start:fees.start,end:fees.end,
    sourceBlocks:fees.sourceBlocks,basis:fees.basis};
  summary.current={...current,feeUsdPerDay:valid?fees.usd_per_day*currentEligible/active:null};
  const candidate=summary.candidate;
  if(candidate){
    const liquidity=liquidityForCapital(capital,candidate.tickLower,candidate.tickUpper,pool)?.liquidity,others=Math.max(0,active-currentEligible);
    const rate=amount=>{const next=liquidityForCapital(amount,candidate.tickLower,candidate.tickUpper,pool)?.liquidity;
      return valid&&positive(next)&&others+next>0?fees.usd_per_day*next/(others+next):null;};
    summary.candidate={...candidate,feeUsdPerDay:positive(liquidity)?rate(capital):null};
    summary.reset=resetComparison({...current,usdPerDay:summary.current.feeUsdPerDay},candidate,pool,
      {capitalUsd:capital,otherEligibleLiquidity:others},context.lpAdviceFunding,position,now);
    if(summary.reset?.costEstimateUsd!==null&&summary.reset?.costEstimateUsd!==undefined&&capital>summary.reset.costEstimateUsd){
      summary.reset.feeUsdPerDayAfterCosts=rate(capital-summary.reset.costEstimateUsd);
      const gain=summary.reset.feeUsdPerDayAfterCosts-summary.current.feeUsdPerDay;
      summary.reset.staticPaybackDays=valid&&gain>0?summary.reset.costEstimateUsd/gain:null;
    }
  }
  const afterFees=summary.reset?.feeUsdPerDayAfterCosts;
  if(valid&&current.inRange&&summary.judgment==='keep_monitoring'&&Number.isFinite(afterFees)&&afterFees>summary.current.feeUsdPerDay*1.1
    &&summary.reset.staticPaybackDays!==null&&summary.reset.staticPaybackDays<=(data.horizonDays||7))summary.judgment='compare_fee_gain';
  if(summary.current.inRange&&data.currentRange&&Math.min((data.price-current.lowerPrice)/data.price,(current.upperPrice-data.price)/data.price)<.01)
    summary.judgment='watch_edge';
  if(Number.isFinite(summary.targetUsdPerDay)&&summary.current.feeUsdPerDay!==null)summary.reachesTarget=summary.current.feeUsdPerDay>=summary.targetUsdPerDay;
  return summary;
}

export function renderLPFees(d) {
  const a=d.feeAdvice,stable=['USDC','VBUSDC','USDT','VBUSDT','USDG','DAI'].includes(String(d.quote).toUpperCase())&&d.quoteUsd===1;
  const price=n=>stable?agentPrice(n):agentNumber(n,6)+' '+d.quote,band=b=>price(b.lowerPrice)+'–'+price(b.upperPrice);
  if(a.priceCaseUnavailable)return 'That price case does not match this fee-paying pool. Ask about '+d.base+' rising or falling by a percentage; KAT income assumptions do not apply to '+d.pair+'.';
  if(a.priceCase){const c=a.priceCase;return c.symbol+' '+(c.changePct>0?'+':'')+agentNumber(c.changePct,1)+'% puts this pool around '+price(c.price)+': '
    +(c.inRange?'your current LP stays in range.':'your current LP leaves its range; it stops earning new trading fees while outside.')
    +'\n• LP principal: '+agentMoney(c.principalUsd)+' versus '+agentMoney(c.holdingUsd)+' holding your current tokens. Fees and costs are excluded.'
    +'\nSuggestion: '+(c.inRange?'watch the remaining range buffer.':'review a replacement only after refreshing the market and costs.')
    +' Future volume and competing liquidity remain unknown.';}
  const lines=[d.pair+' on '+d.chain+': '+({review_exit:'review the range exit before deciding to reset.',watch_edge:'monitor the nearby range edge closely.',
    owner_declined:'I have kept your earlier rejection in mind; current risk facts are still shown.',compare_wider:'compare a wider band because earlier bands missed later prices.',
    compare_fee_gain:'compare the candidate’s conditional fee increase with its tighter-range risk and reset costs.',
    keep_monitoring:'keep monitoring; there is no verified fee benefit that by itself justifies a reset.'})[a.judgment]];
  if(!d.withinAssetPreferences&&!d.learning?.ownerDeclined)lines.push('This pool is outside your saved asset/protocol limits; a new range suggestion is withheld.');
  if(d.currentRange)lines.push('• Current range: '+band(d.currentRange)+'. Price '+price(d.price)+'; '+(d.currentRange.inRange?'inside the band.':'outside the band.'));
  if(d.currentRange?.inRange)lines.push('• Room: '+agentNumber((d.price-d.currentRange.lowerPrice)/d.price*100,2)+'% down / '
    +agentNumber((d.currentRange.upperPrice-d.price)/d.price*100,2)+'% up.');
  if(a.current?.feeUsdPerDay!==null&&a.current?.feeUsdPerDay!==undefined)lines.push('• Current fee-rate scenario: '+agentMoney(a.current.feeUsdPerDay)
    +'/day from the recorded 24-hour fee-growth window'+(a.targetUsdPerDay!==null?' versus your '+agentMoney(a.targetUsdPerDay)+'/day goal':'')+'.');
  else lines.push('• Daily fees: '+a.feeUnavailableReason+' I cannot price the income goal yet.');
  if(a.candidate)lines.push('• Compare '+band(a.candidate)+' ('+a.candidate.days+'-day '+(a.candidate.historyBasis==='sampled_pool_quotes'?'sampled prices':'price history')+')'
    +(Number.isFinite(a.candidate.feeUsdPerDay)?': '+agentMoney(a.candidate.feeUsdPerDay)+'/day in the same volume/share scenario.':'.'));
  else lines.push('• New range: more covered price history is needed; I can still monitor your current boundaries.');
  if(a.candidate?.provisional)lines.push('  This is an early comparison at least as wide as your current range; longer history is still building.');
  if(a.reset){const tokens=a.reset.tokens.filter(row=>Math.abs(row.deltaUsd)>=.01&&!['USDC','VBUSDC','USDG','USDT','DAI'].includes(row.symbol.toUpperCase()));
    const mix=tokens.map(row=>(row.delta>0?'buy ':'sell ')+agentMoney(Math.abs(row.deltaUsd))+' of '+row.symbol).join(' and ');
    lines.push('• Reset: '+(mix||'little token-mix change')+(a.reset.costEstimateUsd===null?'; gas/cost recovery still needs verification.':'; about '
      +agentMoney(a.reset.costEstimateUsd)+' with a 0.5% slippage allowance.' ));
    if(a.reset.staticPaybackDays!==null)lines.push('  About '+agentNumber(a.reset.staticPaybackDays,1)+' days of additional fees to recover this cost in the same scenario.');}
  if(d.learning?.message)lines.push('• Memory: '+d.learning.message);
  lines.push('Suggestion: '+(a.judgment==='review_exit'?'refresh fees, price and costs before choosing a replacement band.':'review again at a range edge or after a material fee/volatility change.')
    +' Fee cases assume stable volume and competing liquidity, before transaction and borrowing costs.');
  lines.push('Checked '+agentReadingTime(d.poolObservation.observedAt)+'.');return lines.join('\n');
}
