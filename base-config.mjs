/* Official Uniswap V3 deployment on Base (8453). Public, read-only configuration.
   The UNI guide uses the same factory/token addresses in api/_uni-config.mjs. */
export const BASE = Object.freeze({
  key: 'base', id: 8453, name: 'Base',
  npm: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
  factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.gateway.tenderly.co'],
  tokens: [
    { s: 'USDC', a: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', d: 6, stable: true },
    { s: 'USDT', a: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', d: 6, stable: true },
    { s: 'DAI', a: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', d: 18, stable: true },
    { s: 'USDbC', a: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', d: 6, stable: true },
    { s: 'WETH', a: '0x4200000000000000000000000000000000000006', d: 18 },
    { s: 'UNI', a: '0xc3de830ea07524a0761646a6a4e4be0e114a3c83', d: 18 },
  ],
});
