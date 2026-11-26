import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CFG,pad,keccakHex} from '../api/_core.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {createUniTransferBatch} from '../api/_uni-transfers.mjs';
import {scanUniFlows} from '../api/_uni-flow-reader.mjs';
import {emptyUniTradeBook,validUniTradeBook,advanceUniTradeFeed} from '../api/_uni-trades.mjs';
import {TRANSFER,ONEINCH_PROTOCOL} from '../uni-trade-core.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;},H=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),hex=n=>'0x'+n.toString(16),owners=CFG.wallets.map(w=>w.address),base=UNI_CHAINS.base;
const filter=(from,to,side=2,chain=base)=>{const topics=[TRANSFER,null,null];topics[side]=owners.map(o=>'0x'+pad(o));return {address:chain.uni.address,topics,fromBlock:hex(from),toBlock:hex(to)};};
let calls=[];
const rpc=createUniTransferBatch({...base,rpcs:['https://closed-source.invalid']},{fetcher:async(url,options)=>{const request=JSON.parse(options.body);calls.push({url,request});if(!Array.isArray(request))return Response.json({result:'0x2105'});return Response.json(request.map(q=>({id:q.id,result:[]})).reverse());}});
eq(await rpc([filter(10,20),filter(10,20,1)]),[[],[]],'Response IDs restore the exact caller order');ok(calls.every(c=>Array.isArray(c.request)?c.request.every(r=>r.method==='eth_getLogs'):c.request.method==='eth_chainId'),'The batch transport can only read chain identity and fixed UNI transfer logs');
let before=calls.length;await assert.rejects(()=>rpc([{...filter(10,20),address:'0x'+'f'.repeat(40)}]));eq(calls.length,before,'An arbitrary contract is rejected before network access');
await assert.rejects(()=>rpc([filter(0,50000)]));n++;
const bad=createUniTransferBatch({...base,rpcs:['https://closed-source.invalid']},{fetcher:async(_u,options)=>{const request=JSON.parse(options.body);if(!Array.isArray(request))return Response.json({result:'0x2105'});return Response.json(request.map(()=>({id:0,result:[]})));}});
await assert.rejects(()=>bad([filter(10,20),filter(10,20,1)]),/Incomplete/);n++;
let small=0;
const narrow=createUniTransferBatch({...UNI_CHAINS.bnb,rpcs:['https://56.rpc.thirdweb.com']},{fetcher:async(_u,options)=>{const request=JSON.parse(options.body);if(!Array.isArray(request))return Response.json({result:'0x38'});for(const q of request){ok(BigInt(q.params[0].toBlock)-BigInt(q.params[0].fromBlock)<1000n,'The verified BNB archive peer receives only its supported 1,000-block windows');small++;}return Response.json(request.map(q=>({id:q.id,result:[]})));}});
eq(await narrow([filter(100000,149999,2,UNI_CHAINS.bnb)]),[[]],'Fifty complete small windows form one complete outer interval');eq(small,50,'No historical subrange is skipped at the provider-specific limit');
const fixture=JSON.parse(readFileSync(new URL('./fixtures/uni-limit-fills.json',import.meta.url))),entries=fixture.entries,head=Math.max(...entries.map(e=>Number(BigInt(e.receipt.blockNumber))))+1,tip={number:head,hash:H(head),ts:Math.max(...entries.map(e=>e.ts))+1},K=s=>keccakHex(Buffer.from(s).toString('hex')),hash=keccakHex,
 domain=hash(K('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')+K('1inch Aggregation Router')+K('6')+pad(base.id.toString(16))+pad(ONEINCH_PROTOCOL)),type=K('Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)');
