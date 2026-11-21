/* ABI-shaped closed RPC for receipt/coverage proofs; no external requests. */
import {strategyFixture,A,B,UNI,USDC,NPM,POOL,H,ZERO} from './uni-strategy.mjs';
import {CFG} from '../../api/_core.mjs';
import {UNI_MULTICALL} from '../../api/_uni-config.mjs';
import {TRANSFER} from '../../uni-trade-core.mjs';
import {strategyTokens} from '../../uni-strategy-core.mjs';
const INC='0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',DEC='0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',COL='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const word=v=>BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0'),data=(...vs)=>'0x'+vs.map(word).join(''),hex=n=>'0x'+n.toString(16);
export function strategyRpcFixture(scenario='reuse',options={}){
 const source=strategyFixture(scenario),text=JSON.stringify({book:source.book,trade:source.trade,lpView:source.lpView}).replaceAll(A,CFG.wallets[0].address).replaceAll(B,CFG.wallets[1].address),f=JSON.parse(text),s=f.book.chains.base,owners=f.book.wallets,head=options.head??s.head,now=s.ts,calls=[],receipts=new Map(),transactions=new Map();
 for(const e of f.book.events){
  const logs=e.moves.map(m=>({address:m.token,topics:[TRANSFER,data(m.from),data(m.to)],data:data(m.raw)}));
  for(const op of e.lp){
   if(op.kind==='add'&&options.discover)logs.push({address:NPM,topics:[TRANSFER,data(ZERO),data(f.book.positions['base:'+op.id].owner),data(op.id)],data:'0x'});
   logs.push({address:NPM,topics:[op.kind==='add'?INC:op.kind==='remove'?DEC:COL,data(op.id)],data:op.kind==='collect'?data(op.recipient,op.a0,op.a1):data(op.liquidity,op.a0,op.a1)});
  }
  for(const [i,l]of logs.entries())Object.assign(l,{logIndex:hex(i),transactionHash:e.hash,blockNumber:hex(e.block),blockHash:e.blockHash,removed:false});
  receipts.set(e.hash,{transactionHash:e.hash,blockNumber:hex(e.block),blockHash:e.blockHash,transactionIndex:hex(e.index),status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs});
  transactions.set(e.hash,{hash:e.hash,blockNumber:hex(e.block),blockHash:e.blockHash,from:owners[0],to:NPM});
 }
 const allLogs=[...receipts.values()].flatMap(r=>r.logs),match=(l,q)=>l.address===q.address&&Number(BigInt(l.blockNumber))>=Number(BigInt(q.fromBlock))&&Number(BigInt(l.blockNumber))<=Number(BigInt(q.toBlock))&&(q.topics||[]).every((x,i)=>x===null||x===undefined||Array.isArray(x)?x===null||x===undefined||x.includes(l.topics[i]):x===l.topics[i]);
 const readBatch=async filters=>filters.map(q=>allLogs.filter(l=>match(l,q)).map(l=>({...l,...(options.removed?{removed:true}:{})})));
 function call(to,bytes,at){
  const selector=bytes.slice(0,10);
  if(selector==='0x313ce567')return data(strategyTokens('base').find(t=>t.address===to).decimals);
  if(selector==='0x70a08231'){const owner='0x'+bytes.slice(-40);return data(s.balances[owner]?.[to]??0);}
  if(to===NPM){const id=BigInt('0x'+bytes.slice(10)).toString(),p=f.book.positions['base:'+id];if(!p)throw Error('Unknown fixture NFT');
   if(selector==='0x6352211e')return data(p.owner);
   if(selector==='0x99fbab88'){
    const ops=f.book.events.filter(e=>e.block<=at).flatMap(e=>e.lp.filter(op=>op.id===id)),L=ops.reduce((q,op)=>q+(op.kind==='add'?BigInt(op.liquidity):op.kind==='remove'?-BigInt(op.liquidity):0n),0n),owed=f.book.owed['base:'+id]||{a0:'0',a1:'0'};
    return data(0,0,p.token0,p.token1,3000,0,1,L,0,0,owed.a0,owed.a1);
   }
  }
  if(to===POOL){if(selector==='0x0dfe1681')return data(USDC);if(selector==='0xd21220a7')return data(UNI);if(selector==='0x3850c7bd')return data(BigInt(Math.floor(Math.sqrt(1e11)*2**96)),0,0,0,0,0,1);}
  if(selector==='0x1698ee82')return data(POOL);
  throw Error('Unexpected strategy fixture call '+selector);
 }
 const multi=(encoded,at)=>{
  const h=encoded.slice(10),n=Number(BigInt('0x'+h.slice(64,128))),rows=[];
  for(let i=0;i<n;i++){const a=(64+Number(BigInt('0x'+h.slice(128+i*64,192+i*64))))*2,to='0x'+h.slice(a+24,a+64),d=Number(BigInt('0x'+h.slice(a+128,a+192)))*2+a,len=Number(BigInt('0x'+h.slice(d,d+64)));rows.push(call(to,'0x'+h.slice(d+64,d+64+len*2),at));}
  let tails='',offsets='';for(const bytes of rows){offsets+=word(n*32+tails.length/2);tails+=word(1)+word(64)+word((bytes.length-2)/2)+bytes.slice(2).padEnd(Math.ceil((bytes.length-2)/64)*64,'0');}return '0x'+word(32)+word(n)+offsets+tails;
 };
 const rpc=async(method,params)=>{
  calls.push({method,params});if(options.offline)throw Error('Controlled offline reading');
  if(method==='eth_blockNumber')return hex(head);
  if(method==='eth_getBlockByNumber'){const n=Number(BigInt(params[0]));return {number:hex(n),hash:options.reorg?H(n+2000):H(n+1000),timestamp:hex(now-(head-n))};}
  if(method==='eth_getTransactionReceipt'){const r=structuredClone(receipts.get(params[0]));if(options.badReceipt&&r)r.logs.pop();return r;}
  if(method==='eth_getTransactionByHash')return structuredClone(transactions.get(params[0]));
  if(method==='eth_getLogs')return allLogs.filter(l=>match(l,params[0])).map(l=>({...l}));
  if(method==='eth_call')return params[0].to===UNI_MULTICALL?multi(params[0].data,Number(BigInt(params[1]))):call(params[0].to,params[0].data,Number(BigInt(params[1])));
  throw Error('Unsupported closed strategy RPC '+method);
 };
 const trade={...f.trade,book:{...f.trade.book,chains:{base:{transferStart:100}}},trades:f.book.events.filter(e=>e.trade).map(e=>({...e.trade,chain:e.chain,hash:e.hash,block:e.block,blockHash:e.blockHash,price:e.trade.usd/(Number(BigInt(e.trade.raw))/1e18)}))};
 const lpBook={positions:options.discover?{}:Object.fromEntries(Object.entries(f.book.positions).map(([key,p])=>[key,{...p,wallet:p.owner,a0:p.token0,a1:p.token1,opened_block:101}]))};
 return {...f,now,head,rpc,readBatch,calls,trade,lpBook,receipts};
}
