/* Deterministic monitoring and measured range evidence. All percentages describe
   observed quotes/cases. Sampled containment is not continuous time in range. */
import { priceAtTick, liquidityForCapital } from '../strategy-core.mjs';
import { AUTO_LIMITS, autoFresh, autoHash } from './_agent-auto-state.mjs';
import { positionIdentity } from '../portfolio-core.mjs';
import { agentNumber, agentPrice, agentMoney, agentReadingTime } from '../agent-language.mjs';

const positive=n=>Number.isFinite(n)&&n>0;
export function trackedIdentity(p) { return positionIdentity({chain:p.chain,protocolContract:p.contract,positionId:String(p.positionId||p.id||''),owner:p.owner}); }
export function positionMarket(position, pool, now) {
  const raw=position.raw;
  if(!autoFresh(position.observedAt,now)||position.status!=='observed'||!raw||![raw.lowerTick,raw.upperTick].every(Number.isInteger)
    ||raw.lowerTick>=raw.upperTick||Math.max(Math.abs(raw.lowerTick),Math.abs(raw.upperTick))>887272)return null;
  const usable=pool&&autoFresh(pool.ts||pool.observedAt,now)&&['fresh','partial'].includes(pool.status)
    && (pool.chain||'katana')===position.chain && pool.pool?.toLowerCase()===position.pool?.toLowerCase()
    && [0,1].every(i=>pool['token'+i]?.address?.toLowerCase()===raw['token'+i]?.address?.toLowerCase()
      &&pool['token'+i]?.decimals===raw['token'+i]?.decimals);
  if(usable){const tick=pool.tick;
    if(!Number.isInteger(tick)||Math.abs(tick)>887272||!positive(pool.price)||!positive(pool.sqrtPrice))return null;
    return {...pool,...(pool.ratesObservedAt&&!autoFresh(pool.ratesObservedAt,now)
      ?{kat:null,katPerDay:null,fees:null,eligible:null}:{}),ts:pool.ts||pool.observedAt,chain:position.chain};}
  // The LP Book quote can support clearly scoped ratio monitoring even when a
  // dedicated V3 market adapter is unavailable (for example a V4 hook position).
  if(typeof raw.sqrtPriceX96!=='string'||!/^\d{1,78}$/.test(raw.sqrtPriceX96))return null;
  const sqrt=Number(raw.sqrtPriceX96)/2**96;
  if(!positive(sqrt)||![raw.token0?.decimals,raw.token1?.decimals].every(d=>Number.isInteger(d)&&d>=0&&d<=36))return null;
  const tick=Math.floor(Math.log(sqrt)*2/Math.log(1.0001)),ratio=sqrt**2*10**(raw.token0.decimals-raw.token1.decimals);
  if(Math.abs(tick)>887272||!positive(ratio))return null;
  return {chain:position.chain,pool:position.pool,status:'fresh',ts:position.observedAt,tick,sqrtPrice:sqrt,
    token0:raw.token0,token1:raw.token1,baseIndex:0,base:raw.token0.symbol,quote:raw.token1.symbol,price:ratio,
    tickSpacing:null,activeLiquidity:null,block:null,scope:'LP Book ratio quote; independent valuation block unavailable',recent:{}};
}
export function updatePoolHistory(previous={},market,now) {
  if(!market||!autoFresh(market.ts,now)||!positive(market.price))return previous;
  const at=Date.parse(market.ts),last=previous.last;
  if(last&&at<=Date.parse(last.ts))return previous;
  const point={ts:market.ts,price:market.price,tick:market.tick,liquidity:market.activeLiquidity??null,
    katPerDay:market.katPerDay??null,feeRate:market.fees?.usd_per_day??null,block:market.block??null};
  const samples=[...(previous.samples||[]).filter(sample=>Date.parse(sample.ts)<at),point].slice(-AUTO_LIMITS.poolSamples);
  const hour=Math.floor(at/3600000),hours=(previous.hours||[]).map(row=>({...row})),bucket=hours.at(-1);
  if(bucket?.hour===hour){bucket.low=Math.min(bucket.low,point.tick);bucket.high=Math.max(bucket.high,point.tick);bucket.lastAt=market.ts;bucket.count++;
    bucket.maxGapMs=Math.max(bucket.maxGapMs||0,last?at-Date.parse(last.ts):0);}
  else hours.push({hour,low:point.tick,high:point.tick,firstAt:market.ts,lastAt:market.ts,count:1,maxGapMs:last?at-Date.parse(last.ts):0,
    feeGrowth0:market.feeGrowth0??null,feeGrowth1:market.feeGrowth1??null,liquidity:market.activeLiquidity??null,block:point.block});
  return {schemaVersion:'agent-pool-history-v1',chain:market.chain||'katana',pool:market.pool,samplingIntervalMinutes:market.samplingIntervalMinutes||5,last:{...point,
    feeGrowth0:market.feeGrowth0??null,feeGrowth1:market.feeGrowth1??null},samples,hours:hours.slice(-AUTO_LIMITS.hours),
    basis:'Sampled observations at reported source times; gaps remain explicit.'};
}
export function observedFeeRate(history,market) {
  if(market.fees?.usd_per_day!=null)return market.fees;
  const at=Date.parse(market.ts),before=(history.hours||[]).findLast(row=>Date.parse(row.firstAt)<=at-86400000);
  const rows=(history.hours||[]).filter(row=>before&&row.hour>=before.hour);
  const cadence=history.samplingIntervalMinutes||5,maxGap=Math.max(900000,cadence*90000),minimum=Math.max(1,Math.floor(60/cadence/4));
  if(!before||rows.length<24||rows.some((row,index)=>row.maxGapMs>maxGap||(index!==rows.length-1&&row.count<minimum))
    ||!positive(market.activeLiquidity)||![market.token0?.usd,market.token1?.usd].every(n=>Number.isFinite(n)&&n>=0))return null;
  const elapsed=(at-Date.parse(before.firstAt))/1000;if(elapsed<86400||elapsed>90000)return null;
  try{const mod=1n<<256n,amounts=[0,1].map(i=>{
    const a=market['feeGrowth'+i],b=before['feeGrowth'+i];if(!/^\d{1,78}$/.test(a||'')||!/^\d{1,78}$/.test(b||''))throw Error();
    return Number((BigInt(a)-BigInt(b)+mod)%mod)/2**128*market.activeLiquidity/10**market['token'+i].decimals;
  });const usd=amounts[0]*market.token0.usd+amounts[1]*market.token1.usd;
    return Number.isFinite(usd)&&usd>=0?{usd_per_day:usd/elapsed*86400,window_days:elapsed/86400,
      basis:'24-hour fee-growth estimate at the observed active liquidity; liquidity is assumed constant within the interval.',
      start:before.firstAt,end:market.ts,sourceBlocks:[before.block??null,market.block??null]}:null;
  }catch{return null;}
}
export function rangeCandidates(market,history,now) {
  if(!market||!Number.isInteger(market.tickSpacing)||market.tickSpacing<1||market.tickSpacing>32767)return [];
  const spacing=market.tickSpacing,edge=Math.floor(887272/spacing)*spacing,out=[],cadence=history.samplingIntervalMinutes||5,
    maxGap=Math.max(900000,cadence*90000),minimum=Math.max(1,Math.floor(60/cadence/4));
  for(const days of [1,7,14,30]){
    const known=market.recent?.[days],hours=(history.hours||[]).filter(h=>h.hour>=Math.floor(now/3600000)-days*24);
    let lo,hi,basis;
    if(known?.complete===true&&Number.isInteger(known.lowTick)&&Number.isInteger(known.highTick)&&Math.max(Math.abs(known.lowTick),Math.abs(known.highTick))<=887272
      &&known.lowTick<=known.highTick&&Number.isSafeInteger(known.swaps)&&known.swaps>0){lo=known.lowTick;hi=known.highTick;basis='verified_swap_history';}
    else if(hours.length>=days*24&&hours[0].firstAt&&now-Date.parse(hours[0].firstAt)>=days*86400000
      &&hours.every((h,index)=>h.maxGapMs<=maxGap&&(index===0||index===hours.length-1||h.count>=minimum))) {lo=Math.min(...hours.map(h=>h.low));hi=Math.max(...hours.map(h=>h.high));basis='sampled_pool_quotes';}
    else continue;
    lo=Math.floor(Math.min(lo,market.tick)/spacing)*spacing;hi=(Math.floor(Math.max(hi,market.tick)/spacing)+1)*spacing;
    if(lo < -edge||hi>edge||hi<=lo)continue;
    const a=priceAtTick(lo,market),b=priceAtTick(hi,market);if(!positive(a)||!positive(b))continue;
    out.push({days,tickLower:lo,tickUpper:hi,lowerPrice:Math.min(a,b),upperPrice:Math.max(a,b),historyBasis:basis});
  }
  return out;
}
export function lpRisk(position,market,history,now) {
  if(!market||!autoFresh(market.ts,now))return {status:'unavailable',signals:[],reason:'Waiting for a verified current market quote.'};
  const lo=position.raw.lowerTick,hi=position.raw.upperTick,tick=market.tick,inRange=tick>=lo&&tick<hi;
  const edgePct=Math.min(tick-lo,hi-tick)/(hi-lo)*100;
  const cadence=history.samplingIntervalMinutes||5,window=Math.max(3600000,cadence*360000),maxGap=Math.max(900000,cadence*90000);
  const samples=(history.samples||[]).filter(p=>Date.parse(p.ts)>=now-window&&Date.parse(p.ts)<=now+30000);
  const intervals=samples.slice(1).map((p,i)=>({gap:Date.parse(p.ts)-Date.parse(samples[i].ts),move:Math.log(p.price/samples[i].price)}));
  const measured=intervals.length>=6&&samples.length&&now-Date.parse(samples[0].ts)>=window/2&&intervals.every(p=>p.gap>=60000&&p.gap<=maxGap);
  const volatility=measured?Math.sqrt(intervals.reduce((sum,p)=>sum+p.move*p.move,0))*100:null;
  const move=measured?(market.price/samples[0].price-1)*100:null,baseline=samples[0];
  const liquidityDrop=positive(baseline?.liquidity)&&Number.isFinite(market.activeLiquidity)?(1-market.activeLiquidity/baseline.liquidity)*100:null;
  const rewardDrop=positive(baseline?.katPerDay)&&Number.isFinite(market.katPerDay)?(1-market.katPerDay/baseline.katPerDay)*100:null;
  const signals=[];
  if(!inRange)signals.push({kind:'out_of_range',severity:'warning',message:'The current price is outside your LP range.',immediate:true});
  else if(edgePct<=AUTO_LIMITS.nearEdgePct)signals.push({kind:'near_edge',severity:'warning',message:'The price is within '+agentNumber(Math.max(0,edgePct),1)+'% of a range edge, measured against the band width.'});
  if(measured&&(volatility>=AUTO_LIMITS.hourlyVolatilityPct||Math.abs(move)>=AUTO_LIMITS.hourlyMovePct))signals.push({kind:'volatility',severity:'warning',
    message:'Recent sampled market volatility is '+agentNumber(volatility,1)+'%; the price moved '+agentNumber(move,1)+'% over '+Math.round((now-Date.parse(samples[0].ts))/60000)+' minutes.'});
  if(liquidityDrop>=AUTO_LIMITS.liquidityDropPct)signals.push({kind:'liquidity',severity:'warning',message:'Observed active pool liquidity fell '+agentNumber(liquidityDrop,1)+'%.'});
  if(rewardDrop>=AUTO_LIMITS.rewardDropPct)signals.push({kind:'rewards',severity:'warning',message:'Observed pool incentives fell '+agentNumber(rewardDrop,1)+'%.'});
  if(Number.isFinite(market.campaign?.end)&&market.campaign.end*1000<=now)signals.push({kind:'campaign',severity:'warning',message:'The recorded incentive campaign has ended.',immediate:true});
  return {status:signals.length?'watch':'steady',signals,inRange,edgePct,volatilityPct:volatility,priceMovePct:move,liquidityDropPct:liquidityDrop,rewardDropPct:rewardDrop,
    observedAt:market.ts,sampleCount:samples.length,volatilityBasis:'Realized log-return movement over sampled quotes, not an annualized forecast.'};
}
export function chooseAutomaticRange({position,market,history,risk,lessons={},policy,now}) {
  if(!market||!autoFresh(market.ts,now)||!market.base||!market.quote)return {status:'unavailable',candidates:[],selected:null,reason:'Waiting for verified current pool metadata.'};
  const candidates=rangeCandidates(market,history,now),constraints=policy?.status==='confirmed'?policy.constraints||{}:{};
  const allowed=(!Array.isArray(constraints.allowedAnalysisTypes)||constraints.allowedAnalysisTypes.includes('lp'))
    &&(!Array.isArray(constraints.eligibleAssets)||[market?.base,market?.quote].every(s=>constraints.eligibleAssets.some(t=>t.toUpperCase()===String(s).toUpperCase())));
  if(!allowed)return {status:'outside_policy',candidates:[],selected:null,reason:'Your saved asset or analysis limits exclude this range suggestion.'};
  const protocol=position.protocol|| (position.chain==='katana'?'Sushi V3':'Uniswap V3');
  const protocolKey=s=>s.toLowerCase().replace(/sushiswap/g,'sushi').replace(/[^a-z0-9]/g,'');
  if(Array.isArray(constraints.eligibleProtocols)&&!constraints.eligibleProtocols.some(p=>protocolKey(p)===protocolKey(protocol)))
    return {status:'outside_policy',candidates,selected:null,reason:'This LP protocol is outside your saved limits.'};
  const hasLearning=lessons.completedProposals>=3&&lessons.observations>=36;
  const highPressure=hasLearning&&lessons.outsideObservations/lessons.observations>.2;
  const cadence=constraints.reviewFrequencyDays??7,lookback=highPressure||risk?.status==='watch'?30:cadence<=1?7:cadence<=7?14:30;
  let selected=candidates.find(c=>c.days===lookback)||candidates.filter(c=>c.days>=7).at(-1)||candidates.at(-1)||null;
  const provisional=!!selected&&selected.days<lookback;
  if(selected&&(provisional||risk?.status==='watch')){
    const lo=Math.min(selected.tickLower,position.raw.lowerTick),hi=Math.max(selected.tickUpper,position.raw.upperTick);
    if(lo<selected.tickLower||hi>selected.tickUpper){const a=priceAtTick(lo,market),b=priceAtTick(hi,market);
      selected={...selected,tickLower:lo,tickUpper:hi,lowerPrice:Math.min(a,b),upperPrice:Math.max(a,b),includesCurrentRange:true};}
  }
  return {status:selected?'ready':'collecting_history',candidates,selected,preferredDays:lookback,
    provisional,reason:!selected?'Building a reliable pool history before suggesting a numeric band.':provisional
      ?'Early history supports a provisional comparison at least as wide as the current range; longer history is still being collected.':highPressure
      ?'Earlier recorded bands missed later sampled prices often enough to compare a wider historical band.'
      :risk?.status==='watch'?'Current market risk favors comparing a band that includes the current range and more observed price history.':'A historical band balances price room with liquidity concentration.',
    learningApplied:highPressure,learningBasis:'Prospective sampled containment; no realized-return or future-win-rate claim.',
    basis:policy?.status==='confirmed'?'confirmed_policy_and_observational_defaults':'observational_defaults',
    defaultHorizonDays:constraints.horizonDays??7};
}
export function renderPositionSuggestion(item,{compact=false}={}) {
  const p=item.position,risk=item.current===false?{status:'unavailable'}:item.risk,selected=item.current===false?null:item.range?.selected;
  const action=risk?.status==='unavailable'?'Waiting for a current reading':risk?.status==='watch'?'Monitor closely':'Keep monitoring';
  const reason=risk?.signals?.[0]?.message||item.range?.reason||'The latest checked price is inside your range.';
  const quoteUsd=item.market?.quoteUsd??item.market?.['token'+(1-item.market?.baseIndex)]?.usd;
  const quoted=value=>quoteUsd===1&&['USDC','VBUSDC','USDT','VBUSDT','USDG'].includes(String(item.market?.quote).toUpperCase())?agentPrice(value):agentNumber(value,6);
  const range=selected?'\n• Compare range: '+quoted(selected.lowerPrice)+'–'+quoted(selected.upperPrice)+' '+(item.market?.quote||'')
    +' ('+selected.days+'-day '+(selected.historyBasis==='verified_swap_history'?'price history':'sampled history')+').':'';
  return (p.pair||[p.raw?.token0?.symbol,p.raw?.token1?.symbol].filter(Boolean).join('/'))+' · '+p.chain+' #'+p.positionId
    +'\n• Suggestion: '+action+'.'+(compact?' ':'\n• Why: ')+reason+range
    +(item.comparisonSummary&&item.current!==false?'\n• Costs/cases: '+item.comparisonSummary
      +((item.comparison?.financingBasis||item.comparison?.result?.comparisonBasis)==='before_financing'?' Values are before borrowing costs.':''):'')
    +(compact?'':'\n• Next: '+(risk?.status==='unavailable'?'Retry the live reading.':'Check again in about '+(item.intervalMinutes||5)+' minutes.'));
}

