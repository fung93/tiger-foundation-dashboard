/* Read-only conditional scenarios. No model arithmetic, execution, probabilities,
   inferred risk mandate or extrapolation of carry rewards/short observed APR. */
import { createHash } from 'node:crypto';
import { targetMetrics, debtAssets, liquidationMetrics } from '../morpho-core.mjs';
import { orientation, priceAtTick, tickAtPrice, snapRange, amountsPerLiquidity,
  liquidityForCapital } from '../strategy-core.mjs';
import { runAgentTool } from './_agent-tools.mjs';
import { httpError } from './_agent-http.mjs';
import { agentMoney, agentNumber, agentReadingTime, friendlyAgentNotes } from '../agent-language.mjs';
import { renderLPComparisonSummary } from '../agent-lp-summary.mjs';

export const AGENT_SCENARIO_SCHEMA = 'agent-scenarios-v1';
const DAY = 86400000, WAD = 10n ** 18n, ORACLE = 10n ** 36n;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ceil = (a,b) => (a+b-1n)/b;
const finite = (n,lo=0,hi=1e12) => typeof n==='number'&&Number.isFinite(n)&&n>=lo&&n<=hi;
const current = (ts,now) => Number.isFinite(Date.parse(ts))&&now-Date.parse(ts)>=-30000&&now-Date.parse(ts)<90000;
const usd = n => Number.isFinite(n)?'$'+n.toFixed(2):'unavailable';
const known = (x, keys) => x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const bad = () => httpError(400,'Choose valid scenario inputs and explicit assumptions.');
export function validateAgentComparison(input) {
  const keys=['kind','horizonDays','market','targetHealth','annualRatePct','cashUsd','gasUsd','oracleMovesPct',
    'positionId','chain','owner','widenFactor','lowerPrice','upperPrice','swapFeeBps',
    'slippageBps','borrowingCostUsd','rewardPriceUsd','competingLiquidityMultiplier','rewardEligible','paths',
    'thesis','catalysts','invalidationConditions','reviewAt','evidenceIds','useObservedRates','katAmount','katPriceUsd','comparisonBasis'];
  if(!known(input,keys)||!['lending','lp','kat'].includes(input.kind)
    ||!Number.isInteger(input.horizonDays)||input.horizonDays<1||input.horizonDays>365)throw bad();
  for(const k of ['cashUsd','gasUsd','borrowingCostUsd','rewardPriceUsd','katAmount','katPriceUsd'])
    if(input[k]!=null&&!finite(input[k]))throw bad();
  if(input.comparisonBasis!=null&&(input.kind!=='lp'||input.comparisonBasis!=='before_financing'||input.borrowingCostUsd!==0))throw bad();
  for(const k of ['annualRatePct','swapFeeBps','slippageBps'])if(input[k]!=null&&!finite(input[k],0,1000))throw bad();
  if(input.targetHealth!=null&&!finite(input.targetHealth,1,100))throw bad();
  if(input.competingLiquidityMultiplier!=null&&!finite(input.competingLiquidityMultiplier,.01,100))throw bad();
  if(input.widenFactor!=null&&!finite(input.widenFactor,1.01,10))throw bad();
  for(const k of ['lowerPrice','upperPrice'])if(input[k]!=null&&!finite(input[k],Number.MIN_VALUE))throw bad();
  for(const k of ['market','positionId','chain','owner'])if(input[k]!=null&&(typeof input[k]!=='string'||!input[k]||input[k].length>400))throw bad();
  if(input.rewardEligible!=null&&typeof input.rewardEligible!=='boolean')throw bad();
  if(input.useObservedRates!=null&&typeof input.useObservedRates!=='boolean')throw bad();
  if(input.oracleMovesPct!=null&&(!Array.isArray(input.oracleMovesPct)||!input.oracleMovesPct.length||input.oracleMovesPct.length>8
    ||input.oracleMovesPct.some(n=>!finite(n,-95,500))))throw bad();
  if(input.paths!=null&&(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>8))throw bad();
  for(const path of input.paths||[]){
    if(!known(path,['label','points','rewardFactor','rewardPriceUsd'])||typeof path.label!=='string'||path.label.length>80
      ||!Array.isArray(path.points)||path.points.length<2||path.points.length>32)throw bad();
    let previous=-1;
    for(const point of path.points){if(!known(point,['day','ratio'])||!finite(point.day,0,input.horizonDays)
      ||!finite(point.ratio,.05,6)||point.day<=previous)throw bad();previous=point.day;}
    if(path.points[0].day!==0||path.points[0].ratio!==1||path.points.at(-1).day!==input.horizonDays)throw bad();
    if(path.rewardFactor!=null&&!finite(path.rewardFactor,0,3))throw bad();
    if(path.rewardPriceUsd!=null&&!finite(path.rewardPriceUsd))throw bad();
  }
  for(const key of ['thesis'])if(input[key]!=null&&(typeof input[key]!=='string'||input[key].length>2000))throw bad();
  for(const key of ['catalysts','invalidationConditions','evidenceIds'])if(input[key]!=null&&(!Array.isArray(input[key])
    ||input[key].length>12||input[key].some(x=>typeof x!=='string'||!x||x.length>500)))throw bad();
  if(input.reviewAt!=null&&(!Number.isFinite(Date.parse(input.reviewAt))||typeof input.reviewAt!=='string'))throw bad();
  return input;
}
function policyChecks(context,policy,input,cashRequired=0,market=null){
  const p=policy?.constraints||{}, checks=[];
  checks.push({field:'confirmedPolicy',status:policy?.status==='confirmed'?'pass':'unknown'});
  checks.push({field:'allocationCoverage',status:context.snapshot?.allocationBlocked===false?'pass':'unknown'});
  checks.push({field:'liquidCash',status:input.cashUsd==null?'unknown':input.cashUsd>=cashRequired?'pass':'fail',cashRequiredUsd:cashRequired});
  checks.push({field:'minimumLiquidReserve',status:p.minLiquidReserveUsd==null||input.cashUsd==null?'unknown'
    :input.cashUsd-cashRequired>=p.minLiquidReserveUsd?'pass':'fail'});
  if(p.horizonDays!=null)checks.push({field:'horizon',status:input.horizonDays<=p.horizonDays?'pass':'fail'});
  if(Array.isArray(p.allowedAnalysisTypes))checks.push({field:'allowedAnalysisTypes',status:p.allowedAnalysisTypes.includes(input.kind)||p.allowedAnalysisTypes.includes('strategy')?'pass':'fail'});
  const ids=items=>(items||[]).map(value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,''));
  const assets=market?.assets||[market?.collateral_token,market?.loan_token].filter(Boolean);
  checks.push({field:'eligibleAssets',status:!Array.isArray(p.eligibleAssets)||!assets.length?'unknown'
    :assets.every(asset=>ids(p.eligibleAssets).includes(ids([asset])[0]))?'pass':'fail'});
  const protocol=market?.protocol||(market?.key?'Morpho':null);
  checks.push({field:'eligibleProtocols',status:!Array.isArray(p.eligibleProtocols)||!protocol?'unknown'
    :ids(p.eligibleProtocols).includes(ids([protocol])[0])?'pass':'fail'});
  checks.push({field:'exposureLimits',status:p.exposureLimits&&Object.keys(p.exposureLimits).length===0?'pass':'unknown'});
  if(market){
    const m=p.marketLimits?.[market.key];
    if(m?.targetHealth!=null)checks.push({field:'marketTargetHealth',status:input.targetHealth>=m.targetHealth?'pass':'fail'});
    if(m?.maxLtvPct!=null)checks.push({field:'marketLtv',status:market.lltv/input.targetHealth*100<=m.maxLtvPct?'pass':'fail'});
  }
  return checks;
}
function finalize(context,policy,input,detail,now){
  const body={schemaVersion:AGENT_SCENARIO_SCHEMA,kind:input.kind,horizonDays:input.horizonDays,
    snapshotId:context.snapshot?.snapshotId||detail.sourceSnapshotId||null,policyVersion:policy?.version||0,
    observedAt:detail.observedAt||null,validUntil:detail.validUntil||null,status:detail.status,
    assumptions:detail.assumptions||[],limitations:detail.limitations||[],options:detail.options||[],
    scenarios:detail.scenarios||[],calculationIds:detail.calculationIds||[],calculations:detail.calculations||[],
    capitalBaseUsd:detail.capitalBaseUsd??null,paperBaseline:detail.paperBaseline||null,thesis:input.thesis||null,catalysts:input.catalysts||[],
    ...(input.comparisonBasis?{comparisonBasis:input.comparisonBasis}:{}),
    evidenceIds:input.evidenceIds||[],invalidationConditions:input.invalidationConditions||[],reviewAt:input.reviewAt||null,
    scope:'Conditional paper scenarios; no probability, forecast, trade or automatic recommendation.',
    createdAt:new Date(now).toISOString()};
  return {...body,calculationId:'scenario:'+hash({input,...body})};
}
const review=()=>({id:'maintain_review',label:'Maintain and review',status:'informational',cashRequiredUsd:0,
  outcomes:[],limitations:['This is a review option, not a claim that maintaining the risk is safe.']});
