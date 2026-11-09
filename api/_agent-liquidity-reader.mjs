/* Three fixed bitmap words and at most 96 initialized ticks, at the pool's
   already pinned block. This reader lives in the existing financial API. */
import {multi,VAULT} from './_core.mjs';
import {createLiquidityCurve} from '../agent-liquidity.mjs';
const signed=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const word=(row,index=0)=>row?.ok&&/^0x[0-9a-f]+$/i.test(row.data||'')&&row.data.length>=66+index*64
  ?BigInt('0x'+row.data.slice(2+index*64,66+index*64)):null;
export async function readLiquidityEvidence(market,{readMulti=multi}={}){
  const result={schemaVersion:'agent-liquidity-v1',chain:market.chain,pool:market.pool,block:market.block,
    observedAt:market.observedAt,currentTick:market.tick,activeLiquidityRaw:market.activeLiquidityRaw,
    complete:false,ticks:[],lowerTick:null,upperTick:null,reason:'Initialized liquidity is unavailable.'};
  if(!VAULT.chains[market.chain]||!Number.isInteger(market.tickSpacing)||market.tickSpacing<1
    ||!Number.isSafeInteger(market.block)||!/^0x[0-9a-f]{40}$/i.test(market.pool||''))return result;
  const center=Math.floor(Math.floor(market.tick/market.tickSpacing)/256),indices=[center-1,center,center+1];
  result.lowerTick=Math.max(-887272,indices[0]*256*market.tickSpacing);
  result.upperTick=Math.min(887273,(indices[2]+1)*256*market.tickSpacing);
  const rpc=VAULT.chains[market.chain].rpc,tag='0x'+market.block.toString(16);
  try{
    const maps=await readMulti(rpc,indices.map(index=>({to:market.pool,data:'0x5339c296'+signed(index)})),tag);
    const ticks=[];
    for(let i=0;i<indices.length;i++){
      const bits=word(maps[i]);if(bits===null)throw Error();
      for(let bit=0;bit<256;bit++)if(bits&(1n<<BigInt(bit))){const tick=(indices[i]*256+bit)*market.tickSpacing;
        if(tick>=-887272&&tick<=887272)ticks.push(tick);if(ticks.length>96)return {...result,reason:'The bounded bitmap region contains more than 96 initialized ticks.'};}
    }
    const rows=ticks.length?await readMulti(rpc,ticks.map(tick=>({to:market.pool,data:'0xf30dba93'+signed(tick)})),tag):[];
    result.ticks=ticks.map((tick,i)=>{const gross=word(rows[i]),net=word(rows[i],1),initialized=word(rows[i],7);
      if(gross===null||net===null||initialized!==1n)throw Error();return {tick,gross:gross.toString(),net:BigInt.asIntN(256,net).toString()};});
    result.complete=true;result.reason=null;
    if(!createLiquidityCurve(result))throw Error();return result;
  }catch{return {...result,complete:false,ticks:[],reason:'Bitmap/tick responses could not be reconciled at the pinned block.'};}
}
