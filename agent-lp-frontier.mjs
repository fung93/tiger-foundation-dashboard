/* Equal-capital LP choices across explicit paths. A frontier of conditional
   cases is not an expected return, probability, forecast or trade instruction. */
import {amountsPerLiquidity,liquidityForCapital,tickAtPrice,priceAtTick,snapRange} from './strategy-core.mjs';
import {createLiquidityCurve} from './agent-liquidity.mjs';
import {resetComparison} from './api/_agent-lp-advice.mjs';
import {agentMoney,agentPrice,agentNumber} from './agent-language.mjs';
import {renderInvestmentBrief} from './agent-investment-brief.mjs';
const positive=n=>Number.isFinite(n)&&n>0;
const tick=n=>Number.isInteger(n)&&Math.abs(n)<=887272;
const units=(L,lo,hi,sqrt,p)=>{const a=amountsPerLiquidity(lo,hi,sqrt,p.token0.decimals,p.token1.decimals);return [a.amount0*L,a.amount1*L];};
export function buildLPFrontier({position:p,pool,rangeData,context,args={},now=Date.now()}={}){
  const result={schemaVersion:'agent-lp-frontier-v1',status:'partial',options:[],efficientOptionIds:[],scenarios:[],brief:null,
    assumptions:['All choices use the same original LP capital. Reset gas, pool fee and a 0.5% slippage case reduce replacement capital.',
      'Explicit flat/down/up/whipsaw/income-stress paths; none is a forecast or assigned a probability.',
      'Future pool volume and other liquidity are conditional. KAT eligible liquidity is a separate spot assumption, not inferred from total pool liquidity.',
      'Holding marks the original LP token amounts; hypothetical exit/claim gas and future financing are not known. It is a principal benchmark, not an executed holding return.',
      'Existing carried/accrued rewards are common prior wealth and excluded from newly projected income. Results are before financing.'],reasons:[]};
  if(!p||!rangeData?.currentRange||!positive(p.principalUsd)||!positive(pool?.sqrtPrice)||!rangeData.withinAssetPreferences)return result;
  const C=p.principalUsd,L=Number(p.raw?.liquidity),own=rangeData.currentRange;
  const initial=units(L,own.tickLower,own.tickUpper,pool.sqrtPrice,pool),prices=[pool.token0.usd,pool.token1.usd];
  if(!positive(L)||!prices.every(positive)||Math.abs(initial[0]*prices[0]+initial[1]*prices[1]-C)>Math.max(.02,C*.005))return result;
  if(own.inRange&&L>pool.activeLiquidity*(1+1e-9)){result.reasons.push('Owned and total active liquidity do not reconcile.');return result;}
  const horizon=Math.min(30,Math.max(1,(context.policy?.status==='confirmed'?context.policy.constraints?.horizonDays:null)||7));
  const paths=[{id:'flat',points:[[0,1],[horizon,1]],incomeFactor:1,rewardPriceFactor:1},
    {id:'down_15pct',points:[[0,1],[horizon,.85]],incomeFactor:1,rewardPriceFactor:1},
    {id:'up_15pct',points:[[0,1],[horizon,1.15]],incomeFactor:1,rewardPriceFactor:1},
    {id:'whipsaw',points:[[0,1],[horizon/3,.85],[horizon*2/3,1.1],[horizon,1]],incomeFactor:1,rewardPriceFactor:1},
    {id:'income_stress',points:[[0,1],[horizon,1]],incomeFactor:.5,rewardPriceFactor:.8}];
  result.horizonDays=horizon;result.scenarios=paths;result.capitalUsd=C;
  const evidence=pool.liquidityEvidence,curve=evidence?.chain===(pool.chain||p.chain)&&evidence.pool?.toLowerCase()===pool.pool.toLowerCase()
    &&evidence.currentTick===pool.tick&&evidence.block===pool.block?createLiquidityCurve(evidence):null;
  result.liquidityBasis=curve?'pinned_initialized_ticks':'constant_spot_competition_case';
  result.liquidityEvidence=evidence||null;
  if(!curve)result.reasons.push('Pinned initialized-tick evidence is incomplete; only an explicit constant-competition case is available.');
  const candidates=[{id:'keep',...own},...(rangeData.windows||[]).map(row=>({id:'history_'+row.days,...row}))];
  for(const factor of [1,1.5]){const width=(own.upperPrice-own.lowerPrice)*factor,lo=Math.max(rangeData.price-width/2,rangeData.price*.01),hi=rangeData.price+width/2;
    const r=snapRange(lo,hi,pool);if(!r.error)candidates.push({id:factor===1?'recenter':'wider',...r});}
  const unique=[...new Map(candidates.filter(row=>tick(row.tickLower)&&tick(row.tickUpper)&&row.tickLower<row.tickUpper)
    .map(row=>[row.tickLower+':'+row.tickUpper,row])).values()].slice(0,6);
  // Retain the actual keep ID when a historical band has identical boundaries.
  const same=unique.find(row=>row.tickLower===own.tickLower&&row.tickUpper===own.tickUpper);if(same)same.id='keep';
  const routeFees=p.feesMine===true&&!(p.chain==='katana'&&p.staked===true),wantsKat=pool.kind==='rewards'&&p.staked===true;
  const feeRate=routeFees&&Number.isFinite(pool.fees?.usd_per_day)&&pool.fees.usd_per_day>=0?pool.fees.usd_per_day:null;
  const katValid=wantsKat&&pool.rules?.weightFees===10000&&pool.rules?.weightToken0===0&&pool.rules?.weightToken1===0&&pool.rules?.outOfRange===false
    &&positive(pool.katPerDay)&&Number.isFinite(pool.eligible?.liquidity)&&pool.eligible.liquidity>=(own.inRange?L:0)
    &&Number.isFinite(pool.campaign?.start)&&Number.isFinite(pool.campaign?.end)&&pool.campaign.end>pool.campaign.start&&positive(context.strategy?.kat_usd);
  const rateTimestamp=Date.parse(pool.ratesObservedAt||context.strategy?.ts||pool.ts),rateFresh=Number.isFinite(rateTimestamp)&&now-rateTimestamp>=-30000&&now-rateTimestamp<90000;
  const otherEligible=katValid?Math.max(0,pool.eligible.liquidity-(own.inRange?L:0)):null;
  for(const r of unique){
    const keep=r.id==='keep',cost=keep?0:resetComparison({...own,usdPerDay:0},r,pool,{capitalUsd:C},context.lpAdviceFunding,p,now,{projectRewards:false})?.costEstimateUsd;
    const capital=cost!==null&&cost!==undefined?C-cost:null;
    const nextL=keep?L:positive(capital)?liquidityForCapital(capital,r.tickLower,r.tickUpper,pool)?.liquidity:null;
    const out={id:r.id,tickLower:r.tickLower,tickUpper:r.tickUpper,lowerPrice:Math.min(priceAtTick(r.tickLower,pool),priceAtTick(r.tickUpper,pool)),
      upperPrice:Math.max(priceAtTick(r.tickLower,pool),priceAtTick(r.tickUpper,pool)),costUsd:cost??null,capitalAfterCostUsd:capital,
      liquidity:nextL,outcomes:[],status:positive(nextL)?'conditional':'blocked'};
    for(const path of paths){
      const terminal=path.points.at(-1)[1],finalPrices=[...prices];finalPrices[pool.baseIndex]*=terminal;
      const hold=initial[0]*finalPrices[0]+initial[1]*finalPrices[1];
      if(!positive(nextL)){out.outcomes.push({scenario:path.id,principalUsd:null,newFeesUsd:null,newRewardsUsd:null,netBeforeFinancingUsd:null,holdUsd:hold,differenceFromHoldUsd:null});continue;}
      const sqrt=pool.sqrtPrice*(pool.baseIndex===0?Math.sqrt(terminal):1/Math.sqrt(terminal)),amount=units(nextL,r.tickLower,r.tickUpper,sqrt,pool);
      const principal=amount[0]*finalPrices[0]+amount[1]*finalPrices[1];
      let inDays=0,fees=0,kat=0,known=(p.feesMine===true||p.feesMine===false)&&(pool.kind!=='rewards'||typeof p.staked==='boolean');
      for(let j=1;j<path.points.length;j++){
        const [d0,x0]=path.points[j-1],[d1,x1]=path.points[j],cuts=[d0,d1];
        const crossings=[r.tickLower,r.tickUpper,own.tickLower,own.tickUpper,...(curve?.ticks||[])].map(t=>priceAtTick(t,pool)/rangeData.price);
        for(const x of crossings)if(x1!==x0){const at=d0+(x-x0)/(x1-x0)*(d1-d0);if(at>d0&&at<d1)cuts.push(at);}
        if(katValid)for(const t of [pool.campaign.start,pool.campaign.end]){const at=(t-now/1000)/86400;if(at>d0&&at<d1)cuts.push(at);}
        cuts.sort((a,b)=>a-b);
        for(let k=1;k<cuts.length;k++){
          const duration=cuts[k]-cuts[k-1];if(duration<=0)continue;
          const mid=(cuts[k]+cuts[k-1])/2,ratio=x0+(x1-x0)*(mid-d0)/(d1-d0),t=Math.floor(tickAtPrice(rangeData.price*ratio,pool));
          if(t<r.tickLower||t>=r.tickUpper)continue;inDays+=duration;
          if(routeFees){const total=curve?curve.at(t):pool.activeLiquidity;
            if(feeRate===null||!Number.isFinite(total)){known=false;continue;}
            const ownActive=t>=own.tickLower&&t<own.tickUpper?L:0,others=curve?total-ownActive:total-(own.inRange?L:0);
            if(others< -Math.max(1,total*1e-9)){known=false;continue;}
            fees+=feeRate*path.incomeFactor*nextL/(Math.max(0,others)+nextL)*duration;}
          if(wantsKat){const at=now/1000+mid*86400;
            if(!katValid||!rateFresh){known=false;continue;}
            if(at>=pool.campaign.start&&at<pool.campaign.end)kat+=pool.katPerDay*path.incomeFactor*nextL/(otherEligible+nextL)*duration;}
        }
      }
      const rewards=kat*(context.strategy?.kat_usd||0)*path.rewardPriceFactor,value=known?principal+fees+rewards:null;
      out.outcomes.push({scenario:path.id,principalUsd:principal,timeInRangeDays:inDays,newFeesUsd:known?fees:null,newRewardsKat:known?kat:null,
        newRewardsUsd:known?rewards:null,netBeforeFinancingUsd:value,holdUsd:hold,differenceFromHoldUsd:value===null?null:value-hold});
    }
    result.options.push(out);
  }
  const valid=result.options.filter(row=>row.outcomes.length===paths.length&&row.outcomes.every(out=>Number.isFinite(out.differenceFromHoldUsd)));
  const dominates=(a,b)=>a.outcomes.every((out,i)=>out.differenceFromHoldUsd>=b.outcomes[i].differenceFromHoldUsd-.005)
    &&a.outcomes.some((out,i)=>out.differenceFromHoldUsd>b.outcomes[i].differenceFromHoldUsd+.01);
  result.efficientOptionIds=valid.filter(row=>!valid.some(other=>other!==row&&dominates(other,row))).map(row=>row.id);
  const keep=result.options.find(row=>row.id==='keep'),better=keep&&valid.find(row=>row!==keep&&dominates(row,keep));
  result.status=curve&&valid.length===result.options.length&&valid.length>1?'ready':'partial';
  const quoted=n=>pool.quoteUsd===1||pool['token'+(1-pool.baseIndex)]?.usd===1?agentPrice(n):agentNumber(n,6)+' '+pool.quote;
  const fmt=r=>quoted(r.lowerPrice)+'–'+quoted(r.upperPrice),target=args.dailyRewardTargetUsd;
  result.brief={suggestion:wantsKat&&pool.campaign?.end<=now/1000?'Review the ended KAT campaign before relying on more reward income.'
    :!own.inRange?'Review a reset: your current LP is outside its earning range.'
    :better&&result.status==='ready'?'Compare '+fmt(better)+'; it improves on keeping the current band in the tested cases.'
      :'Keep the current range as the starting point; no verified reset wins across every tested case.',
    evidence:'Compared '+result.options.length+' equal-capital bands over '+horizon+' days across '+paths.length+' stated paths'
      +(target?' for your '+agentMoney(target)+'/day goal':'')+'. '+(curve?'Pool competition uses pinned initialized ticks.':'Future competition is a constant-spot assumption.'),
    tradeOff:'Narrower bands concentrate income but can stop earning sooner. Costs reduce capital; outcomes are before financing. '
      +(wantsKat?'Future Merkl competition remains a spot-based assumption.':'Future trading volume remains conditional.'),
    recheck:'Price approaches '+fmt(own)+', volume/emissions or liquidity changes, or the campaign ends.'};
  result.reply=renderInvestmentBrief(result.brief);return result;
}