async function lending(context,policy,input,now){
  const risk=await runAgentTool('getLendingRisk',input.market?{market:input.market}:{},{context,policy,now});
  const options=[review()], base={options,scenarios:[],calculationIds:[risk.calculationId],calculations:[risk],observedAt:risk.observedAt,validUntil:risk.validUntil,
    assumptions:['Interest is projected by the owner-supplied simple annual rate; it is not an observed future rate.',
      'Oracle shocks change the collateral-to-loan oracle variable with fixed positions.','A common USD price move on both avKAT and KAT does not change their oracle ratio.'],limitations:[]};
  const row=context.lending?.markets?.find(r=>[r.id,r.key,r.label].includes(input.market));
  if(risk.status==='blocked'||!row||!row.raw||!finite(row.loan_usd,Number.MIN_VALUE)||!finite(row.collateral_price_usd,Number.MIN_VALUE)
    ||input.targetHealth==null||input.annualRatePct==null||!input.oracleMovesPct?.length||input.cashUsd==null||input.gasUsd==null)
    return {...base,status:'blocked',limitations:['Fresh accrued market data, a target, horizon, interest rate, oracle cases, cash and transaction-cost assumptions are required.']};
  const target=await runAgentTool('calculateTargetHealth',{market:row.key,targetHealth:input.targetHealth},{context,policy,now});
  if(target.status==='blocked')return {...base,status:'blocked',limitations:target.limitations};
  base.calculationIds.push(target.calculationId);
  base.calculations.push(target);
  const r=row.raw, collateral=BigInt(r.collateral), debt=BigInt(r.debt), price=BigInt(r.oracle_price), lltv=BigInt(r.lltv);
  const targetWad=BigInt(Math.ceil(input.targetHealth*1e6))*10n**12n;
  const desiredOracle=ceil(ceil(debt*targetWad,WAD)*WAD,lltv);
  const requiredCollateral=ceil(desiredOracle*ORACLE,price);
  const extra=requiredCollateral>collateral?requiredCollateral-collateral:0n;
  const scale=n=>Number(n)/10**row.loan_decimals, collScale=n=>Number(n)/10**row.collateral_decimals;
  const rateDenominator=36500n*1000000n;
  const rateNumerator=rateDenominator+BigInt(Math.ceil(input.annualRatePct*1e6))*BigInt(input.horizonDays);
  // Preserve Morpho's virtual-share rounding when changing the debt before projection.
  const repay=BigInt(target.data.repay_raw||0), A=BigInt(r.total_borrow_assets), S=BigInt(r.total_borrow_shares), b=BigInt(r.borrow_shares);
  let lo=0n,hi=b;
  const limit=BigInt(target.data.target_debt_raw||r.debt);
  while(lo<hi){const mid=(lo+hi+1n)/2n;if(debtAssets(mid,A,S)<=limit)lo=mid;else hi=mid-1n;}
  const variants=[{id:'maintain',label:'Maintain debt',collateral,debt,cash:0},
    {id:'reduce_debt',label:'Reduce debt to current target',collateral,
      debt:debtAssets(lo,A-repay,S-(b-lo)),cash:repay>0n?scale(repay)*row.loan_usd+input.gasUsd:0},
    {id:'add_collateral',label:'Add collateral to current target',collateral:collateral+extra,debt,
      cash:extra>0n?collScale(extra)*row.collateral_price_usd+input.gasUsd:0}];
  for(const v of variants){
    const out={id:v.id,label:v.label,status:'conditional',cashRequiredUsd:v.cash,repayRaw:v.id==='reduce_debt'?String(repay):'0',
      collateralAddedRaw:v.id==='add_collateral'?String(extra):'0',policyChecks:policyChecks(context,policy,input,v.cash,row),outcomes:[],limitations:[]};
    for(const move of input.oracleMovesPct){
      const px=price*BigInt(Math.round((1+move/100)*1e6))/1000000n, projected=ceil(v.debt*rateNumerator,rateDenominator);
      const oracleValue=v.collateral*px/ORACLE, liquidation=oracleValue*lltv/WAD;
      const health=projected===0n?null:Number(liquidation)/Number(projected),ltv=oracleValue===0n?null:Number(projected)/Number(oracleValue);
      out.outcomes.push({oracleMovePct:move,oracleVariable:row.loan_token==='KAT'?'avKAT/KAT ratio':'collateral/loan oracle',
        projectedDebtRaw:String(projected),projectedDebtAmount:scale(projected),loanToken:row.loan_token,collateralRaw:String(v.collateral),health,ltv,
        liquidatable:projected>liquidation,remainingCashUsd:input.cashUsd-v.cash,
        policyHealthPass:policy?.constraints?.marketLimits?.[row.key]?.targetHealth==null?null:health===null||health>=policy.constraints.marketLimits[row.key].targetHealth,
        policyLtvPass:policy?.constraints?.marketLimits?.[row.key]?.maxLtvPct==null?null:ltv!==null&&ltv*100<=policy.constraints.marketLimits[row.key].maxLtvPct});
    }
    if(out.policyChecks.some(c=>c.status==='fail')||out.outcomes.some(c=>c.policyHealthPass===false||c.policyLtvPass===false))out.status='outside_policy';
    options.push(out);
  }
  base.capitalBaseUsd=row.collateral_amount*row.collateral_price_usd-row.debt_usd+input.cashUsd;
  return {...base,status:policyChecks(context,policy,input).some(c=>c.status!=='pass')?'partial':'ready',
    limitations:context.snapshot?.allocationBlocked!==false?['Portfolio coverage/cash availability is not fully reconciled; these are informational scenarios, not allocation sizing.']:[]};
}

