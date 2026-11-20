import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CFG,keccakHex,pad} from '../api/_core.mjs';
import {uniTradeOverview} from '../uni-accounting.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {uniOrderCandidates,verifyUniOrders} from '../api/_uni-orders.mjs';
import {receiptUniTrade,replayUniTrades,ONEINCH_PROTOCOL,ONEINCH_FILLED} from '../uni-trade-core.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},near=(a,b,m)=>{assert.ok(Math.abs(a-b)<1e-9,m+': '+a+' vs '+b);n++;};
const fixture=JSON.parse(readFileSync(new URL('./fixtures/uni-limit-fills.json',import.meta.url))),wallets=CFG.wallets.map(w=>w.address),chain=UNI_CHAINS.base,K=s=>keccakHex(Buffer.from(s).toString('hex')),H=keccakHex,
 domain=H(K('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')+K('1inch Aggregation Router')+K('6')+pad(chain.id.toString(16))+pad(ONEINCH_PROTOCOL)),
 type=K('Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)'),orderHash=encoded=>'0x'+H('1901'+domain+H(type+encoded)),trades=[];
for(const e of fixture.entries){
 const events=e.receipt.logs.filter(l=>l.address===ONEINCH_PROTOCOL&&l.topics[0]===ONEINCH_FILLED);if(!events.length)continue;
 const candidates=uniOrderCandidates(chain,wallets,e.transaction);eq(candidates.length,1,'The packed resolver calldata contains one owned UNI order');eq(orderHash(candidates[0].encoded),events[0].data.slice(0,66),'Independent EIP-712 calculation binds actual resolver calldata to the recorded on-chain fill');
 let reads=0;const rpc=async(method,params)=>{reads++;eq(method,'eth_call','Verification can only read the deployed order hash');eq(params[0].to,ONEINCH_PROTOCOL,'The official protocol contract supplies the proof');eq(params[0].data.slice(0,10),'0x802b2ef1','The actual eight-word hashOrder ABI is used');eq(params[1],e.receipt.blockNumber,'Verification is pinned to the fill block');return orderHash(params[0].data.slice(10));};
 const orders=await verifyUniOrders(chain,wallets,rpc,e.receipt,e.transaction);eq(orders.length,1,'The protocol hash matches the emitted order hash');eq(reads,1,'No model, quote API or wallet signature is required');
 const found=receiptUniTrade({chain,wallets,...e,verifiedOrders:orders}).trade;eq(found.route,'1inch_limit','A resolver fill does not require a wallet-initiated transaction');eq(found.gasPayer,'resolver','Resolver-paid gas is not charged to the owner');eq(found.gas,null,'Resolver gas cannot enter owner fees');eq(found.verified,true,'The matched maker order and real payment are verified');trades.push(found);
 const spoof=structuredClone(e.receipt);spoof.logs.find(l=>l.topics[0]===ONEINCH_FILLED).address='0x'+'a'.repeat(40);eq((await verifyUniOrders(chain,wallets,rpc,spoof,e.transaction)).length,0,'An event from another emitter cannot authenticate a trade');
 const wrong=await verifyUniOrders(chain,wallets,async()=> '0x'+'f'.repeat(64),e.receipt,e.transaction);eq(wrong.length,0,'A hash mismatch cannot authenticate an unrelated order');
}
eq(trades.length,3,'All three actual fill transactions are recorded');eq(new Set(trades.flatMap(t=>t.orderHashes)).size,2,'Two fills of the same partial order remain separate transactions');eq(new Set(trades.map(t=>t.id)).size,3,'Partial fills are deduplicated by transaction, not discarded by shared order hash');
const summary=replayUniTrades(trades);near(summary.qty,19.09969908869371,'Buy quantity is UNI actually received after 1inch fees');near(summary.cost,99.982335,'Buy cost is USDC actually paid');near(summary.avg,5.2347596962501735,'Average cost includes all three executions');
near(uniTradeOverview({trade:{trades,historyComplete:true}}).averageBuyPriceUsd,5.2347596962501735,'Dashboard average uses the actual partial-fill consideration and received UNI');
const second=trades[1],third=trades[2];near(second.usd+third.usd,49.999999,'The last unfilled USDC micro-unit is not booked as a purchase');
const malicious={...fixture.entries.find(e=>uniOrderCandidates(chain,wallets,e.transaction).length).transaction,input:'0x'+('ff'.repeat(500001))};assert.throws(()=>uniOrderCandidates(chain,wallets,malicious));n++;
console.log(`Recorded 1inch resolver fills, partial orders and actual cost: ${n} assertions passed.`);
