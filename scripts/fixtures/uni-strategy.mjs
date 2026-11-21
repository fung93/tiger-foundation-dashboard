import {STRATEGY_ASSETS,emptyUniStrategy} from '../../uni-strategy-core.mjs';
export const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),R='0x'+'3'.repeat(40),POOL='0x'+'4'.repeat(40),ZERO='0x'+'0'.repeat(40),UNI=STRATEGY_ASSETS.base.uni,USDC=STRATEGY_ASSETS.base.stables[0][1],NPM=STRATEGY_ASSETS.base.npm;
export const H=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),ur=n=>BigInt(Math.round(n*1e9))*10n**9n,cr=n=>BigInt(Math.round(n*1e6));
const move=(token,from,to,q)=>({token,from,to,raw:(token===UNI?ur(q):cr(q)).toString()});
export function strategyFixture(scenario='reuse'){
 const book=emptyUniStrategy([A,B]),events=[],positions=book.positions;
 const add=(moves=[],lp=[],trade=null)=>{const n=100+events.length,e={id:'base:'+H(n),chain:'base',hash:H(n),block:n,blockHash:H(n+1000),index:0,ts:1800000000+n,moves,lp,trade,uniPriceUsd:10,prices:{}};events.push(e);return e;};
 const purchase=(usd,uni,owner=A)=>add([move(USDC,owner,R,usd),move(UNI,R,owner,uni)],[],{side:'buy',verified:true,raw:ur(uni).toString(),usd,owner,quote:[{address:USDC,raw:(-cr(usd)).toString(),decimals:6}]});
 const register=(id,owner=A)=>positions['base:'+id]={chain:'base',id,owner,pool:POOL,pair:'UNI / USDC',token0:USDC,token1:UNI};
 register('900001');purchase(250,25);
 add([move(UNI,A,POOL,25)],[{kind:'add',id:'900001',liquidity:'100',a0:'0',a1:ur(25).toString()}]);
 if(scenario!=='open'){
  add([],[{kind:'remove',id:'900001',liquidity:scenario==='partial'?'40':'100',a0:cr(scenario==='partial'?96:240).toString(),a1:'0'}]);
  if(scenario!=='pending')add([move(USDC,NPM,A,scenario==='partial'?96:240)],[{kind:'collect',id:'900001',recipient:A,a0:cr(scenario==='partial'?96:240).toString(),a1:'0'}]);
 }
 if(['reuse','topup','internal'].includes(scenario)){
  if(scenario==='topup')add([move(USDC,R,A,10)]);
  if(scenario==='internal')add([move(USDC,A,B,240)]);
  const owner=scenario==='internal'?B:A,usd=scenario==='topup'?250:240,q=usd/10;
  purchase(usd,q,owner);register('900002',owner);add([move(UNI,owner,POOL,q)],[{kind:'add',id:'900002',liquidity:'100',a0:'0',a1:ur(q).toString()}]);
 }
 book.events=events;const balances=Object.fromEntries([A,B].map(owner=>[owner,Object.fromEntries([UNI,...STRATEGY_ASSETS.base.stables.map(s=>s[1])].map(token=>[token,owner===A&&token===USDC?cr(250).toString():'0']))]));
 const opening=structuredClone(balances);
 for(const e of events)for(const m of e.moves){if(balances[m.from])balances[m.from][m.token]=(BigInt(balances[m.from][m.token])-BigInt(m.raw)).toString();if(balances[m.to])balances[m.to][m.token]=(BigInt(balances[m.to][m.token])+BigInt(m.raw)).toString();}
 const last=events.at(-1);book.chains.base={startBlock:100,cursor:last.block,head:last.block,hash:last.blockHash,ts:last.ts,opening,balances};
 if(!['open','partial'].includes(scenario))book.owed['base:900001']={a0:scenario==='pending'?cr(240).toString():'0',a1:'0',block:last.block};
 const openPositions=scenario==='open'?[{id:'900001',owner:A,liquidity:'100',value:240}]:scenario==='partial'?[{id:'900001',owner:A,liquidity:'60',value:144}]:['reuse','topup','internal'].includes(scenario)?[{id:'900002',owner:scenario==='internal'?B:A,liquidity:'100',value:scenario==='topup'?250:240}]:[];
 const trade={schemaVersion:'uni-trade-view-v1',accountingVersion:2,book:{wallets:[A,B]},trades:[],flows:[],quotes:{base:{priceUsd:10,ts:last.ts,pool:POOL,block:last.block},bnb:{priceUsd:10,ts:last.ts,pool:POOL,block:last.block}},wallets:[A,B].flatMap(owner=>['base','bnb'].map(chain=>({chain,owner,uni:chain==='base'?Number(BigInt(balances[owner][UNI]))/1e18:0,valueUsd:0}))),complete:true,historyComplete:true};
 const lpView={generated:new Date(last.ts*1000).toISOString(),cards:{},health:{errors:{},behind:{},unread:[],unpriced:[]},uni:{schemaVersion:'uni-lp-accounting-v1',complete:true,positions:openPositions.map(p=>({key:'base:'+p.id,chain:'base',id:p.id,owner:p.owner,status:'open',pair:'UNI / USDC'}))},position_data:openPositions.map(p=>({chain:'base',id:p.id,owner:p.owner,status:'observed',feesMine:true,principalUsd:p.value,raw:{liquidity:p.liquidity,token0:{address:USDC,symbol:'USDC',decimals:6},token1:{address:UNI,symbol:'UNI',decimals:18}},amounts:{UNI:scenario==='open'?0:p.value/10,USDC:scenario==='open'?p.value:0}})),position_metrics:openPositions.map(p=>({key:'base:'+p.id,owner:p.owner,complete:true,unclaimedUsd:0,unclaimedTokens:{}})),live:[]};
 return {book,trade,lpView,add,move,purchase};
}
export function refreshStrategyFixture(f){
 const s=f.book.chains.base,last=f.book.events.at(-1);s.cursor=s.head=last.block;s.hash=last.blockHash;s.ts=last.ts;
 s.balances=structuredClone(s.opening);
 for(const e of f.book.events)for(const m of e.moves){if(s.balances[m.from])s.balances[m.from][m.token]=(BigInt(s.balances[m.from][m.token])-BigInt(m.raw)).toString();if(s.balances[m.to])s.balances[m.to][m.token]=(BigInt(s.balances[m.to][m.token])+BigInt(m.raw)).toString();}
 for(const o of Object.values(f.book.owed||{}))o.block=s.head;
 for(const w of f.trade.wallets)if(w.chain==='base'){w.uni=Number(BigInt(s.balances[w.owner][UNI]))/1e18;w.valueUsd=w.uni*f.trade.quotes.base.priceUsd;}
 return f;
}