function daysInRange(points,lower,upper,toDay){
  let days=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],end=Math.min(b.day,toDay);if(end<=a.day)continue;
    const duration=end-a.day, delta=(b.ratio-a.ratio)/(b.day-a.day)*duration;
    if(delta===0){if(a.ratio>=lower&&a.ratio<upper)days+=duration;continue;}
    const x=(lower-a.ratio)/delta,y=(upper-a.ratio)/delta;
    days+=duration*Math.max(0,Math.min(1,Math.max(x,y))-Math.max(0,Math.min(x,y)));
  }
  return days;
}
async function lp(context,policy,input,now){
  const args={positionId:input.positionId,...(input.chain?{chain:input.chain}:{}),...(input.owner?{owner:input.owner}:{})};
  if(!input.positionId)return {status:'blocked',options:[review()],limitations:['Choose an identified LP position.']};
  const source=await runAgentTool('getLPPosition',args,{context,policy,now}),p=source.data;
  const base={options:[review()],scenarios:[],calculationIds:[source.calculationId],calculations:[source],observedAt:source.observedAt,validUntil:source.validUntil,
    assumptions:['Each option starts with the same LP principal and the same owner-declared cash reserve.',
      'Price is linear between explicit path points; the quote token keeps its observed USD price.',
      'Observed pool rates and competing liquidity are conditional assumptions, not future facts.',
      'Existing accrued/carried rewards are common pre-existing assets, excluded from projected new earnings.',
      'Terminal LP valuation already includes divergence from holding; no second impermanent-loss subtraction is made.'],limitations:[...(source.limitations||[])]};
  const pool=[...(context.strategy?.pools||[]),...(context.strategy?.fee_pools||[])].find(row=>row.pool?.toLowerCase()===p.pool?.toLowerCase()&&(row.chain||'katana')===p.chain);
  if(source.status==='blocked'||!pool||pool.status!=='fresh'||!current(pool.ts,now)||!p.raw||!finite(p.principalUsd,Number.MIN_VALUE)
    ||!Number.isInteger(p.raw.lowerTick)||!Number.isInteger(p.raw.upperTick)||!input.paths?.length||input.cashUsd==null)
    return {...base,status:'blocked',limitations:[...base.limitations,'Fresh identified LP/pool metadata, cash and explicit price paths are required.']};
  if(![pool.token0?.usd,pool.token1?.usd,pool.sqrtPrice].every(x=>finite(x,Number.MIN_VALUE))
    ||typeof p.raw.liquidity!=='string'||!/^\d{1,78}$/.test(p.raw.liquidity))return {...base,status:'blocked',limitations:['Token prices or raw LP liquidity are unavailable.']};
  const L=Number(BigInt(p.raw.liquidity)), d0=pool.token0.decimals,d1=pool.token1.decimals,C=p.principalUsd;
  if(p.raw.token0?.address?.toLowerCase()!==pool.token0.address?.toLowerCase()
    ||p.raw.token1?.address?.toLowerCase()!==pool.token1.address?.toLowerCase()
    ||p.raw.token0?.decimals!==d0||p.raw.token1?.decimals!==d1)
    return {...base,status:'blocked',limitations:['LP and pool token identities/units do not match.']};
  const units=amountsPerLiquidity(p.raw.lowerTick,p.raw.upperTick,pool.sqrtPrice,d0,d1);
  const initial={amount0:L*units.amount0,amount1:L*units.amount1};
  const checked=initial.amount0*pool.token0.usd+initial.amount1*pool.token1.usd;
  if(!finite(L,Number.MIN_VALUE,1e80)||Math.abs(checked-C)>Math.max(.02,C*.005))
    return {...base,status:'blocked',limitations:['LP principal and pool token valuation do not reconcile; no range sizing is available.']};
  base.capitalBaseUsd=C+input.cashUsd;
  base.paperBaseline={pool:pool.pool,chain:p.chain,token0:pool.token0,token1:pool.token1,initialAmounts:initial,cashUsd:input.cashUsd};
  const ownRange={tickLower:p.raw.lowerTick,tickUpper:p.raw.upperTick,
    lowerPrice:Math.min(priceAtTick(p.raw.lowerTick,pool),priceAtTick(p.raw.upperTick,pool)),
    upperPrice:Math.max(priceAtTick(p.raw.lowerTick,pool),priceAtTick(p.raw.upperTick,pool))};
  const lpProtocol=p.chain==='katana'?'Sushi V3':'Uniswap V3';
  const ranges=[{id:'maintain',label:'Keep current range',range:ownRange,liquidity:L,deposit:initial,cost:0}];
  const addRange=(id,label,lower,upper)=>{
    if(!finite(lower,Number.MIN_VALUE)||!finite(upper,Number.MIN_VALUE)||input.gasUsd==null||input.swapFeeBps==null||input.slippageBps==null){
      base.options.push({id,label,status:'blocked',outcomes:[],limitations:['Range, gas, swap-fee and slippage assumptions are required.']});return;}
    const range=snapRange(lower,upper,pool),pos=!range.error&&liquidityForCapital(C,range.tickLower,range.tickUpper,pool);
    if(!pos){base.options.push({id,label,status:'blocked',outcomes:[],limitations:['The requested range cannot be valued.']});return;}
    const swapNotional=Math.abs(pos.amount0-initial.amount0)*pool.token0.usd;
    const cost=input.gasUsd+swapNotional*(input.swapFeeBps+input.slippageBps)/10000;
    ranges.push({id,label,range,liquidity:pos.liquidity,deposit:pos,cost,swapNotionalUsd:swapNotional});
  };
  if(input.widenFactor!=null)addRange('widen','Widen range',pool.price-(pool.price-ownRange.lowerPrice)*input.widenFactor,
    pool.price+(ownRange.upperPrice-pool.price)*input.widenFactor);
  else base.options.push({id:'widen',label:'Widen range',status:'blocked',outcomes:[],limitations:['Choose an explicit widening factor.']});
  addRange('reposition','Reposition range',input.lowerPrice,input.upperPrice);
  const hold={id:'hold',label:'Hold underlying tokens',status:input.gasUsd==null?'blocked':'conditional',cashRequiredUsd:input.gasUsd??null,
    policyChecks:policyChecks(context,policy,input,input.gasUsd||0,{assets:[pool.token0.symbol,pool.token1.symbol],protocol:lpProtocol}),outcomes:[],limitations:input.gasUsd==null?['Closing gas cost is required.']:[]};
  if(hold.status!=='blocked'&&hold.policyChecks.some(check=>check.status==='fail'))hold.status='outside_policy';
  const baseSide=orientation(pool).base,quoteUsd=baseSide===0?pool.token1.usd:pool.token0.usd;
  for(const path of input.paths){
    const terminalRatio=path.points.at(-1).ratio,quoted=pool.price*terminalRatio;
    const prices=baseSide===0?[quoted*quoteUsd,quoteUsd]:[quoteUsd,quoted*quoteUsd];
    const benchmark=initial.amount0*prices[0]+initial.amount1*prices[1];
    base.scenarios.push({id:path.label,path:path.points,rewardFactor:path.rewardFactor??1,
      rewardPriceUsd:path.rewardPriceUsd??input.rewardPriceUsd,holdBenchmarkUsd:benchmark+input.cashUsd});
    if(hold.status!=='blocked')hold.outcomes.push({scenario:path.label,terminalAmounts:initial,principalUsd:benchmark,
      newFeesUsd:0,newRewardsKat:0,newRewardsUsd:0,costUsd:input.gasUsd,netUsd:benchmark+input.cashUsd-input.gasUsd,
      differenceFromHoldUsd:-input.gasUsd});
  }
  base.options.push(hold);
  for(const option of ranges){
    const out={id:option.id,label:option.label,status:'conditional',cashRequiredUsd:option.cost,range:option.range,
      initialCapitalUsd:C,initialLiquidity:option.liquidity,swapNotionalUsd:option.swapNotionalUsd||0,
      policyChecks:policyChecks(context,policy,input,option.cost,{assets:[pool.token0.symbol,pool.token1.symbol],protocol:lpProtocol}),outcomes:[],limitations:[]};
    for(const path of input.paths){
      const last=pool.price*path.points.at(-1).ratio,tick=tickAtPrice(last,pool);
      if(!Number.isFinite(tick)||Math.abs(tick)>887272)throw bad();
      const amount=amountsPerLiquidity(option.range.tickLower,option.range.tickUpper,Math.pow(1.0001,tick/2),d0,d1);
      const terminalAmounts={amount0:amount.amount0*option.liquidity,amount1:amount.amount1*option.liquidity};
      const prices=baseSide===0?[last*quoteUsd,quoteUsd]:[quoteUsd,last*quoteUsd];
      const principal=terminalAmounts.amount0*prices[0]+terminalAmounts.amount1*prices[1];
      const inDays=daysInRange(path.points,option.range.lowerPrice/pool.price,option.range.upperPrice/pool.price,input.horizonDays);
      let rewardKat=0,fees=0,earningsKnown=p.feesMine===false||p.feesMine===true;
      if(pool.kind==='rewards'&&option.id==='maintain'&&typeof p.staked!=='boolean')earningsKnown=false;
      const routedToDao=pool.kind==='rewards'&&(p.staked===true||(option.id!=='maintain'&&input.rewardEligible===true));
      if(p.feesMine===true&&!routedToDao){
        if(input.useObservedRates!==true||!finite(pool.fees?.usd_per_day)||!finite(input.competingLiquidityMultiplier,Number.MIN_VALUE))earningsKnown=false;
        else{const other=Math.max(0,pool.activeLiquidity-(p.inRange?L:0))*input.competingLiquidityMultiplier;
          fees=pool.fees.usd_per_day*option.liquidity/(other+option.liquidity)*inDays;}
      }
      const wantsRewards=pool.kind==='rewards'&&(option.id!=='maintain'||p.staked===true);
      if(wantsRewards){
        if(input.rewardEligible==null)earningsKnown=false;
        else if(input.rewardEligible){
          if(input.useObservedRates!==true||!finite(input.competingLiquidityMultiplier,Number.MIN_VALUE)
            ||!finite(pool.eligible?.liquidity,0,1e100)||pool.rules?.weightFees!==10000||pool.rules?.weightToken0!==0||pool.rules?.weightToken1!==0
            ||pool.rules?.outOfRange!==false||!finite(pool.katPerDay)||!finite(pool.campaign?.end))earningsKnown=false;
          else{const ends=Math.max(0,Math.min(input.horizonDays,(pool.campaign.end-now/1000)/86400));
            const days=daysInRange(path.points,option.range.lowerPrice/pool.price,option.range.upperPrice/pool.price,ends);
            const other=Math.max(0,pool.eligible.liquidity-(p.inRange&&p.staked?L:0))*input.competingLiquidityMultiplier;
            rewardKat=pool.katPerDay*option.liquidity/(other+option.liquidity)*days*(path.rewardFactor??1);}
        }
      }
      const rewardPrice=path.rewardPriceUsd??input.rewardPriceUsd;
      if(rewardKat>0&&rewardPrice==null)earningsKnown=false;
      const rewardUsd=rewardKat===0?0:rewardKat*rewardPrice;
      if(input.borrowingCostUsd==null)earningsKnown=false;
      const cost=option.cost+(input.borrowingCostUsd||0),holdValue=initial.amount0*prices[0]+initial.amount1*prices[1]+input.cashUsd;
      out.outcomes.push({scenario:path.label,terminalAmounts,principalUsd:principal,timeInRangeDays:inDays,
        newFeesUsd:earningsKnown?fees:null,newRewardsKat:earningsKnown?rewardKat:null,newRewardsUsd:earningsKnown?rewardUsd:null,
        costUsd:cost,netUsd:earningsKnown?principal+input.cashUsd+fees+rewardUsd-cost:null,
        differenceFromHoldUsd:earningsKnown?principal+input.cashUsd+fees+rewardUsd-cost-holdValue:null});
      if(!earningsKnown)out.limitations.push('Fee routing, borrowing costs or explicit eligible reward/price/rate assumptions are incomplete.');
    }
    if(out.policyChecks.some(check=>check.status==='fail'))out.status='outside_policy';
    else if(out.outcomes.some(outcome=>outcome.netUsd===null))out.status='partial';
    base.options.push(out);
  }
  base.limitations.push('Pool path liquidity and fee rates are assumed static except for the explicit competing-liquidity multiplier.',
    'No probability or future win rate is inferred. No recommendation is issued from incomplete portfolio/pinning coverage.');
  return {...base,status:base.limitations.length||base.options.some(o=>['blocked','partial'].includes(o.status))?'partial':'ready'};
}
export async function compareAgentStrategies({context={},policy=context.policy,input,now=Date.now}={}){
  validateAgentComparison(input);const at=typeof now==='function'?now():now;
  if(!Number.isSafeInteger(at)||at<=0)throw bad();
  let detail;
  if(input.kind==='lending')detail=await lending(context,policy,input,at);
  else if(input.kind==='lp')detail=await lp(context,policy,input,at);
  else{
    const exposure=await runAgentTool('getKATExposure',{},{context,policy,now:at});
    detail={status:'partial',options:[review()],scenarios:[],calculationIds:[exposure.calculationId],calculations:[exposure],
      observedAt:exposure.observedAt,validUntil:exposure.validUntil,limitations:[...exposure.limitations,
        'KAT allocation choices need reconciled holdings, confirmed policy, eligible assets and actual liquidity.'],
      assumptions:['A thesis is a prospective owner hypothesis; it is not historical performance.']};
    detail.options[0].exposure=exposure.data;
    if(exposure.status==='ready'&&finite(exposure.data.completeExposureKat)&&finite(exposure.data.liquidKat)
      &&finite(input.katAmount,Number.MIN_VALUE)&&finite(input.katPriceUsd,Number.MIN_VALUE)
      &&input.cashUsd!=null&&input.gasUsd!=null&&input.swapFeeBps!=null&&input.slippageBps!=null){
      const amount=input.katAmount,notional=amount*input.katPriceUsd,
        cost=input.gasUsd+notional*(input.swapFeeBps+input.slippageBps)/10000;
      const checks=policyChecks(context,policy,input,cost,{assets:['KAT'],protocol:'Wallet spot conversion'});
      detail.capitalBaseUsd=exposure.data.completeExposureKat*input.katPriceUsd+input.cashUsd;
      detail.options.push({id:'reduce_liquid_kat',label:'Reduce liquid KAT exposure (paper only)',
        status:amount>exposure.data.liquidKat?'blocked':checks.some(c=>c.status==='fail')?'outside_policy':'conditional',
        cashRequiredUsd:input.gasUsd,policyChecks:checks,outcomes:amount>exposure.data.liquidKat?[]:[{scenario:'Owner price assumption',
          katSold:amount,remainingKatExposure:exposure.data.completeExposureKat-amount,
          liquidKatRemaining:exposure.data.liquidKat-amount,proceedsUsd:notional-cost,netUsd:detail.capitalBaseUsd-cost,
          differenceFromHoldUsd:-cost,costUsd:cost}],limitations:[...(amount>exposure.data.liquidKat?['Requested sale exceeds verified liquid KAT; outcomes are blocked.']:[]),'Sale price and fees are assumptions; no venue liquidity, order or transaction is authorized.']});
    }
  }
  return finalize(context,policy,input,detail,at);
}
export function renderAgentStrategyResult(result){
  if(result.kind==='lp')return renderLPComparisonSummary(result);
  const lines=[result.status==='blocked'?'I need more information to complete this comparison.':'Here is how the options compare over '+result.horizonDays+' days.'];
  if(result.status==='superseded')lines.push('These results use your earlier preferences. Run a new comparison before using them.');
  if(Number.isFinite(result.capitalBaseUsd))lines.push('Each option starts with the same '+agentMoney(result.capitalBaseUsd)+'.');
  if(result.comparisonBasis==='before_financing')lines.push('These LP scenarios are before borrowing costs; portfolio loans are assessed separately.');
  for(const option of result.options){
    if(result.status==='blocked')continue;
    lines.push('\n'+option.label+(option.status==='outside_policy'?' — outside your saved limits':option.status==='blocked'?' — more information needed':''));
    if(Number.isFinite(option.cashRequiredUsd))lines.push('Extra cash needed: '+agentMoney(option.cashRequiredUsd)+'.');
    for(const out of option.outcomes||[])lines.push(out.scenario!=null?
      out.scenario+': estimated final value '+(result.comparisonBasis==='before_financing'?'before borrowing costs ':'')+agentMoney(out.netUsd)+(Number.isFinite(out.differenceFromHoldUsd)
        ? out.differenceFromHoldUsd===0?' — the same as holding.':' — '+agentMoney(Math.abs(out.differenceFromHoldUsd))+(out.differenceFromHoldUsd>0?' ahead of holding.':' behind holding.'):''):
      (out.oracleMovePct===0?'If the oracle ratio stays the same':'If the oracle ratio '+(out.oracleMovePct<0?'falls ':'rises ')+agentNumber(Math.abs(out.oracleMovePct),2)+'%')+
      ': '+(out.health==null?'no debt':'health '+agentNumber(out.health))+', LTV '+(out.ltv==null?'unavailable':agentNumber(out.ltv*100,2)+'%')+
      ', estimated debt '+agentNumber(out.projectedDebtAmount)+' '+out.loanToken+'.');
  }
  if(result.status!=='blocked')lines.push('\nThese are what-if estimates using the costs and assumptions you entered.');
  if(result.kind==='lp'&&result.status!=='blocked')lines.push('Projected earnings depend on the assumed rates and campaign end; they are not future facts.');
  if(result.kind==='lending'&&result.options.some(option=>option.outcomes?.some(out=>out.oracleVariable==='avKAT/KAT ratio')))
    lines.push('For avKAT/KAT, these changes affect the collateral-to-debt oracle ratio, not a KAT dollar-price forecast.');
  lines.push(...friendlyAgentNotes(result.limitations,{partial:result.status==='partial',blocked:result.status==='blocked',kind:'strategy'}));
  const stamp=agentReadingTime(result.observedAt);if(stamp)lines.push('\nReading: '+stamp+'.');
  return lines.join('\n').slice(0,11500);
}
