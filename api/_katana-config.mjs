/* Verified Katana assets and stablecoin quote pools. No remote configuration. */
export const KATANA_ASSETS=Object.freeze({
 USDC:{address:'0x203a662b0bd271a6ed5a60edfbd04bfce608fd36',symbol:'vbUSDC',decimals:6},
 USDT:{address:'0x2dca96907fde857dd3d816880a0df407eeb2d2f2',symbol:'vbUSDT',decimals:6},
 KAT:{address:'0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d',symbol:'KAT',decimals:18},
 avKAT:{address:'0x7231dbacdfc968e07656d12389ab20de82fbfceb',symbol:'avKAT',decimals:18},
 ETH:{address:'0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62',symbol:'vbETH',decimals:18},
 BTC:{address:'0x0913da6da4b42f538b445599b46bb4622342cf52',symbol:'vbWBTC',decimals:8},
});
export const KATANA_USD_POOLS=Object.freeze({
 [KATANA_ASSETS.KAT.address]:'0x10045367e619caae6f60cc80046c43c6cd55f629',
 [KATANA_ASSETS.ETH.address]:'0x2a2c512beaa8eb15495726c235472d82effb7a6b',
 [KATANA_ASSETS.BTC.address]:'0x744676b3ced942d78f9b8e9cd22246db5c32395c',
});
