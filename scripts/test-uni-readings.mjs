import assert from 'node:assert/strict';
import {readUniChain} from '../api/_uni-reader.mjs';
import {uniFixture} from './fixtures/uni.mjs';
import {uniReadingStatus,uniEstimate,uniDefaultInput,uniPriceFromSqrt} from '../uni-core.mjs';
let checks=0;const ok=(v,n)=>{assert.ok(v,n);checks++;},eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},near=(a,b,n)=>ok(Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-9),n+': '+a+' vs '+b);
const f=uniFixture(),p=(await readUniChain(f.chain,f)).pools[0],balanced=uniDefaultInput(p,'balanced');
eq(uniDefaultInput(p,'uni').lowerPrice,p.price,'UNI-only entry starts at the current price');
eq(uniDefaultInput(p,'stable').upperPrice,p.price,'Stablecoin-only entry starts at the current price');
for(const elapsed of [0,181,600,3600,8*3600]){
  const now=p.at+elapsed,status=uniReadingStatus({...p,retained:true,status:'partial'},{now,liveFailed:true});
  ok(status.ready,'A valid dated reading remains ready after '+elapsed+' seconds');
  eq(status.live,false,'A retained observation never claims to be a new live quote');
  eq(status.recorded,true,'The recorded state is explicit');
  const r=uniEstimate(p,balanced,{now});ok(Number.isFinite(r.feesPerDay)&&r.feesPerDay>0,'A valid recorded reading still displays a fee estimate');
  ok(Number.isFinite(r.apr)&&r.apr>0,'Recorded fee APR remains available');
  eq(r.activeFeesPerDay,r.feesPerDay,'An already active position has the same conditional and current fee rate');
  eq(r.activeApr,r.apr,'An already active position has the same conditional and current APR');
}
eq(uniReadingStatus({...p,status:'partial'},{now:p.at}).ready,true,'Successful alternate evidence is usable despite an unavailable optional method');
eq(uniReadingStatus({...p,status:'partial'},{now:p.at}).live,true,'A current alternate-source reading remains current');
const expired=uniEstimate(p,balanced,{now:p.at+8*3600+1});ok(expired.error,'A truly expired price cannot generate an estimate');
eq(uniReadingStatus({...p,feeWindow:null},{now:p.at}).ready,false,'Missing fee evidence is not ready');
const staleWindow={...p,at:p.at+3600,feeWindow:{...p.feeWindow,fromTs:p.at-8*3600-86400,toTs:p.at-8*3600}};
eq(uniReadingStatus(staleWindow,{now:staleWindow.at}).fees,false,'A fresh price cannot renew an old fee window');
eq(uniEstimate(staleWindow,balanced,{now:staleWindow.at}).feesPerDay,null,'An expired fee basis is unavailable rather than zero');
eq(uniReadingStatus({...p,activeLiquidity:0},{now:p.at}).ready,false,'No active liquidity cannot promise in-range earnings');

