import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {CFG} from '../api/_core.mjs';
import {receiptUniTrade,replayUniTrades,validateUniTradeBook} from '../uni-trade-core.mjs';
import {advanceUniTrades,emptyUniTradeBook,validUniTradeBook,firstWalletActivity} from '../api/_uni-trades.mjs';
import {updateUniTrades} from './uni-trades.mjs';
import {uniTradeFixture,tradeReceipt,H,hex} from './fixtures/uni-trades.mjs';
let checks=0;const eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},ok=(v,n)=>{assert.ok(v,n);checks++;},near=(a,b,n)=>ok(Math.abs(a-b)<1e-8,n);
const wallets=CFG.wallets.map(w=>w.address),clone=structuredClone;
function decode(chain,entry,more={}){return receiptUniTrade({chain,wallets,...entry,ts:1794661100,verifiedPools:[entry.receipt.logs.at(-1).address],...more});}
for(const chain of Object.values(UNI_CHAINS)){
 const buy=decode(chain,tradeReceipt(chain)),sell=decode(chain,tradeReceipt(chain,{side:'sell',uni:4,usd:40,nonce:1,block:999990}));
 eq(buy.trade.usd,80,'Actual stablecoin consideration uses '+chain.name+' token decimals');eq(buy.trade.price,8,'The event price is the execution price');
 eq(sell.trade.side,'sell','Outgoing UNI plus incoming quote is a sale');near(buy.trade.gas,.000021,'Native gas is stored without inventing a historical USD price');
 const current=replayUniTrades([sell.trade,buy.trade],{[chain.key]:{priceUsd:9}});
 near(current.qty,6,'A partial sale preserves six UNI');near(current.cost,48,'Sold UNI leaves at average cost');near(current.avg,8,'A sale does not change the remaining average');near(current.value,54,'Current price values only remaining trade units');near(current.unrealized,6,'Unrealised P&L subtracts remaining basis');near(current.realized,8,'Realised P&L uses actual proceeds and historical basis');
 const original=JSON.stringify(buy.trade);replayUniTrades([buy.trade],{[chain.key]:{priceUsd:999}});eq(JSON.stringify(buy.trade),original,'Current prices never rewrite a historical fill');
 const unknown=decode(chain,tradeReceipt(chain),{verifiedPools:[]}).trade;eq(unknown.usd,null,'Unproven pool identity cannot create a dollar price');eq(replayUniTrades([unknown],{[chain.key]:{priceUsd:9}}).avg,null,'Missing trade costs are unavailable, never zero');
 const absentGas=tradeReceipt(chain);delete absentGas.receipt.effectiveGasPrice;eq(decode(chain,absentGas).trade.gas,null,'Missing native gas is not zero');
 eq(replayUniTrades([buy.trade]).value,null,'A current-price failure is not a zero value');
 for(const topic of ['0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f','0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4','0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01','0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683']){
  const e=tradeReceipt(chain);e.receipt.logs.push({topics:[topic]});eq(decode(chain,e).reason,'liquidity_or_claim','Liquidity changes, fee collections and claims never become buys/sells');
 }
 const transfer=tradeReceipt(chain);transfer.receipt.logs.pop();eq(decode(chain,transfer,{verifiedPools:[]}).reason,'transfer_only','A plain transfer is not a purchase');
 const internal=tradeReceipt(chain);internal.receipt.logs[0].topics[1]='0x'+wallets[1].slice(2).padStart(64,'0');eq(decode(chain,internal).reason,'internal_or_no_uni_change','Moving tokens between owned wallets is not a sale');
 const received=tradeReceipt(chain);received.transaction.from='0x'+'b'.repeat(40);eq(decode(chain,received).reason,'not_wallet_initiated','Unsolicited inbound activity does not become an owned swap');
 const reverted=tradeReceipt(chain);reverted.receipt.status='0x0';assert.throws(()=>decode(chain,reverted));checks++;
}
const base=UNI_CHAINS.base,bnb=UNI_CHAINS.bnb;
const b=decode(base,tradeReceipt(base)).trade,c=decode(bnb,tradeReceipt(bnb,{uni:20,usd:200})).trade;
const mixed=replayUniTrades([b,c],{base:{priceUsd:9},bnb:{priceUsd:11}});near(mixed.qty,30,'Two networks combine quantity');near(mixed.avg,280/30,'Combined average weights actual costs');near(mixed.unrealized,30,'Each network uses its own current quote');
const onlyBNBSale=decode(bnb,tradeReceipt(bnb,{side:'sell',uni:2,usd:30})).trade;
const separate=replayUniTrades([b,onlyBNBSale],{base:{priceUsd:9},bnb:{priceUsd:11}});eq(separate.qty,10,'A BNB sale cannot consume the Base cost basis');eq(separate.realized,null,'Sales without a known buy basis cannot report invented profits');
const weighted=decode(base,tradeReceipt(base,{uni:20,usd:200,block:999980})).trade;near(replayUniTrades([b,weighted],{base:{priceUsd:9}}).avg,280/30,'Additional buys use weighted average, not the last price');
const empty=emptyUniTradeBook();eq(validUniTradeBook(empty),empty,'A new ledger is structurally valid');
for(const mutate of [f=>f.version++,f=>f.wallets.reverse(),f=>f.trades=[b,b],f=>f.trades=[{...b,usd:-1}],f=>f.trades=[{...b,raw:'1'}],f=>f.trades=[{...b,price:99}],f=>f.chains.base={chainId:1}]){
 const bad=clone(empty);mutate(bad);assert.throws(()=>validateUniTradeBook(bad,UNI_CHAINS,wallets));checks++;
 let network=0;await assert.rejects(()=>advanceUniTrades(bad,{rpcFactory:()=>{network++;throw Error('Should not read');}}));eq(network,0,'Bad saved history fails before network reads');
}
const fixtures={base:uniTradeFixture('base'),bnb:uniTradeFixture('bnb',{entries:[]})};
const opts={rpcFactory:chain=>fixtures[chain.key].rpc,now:()=>fixtures.base.now*1000};
const first=await advanceUniTrades(empty,{...opts,maxWindows:1});eq(first.complete,false,'A bounded first pass reports incomplete history');eq(first.book.trades.length,1,'The first confirmed buy is checkpointed');ok(first.book.chains.base.cursor<fixtures.base.head,'Unscanned history never advances to head');
const finished=await advanceUniTrades(first.book,{...opts,maxWindows:1});eq(finished.complete,true,'The second pass reaches both verified heads');eq(finished.book.trades.length,2,'Retry does not duplicate the saved buy');near(replayUniTrades(finished.book.trades,finished.quotes).unrealized,0,'On-chain replay uses its independently read spot price');
const again=await advanceUniTrades(finished.book,opts);eq(again.book.trades,finished.book.trades,'Unchanged heads leave all fills byte-for-byte unchanged');eq(again.complete,true,'Nonce-zero BNB is proven empty, not missing');
for(const f of Object.values(fixtures))eq(f.calls.filter(c=>c.method==='eth_getLogs').length,0,'Historical nonce search does not need an unreliable log indexer');
const fail=await advanceUniTrades(first.book,{...opts,rpcFactory:chain=>chain.key==='base'?async(m,p)=>{if(m==='eth_getTransactionReceipt')throw Error('Receipt unavailable');return fixtures.base.rpc(m,p);}:fixtures.bnb.rpc});
eq(fail.complete,false,'A receipt failure is not a complete history');eq(fail.book.trades,first.book.trades,'A failed block cannot append a partial fill');eq(fail.book.chains.base.cursor,first.book.chains.base.cursor,'Failed block cursor stays retryable');
const recovery=await advanceUniTrades(fail.book,opts);eq(recovery.complete,true,'Recovered receipt finishes the same source range');eq(recovery.book.trades.length,2,'Recovery appends the missing sale exactly once');
const reorg=await advanceUniTrades(finished.book,{...opts,rpcFactory:chain=>chain.key==='base'?async(m,p)=>m==='eth_getBlockByNumber'&&Number(BigInt(p[0]))===finished.book.chains.base.cursor?{number:p[0],hash:H(5),timestamp:hex(fixtures.base.now)}:fixtures.base.rpc(m,p):fixtures.bnb.rpc});
eq(reorg.complete,false,'A changed checkpoint fails closed');eq(reorg.book.trades,finished.book.trades,'A source reorg cannot silently rewrite saved fills');
const missingBlock=await advanceUniTrades(first.book,{...opts,rpcFactory:chain=>chain.key==='base'?async(m,p)=>{const v=await fixtures.base.rpc(m,p);return m==='eth_getBlockByNumber'&&p[1]?{...v,transactions:[]}:v;}:fixtures.bnb.rpc});
ok(missingBlock.errors.base.includes('Incomplete UNI transaction block'),'Nonce changes detect a truncated full block');eq(missingBlock.book.trades,first.book.trades,'Truncated block keeps prior history intact');
const quoteFail=await advanceUniTrades(finished.book,{...opts,rpcFactory:chain=>async(m,p)=>{if(m==='eth_call')throw Error('Quote timeout');return fixtures[chain.key].rpc(m,p);}});eq(quoteFail.complete,true,'Quote outages do not erase verified trade coverage');eq(Object.keys(quoteFail.quotes).length,0,'Missing prices remain absent');ok(quoteFail.errors.base_quote&&quoteFail.errors.bnb_quote,'Independent quote failures stay explicit');
await assert.rejects(()=>firstWalletActivity(async()=>{throw Error('Historical nonce unavailable');},wallets[0],100));checks++;
eq(await firstWalletActivity(async()=> '0x0',wallets[0],100),101,'Zero nonce proves no wallet-initiated trades');
const dir=await mkdtemp(join(tmpdir(),'uni-trade-'));try{
 await writeFile(join(dir,'lpbook.json'),'untouched');await writeFile(join(dir,'kat-trades.json'),'untouched');
 const saved=await updateUniTrades(dir,{advance:async()=>finished});eq(saved.complete,true,'The scheduled writer saves the verified book');eq((await readdir(dir)).sort(),['kat-trades.json','lpbook.json','uni-trades.json'],'The UNI writer creates only its own ledger');eq(await readFile(join(dir,'lpbook.json'),'utf8'),'untouched','LP accounting is preserved');eq(await readFile(join(dir,'kat-trades.json'),'utf8'),'untouched','KAT accounting is preserved');
 await writeFile(join(dir,'uni-trades.json'),'{invalid');let ran=false;await assert.rejects(()=>updateUniTrades(dir,{advance:async()=>{ran=true;}}));eq(ran,false,'A malformed persisted ledger never starts a replacement history');
}finally{await rm(dir,{recursive:true,force:true});}
console.log(`UNI swap classification, deterministic cost basis and resumable read-only history: ${checks} assertions passed.`);
