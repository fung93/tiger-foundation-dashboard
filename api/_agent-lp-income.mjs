/* Goal planning at an observed campaign state. All numbers are deterministic;
   no promised daily income, net-return ranking, allocation mandate or trade. */
import { amountsPerLiquidity,liquidityForCapital,estimateReward,priceAtTick } from '../strategy-core.mjs';
import { agentMoney,agentNumber,agentPrice,agentReadingTime } from '../agent-language.mjs';

const positive=n=>Number.isFinite(n)&&n>0;
export function requestedLPDailyRewardGoal(message) {
  if(typeof message!=='string')return null;
  const text=message.replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g,' ');
  if(!/\b(?:earn|make|generate|receive|target|goal|aim|want|income|rewards?|profits?|yield)\b/i.test(text))return null;
  const number='(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
  const money=new RegExp('(?:\\$\\s*|USD\\s*)('+number+')|('+number+')\\s*(?:USD|dollars?)\\b','gi'),values=[];
  for(const match of text.matchAll(money)){
    const before=text.slice(Math.max(0,match.index-70),match.index),after=text.slice(match.index+match[0].length,match.index+match[0].length+90);
    const suffix=/^\s*(?:(?:worth\s+of|in|of)\s+)?(?:(?:KAT|gross|net|rewards?|income|profit)\s*){0,4}(?:daily\b|per\s+day\b|a\s+day\b|each\s+day\b|\/\s*(?:day|d)\b)/i.test(after);
    const prefix=/\b(?:daily|per.day)\s+(?:(?:KAT|gross|net|profit|reward|rewards|income|target|goal|of|is|worth|to|earn)\s+){0,6}$/i.test(before);
    if(/^\s*(?:or|and|to|[-–])\s*(?:\$\s*|USD\s*)?\d[\d,.]*\s*(?:(?:worth\s+of|in|of)\s+)?(?:(?:KAT|gross|net|rewards?|income|profit)\s*){0,4}(?:daily\b|per\s+day\b|a\s+day\b|each\s+day\b|\/\s*day\b)/i.test(after))
      return {error:'Choose one daily KAT reward target in USD.'};
    if((suffix||prefix)&&!/\b(?:currently|already)\s+(?:earn|make|receive|generate)\s*$/i.test(before))values.push(Number((match[1]||match[2]).replaceAll(',','')));
  }
  if(!values.length)return null;
  if(new Set(values).size!==1||!positive(values[0])||values[0]<.000001||values[0]>1e9)return {error:'Choose one daily KAT reward target in USD.'};
  if(/\bnet\b|\bprofits?\b|\bafter\s+(?:gas|fees|costs|interest|borrowing)\b/i.test(text))
    return {error:'An after-cost profit goal is different from gross KAT rewards.',kind:'net_target'};
  return {usdPerDay:values[0]};
}
export function isLPIncomeQuestion(message) {
  return !!requestedLPDailyRewardGoal(message)&&/\bLP\b|liquidity|pool|\b[a-z][a-z0-9]{1,11}\s*\/\s*[a-z][a-z0-9]{1,11}\b/i.test(message||'');
}
const unavailable=(targetUsd,reason,message)=>({status:'unavailable',targetUsdPerDay:targetUsd,reason,message});
const quotedRange=(lo,hi,pool)=>{const a=priceAtTick(lo,pool),b=priceAtTick(hi,pool);
  return {tickLower:lo,tickUpper:hi,lowerPrice:Math.min(a,b),upperPrice:Math.max(a,b)};};

