/* 1inch v4: official IOrderMixin.Order ABI and OrderFilled(bytes32,uint256).
   Authenticate the exact eight-word order against the deployed protocol's hashOrder.
   Calldata can belong to a resolver which embeds the protocol call in its own ABI. */
import {ONEINCH_PROTOCOL,ONEINCH_FILLED} from '../uni-trade-core.mjs';
const FEE_TAKERS={base:'0xc0dfdb9e7a392c3dbbe7c6fbe8fbc1789c9fe05e',bnb:'0xc0dfdb9e7a392c3dbbe7c6fbe8fbc1789c9fe05e'};
const HASH_ORDER='0x802b2ef1',zero='0x'+'0'.repeat(40);
export function uniOrderCandidates(chain,wallets,transaction){
 const input=String(transaction.input||'').toLowerCase().replace(/^0x/,''),out=[],seen=new Set();
 if(!/^[0-9a-f]*$/.test(input)||input.length>500000)throw Error('Unverified order calldata');
 for(const owner of wallets){const pattern=owner.slice(2).padStart(64,'0');let at=input.indexOf(pattern);
  while(at>=0){
   if(at>=64&&at%2===0&&input.length>=at-64+512){const encoded=input.slice(at-64,at-64+512),words=encoded.match(/.{64}/g),addr=n=>'0x'+words[n].slice(-40),maker=addr(1),receiver=addr(2)===zero?maker:addr(2),makerAsset=addr(3),takerAsset=addr(4),assets=[chain.uni.address,...chain.stables.map(t=>t.address)];
    if(wallets.includes(maker)&&(wallets.includes(receiver)||receiver===FEE_TAKERS[chain.key])&&[makerAsset,takerAsset].includes(chain.uni.address)&&assets.includes(makerAsset)&&assets.includes(takerAsset)&&makerAsset!==takerAsset&&BigInt('0x'+words[5])>0n&&BigInt('0x'+words[6])>0n&&!seen.has(encoded)){
     out.push({maker,receiver,makerAsset,takerAsset,encoded,feeTaker:receiver===FEE_TAKERS[chain.key]});seen.add(encoded);if(out.length>32)throw Error('Too many candidate orders');
    }
   }at=input.indexOf(pattern,at+2);
  }
 }
 return out;
}
export async function verifyUniOrders(chain,wallets,rpc,receipt,transaction){
 const hashes=new Set((receipt.logs||[]).filter(log=>log.address?.toLowerCase()===ONEINCH_PROTOCOL&&log.topics?.[0]===ONEINCH_FILLED&&/^0x[0-9a-f]{128}$/i.test(log.data||'')).map(log=>log.data.slice(0,66).toLowerCase()));
 if(!hashes.size)return [];
 const result=[];
 for(const candidate of uniOrderCandidates(chain,wallets,transaction)){
  const hash=await rpc('eth_call',[{to:ONEINCH_PROTOCOL,data:HASH_ORDER+candidate.encoded},receipt.blockNumber]);
  if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('1inch order hash unavailable');
  if(hashes.has(hash.toLowerCase()))result.push({...candidate,hash:hash.toLowerCase()});
 }
 return result;
}
