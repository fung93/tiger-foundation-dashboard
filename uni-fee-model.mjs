/* Same-pool realized fee growth, in native tokens per active liquidity-day.
   Read-only: never fit to an unfinished LP or rewrite its accounting. */
const DAY=86400,MIN_ACTIVE=1800,MIN_TOTAL=21600,MAX_AGE=7*DAY;
const UNI={base:'0xc3de830ea07524a0761646a6a4e4be0e114a3c83',bnb:'0xbf5140a22578168fd562dccf235e5d43a02ce9b1'};
const address=v=>/^0x[0-9a-f]{40}$/.test(v||''),positive=v=>Number.isFinite(v)&&v>0,nonnegative=v=>Number.isFinite(v)&&v>=0;
export function buildUniFeeHistory(book){
 if(book?.version!==9||!Array.isArray(book.wallets)||!book.wallets.every(address)||!book.positions||!book.tokens||!Array.isArray(book.runs))throw Error('Invalid LP history');
 const sourceAt=Math.max(0,...book.runs.map(r=>r.ts).filter(t=>Number.isSafeInteger(t)&&t>0)),observations=[];
 for(const [key,p] of Object.entries(book.positions)){
  if(!p||!UNI[p.chain]||key!==p.key||key!==p.chain+':'+p.id||p.status!=='closed'||p.unpriced||p.at_start||!book.wallets.includes(p.wallet)||!address(p.pool)||p.liq!=='0'||p.owed?.r0!=='0'||p.owed?.r1!=='0'||!p.frozen||p.frozen.incomplete||!p.frozen.fee_tokens||Array.isArray(p.frozen.fee_tokens)||p.frozen.at_ts!==p.closed_ts||p.frozen.at_block!==p.closed_block||p.deposits?.length!==1||p.claims!==undefined&&!Array.isArray(p.claims))continue;
  const duration=p.closed_ts-p.opened_ts,active=p.range?.in_s;
  if(!Number.isSafeInteger(p.closed_ts)||p.closed_ts>sourceAt||!Number.isSafeInteger(p.opened_ts)||duration<3600||p.range?.ts!==p.closed_ts||p.range?.all_s!==duration||!Number.isSafeInteger(active)||active<MIN_ACTIVE||active>duration)continue;
  if(![p.a0,p.a1].every(address)||![p.a0,p.a1].includes(UNI[p.chain])||![p.d0,p.d1].every(d=>Number.isInteger(d)&&d>=0&&d<=24)||![p.lo,p.hi].every(Number.isInteger)||p.lo< -887272||p.hi>887272||p.hi<=p.lo||!Number.isInteger(p.fee)||p.fee<=0||p.fee>=1000000)continue;
  if([0,1].some(i=>{const t=book.tokens[p['t'+i]];return t?.a!==p['a'+i]||t.d!==p['d'+i];}))continue;
  const deposit=p.deposits[0],fees=[0,1].map(i=>p.frozen.fee_tokens?.[p['t'+i]]??0),claimed=[0,1].map(i=>(p.claims||[]).reduce((sum,c)=>sum+(c.tokens?.[p['t'+i]]??0),0));
  if(deposit.ts!==p.opened_ts||![deposit.a0,deposit.a1,...fees,...claimed].every(nonnegative)||deposit.a0+deposit.a1<=0||fees.some((f,i)=>Math.abs(f-claimed[i])>Math.max(1e-10,Math.abs(f)*1e-10)))continue;
  // Used token amounts determine mint liquidity without an entry-price guess.
  // x=L(b-s)/(sb), y=L(s-a) => (b-a)L²-(y+xab)L-xyb=0.
  const a=1.0001**(p.lo/2),b=1.0001**(p.hi/2),x=deposit.a0*10**p.d0,y=deposit.a1*10**p.d1,B=y+x*a*b,
   liquidity=(B+Math.sqrt(B*B+4*(b-a)*x*y*b))/(2*(b-a));
  if(!positive(liquidity))continue;
  observations.push({id:p.key,chain:p.chain,pool:p.pool,fee:p.fee,a0:p.a0,a1:p.a1,d0:p.d0,d1:p.d1,openedAt:p.opened_ts,closedAt:p.closed_ts,activeSeconds:active,liquidity,fees0:fees[0],fees1:fees[1]});
 }
 return {schemaVersion:'uni-fee-history-v1',sourceAt,observations:observations.sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id))};
}
export function uniEstimatedFeeRate(pool,history,{now=pool.at}={}){
 const g=pool.feeWindow,current=g?.perL0Day*pool.token0.usd+g?.perL1Day*pool.token1.usd;
 const original={perLiquidityDay:current,history:null};
 if(!nonnegative(current)||current===0||g?.method!=='fee_growth'||history?.schemaVersion!=='uni-fee-history-v1'||!Number.isSafeInteger(history.sourceAt)||history.sourceAt<=0||history.sourceAt>now+180||!Array.isArray(history.observations))return original;
 const seen=new Set(),eligible=history.observations.filter(o=>{
  if(!o||o.chain!==pool.chain||o.pool!==pool.pool||o.fee!==pool.fee||o.a0!==pool.token0.address||o.a1!==pool.token1.address||o.d0!==pool.token0.decimals||o.d1!==pool.token1.decimals||typeof o.id!=='string'||seen.has(o.id))return false;
  seen.add(o.id);return Number.isSafeInteger(o.closedAt)&&o.closedAt<=history.sourceAt&&o.closedAt<=now&&now-o.closedAt<=MAX_AGE&&Number.isSafeInteger(o.openedAt)&&o.openedAt<o.closedAt&&Number.isSafeInteger(o.activeSeconds)&&o.activeSeconds>=MIN_ACTIVE&&o.activeSeconds<=o.closedAt-o.openedAt&&positive(o.liquidity)&&[o.fees0,o.fees1].every(nonnegative);
 });
 const active=eligible.reduce((sum,o)=>sum+o.activeSeconds,0);
 if(eligible.length<3||active<MIN_TOTAL)return original;
 const rates=eligible.map(o=>({rate:(o.fees0*pool.token0.usd+o.fees1*pool.token1.usd)*DAY/(o.liquidity*o.activeSeconds),weight:o.activeSeconds*2**(-(now-o.closedAt)/(3*DAY))})).filter(r=>nonnegative(r.rate)&&positive(r.weight)).sort((a,b)=>a.rate-b.rate);
 if(rates.length<3)return original;
 const middle=rates.reduce((sum,r)=>sum+r.weight,0)/2;let weight=0,median=0;
 for(const r of rates){weight+=r.weight;if(weight>=middle){median=r.rate;break;}}
 // Retain half of the current market signal. History only tempers an elevated
 // rate; old strong earnings cannot inflate a weak current fee reading.
 const adjusted=Math.min(current,(current+median)/2);
 return {perLiquidityDay:adjusted,history:{method:'realized_fee_blend_v1',samples:eligible.length,activeSeconds:active,sourceAt:history.sourceAt,latestClose:Math.max(...eligible.map(o=>o.closedAt)),factor:adjusted/current}};
}
