import assert from 'node:assert/strict';
import {readPositionCostEvidence} from '../api/_agent-cost-reader.mjs';
import {CFG} from '../api/_core.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};
const owner=CFG.wallets[0].address,tx='0x'+'1'.repeat(64),blockHash='0x'+'2'.repeat(64),topic='0x'+'1'.padStart(64,'0');
const event='0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const log={address:CFG.npm,topics:[event,topic],blockNumber:'0x64',blockHash,transactionHash:tx};
const receipt={transactionHash:tx,blockNumber:'0x64',blockHash,from:owner,status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[log]};
const book={tokens:{},positions:{'katana:1':{id:'1',wallet:owner,deposits:[{block:100}],withdrawals:[],claims:[]}}};
let modes={},calls=[];
const rpc=async(url,method,args)=>{calls.push({url,method,args});if(method==='eth_getLogs')return [{...log,...modes.log}];
 if(method==='eth_getTransactionReceipt')return {...receipt,...modes.receipt};throw Error('Unapproved RPC method');};
const run=()=>readPositionCostEvidence({book,chain:'katana',positionId:'1',readRpc:rpc,readPrice:async()=>2000});
let result=await run();
check(result.receipts.length,1,'Known LP events discover their exact transaction receipt');
check(result.receipts[0].nativeRaw,'100000000000000','Gas comes from receipt usage times actual gas price');
check(Math.abs(result.gasUsd-.2)<1e-10,true,'Gas receives its historical native-token price proxy');
check(result.complete,false,'Identified receipts never prove all lifetime LP costs or financing');
check(calls.every(row=>['eth_getLogs','eth_getTransactionReceipt'].includes(row.method)),true,'The reader invokes fixed read-only RPC methods');
for(const change of [{from:'0x'+'9'.repeat(40)},{blockHash:'0x'+'3'.repeat(64)},{blockNumber:'0x65'},{status:'0x0'},{effectiveGasPrice:null}]){
 modes={receipt:change};check((await run()).receipts.length,0,'Foreign, failed or malformed receipts cannot become owner costs');}
modes={receipt:{logs:[log,{...log,topics:[event,'0x'+'2'.padStart(64,'0')]}]}};
result=await run();check(result.receipts[0].shared,true,'A transaction touching another NFT is marked shared');
check(result.gasUsd,null,'The whole transaction is not charged to each LP');
modes={log:{removed:true}};check((await run()).receipts.length,0,'Removed logs never become expense evidence');
await assert.rejects(()=>readPositionCostEvidence({book,chain:'katana',positionId:'2',readRpc:rpc}),e=>e.status===400);n++;
await assert.rejects(()=>readPositionCostEvidence({book,chain:'invented',positionId:'1',readRpc:rpc}),e=>e.status===400);n++;
console.log('Read-only LP gas evidence: '+n+' assertions passed.');
