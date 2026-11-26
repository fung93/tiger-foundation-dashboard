/* Small, read-only table view. Receipt evidence stays in the source ledger;
   removing table details must never change execution amounts or strategy cost. */
const chains=['base','bnb'],address=v=>/^0x[0-9a-f]{40}$/.test(v||''),positive=v=>Number.isFinite(v)&&v>0;
export function validUniTradeFeed(v){
 if(v?.schemaVersion!=='uni-trade-feed-v1'||!Array.isArray(v.book?.wallets)||v.book.wallets.length!==2||!v.book.wallets.every(address)||new Set(v.book.wallets).size!==2
  ||!Array.isArray(v.trades)||v.trades.length>10000||typeof v.complete!=='boolean'||typeof v.historyComplete!=='boolean'||!v.coverage||!v.errors||typeof v.errors!=='object'||!Number.isSafeInteger(v.at)||v.at<=0)return false;
 const ids=new Set();
 for(const t of v.trades){if(!t||!chains.includes(t.chain)||!new RegExp('^'+t.chain+':0x[0-9a-f]{64}$').test(t.id)||ids.has(t.id)||!['buy','sell'].includes(t.side)||!positive(t.uni)||!Number.isSafeInteger(t.ts)||t.ts<=0||typeof t.verified!=='boolean'
   ||!(t.usd===null&&t.price===null||t.verified&&Number.isFinite(t.usd)&&t.usd>=0&&Number.isFinite(t.price)&&t.price>=0&&Math.abs(t.uni*t.price-t.usd)<=Math.max(1e-8,t.usd*1e-10)))return false;ids.add(t.id);}
 return chains.every(chain=>{const c=v.coverage[chain];return c&&typeof c.current==='boolean'&&typeof c.historyComplete==='boolean'&&(c.checkedAt===null||Number.isSafeInteger(c.checkedAt)&&c.checkedAt>0)
  &&(c.remainingBlocks===null||Number.isSafeInteger(c.remainingBlocks)&&c.remainingBlocks>=0)&&(!c.current||c.checkedAt!==null&&c.remainingBlocks===0);})
  &&(!v.complete||chains.every(c=>v.coverage[c].current&&!v.errors[c]))&&(!v.historyComplete||chains.every(c=>v.coverage[c].historyComplete));
}
export function savedUniTradeFeed(book){
 if(book?.version!==1||!book.chains||!Array.isArray(book.trades))throw Error('Invalid saved UNI history');
 const coverage=Object.fromEntries(chains.map(chain=>{const s=book.chains[chain],caught=!!s&&s.recentCursor===s.head;
  return [chain,{current:false,checkedAt:caught&&!book.errors?.[chain]?s.ts:null,historyComplete:book.historyComplete===true,remainingBlocks:s?Math.max(0,s.head-(s.recentCursor??s.head)):null}];}));
 const value={schemaVersion:'uni-trade-feed-v1',book:{wallets:book.wallets},trades:book.trades.map(({id,chain,side,ts,uni,usd,price,verified})=>({id,chain,side,ts,uni,usd,price,verified})),coverage,
  complete:false,historyComplete:book.historyComplete===true,errors:book.errors||{},at:book.lastAttempt||Math.max(...Object.values(book.chains).map(s=>s.ts))};
 if(!validUniTradeFeed(value))throw Error('Invalid saved UNI trades');return value;
}
export function mergeUniTradeFeeds(previous,next){
 if(!validUniTradeFeed(next)||previous&&!validUniTradeFeed(previous))throw Error('Invalid UNI trade reading');
 if(previous&&JSON.stringify(previous.book.wallets)!==JSON.stringify(next.book.wallets))throw Error('UNI history owner changed');
 const rows=new Map((previous?.trades||[]).map(t=>[t.id,t]));
 for(const t of next.trades){const old=rows.get(t.id);
  if(old&&(old.side!==t.side||old.uni!==t.uni||old.ts!==t.ts||old.verified&&t.verified&&(old.usd!==t.usd||old.price!==t.price)))throw Error('Recorded UNI execution changed');
  rows.set(t.id,old?.verified&&!t.verified?old:t);
 }
 return {...next,trades:[...rows.values()].sort((a,b)=>b.ts-a.ts||a.id.localeCompare(b.id))};
}