export function renderAutomaticPortfolioBrief(latest) {
  const lines=['Your automatic portfolio check'];
  const loan=latest.loanAttention?.find(item=>item.severity==='critical')||latest.loanAttention?.[0];
  if(loan)lines.push('• Lending priority: '+loan.message.replace(/ Reading:.*$/,''));
  if(latest.lp)lines.push('• LPs: '+latest.lp.open+' open · '+agentMoney(latest.lp.value_usd)+' value · '
    +agentMoney(latest.lp.net_usd)+' net · '+agentMoney(latest.lp.unclaimed_usd)+' fees/rewards still to claim.');
  const positions=latest.positions||[],active=positions.filter(p=>p.current!==false&&p.risk?.status==='watch');
  if(active.length)lines.push('• Attention: '+active.length+' LP'+(active.length===1?' needs':'s need')+' a closer watch.');
  else lines.push('• Attention: '+(latest.lp&&positions.every(p=>p.current!==false)?'No new LP risk trigger in the verified readings.':'Waiting for a complete LP reading.'));
  const lesson=latest.portfolioLearning?.lessons?.find(row=>row.kind==='lending'&&row.trend==='falling')
    ||latest.portfolioLearning?.lessons?.find(row=>row.priority>=40);
  if(lesson)lines.push('• Recorded lesson: '+lesson.message);
  const ordered=[...positions].sort((a,b)=>Number(b.current!==false&&b.risk?.status==='watch')-Number(a.current!==false&&a.risk?.status==='watch')
    ||(a.risk?.edgePct??100)-(b.risk?.edgePct??100));
  const footer=[];
  if(latest.coverage?.truncated)footer.push('Market monitoring currently covers '+positions.length+' of '+latest.coverage.totalOpenPositions+' open LPs.');
  if(latest.status!=='ready')footer.push('Some sources are still being verified; retained values keep their original dates.');
  footer.push('Next check in about '+(latest.intervalMinutes||5)+' minutes.','Checked '+agentReadingTime(latest.checkedAt)+'.');
  let shown=0;
  for(const item of ordered){
    // Render every position that fits, rather than describing only the leading
    // LP. Reserve space for an explicit count if a large portfolio cannot fit.
    const available=3000-lines.join('\n').length-footer.join('\n').length-180;
    const alternatives=[renderPositionSuggestion(item,{compact:true}),
      renderPositionSuggestion({...item,comparisonSummary:null},{compact:true})];
    const text=alternatives.find(value=>value.length<=available);if(!text)break;
    lines.push('\n'+text);shown++;
  }
  if(shown<positions.length)lines.push('\nShowing '+shown+' of '+positions.length+' tracked LPs; all positions and recorded outcomes are available in Agent.');
  else if(positions.length)lines.push('\nDetails and recorded outcomes are available in Agent.');
  lines.push(...footer);
  return lines.join('\n');
}