export function analyzeLPIncomeTarget({targetUsd,pool,position,rangeData,katUsd,katObservedAt,now}) {
  if(!positive(targetUsd)||targetUsd<.000001||targetUsd>1e9)return unavailable(targetUsd,'invalid_target','Choose one positive daily reward target in USD.');
  if(!rangeData.withinAssetPreferences)return unavailable(targetUsd,'outside_policy','This pair or protocol is outside your saved limits; I can’t suggest a range change for that target.');
  if(!position||!rangeData.currentRange||!positive(position.principalUsd))return unavailable(targetUsd,'position_unavailable','I need one verified current LP and its capital to check that income goal.');
  if(pool.kind!=='rewards')return unavailable(targetUsd,'no_kat_campaign','This pool does not have a verified KAT reward campaign for that target.');
  if(!positive(katUsd)||!Number.isFinite(Date.parse(katObservedAt))||now-Date.parse(katObservedAt)<-30000||now-Date.parse(katObservedAt)>=90000)
    return unavailable(targetUsd,'kat_price_unavailable','The current KAT dollar price is missing or stale, so I can’t check the dollar-per-day goal yet.');
  const campaign=pool.campaign,timestamp=now/1000;
  if(!Number.isSafeInteger(campaign?.start)||!Number.isSafeInteger(campaign?.end)||campaign.end<=campaign.start
    ||timestamp<campaign.start||timestamp>=campaign.end)return unavailable(targetUsd,'campaign_inactive','There is no verified active KAT campaign to support that daily estimate.');
  if(!Number.isFinite(pool.katPerDay)||pool.katPerDay<0||pool.rules?.weightFees!==10000||pool.rules?.weightToken0!==0
    ||pool.rules?.weightToken1!==0||pool.rules?.outOfRange!==false||!Number.isFinite(pool.eligible?.liquidity)||pool.eligible.liquidity<0)
    return unavailable(targetUsd,'reward_inputs_unavailable','The campaign’s current reward rate or eligible liquidity needs a fresh complete reading.');
  if(position.staked!==true||position.feesMine!==false)return unavailable(targetUsd,'staking_unverified','A range change alone does not establish KAT eligibility; this LP’s campaign staking must be verified first.');
  if(typeof position.raw?.liquidity!=='string'||!/^\d{1,78}$/.test(position.raw.liquidity))return unavailable(targetUsd,'liquidity_unavailable','The LP’s raw liquidity is missing, so I can’t size its reward share.');
  const ownerL=Number(BigInt(position.raw.liquidity)),own=rangeData.currentRange;
  const units=amountsPerLiquidity(own.tickLower,own.tickUpper,pool.sqrtPrice,pool.token0.decimals,pool.token1.decimals);
  const capital=ownerL*(units.amount0*pool.token0.usd+units.amount1*pool.token1.usd);
  if(!positive(ownerL)||!positive(capital)||Math.abs(capital-position.principalUsd)>Math.max(.02,position.principalUsd*.005))
    return unavailable(targetUsd,'valuation_mismatch','LP capital and the current pool quote do not reconcile; I need a consistent reading before sizing the target.');
  const ownInRange=pool.tick>=own.tickLower&&pool.tick<own.tickUpper;
  if(ownInRange&&pool.eligible.liquidity+Math.max(1,ownerL*1e-10)<ownerL)
    return unavailable(targetUsd,'eligible_liquidity_mismatch','The campaign’s eligible liquidity is smaller than this LP’s verified active liquidity; I can’t trust the reward estimate yet.');
  // Replacing this LP removes its existing eligible liquidity first. Treating
  // all current liquidity as competition would count the owner's position twice.
  const others=Math.max(0,pool.eligible.liquidity-(ownInRange?ownerL:0));
  const poolBudgetUsd=pool.katPerDay*katUsd;
  if(!Number.isFinite(poolBudgetUsd)||!Number.isFinite(targetUsd/katUsd))return unavailable(targetUsd,'invalid_rate','The dollar reward rate could not be validated.');
  const finiteTargetPossible=targetUsd<poolBudgetUsd||others===0&&targetUsd<=poolBudgetUsd;
  // Only fee/liquidity scoring is supported above. Zero-weight token terms do
  // not need token-balance observations (avoid 0 * NaN in the general engine).
  const counterfactual={...pool,eligible:{...pool.eligible,liquidity:others,amount0:0,amount1:0}};
  const ctx={now:timestamp,katUsd,rewardStart:campaign.start,rewardEnd:campaign.end};
  const evaluate=(range,amount=capital)=>{
    const value=estimateReward(counterfactual,{capitalUsd:amount,lowerPrice:range.lowerPrice,upperPrice:range.upperPrice},ctx);
    return value.error||!Number.isFinite(value.usdPerDay)||value.usdPerDay<0?null:{...range,
      katPerDay:value.katPerDay,usdPerDay:value.usdPerDay,share:value.share,capitalUsd:amount,
      reachesTarget:finiteTargetPossible&&value.usdPerDay>=targetUsd*(1-1e-10)};
  };
  const currentKat=ownInRange&&pool.eligible.liquidity>0?pool.katPerDay*Math.min(1,ownerL/pool.eligible.liquidity):0;
  const current={...own,katPerDay:currentKat,usdPerDay:currentKat*katUsd,reachesTarget:finiteTargetPossible&&currentKat*katUsd>=targetUsd};
  const candidates=rangeData.windows.map(row=>evaluate(row)).filter(Boolean),preferred=candidates.find(row=>row.days===rangeData.preferredDays)||null;
  const historicalChoice=candidates.filter(row=>row.days>=rangeData.preferredDays&&row.reachesTarget).sort((a,b)=>b.days-a.days)[0]||null;
  const spacing=pool.tickSpacing,edge=Math.floor(887272/spacing)*spacing,lo=Math.floor(pool.tick/spacing)*spacing,hi=lo+spacing;
  const minimum=lo>=-edge&&hi<=edge?evaluate(quotedRange(lo,hi,pool)):null;
  let targetOnlyRange=null;
  if(minimum?.reachesTarget){
    let a=0,b=Math.floor(Math.min((lo+edge)/spacing,(edge-hi)/spacing));
    while(a<b){const mid=Math.ceil((a+b)/2),test=evaluate(quotedRange(lo-mid*spacing,hi+mid*spacing,pool));
      if(test?.reachesTarget)a=mid;else b=mid-1;}
    targetOnlyRange=evaluate(quotedRange(lo-a*spacing,hi+a*spacing,pool));
    const history=rangeData.windows.find(row=>row.days===rangeData.preferredDays);
    targetOnlyRange.coversPreferredHistory=history?targetOnlyRange.tickLower<=history.historyLowTick&&targetOnlyRange.tickUpper>history.historyHighTick:null;
  }
  let capitalRequiredForPreferredUsd=null;
  if(preferred&&others>0&&poolBudgetUsd>targetUsd){
    const perDollar=liquidityForCapital(1,preferred.tickLower,preferred.tickUpper,pool)?.liquidity;
    const amount=others*targetUsd/(poolBudgetUsd-targetUsd)/perDollar;
    if(positive(amount)&&amount<=1e12){const rounded=Math.ceil(amount*100)/100,check=evaluate(preferred,rounded);
      if(check?.reachesTarget)capitalRequiredForPreferredUsd=rounded;}
  }
  return {schemaVersion:'agent-lp-income-v1',status:'ready',targetUsdPerDay:targetUsd,targetKatPerDay:targetUsd/katUsd,
    capitalUsd:capital,bookCapitalUsd:position.principalUsd,positionId:position.positionId,katUsd,
    observation:{position:{chain:position.chain,owner:position.owner,contract:position.contract,positionId:position.positionId,
      observedAt:position.observedAt,staked:position.staked,feesMine:position.feesMine},rawOwnerLiquidity:position.raw.liquidity,
      poolObservedAt:pool.ts,katObservedAt,katPerDay:pool.katPerDay,eligibleLiquidity:pool.eligible.liquidity,rules:{...pool.rules}},
    current,candidates,preferred,historicalChoice,targetOnlyRange,capitalRequiredForPreferredUsd,
    maxDailyRewardAtCapitalUsd:minimum?.usdPerDay??null,poolBudgetUsd,otherEligibleLiquidity:others,ownerLiquidity:ownerL,
    campaign:{start:campaign.start,end:campaign.end,remainingDays:(campaign.end-timestamp)/86400},
    basis:'Conditional gross KAT rate with current price, emissions and competing liquidity; no future price-path probability or transaction is assumed.',
    excludes:['historical/carried rewards','DAO trading fees','gas and swap costs','borrowing costs']};
}

