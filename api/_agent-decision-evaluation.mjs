/* Prospective originals and later marks. Estimated alternatives never become
   executed returns; cached quotes and capital changes cannot manufacture wins. */
import {createHash} from 'node:crypto';
import {amountsPerLiquidity} from '../strategy-core.mjs';
import {positionIdentity} from '../portfolio-core.mjs';
import {automaticInputs,autoPaused,autoFresh} from './_agent-auto-state.mjs';
import {mytDayAndTime} from './_agent-notifications.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const amounts=(L,r,sqrt,p)=>{const a=amountsPerLiquidity(r.tickLower,r.tickUpper,sqrt,p.token0.decimals,p.token1.decimals);return {amount0:a.amount0*L,amount1:a.amount1*L};};
export function markInvestmentDecision(original,{position,market,policyVersion,now=Date.now()}={}){
  const result={schemaVersion:'agent-decision-evaluation-v1',baselineId:original.id,identity:original.identity,policyVersion:original.policyVersion,
    baselineAt:original.createdAt,observedAt:market?.ts||market?.observedAt||null,status:'unavailable',marks:[],winner:null,
    basis:'Original capital and bands at a later quote. Alternative marks exclude unobserved fees, financing and actual execution. No return/win-rate claim.'};
  if(!market||position?.status!=='observed'||!autoFresh(position.observedAt,now)||!autoFresh(market.ts||market.observedAt,now)||Date.parse(result.observedAt)<=Date.parse(original.createdAt)
    ||Date.parse(result.observedAt)-Date.parse(original.createdAt)<60000)return result;
  const identity=positionIdentity({chain:position?.chain,protocolContract:position?.contract,positionId:position?.positionId||position?.id,owner:position?.owner});
  if(identity!==original.identity||position.pool?.toLowerCase()!==original.position.pool.toLowerCase()||market.chain!==original.position.chain||market.pool?.toLowerCase()!==original.market.pool.toLowerCase()
    ||['token0','token1'].some(k=>market[k]?.address?.toLowerCase()!==original.market[k].address.toLowerCase()||market[k]?.decimals!==original.market[k].decimals))return result;
  if(policyVersion!==original.policyVersion)return {...result,status:'earlier_policy'};
  if(position.raw?.liquidity!==original.position.raw.liquidity||position.raw?.lowerTick!==original.position.raw.lowerTick||position.raw?.upperTick!==original.position.raw.upperTick
    ||original.capitalVersion&&position.performance?.attribution?.capitalVersion!==original.capitalVersion)
    return {...result,status:'capital_changed'};
  if(![market.sqrtPrice,market.token0.usd,market.token1.usd].every(n=>Number.isFinite(n)&&n>0))return result;
  const usd=a=>a.amount0*market.token0.usd+a.amount1*market.token1.usd,hold=usd(original.initialAmounts);
  result.holdUsd=hold;
  for(const option of original.options){
    if(!Number.isFinite(option.liquidity)||option.liquidity<=0)continue;
    const tokens=amounts(option.liquidity,option,market.sqrtPrice,market),principal=usd(tokens);
    result.marks.push({optionId:option.id,principalUsd:principal,initialAssumedCostUsd:option.costUsd,
      differenceBeforeUnobservedIncomeUsd:principal-hold,feeIncomeUsd:null,netAfterAllCostsUsd:null,
      kind:option.id==='keep'&&original.capitalVersion?'verified_unchanged_position_principal_mark':'hypothetical_alternative_principal_mark'});
  }
  result.status=result.marks.length?'observed':'unavailable';
  result.actualCapitalUnchanged=!!original.capitalVersion;
  const before=original.position.performance?.attribution?.grossCashBasisPnlUsd,after=position.performance?.attribution?.grossCashBasisPnlUsd;
  result.observedCashBasisWealthChangeUsd=original.capitalVersion&&Number.isFinite(before)&&Number.isFinite(after)?after-before:null;
  result.wealthChangeBasis='Same-position cash-basis wealth change before unverified costs; includes reward-price changes. Not a strategy excess-return estimate.';
  return result;
}
export async function recordInvestmentDecision({store,position,market,frontier,policyVersion=0,revision,now=Date.now()}={}){
  const identity=positionIdentity({chain:position?.chain,protocolContract:position?.contract,positionId:position?.positionId||position?.id,owner:position?.owner});
  if(!identity||!frontier?.options?.length||!market||position.status!=='observed'||!autoFresh(position.observedAt,now)
    ||!autoFresh(market.ts||market.observedAt,now)||market.chain!==position.chain||market.pool?.toLowerCase()!==position.pool?.toLowerCase()
    ||![market.sqrtPrice,market.token0?.usd,market.token1?.usd,Number(position.raw?.liquidity)].every(n=>Number.isFinite(n)&&n>0)
    ||['token0','token1'].some(k=>market[k]?.address?.toLowerCase()!==position.raw?.[k]?.address?.toLowerCase()||market[k]?.decimals!==position.raw?.[k]?.decimals)
    ||!Number.isInteger(position.raw?.lowerTick)||!Number.isInteger(position.raw?.upperTick))return {status:'unavailable'};
  const lease=await store.lock('investment:position:'+hash(identity),20);if(!lease)throw Error('Decision evaluation is busy');
  try{
    const day=mytDayAndTime(Date.parse(market.ts||market.observedAt)).day,daily='investment:baseline:'+day+':'+hash([identity,policyVersion]),
      latestKey='investment:latest:'+hash([identity,policyVersion]);
    const marker='investment:eval-period:'+hash([identity,policyVersion,Math.floor(now/21600000)]);
    const input=await automaticInputs(store,[daily,latestKey,marker]);
    if(autoPaused(input.settings,now)||revision!==undefined&&(!input.controls.enabled||input.controls.revision!==revision)
      ||input.policy.version!==policyVersion)return {status:'paused_or_superseded'};
    const original=input.raw[latestKey],entries=[];let evaluation=null;
    if(original&&!input.raw[marker]){evaluation=markInvestmentDecision(original,{position,market,policyVersion,now});
      if(evaluation.status!=='unavailable'){const key='investment:evaluation:'+evaluation.observedAt+':'+hash([original.id,evaluation]);
        entries.push({key,value:{...evaluation,id:key},immutable:true},{key:marker,value:{evaluationId:key},ttlSeconds:172800});}}
    if(!input.raw[daily]){
      const own={tickLower:position.raw.lowerTick,tickUpper:position.raw.upperTick},L=Number(position.raw.liquidity);
      const baseline={schemaVersion:'agent-decision-baseline-v1',id:daily,identity,day,policyVersion,createdAt:market.ts||market.observedAt,
        capitalVersion:position.performance?.attribution?.capitalVersion||null,position,market,
        initialAmounts:amounts(L,own,market.sqrtPrice,market),options:frontier.options,
        recommendation:frontier.brief,conditions:frontier.assumptions,execution:'No transaction is inferred; this is the original prospective paper decision.'};
      entries.push({key:daily,value:baseline,immutable:true},{key:latestKey,value:baseline});
    }
    if(entries.length)await lease.commit(entries);return {status:entries.length?'recorded':'duplicate',evaluation};
  }finally{await lease.release();}
}
