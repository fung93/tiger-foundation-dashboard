/* UNI guide: deterministic Uniswap V3 position maths. No network or wallet access. */
import {snapRange,liquidityForCapital,edgeOutcome} from './strategy-core.mjs';

export const UNI_MODES=['uni','stable','balanced'];
export function uniPoolLink(chain,pool){
  if(!['base','bnb'].includes(chain)||!/^0x[0-9a-f]{40}$/i.test(pool))throw Error('Invalid Uniswap pool');
  return `https://app.uniswap.org/explore/pools/${chain}/${pool.toLowerCase()}`;
}
export function uniDefaultInput(pool,mode){
  if(!UNI_MODES.includes(mode)||!(pool.price>0))return null;
  const factors=mode==='uni'?[1.01,1.15]:mode==='stable'?[.85,.99]:[.9,1.1];
  return {mode,amount:mode==='uni'?1000/pool.price:1000,lowerPrice:pool.price*factors[0],upperPrice:pool.price*factors[1]};
}
export function uniEstimate(pool,input){
  if(!UNI_MODES.includes(input.mode))return {error:'Choose how you want to deposit first.'};
  if(!(input.amount>0)||!Number.isFinite(input.amount))return {error:'Enter an amount greater than zero.'};
  if(![input.lowerPrice,input.upperPrice].every(n=>Number.isFinite(n)&&n>0))return {error:'Enter a minimum and maximum price greater than zero.'};
  if(!(pool.price>0)||!(pool.sqrtPrice>0)||!(pool.tickSpacing>0))return {error:'A current pool price is needed.'};
  const range=snapRange(input.lowerPrice,input.upperPrice,pool);if(range.error)return range;
  const inRange=pool.tick>=range.tickLower&&pool.tick<range.tickUpper;
  if(input.mode==='uni'&&(range.lowerPrice<pool.price||inRange))return {error:'For UNI only, set the minimum price above the current price. The position sells UNI as price rises into the range.',range};
  if(input.mode==='stable'&&(range.upperPrice>pool.price||inRange))return {error:'For stablecoin only, set the maximum price below the current price. The position buys UNI as price falls into the range.',range};
  if(input.mode==='balanced'&&(!inRange||!(range.lowerPrice<pool.price&&range.upperPrice>pool.price)))return {error:'For both tokens, put the current price between your minimum and maximum.',range};
  const capital=input.amount*(input.mode==='uni'?pool.price:1),pos=liquidityForCapital(capital,range.tickLower,range.tickUpper,pool);
  if(!pos||!Number.isFinite(pos.liquidity))return {error:'This range cannot be valued. Try prices closer to the current price.',range};
  const base=pool.baseIndex,uni=pos['amount'+base],stable=pos['amount'+(1-base)];
  const growth=pool.feeWindow,verified=growth?.verified===true&&growth.seconds>=82800&&growth.seconds<=90000
    &&[growth.perL0Day,growth.perL1Day].every(n=>Number.isFinite(n)&&n>=0);
  // Observed per-liquidity fee growth already excludes protocol fees. Account
  // for a new deposit diluting today's active liquidity; never promise a yield.
  const dilution=pool.activeLiquidity>0?pool.activeLiquidity/(pool.activeLiquidity+pos.liquidity):null;
  let daily=null;
  if(!inRange)daily=0;
  else if(verified&&dilution!==null){daily=pos.liquidity*dilution*(growth.perL0Day*pool.token0.usd+growth.perL1Day*pool.token1.usd);}
  const edge=edgeOutcome(pool,range,pos.liquidity,capital);
  return {range,inRange,capitalUsd:capital,liquidity:pos.liquidity,deposit:{uni,stable},edges:edge,
    feesPerDay:daily,apr:daily===null?null:daily*365/capital,feeBasis:verified?{fromTs:growth.fromTs,toTs:growth.toTs,seconds:growth.seconds}:null};
}
export function uniPriceFromSqrt(sqrtRaw,pool){
  const ratio=(Number(sqrtRaw)/2**96)**2*10**(pool.token0.decimals-pool.token1.decimals);
  return pool.baseIndex===0?ratio:1/ratio;
}