export function renderLPIncomeTarget(d) {
  const g=d.incomeGoal,target=agentMoney(g.targetUsdPerDay)+'/day';
  if(g.status!=='ready')return 'I can’t verify the '+target+' KAT goal yet. '+g.message;
  const stable=['USDC','VBUSDC','USDT','VBUSDT','DAI','USDG'].includes(String(d.quote).toUpperCase())&&d.quoteUsd===1;
  const price=n=>stable?agentPrice(n):agentNumber(n,6)+' '+d.quote;
  const band=row=>price(row.lowerPrice)+'–'+price(row.upperPrice);
  const rate=row=>agentNumber(row.katPerDay,1)+' KAT/day ('+agentMoney(row.usdPerDay)+'/day)';
  const lines=[];
  if(g.historicalChoice)lines.push('At today’s inputs, your '+agentMoney(g.capitalUsd)+' LP can meet '+target+' in a historical-range comparison.');
  else if(g.current.reachesTarget)lines.push('Your current range estimates '+rate(g.current)+', meeting the '+target+' goal at this reading. A wider historical band may earn less.');
  else if(g.poolBudgetUsd<g.targetUsdPerDay||g.poolBudgetUsd===g.targetUsdPerDay&&g.otherEligibleLiquidity>0)lines.push('The whole pool currently pays about '+agentMoney(g.poolBudgetUsd)+'/day in KAT. A '+target+' goal is not supported by its current reward budget and competition.');
  else if(!g.preferred)lines.push('I can estimate your current reward rate, but the '+d.preferredDays+'-day history needed to choose a range for '+target+' is incomplete.');
  else lines.push('With your current '+agentMoney(g.capitalUsd)+' LP, no verified band matching your review interval meets the '+target+' KAT goal.');
  if(!g.current.reachesTarget)lines.push('• Current range: '+rate(g.current)+'. Target: '+agentNumber(g.targetKatPerDay,1)+' KAT/day at today’s KAT price.');
  const comparison=g.historicalChoice||g.preferred;
  if(comparison)lines.push('• Compare '+band(comparison)+' ('+comparison.days+'-day history): about '+rate(comparison)+'.');
  if(!g.historicalChoice&&g.targetOnlyRange&&!g.current.reachesTarget)lines.push('• A target-only band around '+band(g.targetOnlyRange)+' estimates '+rate(g.targetOnlyRange)
    +(g.targetOnlyRange.coversPreferredHistory===false?', but misses part of the relevant historical price moves.':'; its history coverage needs checking.'));
  else if(!g.historicalChoice&&!g.current.reachesTarget&&g.maxDailyRewardAtCapitalUsd!==null&&g.poolBudgetUsd>g.targetUsdPerDay)
    lines.push('• Even the tightest usable band estimates only '+agentMoney(g.maxDailyRewardAtCapitalUsd)+'/day with this capital.');
  if(!g.historicalChoice&&g.capitalRequiredForPreferredUsd!==null)lines.push('• Keeping the '+g.preferred.days+'-day band would require about '
    +agentMoney(g.capitalRequiredForPreferredUsd)+' total LP capital for the target at these inputs.');
  lines.push(g.historicalChoice?'Suggestion: compare the historical band above; it leaves room for the observed moves while meeting the current rate estimate.'
    :'Suggestion: keep price room as the priority; don’t narrow solely to force the income target.');
  lines.push('New gross KAT rewards, before transaction and borrowing costs. Price exits or changes in KAT price, emissions or competing liquidity can reduce earnings.');
  if(g.campaign.remainingDays<1)lines.push('The campaign ends '+agentReadingTime(new Date(g.campaign.end*1000).toISOString())+'; less than one full day remains.');
  else lines.push('Current campaign ends '+agentReadingTime(new Date(g.campaign.end*1000).toISOString())+'.');
  return lines.join('\n');
}
