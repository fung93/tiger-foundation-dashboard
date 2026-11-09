/* Fixed-chain, read-only receipt evidence for known LP book events. This is
   identified-event gas, never proof of all lifetime costs or financing. */
import {CFG,VAULT,chainOf,rpc,priceAtBlock} from './_core.mjs';
const EVENTS=['0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01'];
const hex=n=>'0x'+BigInt(n).toString(16),uint=s=>typeof s==='string'&&/^0x[0-9a-f]{1,64}$/i.test(s)?BigInt(s):null;
const hash=s=>typeof s==='string'&&/^0x[0-9a-f]{64}$/i.test(s);
export async function readPositionCostEvidence({book,chain,positionId,readRpc=rpc,readPrice=priceAtBlock,now=Date.now()}={}){
  const ch=chainOf(chain),p=book?.positions?.[chain+':'+positionId];
  if(!ch||!p||!/^\d{1,78}$/.test(String(positionId))||BigInt(positionId)>=1n<<256n
    ||!CFG.wallets.some(row=>row.address.toLowerCase()===p.wallet?.toLowerCase()))throw Object.assign(Error('Choose a known LP.'),{status:400});
  const blocks=[...new Set([...(p.deposits||[]),...(p.withdrawals||[]),...(p.claims||[])].map(row=>row.block).filter(n=>Number.isSafeInteger(n)&&n>0))];
  const result={schemaVersion:'agent-cost-evidence-v1',chain,positionId:String(positionId),owner:p.wallet,observedAt:new Date(now).toISOString(),
    complete:false,scope:'identified_lp_event_transactions',receipts:[],gasUsd:null,swapCostsUsd:null,financingUsd:null,
    omittedBlocks:blocks.length>6,reason:'Approvals, shared transactions, swaps, borrowing and other lifetime operations are not fully attributed.'};
  const topic='0x'+BigInt(positionId).toString(16).padStart(64,'0'),seen=new Set();
  for(const block of blocks.slice(-6)){
    let logs;try{logs=await readRpc(ch.rpc,'eth_getLogs',[{address:ch.npm,fromBlock:hex(block),toBlock:hex(block),topics:[EVENTS,topic]}]);}catch{continue;}
    if(!Array.isArray(logs)||logs.length>128)continue;
    for(const log of logs){
      if(result.receipts.length>=8){result.omittedBlocks=true;break;}
      if(log.removed||log.address?.toLowerCase()!==ch.npm.toLowerCase()||log.topics?.[1]?.toLowerCase()!==topic
        ||!EVENTS.includes(log.topics[0])||uint(log.blockNumber)!==BigInt(block)||!hash(log.transactionHash)||!hash(log.blockHash)||seen.has(log.transactionHash))continue;
      seen.add(log.transactionHash);
      try{
        const receipt=await readRpc(ch.rpc,'eth_getTransactionReceipt',[log.transactionHash]);
        const gas=uint(receipt?.gasUsed),price=uint(receipt?.effectiveGasPrice),extra=receipt?.l1Fee==null?0n:uint(receipt.l1Fee);
        if(receipt?.transactionHash?.toLowerCase()!==log.transactionHash.toLowerCase()||receipt.blockHash?.toLowerCase()!==log.blockHash.toLowerCase()
          ||uint(receipt.blockNumber)!==BigInt(block)||uint(receipt.status)!==1n||receipt.from?.toLowerCase()!==p.wallet.toLowerCase()
          ||gas===null||price===null||extra===null||!Array.isArray(receipt.logs)||!receipt.logs.some(row=>row.address?.toLowerCase()===ch.npm.toLowerCase()
            &&row.topics?.[0]===log.topics[0]&&row.topics?.[1]?.toLowerCase()===topic))continue;
        const shared=receipt.logs.some(row=>row.address?.toLowerCase()===ch.npm.toLowerCase()&&EVENTS.includes(row.topics?.[0])&&row.topics[1]?.toLowerCase()!==topic);
        const nativeRaw=gas*price+extra;let usd=null,priceBasis=null;
        const key=chain==='robinhood'?'WETH@robinhood':'vbETH@katana';
        const priceBook=chain==='katana'?{...book,tokens:{...book.tokens,[key]:{chain,a:VAULT.chains.katana.tokens.find(t=>t.px==='eth').a,
          s:'vbETH',d:18,stable:false,pool:VAULT.pricePools.eth,other:{a:VAULT.chains.katana.tokens.find(t=>t.s==='vbUSDC').a,d:6}}}}:book;
        try{const quote=await readPrice(priceBook,key,block);if(Number.isFinite(quote)&&quote>0){usd=Number(nativeRaw)/1e18*quote;
          priceBasis=chain==='katana'?'Historical vbETH/USDC proxy for native ETH':'Historical WETH/USDG proxy for native ETH';}}catch{}
        result.receipts.push({transactionHash:log.transactionHash,block,blockHash:log.blockHash,owner:p.wallet,nativeSymbol:'ETH',nativeRaw:nativeRaw.toString(),
          gasUsed:gas.toString(),effectiveGasPrice:price.toString(),extraL1Fee:extra.toString(),usd,priceBasis,shared,
          scope:shared?'Whole transaction; individual LP allocation is unknown.':'Identified LP event transaction; other operations may share its gas.'});
      }catch{}
    }
  }
  if(result.receipts.length&&result.receipts.every(row=>Number.isFinite(row.usd)&&!row.shared))result.gasUsd=result.receipts.reduce((n,row)=>n+row.usd,0);
  return result;
}
