/* Captured Katana reads plus deterministic fault/fee/swap scenarios. No network,
   historical rewrite, wallet action or live provider is permitted by this suite. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {V3,CFG,v3Rows,repairKatanaOpenPositions,replayKatanaFeeHistory,feeTokensOf} from '../api/_core.mjs';
import {observedSwapFees,sortFeePools,hedgePlan,estimateFees} from '../strategy-core.mjs';
import {START,KAT,WALLETS,STABLES,emptyBook,validateBook,scanTrades,hasKatSwap} from '../kat-core.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const fx=JSON.parse(readFileSync(new URL('./fixtures/katana-fee-lps-2026-11-14.json',import.meta.url))),ch=V3.find(c=>c.key==='katana'),oldFetch=globalThis.fetch;
const responses=new Map(fx.rpc.map(r=>[JSON.stringify([r.method,r.params]),r.response]));let calls=0,failAnchor=false;
globalThis.fetch=async(url,options)=>{check(String(url),CFG.katRpc,'Captured tests use only the configured Katana RPC');
 const q=JSON.parse(options.body);calls++;const response=responses.get(JSON.stringify([q.method,q.params]));if(!response)throw Error('Unrecorded test RPC '+q.method);
 if(failAnchor&&q.method==='eth_call'&&q.params[0].to==='0x10045367e619caae6f60cc80046c43c6cd55f629'&&q.params[1]===fx.rpc.find(r=>r.method==='eth_blockNumber').response.result)
  return Response.json({jsonrpc:'2.0',id:q.id,error:{code:-1,message:'Fixture dollar quote failure'}});
 return Response.json({...response,id:q.id});};
try{
 const source=structuredClone(fx.sourceBook),owned=new Map(Object.values(source.positions).filter(p=>p.status==='open').map(p=>[p.id,p.wallet]));
 const rows=await v3Rows(ch,{},owned,{noEntry:true});
 check(rows.map(r=>r.id),['495384','495640'],'Both genuine open Katana positions remain in the live roster');
 for(const expected of fx.expected){const r=rows.find(r=>r.id===expected.id);check(r.value_usd,expected.value_usd,'The captured position value is retained for '+r.id);check(r.fees_mine,true,'Unstaked positions own their trading fees');}
 check(rows[0].raw.prices['KAT@katana']>0,true,'The non-stable pair has a verified dollar anchor');
 check(Number.isSafeInteger(rows[0].raw.valuation_block),true,'The pool and dollar anchor use the pinned valuation block');
 const before=JSON.stringify(source.positions['katana:494956']);await repairKatanaOpenPositions(source,ch);
 check(source.positions['katana:495384'].unpriced,false,'Original non-stable deposits are repaired from their original block');
 check(source.positions['katana:495384'].cost_usd,25.87,'The archived mint values establish the actual original cost');
 check(JSON.stringify(source.positions['katana:494956']),before,'A historical closed position is byte-for-byte unchanged');
 check(source.positions['katana:495384'].fee_accounting_version,1,'Only the current owner-fee accounting is activated');
 const beforeCalls=calls;await repairKatanaOpenPositions(source,ch);check(calls,beforeCalls,'A completed repair is idempotent and requires no historical rescan');
 failAnchor=true;const failed=await v3Rows(ch,{},owned,{noEntry:true});
 check(failed[0].liquidity_usd,null,'A failed bridge stays unavailable, never a fabricated zero');
 check(failed[1].liquidity_usd,rows[1].liquidity_usd,'A bridge failure cannot erase another verified Katana LP');
}finally{globalThis.fetch=oldFetch;}

const word=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0'),topic=n=>'0x'+word(n),data=(...ns)=>'0x'+ns.map(word).join(''),
 wallet=WALLETS[0],walletTopic='0x'+wallet.slice(2).padStart(64,'0'),stakerTopic='0x'+CFG.lpStaker.slice(2).padStart(64,'0'),zero=topic(0),
 transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
 decrease='0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',collect='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
let sequence=0;const event=(topics,payload='0x')=>({topics,data:payload,blockNumber:'0x10',blockTimestamp:'0x100',logIndex:'0x'+(sequence++).toString(16),transactionHash:'0x'+'a'.repeat(64)});
const events=[event([transfer,zero,walletTopic,topic(7)]),event([decrease,topic(7)],data(1,10,20)),event([collect,topic(7)],data(0,12,23)),
 event([transfer,walletTopic,stakerTopic,topic(7)]),event([collect,topic(7)],data(0,90,100)),event([transfer,stakerTopic,walletTopic,topic(7)]),event([collect,topic(7)],data(0,1,2))];
const P={id:'7',chain:'katana',status:'open',t0:'X@katana',t1:'USDC@katana',d0:0,d1:0};
const fees=replayKatanaFeeHistory(P,events,[wallet]);
check(fees.fees,{'X@katana':3,'USDC@katana':5},'Principal is subtracted and staked DAO collections are excluded');
check(fees.claims.length,2,'Only actual owner fee collections create owner claims');
check(fees.feesMine,true,'An unstaked NFT resumes owning its trading fees');
check(feeTokensOf({...P,fees:fees.fees,merkl:{'KAT@katana':100},fee_accounting_version:1},{'X@katana':1}),{'KAT@katana':100,'X@katana':4,'USDC@katana':5},'Actual new fees coexist with original KAT rewards');
check(feeTokensOf({...P,fees:fees.fees,merkl:{'KAT@katana':100}},{}),{'KAT@katana':100},'Legacy reward-only records do not gain historical DAO fees');

const pool={pool:'a',fee:3000,fee_protocol:34,token0:{symbol:'vbUSDC',decimals:6,usd:1},token1:{symbol:'vbETH',decimals:18,usd:25}};
const volume=observedSwapFees([{data:data(100000000,-4n*10n**18n)},{data:data(-50000000,2n*10n**18n)}],pool);
check(volume.volume_usd_24h,150,'Swap volume counts one input per swap rather than both legs');
check(Math.abs(volume.usd_24h-.225)<1e-12,true,'LP fees apply the actual fee tier and protocol split');
check(observedSwapFees([],pool).volume_usd_24h,0,'A complete empty swap reading establishes zero activity');
assert.throws(()=>observedSwapFees([{data:'0x'}],pool),/Incomplete/);count++;
const ranked=[{pool:'a',apr:1,fees:{volume_usd_24h:2,usd_24h:3}},{pool:'b',apr:2,fees:{volume_usd_24h:1,usd_24h:4}},{pool:'c',apr:null,fees:{}}];
check(sortFeePools(ranked,'volume').map(p=>p.pool),['a','b','c'],'Volume sorting is numeric with missing values last');
check(sortFeePools(ranked,'fees','asc').map(p=>p.pool),['a','b','c'],'Fee sorting supports ascending order');
check(sortFeePools(ranked,'apr').map(p=>p.pool),['b','a','c'],'APR sorting remains available');
check(!!estimateFees({quote_usable:false},{capitalUsd:1000},{}).error,true,'An inactive pool cannot produce an actionable income estimate');
const perp={markets:{'KAT-USD':{index:.5,step:.01,min:1,taker:.001,maker:.0005,mmf:.01}},book:{'KAT-USD':{mark:.5,bids:[[.5,10000]],asks:[[.5,10000]]}},funding:{'KAT-USD':{avg:0,now:0}},withdraw_fee:.05},
  correlated={kat_usd:.5,token0:{symbol:'avKAT',usd:1},token1:{symbol:'KAT',usd:.5}};
const hedge=hedgePlan(correlated,{amount0:10,amount1:5},perp,{days:7,capitalUsd:12.5});
check(hedge.legs.length,1,'avKAT and KAT exposure share one KAT hedge');
check(hedge.legs[0].qty,25,'The KAT hedge converts avKAT at the observed ratio');
check(hedge.ratioAssumption,true,'The unhedged avKAT/KAT ratio assumption remains explicit');

// The fresh book must reject claims, refunds, pre-reset trades and failed swaps.
const usdc=Object.keys(STABLES)[0],pair='0x'+'1'.repeat(40),swap='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  addr=a=>'0x'+a.slice(2).padStart(64,'0'),hash=n=>'0x'+String(n).padStart(64,'0'),
  receipt={status:'0x1',from:wallet,gasUsed:'0x0',effectiveGasPrice:'0x0',logs:[{address:pair,topics:[swap],data:'0x'},
    {address:KAT,topics:[transfer,addr(pair),addr(wallet)],data:topic(100n*10n**18n)}]};
check(hasKatSwap(receipt),true,'A successful swap with actual KAT movement is positively identified');
check(hasKatSwap({...receipt,status:'0x0'}),false,'A failed transaction is not a trade');
check(hasKatSwap({...receipt,logs:receipt.logs.slice(1)}),false,'Token transfers alone are not swap evidence');
const tx=(n,block=START.block)=>({hash:hash(n),block,ts:START.ts,legs:[{token:usdc,amount:-1,counterparty:pair},{token:KAT,amount:100,counterparty:pair}]});
let state=emptyBook();let result=await scanTrades(state,[tx(1)],{getReceipt:async()=>receipt,ethUsd:2000});
check(result.trades.length,1,'The new book records a verified buy');check(result.trades[0].swap_verified,true,'The evidence flag is retained in the new ledger');
check(!!validateBook({...state,trades:result.trades,last_block:START.block}),true,'The active swap-only ledger validates with verified evidence');
result=await scanTrades(state,[tx(2)],{getReceipt:async()=>({...receipt,logs:receipt.logs.slice(1)}),ethUsd:2000});
check(result.trades.length,0,'A claim/refund-shaped transaction cannot become a buy');
const sale={...tx(4),legs:[{token:KAT,amount:-40,counterparty:pair},{token:usdc,amount:.6,counterparty:pair}]},
 sellReceipt={...receipt,logs:[receipt.logs[0],{address:KAT,topics:[transfer,addr(wallet),addr(pair)],data:topic(40n*10n**18n)}]};
result=await scanTrades(state,[sale],{getReceipt:async()=>sellReceipt,ethUsd:2000});
check(result.trades[0].side,'sell','A genuine KAT sale remains a trade');
check(result.trades[0].kat,40,'Sale quantities exclude claims and other movements');
result=await scanTrades(state,[{...tx(5),legs:[{token:KAT,amount:100,counterparty:'0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae'}]}],
 {getReceipt:async()=>{throw Error('A pure reward claim must never need a swap receipt');},ethUsd:2000});
check(result.trades.length,0,'A reward claim stays outside the trade record');
result=await scanTrades(state,[tx(3,START.block-1)],{getReceipt:async()=>{throw Error('No pre-reset receipt should be read');},ethUsd:2000});
check(result.trades.length,0,'Pre-reset trades cannot leak into the new ledger');
check(state.trades.length,0,'The restart has no synthetic opening purchase');
assert.throws(()=>validateBook({...state,version:1}),/unsupported/);count++;
console.log('Katana fee transition, pool ranking and swap-only reset: '+count+' assertions passed.');
