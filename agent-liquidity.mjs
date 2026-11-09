/* Bounded initialized-tick evidence. Exact liquidity arithmetic until the final
   numeric ratio; uncovered tick regions cannot be assigned invented liquidity. */
export function createLiquidityCurve(evidence){
  if(evidence?.schemaVersion!=='agent-liquidity-v1'||evidence.complete!==true||!Number.isSafeInteger(evidence.block)
    ||!Number.isInteger(evidence.currentTick)||!Number.isInteger(evidence.lowerTick)||!Number.isInteger(evidence.upperTick)
    ||evidence.lowerTick< -887272||evidence.upperTick>887273
    ||evidence.lowerTick>evidence.currentTick||evidence.upperTick<=evidence.currentTick
    ||!/^\d{1,78}$/.test(evidence.activeLiquidityRaw||'')||!Array.isArray(evidence.ticks)||evidence.ticks.length>96)return null;
  const entries=[];let previous=-887273,base=BigInt(evidence.activeLiquidityRaw);if(base>=(1n<<128n))return null;
  for(const row of evidence.ticks){
    if(!Number.isInteger(row.tick)||row.tick<=previous||row.tick<evidence.lowerTick||row.tick>=evidence.upperTick
      ||!/^\d{1,78}$/.test(row.gross||'')||!/^[-]?\d{1,78}$/.test(row.net||''))return null;
    const net=BigInt(row.net),gross=BigInt(row.gross);
    if(gross<=0n||gross>=(1n<<128n)||net<-(1n<<127n)||net>=(1n<<127n)||net>gross||-net>gross)return null;
    entries.push({tick:row.tick,net});previous=row.tick;if(row.tick<=evidence.currentTick)base-=net;
  }
  if(base<0n||base>=(1n<<128n))return null;
  const levels=[base];for(const row of entries){base+=row.net;if(base<0n||base>=(1n<<128n))return null;levels.push(base);}
  const at=tick=>{if(!Number.isInteger(tick)||tick<evidence.lowerTick||tick>=evidence.upperTick)return null;
    let lo=0,hi=entries.length;while(lo<hi){const mid=(lo+hi)>>1;if(entries[mid].tick<=tick)lo=mid+1;else hi=mid;}
    return Number(levels[lo]);};
  if(at(evidence.currentTick)!==Number(BigInt(evidence.activeLiquidityRaw)))return null;
  return {at,lowerTick:evidence.lowerTick,upperTick:evidence.upperTick,ticks:entries.map(row=>row.tick),block:evidence.block};
}
