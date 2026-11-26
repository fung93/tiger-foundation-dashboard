import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildUniFeeHistory,uniEstimatedFeeRate} from '../uni-fee-model.mjs';
import {uniEstimate} from '../uni-core.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;},near=(a,b,m)=>{assert.ok(Math.abs(a-b)<=Math.max(1e-10,Math.abs(b)*1e-8),m);n++;};
const file=name=>JSON.parse(readFileSync(new URL(name,import.meta.url))),book=file('../lpbook.json'),strategy=file('../uni-strategy.json'),snapshot=file('../uni-pools.json'),pool=snapshot.pools.find(p=>p.chain==='base'),before=JSON.stringify(book),built=buildUniFeeHistory(book);
eq(JSON.stringify(book),before,'Extracting fee history never rewrites a financial ledger');ok(built.observations.length>=3,'Real completed UNI positions supply rate evidence');
for(const o of built.observations){const adds=strategy.events.filter(e=>e.chain===o.chain).flatMap(e=>e.lp.filter(l=>l.id===o.id.split(':')[1]&&l.kind==='add'));
 if(adds.length===1)near(o.liquidity,Number(adds[0].liquidity),'Mint amounts reconstruct the independently recorded original receipt liquidity');
 ok(o.activeSeconds>=1800&&o.closedAt<=built.sourceAt,'Unfinished or momentary observations cannot train the estimate');}
const candidate=Object.values(book.positions).find(p=>built.observations.some(o=>o.id===p.key));
for(const mutate of [p=>p.unpriced=true,p=>p.status='open',p=>p.deposits.push({...p.deposits[0]}),p=>p.range.all_s--,p=>p.range.in_s=12,p=>p.frozen.incomplete=true,p=>delete p.frozen.fee_tokens,p=>p.frozen.fee_tokens[p.t0]=1000,p=>p.owed.r0='1',p=>p.wallet='0x'+'f'.repeat(40)]){
 const bad=structuredClone(book);mutate(bad.positions[candidate.key]);ok(!buildUniFeeHistory(bad).observations.some(o=>o.id===candidate.key),'Incomplete, repriced, topped-up or unowned history is excluded');}
const now=1800000000,q={...pool,at:now,token0:{...pool.token0,usd:1},token1:{...pool.token1,usd:2},feeWindow:{...pool.feeWindow,perL0Day:4e-12,perL1Day:3e-12}},
 obs=i=>({id:'base:'+i,chain:q.chain,pool:q.pool,fee:q.fee,a0:q.token0.address,a1:q.token1.address,d0:q.token0.decimals,d1:q.token1.decimals,openedAt:now-86400,closedAt:now-100,activeSeconds:21600,liquidity:1e12,fees0:.1,fees1:.2}),
 history={schemaVersion:'uni-fee-history-v1',sourceAt:now-50,observations:[1,2,3].map(obs)};
near(uniEstimatedFeeRate(q,history).perLiquidityDay,6e-12,'A known two-dollar earned unit rate and ten-dollar market unit rate blend to six; no fixed APR haircut');
near(uniEstimatedFeeRate(q,history).history.factor,.6,'The adjustment follows actual native earnings and the current market');
const high=structuredClone(history);for(const o of high.observations)o.fees0=100;
near(uniEstimatedFeeRate(q,high).perLiquidityDay,1e-11,'Older strong performance cannot inflate a weaker live rate');
for(const mutate of [h=>h.sourceAt=now+1000,h=>h.observations.pop(),h=>h.observations.forEach(o=>o.pool='0x'+'f'.repeat(40)),h=>h.observations.forEach(o=>o.closedAt=now+1),h=>h.observations.forEach(o=>{o.closedAt=now-8*86400;o.openedAt=now-9*86400;}),h=>h.observations.forEach(o=>o.activeSeconds=1800),h=>h.observations.forEach(o=>o.a0='0x'+'f'.repeat(40))]){
 const invalid=structuredClone(history);mutate(invalid);eq(uniEstimatedFeeRate(q,invalid).history,null,'Wrong-pool, future, stale or insufficient evidence cannot affect the quote');}
eq(uniEstimatedFeeRate({...q,feeWindow:{...q.feeWindow,method:'swap_fee_lower_bound'}},history).history,null,'A conservative partial swap bound is not discounted again');
const fixture=file('./fixtures/uni-apr-history.json'),scored=[];
for(const e of fixture.entries){
 ok(!e.historyCommittedAt||e.historyCommittedAt<=e.now,'Every historical book was available before the tested deposit');
 ok(!e.history||e.history.observations.every(o=>o.closedAt<=e.now),'The target position and future outcomes never enter its calibration');
 const original=uniEstimate(e.pool,e.input,{now:e.now}),updated=uniEstimate(e.pool,e.input,{now:e.now,history:e.history});
 eq(updated.range,original.range,'The actual chosen range stays intact');eq(updated.edges,original.edges,'Fee estimation never changes price P&L at either edge');eq(updated.deposit,original.deposit,'The update never changes capital or required token amounts');
 ok(updated.activeFeesPerDay<=original.activeFeesPerDay&&updated.activeFeesPerDay>=original.activeFeesPerDay*.5,'The market signal remains in the estimate');
 near(updated.activeApr,updated.activeFeesPerDay*365/updated.capitalUsd,'Fees/day and fee APR always use the identical estimate');
 if(!updated.inRange)eq(updated.feesPerDay,0,'Waiting single-sided positions still earn zero before entry');
 if(e.status==='closed')scored.push({actual:e.actual,before:original.activeFeesPerDay*e.inSeconds/86400,after:updated.activeFeesPerDay*e.inSeconds/86400,adjusted:!!updated.feeBasis?.history});
}
const actual=scored.reduce((s,r)=>s+r.actual,0),error=key=>scored.reduce((s,r)=>s+Math.abs(r[key]-r.actual),0)/actual*100,oldError=error('before'),newError=error('after');
eq(scored.length,19,'Replay covers every closed position in the audit');ok(newError<oldError*.6,'Past-data-only replay reduces weighted absolute fee error by more than 40%');ok(newError<35,'The measured error stays below the reviewed regression bound');
console.log(`UNI fee estimate evidence, independent liquidity, causal replay and accounting isolation: ${n} assertions passed; weighted error ${oldError.toFixed(2)}% → ${newError.toFixed(2)}% (${scored.filter(r=>r.adjusted).length} adjusted positions).`);
