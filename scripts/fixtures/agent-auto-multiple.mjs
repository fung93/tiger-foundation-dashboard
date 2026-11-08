/* Two hypothetical chains, including a staked Katana LP. No provider access. */
import { snapRange, tickAtPrice, priceAtTick, liquidityForCapital } from '../../strategy-core.mjs';
import { reviewFixtureFetcher } from './agent-review.mjs';

const address=n=>'0x'+String(n).padStart(40,'0');
export function robinhoodLPFixture(now) {
  const pool={chain:'robinhood',pool:address(13),kind:'fees',status:'fresh',ts:new Date(now).toISOString(),
    token0:{address:address(11),symbol:'WETH',decimals:18,usd:3000},token1:{address:address(12),symbol:'USDG',decimals:6,usd:1},
    baseIndex:0,base:'WETH',quote:'USDG',price:3000,tickSpacing:10,fee:500,activeLiquidity:100000,recent:{},
    block:100,accounting:{valuationBlockPinned:true}};
  pool.tick=Math.floor(tickAtPrice(pool.price,pool));pool.price=priceAtTick(pool.tick,pool);pool.sqrtPrice=1.0001**(pool.tick/2);
  const band=snapRange(2800,3300,pool),liquidity=liquidityForCapital(500,band.tickLower,band.tickUpper,pool);
  const position={schemaVersion:'lp-position-v1',id:'2002',positionId:'2002',chain:'robinhood',owner:address(20),contract:address(14),
    pool:pool.pool,pair:'WETH / USDG',protocol:'Uniswap V3',status:'observed',observedAt:new Date(now).toISOString(),principalUsd:500,
    staked:false,feesMine:true,inRange:true,raw:{liquidity:String(Math.round(liquidity.liquidity)),lowerTick:band.tickLower,upperTick:band.tickUpper,
      sqrtPriceX96:BigInt(Math.floor(pool.sqrtPrice*2**96)).toString(),token0:pool.token0,token1:pool.token1}};
  return {pool,position,live:{id:position.id,chain:position.chain,pair:position.pair,in_range:true}};
}
export function multipleLPFetcher(now,calls=[]) {
  const source=reviewFixtureFetcher(now,calls);
  return async url=>{
    const response=await source(url);if(new URL(url).pathname!=='/api/lpbook')return response;
    const book=await response.json(),rh=robinhoodLPFixture(now);
    book.live.unshift(rh.live);book.position_data.unshift(rh.position);
    book.cards.open++;book.cards.value_usd+=rh.position.principalUsd;
    return Response.json(book);
  };
}
