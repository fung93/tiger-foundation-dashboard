import assert from 'node:assert/strict';
import {readUniChain} from '../api/_uni-reader.mjs';
import {uniFixture} from './fixtures/uni.mjs';
import {uniReadingStatus,uniEstimate,uniDefaultInput,uniPriceFromSqrt} from '../uni-core.mjs';
let checks=0;const ok=(v,n)=>{assert.ok(v,n);checks++;},eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;};
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
}
eq(uniReadingStatus({...p,status:'partial'},{now:p.at}).ready,true,'Successful alternate evidence is usable despite an unavailable optional method');
eq(uniReadingStatus({...p,status:'partial'},{now:p.at}).live,true,'A current alternate-source reading remains current');
const expired=uniEstimate(p,balanced,{now:p.at+8*3600+1});ok(expired.error,'A truly expired price cannot generate an estimate');
eq(uniReadingStatus({...p,feeWindow:null},{now:p.at}).ready,false,'Missing fee evidence is not ready');
const staleWindow={...p,at:p.at+3600,feeWindow:{...p.feeWindow,fromTs:p.at-8*3600-86400,toTs:p.at-8*3600}};
eq(uniReadingStatus(staleWindow,{now:staleWindow.at}).fees,false,'A fresh price cannot renew an old fee window');
eq(uniEstimate(staleWindow,balanced,{now:staleWindow.at}).feesPerDay,null,'An expired fee basis is unavailable rather than zero');
eq(uniReadingStatus({...p,activeLiquidity:0},{now:p.at}).ready,false,'No active liquidity cannot promise in-range earnings');

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
    ok(mode==='uni'?r.range.lowerPrice>=pool.price*(1-1e-12):r.range.upperPrice<=pool.price*(1+1e-12),'The rounded entry remains on the correct side of spot');
    const displayed={...input,[mode==='uni'?'lowerPrice':'upperPrice']:Number(pool.price.toPrecision(9))};
    ok(!uniEstimate(pool,displayed).error,'Typing the displayed current price remains valid');
  }
}
console.log(`UNI recorded estimates and current-price single-sided entries: ${checks} assertions passed.`);
