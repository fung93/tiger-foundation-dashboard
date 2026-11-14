/* Addresses from Uniswap/sdk-core and Uniswap/default-token-list. BNB's
   Binance-Peg assets are identified by contract, not just their ticker. */
const token=(symbol,address,decimals)=>({symbol,address:address.toLowerCase(),decimals});
export const UNI_CHAINS=Object.freeze({
  base:{key:'base',name:'Base',id:8453,factory:'0x33128a8fc17869897dce68ed026d694621f6fdfd',
    rpcs:['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.gateway.tenderly.co'],
    uni:token('UNI','0xc3de830ea07524a0761646a6a4e4be0e114a3c83',18),
    stables:[token('USDC','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',6),token('USDT','0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',6),token('DAI','0x50c5725949a6f0c72e6c4a641f24049a917db0cb',18),token('USDbC','0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',6)]},
  bnb:{key:'bnb',name:'BNB Chain',id:56,factory:'0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7',
    rpcs:['https://bsc-rpc.publicnode.com','https://bsc-dataseed1.bnbchain.org','https://bsc-dataseed2.bnbchain.org'],
    uni:token('UNI','0xbf5140a22578168fd562dccf235e5d43a02ce9b1',18),
    stables:[token('USDT','0x55d398326f99059ff775485246999027b3197955',18),token('USDC','0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',18),token('DAI','0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3',18)]},
});
export const UNI_FEE_TIERS=[100,200,300,400,500,3000,10000];
export const UNI_MULTICALL='0xca11bde05977b3631167028862be2a173976ca11';
