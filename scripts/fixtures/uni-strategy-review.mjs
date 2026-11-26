/* Development examples only. Never imported by a public API or production UI. */
import {strategyFixture} from './uni-strategy.mjs';
export const REVIEW_SCENARIOS=Object.freeze({open:'At upper edge',closed:'Collected $240',reuse:'Reinvest $240',topup:'Add $10',pending:'Awaiting collection',partial:'Partial exit'});
export function uniStrategyReview(scenario='reuse',at=Math.floor(Date.now()/1000)){
 if(!Object.hasOwn(REVIEW_SCENARIOS,scenario))throw Error('Unknown local review scenario');
 const f=strategyFixture(scenario),shift=at-f.book.chains.base.ts;
 for(const e of f.book.events)e.ts+=shift;
 f.book.chains.base.ts=at;
 f.trade.trades=f.book.events.filter(e=>e.trade).map(e=>({...e.trade,id:e.id,chain:e.chain,hash:e.hash,block:e.block,blockHash:e.blockHash,index:e.index,ts:e.ts,uni:Number(BigInt(e.trade.raw))/1e18,price:e.trade.usd/(Number(BigInt(e.trade.raw))/1e18),gas:null,gasRaw:null,gasToken:'ETH',gasPayer:'resolver',note:null}));
 for(const q of Object.values(f.trade.quotes))q.ts=at;
 f.trade.book.version=1;f.trade.book.lastAttempt=at;
 f.trade.book.chains={base:{transferStart:100,head:f.book.chains.base.head,recentCursor:f.book.chains.base.head,ts:at},bnb:{head:0,recentCursor:0,ts:at}};
 for(const w of f.trade.wallets){w.ts=at;w.block=f.trade.quotes[w.chain].block;w.raw=(BigInt(Math.round(w.uni*1e9))*10n**9n).toString();w.valueUsd=w.uni*10;}
 f.lpView.generated=new Date(at*1000).toISOString();
 f.lpView.live=f.lpView.position_data.map(p=>({chain:'base',id:p.id,pair:'UNI / USDC',in_range:scenario!=='open',position_pct:scenario==='open'?100:50,price:'$10.00',lower:'$9.00',upper:scenario==='open'?'$10.00':'$11.00',status:scenario==='open'?'At upper edge':'In range',yield_label:'Fees',yield_value:'$0.00',pnl:scenario==='open'?'-$10.00':'$0.00',pnl_up:false,net:scenario==='open'?'-$10.00':'$0.00',net_up:false,since:'Example position',cost:scenario==='open'?'$250.00':'$'+p.principalUsd.toFixed(2),value_now:'$'+p.principalUsd.toFixed(2),token_mix:{basis:'principal_value_at_pool_price',tokens:[{symbol:'UNI',value_pct:scenario==='open'?0:100},{symbol:'USDC',value_pct:scenario==='open'?100:0}]},comparison:{available:false,complete:false,reason:'Local review · Example figures'},apr:'—'}));
 const history={schemaVersion:'uni-trade-feed-v1',book:{wallets:f.trade.book.wallets},trades:f.trade.trades.map(({id,chain,side,ts,uni,usd,price,verified})=>({id,chain,side,ts,uni,usd,price,verified})),at,complete:true,historyComplete:true,errors:{},coverage:Object.fromEntries(['base','bnb'].map(c=>[c,{current:true,checkedAt:at,historyComplete:true,remainingBlocks:0}]))};
 return {trade:f.trade,history,market:{schemaVersion:'uni-market-view-v1',quotes:f.trade.quotes,wallets:f.trade.wallets,complete:true,errors:{}},lp:f.lpView,strategy:{schemaVersion:'uni-strategy-view-v1',book:f.book,at,complete:true,errors:{},coverage:{base:'tracked',bnb:'no_recorded_activity'}}};
}
export function reviewBanner(scenario){
 return '<aside id="localReview" style="border:1px solid var(--gold);border-radius:12px;padding:16px;margin-top:22px;font-size:12px;line-height:1.6"><strong>Local review · Example figures</strong><p>These examples demonstrate the accounting; they are not your live balances.</p><nav style="display:flex;flex-wrap:wrap;gap:8px" aria-label="Review scenarios">'+Object.entries(REVIEW_SCENARIOS).map(([key,label])=>'<a class="uni-trade-link"'+(key===scenario?' aria-current="page"':'')+' href="/__review/uni-strategy?scenario='+key+'">'+label+'</a>').join('')+'</nav></aside>';
}