let failReceipt=false;
const read=async(method,params)=>{
 if(method==='eth_blockNumber')return hex(head);
 if(method==='eth_call'){if(params[0].to===base.uni.address)return H(0);if(params[0].to===ONEINCH_PROTOCOL)return '0x'+hash('1901'+domain+hash(type+params[0].data.slice(10)));throw Error('Unexpected contract');}
 if(method==='eth_getTransactionReceipt'){if(failReceipt&&params[0]==='0x4e569b5d534451f8b56c73ab45513507bd1ed841fb40b3526568c5e60595b814')return null;return entries.find(e=>e.receipt.transactionHash===params[0])?.receipt;}
 if(method==='eth_getTransactionByHash')return entries.find(e=>e.transaction.hash===params[0])?.transaction;
 if(method==='eth_getBlockByNumber'){const number=Number(BigInt(params[0])),entry=entries.find(e=>Number(BigInt(e.receipt.blockNumber))===number);return {number:params[0],hash:entry?.receipt.blockHash||H(number),timestamp:hex(entry?.ts||tip.ts)};}
 throw Error('Unexpected read '+method);
};
const readBatch=async filters=>filters.map(f=>entries.flatMap(e=>e.receipt.logs).filter(l=>l.address===base.uni.address&&l.topics[0]===TRANSFER&&BigInt(l.blockNumber)>=BigInt(f.fromBlock)&&BigInt(l.blockNumber)<=BigInt(f.toBlock)&&f.topics.slice(1).every((topics,i)=>!topics||topics.includes(l.topics[i+1]))));
const fresh=()=>{const b=emptyUniTradeBook();b.chains.base={chainId:8453,uni:base.uni.address,startBlock:58688016,cursor:head,cursorHash:tip.hash,head,ts:tip.ts};return b;},opts={maxWindows:32,readBatch,provePool:async()=>[],readReturnPrice:async()=>5.2,quote:{pool:'0x1261d6c23a2d719e2543d2d51aec87656050b70d'}};
const book=fresh();await scanUniFlows(book,base,read,tip,opts);eq(book.trades.length,3,'Complete transfer discovery finds all resolver fills despite another transaction sender');eq(book.flows.length,8,'LP principal changes remain inventory events, not additional trades');eq(book.chains.base.transferCursor,head,'The cursor advances only over complete verified transfer intervals');validUniTradeBook(book);n++;
const original=JSON.stringify(book.trades);await scanUniFlows(book,base,read,tip,opts);eq(JSON.stringify(book.trades),original,'Repeating a completed scan never duplicates or reprices fills');
const failed=fresh();failReceipt=true;await assert.rejects(()=>scanUniFlows(failed,base,read,tip,opts),/receipt unavailable/);eq(failed.trades.length,0,'An unavailable resolver receipt does not publish a partial fill');eq(failed.chains.base.transferCursor,failed.chains.base.transferStart-1,'The failed interval stays retryable');failReceipt=false;await scanUniFlows(failed,base,read,tip,opts);eq(failed.trades.length,3,'Receipt recovery catches all fills exactly once');
const incomplete=fresh();await assert.rejects(()=>scanUniFlows(incomplete,base,read,tip,{...opts,readBatch:async filters=>(await readBatch(filters)).slice(1)}),/Incomplete/);eq(incomplete.trades.length,0,'A missing RPC batch result cannot become an empty history');
const reorg=structuredClone(book);reorg.chains.base.transferHash=H(1);await assert.rejects(()=>scanUniFlows(reorg,base,read,tip,opts),/checkpoint changed/);eq(reorg.trades,book.trades,'A source reorg preserves booked execution amounts');
let fast=fresh();Object.assign(fast.chains.base,{recentStart:58688016,recentCursor:58688015,recentHash:null,recentOpeningUni:null});let latest;
for(let i=0;i<8&&fast.chains.base.recentCursor<head;i++){latest=await advanceUniTradeFeed(fast,{rpcFactory:()=>read,readTransferBatch:(_c,filters)=>readBatch(filters),now:()=>tip.ts*1000});fast=latest.book;}
eq(fast.chains.base.recentCursor,head,'Short recent passes resume the saved checkpoint without skipping an unread gap');eq(latest.checked.base,true,'A completed actual maker-fill interval receives a current proof');
eq([...fast.trades].sort((a,b)=>a.id.localeCompare(b.id)),[...book.trades].sort((a,b)=>a.id.localeCompare(b.id)),'The lightweight reader preserves all three real 1inch fills and their exact original costs');eq(fast.flows.length,8,'Actual LP deposits and collections stay outside the simple buy/sell table');
console.log(`UNI transfer batching, actual maker-fill discovery and safe recovery: ${n} assertions passed.`);
