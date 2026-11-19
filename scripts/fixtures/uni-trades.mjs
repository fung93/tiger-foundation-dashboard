import {uniFixture} from './uni.mjs';
import {CFG} from '../../api/_core.mjs';
import {TRANSFER,SWAPS} from '../../uni-trade-core.mjs';
export const H=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),hex=n=>'0x'+n.toString(16);
const indexed=a=>'0x'+a.slice(2).padStart(64,'0');
export function tradeReceipt(chain, {owner=CFG.wallets[0].address,pool='0x'+'1'.repeat(40),side='buy',uni=10,usd=80,block=999950,nonce=0}={}){
 const stable=chain.stables[0],router='0x'+'a'.repeat(40),hash=H(block*10+nonce),blockHash=H(block),inward=side==='buy',
  transfer=(token,from,to,raw)=>({address:token,topics:[TRANSFER,indexed(from),indexed(to)],data:H(raw),blockNumber:hex(block),transactionHash:hash,blockHash,logIndex:'0x0'}),
  transaction={hash,blockHash,blockNumber:hex(block),from:owner,to:router,nonce:hex(nonce),value:'0x0'};
 return {transaction,receipt:{transactionHash:hash,blockNumber:hex(block),blockHash,transactionIndex:'0x0',status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00',logs:[
  transfer(chain.uni.address,inward?pool:owner,inward?owner:pool,BigInt(uni)*10n**18n),
  transfer(stable.address,inward?owner:pool,inward?pool:owner,BigInt(usd)*10n**BigInt(stable.decimals)),
  {address:pool,topics:[[...SWAPS][0]],data:'0x',blockNumber:hex(block),blockHash,transactionHash:hash,logIndex:'0x2'}]}};
}
export function uniTradeFixture(key='base', options={}){
 const f=uniFixture(key),head=1000000,main=CFG.wallets[0].address,entries=options.entries||[
  tradeReceipt(f.chain,{pool:f.pool,block:head-50,nonce:0}),tradeReceipt(f.chain,{pool:f.pool,block:head-10,nonce:1,side:'sell',uni:4,usd:40})];
 const calls=[];
 const count=(owner,block)=>entries.filter(e=>e.transaction.from===owner&&Number(BigInt(e.transaction.blockNumber))<=block).length;
 const rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='eth_getTransactionCount')return hex(count(params[0],Number(BigInt(params[1]))));
  if(method==='eth_getCode')return '0x';
  if(method==='eth_getBlockByNumber'){
   const value=await f.rpc(method,params);if(params[1])value.transactions=entries.filter(e=>e.receipt.blockNumber===params[0]).map(e=>e.transaction);return value;
  }
  if(method==='eth_getTransactionReceipt')return entries.find(e=>e.transaction.hash===params[0])?.receipt||null;
  if(method==='eth_getLogs')throw Error('A nonce-indexed trade reader must not scan pool logs');
  return f.rpc(method,params);
 };
 return {...f,head,main,entries,rpc,calls};
}
