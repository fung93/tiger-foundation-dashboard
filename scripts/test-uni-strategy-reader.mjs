import assert from 'node:assert/strict';
import {advanceUniStrategy} from '../api/_uni-strategy-reader.mjs';
import {emptyUniStrategy,replayUniStrategy,valueUniStrategy} from '../uni-strategy-core.mjs';
import {strategyRpcFixture} from './fixtures/uni-strategy-rpc.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(a,m)=>{assert.ok(a,m);n++;};
const advance=(book,f,extra={})=>advanceUniStrategy(book,{trade:f.trade,lpBook:f.lpBook,rpcFactory:()=>f.rpc,readBatchFactory:()=>f.readBatch,now:()=>f.now*1000,...extra});
for(const scenario of ['open','closed','pending','reuse','topup','internal','partial']){
 const f=strategyRpcFixture(scenario),empty=emptyUniStrategy(f.book.wallets),before=JSON.stringify(empty),r=await advance(empty,f);
 eq(r.errors,{},'All receipt/block/balance proofs pass: '+scenario);eq(r.complete,true,'Complete receipt interval: '+scenario);
 eq(r.book.events.length,f.book.events.length,'USDC-only closes and Decrease-only receipts are discovered: '+scenario);
 const total=valueUniStrategy(replayUniStrategy(r.book),{trade:f.trade,lpView:f.lpView});ok(Math.abs(total.pnlUsd+10)<1e-7,'Receipt-derived capital/P&L reconciles: '+scenario);
 eq(JSON.stringify(empty),before,'Source checkpoint is immutable: '+scenario);
 const second=await advance(r.book,f);eq(second.book.events.length,r.book.events.length,'Warm refresh does not duplicate receipts: '+scenario);
}
const discovered=strategyRpcFixture('reuse',{discover:true}),found=await advance(emptyUniStrategy(discovered.book.wallets),discovered);
eq(found.complete,true,'New owned NFTs are discovered from Transfer receipts without waiting for LP Book');eq(Object.keys(found.book.positions).length,2,'Both fresh and closed canonical UNI pools are verified');
const failed=strategyRpcFixture('reuse',{badReceipt:true}),bad=await advance(emptyUniStrategy(failed.book.wallets),failed);
eq(bad.complete,false,'A log missing from its receipt cannot become a complete reading');eq(bad.book.chains.base.cursor,99,'The failed interval does not advance its cursor');eq(bad.book.events.length,0,'Provisional receipts are not saved');
const recovered=strategyRpcFixture('reuse'),retry=await advance(bad.book,recovered);eq(retry.complete,true,'The same saved checkpoint recovers after source repair');
const removed=strategyRpcFixture('closed',{removed:true}),gone=await advance(emptyUniStrategy(removed.book.wallets),removed);eq(gone.complete,false,'Removed ERC20 logs cannot be used as cash evidence');eq(gone.book.chains.base.cursor,99,'Removed logs retain the unread interval');
const reorg=strategyRpcFixture('reuse',{reorg:true}),changed=await advance(retry.book,reorg);eq(changed.complete,false,'Changed checkpoint hash cannot rewrite history');eq(changed.book.events,retry.book.events,'Saved receipts survive a provider/checkpoint conflict');
const limited=strategyRpcFixture('reuse'),paused=await advance(emptyUniStrategy(limited.book.wallets),limited,{maxWindows:0});eq(paused.complete,false,'Read budget exhaustion cannot report complete empty funding');eq(paused.book.chains.base.cursor,99,'Bounded reader can resume from its saved start');
const resumed=await advance(paused.book,limited);eq(resumed.complete,true,'The next bounded pass completes without a reset');
const noTrade=strategyRpcFixture('reuse');noTrade.trade.trades=[];const awaiting=await advance(emptyUniStrategy(noTrade.book.wallets),noTrade);eq(awaiting.complete,false,'A cash-for-UNI receipt must wait for verified trade consideration');ok(/trade verification/.test(awaiting.errors.base),'Unknown fills are explained as pending, never guessed');
const noBalance=strategyRpcFixture('closed');const failRpc=noBalance.rpc;noBalance.rpc=async(m,p)=>{if(m==='eth_call')throw Error('Controlled balance outage');return failRpc(m,p);};const provisional=await advance(emptyUniStrategy(noBalance.book.wallets),noBalance);eq(provisional.complete,false,'Missing current balances cannot finalize a financial checkpoint');eq(provisional.book.chains.base.cursor,99,'The final interval rolls back until balance/liquidity proofs pass');eq(provisional.book.events.length,0,'Unconfirmed final financial events cannot strand recovery');
eq((await advance(provisional.book,recovered)).complete,true,'Recovery re-reads the provisional final interval');
const blank=strategyRpcFixture('closed');blank.trade.trades=[];blank.readBatch=async filters=>filters.map(()=>[]);const rawRpc=blank.rpc;blank.rpc=async(m,p)=>m==='eth_getLogs'?[]:rawRpc(m,p);const noHistory=await advance(emptyUniStrategy(blank.book.wallets),blank);eq(noHistory.complete,false,'A false empty log response cannot erase an independently known closed LP');ok(/known UNI LP/.test(noHistory.errors.base),'Missing established LP history stays explicit');eq(noHistory.book.chains.base.cursor,99,'False empty final intervals remain retryable');
console.log(`UNI strategy receipt proofs, balances, bounded recovery and new NFTs: ${n} assertions passed.`);