// A controlled $4/day background pool and equal added liquidity must split fees
// $2/$2. Out-of-range plans can compare this active scenario without claiming
// those fees are accruing now. The scenario values fee tokens at recorded prices.
for(const mode of ['uni','stable','balanced']){
  const input=uniDefaultInput(p,mode),liquidity=uniEstimate(p,input).liquidity;
  const pool={...p,activeLiquidity:liquidity,feeWindow:{...p.feeWindow,
    perL0Day:1/(liquidity*p.token0.usd),perL1Day:3/(liquidity*p.token1.usd)}};
  const r=uniEstimate(pool,input);
  near(r.activeFeesPerDay,2,'Equal liquidity shares the $4/day fee scenario equally');
  near(r.activeApr,.73,'Conditional APR annualizes $2/day over $1,000 initial capital');
  eq(r.feesPerDay,mode==='balanced'?r.activeFeesPerDay:0,'Current fees remain independent of a waiting plan’s estimate');
  const larger=uniEstimate(pool,{...input,amount:input.amount*2});
  near(larger.activeFeesPerDay,8/3,'Twice the deposit takes two thirds rather than all of the pool fees');
  near(larger.activeApr,(8/3)*365/2000,'Larger plans use their own capital as the APR denominator');
  ok(larger.activeFeesPerDay<4,'An added plan cannot collect more than the assumed pool fee budget');
  ok(larger.activeApr<r.activeApr,'Dilution lowers the rate per deposited dollar');
  for(const change of [{feeWindow:null},{activeLiquidity:0},{feeWindow:{...pool.feeWindow,toTs:pool.at-8*3600-1}}]){
    const unavailable=uniEstimate({...pool,...change},input);
    eq(unavailable.activeFeesPerDay,null,'Missing or expired evidence cannot invent a conditional fee rate');
    eq(unavailable.activeApr,null,'Missing or expired evidence cannot invent a conditional APR');
    eq(unavailable.feesPerDay,mode==='balanced'?null:0,'A waiting position earns zero even without an income forecast');
  }
  const quiet=uniEstimate({...pool,feeWindow:{...pool.feeWindow,perL0Day:0,perL1Day:0}},input);
  eq(quiet.activeFeesPerDay,0,'Verified zero activity is distinct from unavailable fee evidence');
  eq(quiet.activeApr,0,'A verified quiet pool has zero projected fee APR');
  const conservative=uniEstimate({...pool,feeWindow:{...pool.feeWindow,method:'swap_fee_lower_bound'}},input);
  near(conservative.activeFeesPerDay,2,'The conservative swap source supports the same conditional comparison');
  eq(conservative.feeBasis.method,'swap_fee_lower_bound','The conservative source remains explicit');
}

// Check actual tick boundaries and both token orders, including signed ticks.
// A default equal to spot must never unexpectedly demand the second asset.
for(const base of [0,1])for(const spacing of [1,10,60,200])for(const tick of [-10001,-60,0,9,9999])for(const fraction of [0,.25,.99]){
  const pool={...p,baseIndex:base,tickSpacing:spacing,tick,sqrtPrice:1.0001**((tick+fraction)/2),
    token0:base===1?{...p.token0}:{...p.token1},token1:base===1?{...p.token1}:{...p.token0}};
  pool.price=uniPriceFromSqrt(pool.sqrtPrice*2**96,pool);pool['token'+base].usd=pool.price;pool['token'+(1-base)].usd=1;
  for(const mode of ['uni','stable']){
    const input=uniDefaultInput(pool,mode),r=uniEstimate(pool,input);
    ok(!r.error,'Current-price '+mode+' entry works at signed/fractional usable ticks');
    eq(r.inRange,false,'Outward rounding preserves a single-sided deposit');
    eq(mode==='uni'?r.deposit.stable:r.deposit.uni,0,'The unselected asset is exactly absent');
    eq(r.feesPerDay,0,'An outside range earns zero at the recorded price');
    eq(r.apr,0,'Waiting positions display zero APR instead of a missing value');
    ok(Number.isFinite(r.activeFeesPerDay)&&r.activeFeesPerDay>0,'A waiting position still has an evidence-backed in-range estimate');
    near(r.activeApr,r.activeFeesPerDay*365/r.capitalUsd,'Both token orders use initial capital for the conditional APR');
    ok(mode==='uni'?r.range.lowerPrice>=pool.price*(1-1e-12):r.range.upperPrice<=pool.price*(1+1e-12),'The rounded entry remains on the correct side of spot');
    const displayed={...input,[mode==='uni'?'lowerPrice':'upperPrice']:Number(pool.price.toPrecision(9))};
    ok(!uniEstimate(pool,displayed).error,'Typing the displayed current price remains valid');
  }
}
console.log(`UNI recorded estimates and current-price single-sided entries: ${checks} assertions passed.`);
