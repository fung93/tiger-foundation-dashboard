/* Closed test chain, never imported by the site or its API. */
import {UNI_CHAINS,UNI_MULTICALL} from '../../api/_uni-config.mjs';
import {UNI_SWAP_TOPIC} from '../../api/_uni-reader.mjs';
const pad=v=>BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0');
const data=(...v)=>'0x'+v.map(pad).join('');
export function uniFixture(chainKey='base',{now=1794661200,archiveFailure=false,logsFailure=false,reorg=false,missingDiscovery=false,empty=false}={}){
  const chain=UNI_CHAINS[chainKey],stable=chain.stables[0],head=1000000,pool=chainKey==='base'?'0x'+'1'.repeat(40):'0x'+'2'.repeat(40),fee=500,
    tokens=[chain.uni,stable].sort((a,b)=>a.address.localeCompare(b.address)),baseIndex=tokens[0].address===chain.uni.address?0:1,
    ratio=(baseIndex===0?8:1/8)/10**(tokens[0].decimals-tokens[1].decimals),sqrt=BigInt(Math.floor(Math.sqrt(ratio)*2**96)),tick=Math.floor(Math.log(ratio)/Math.log(1.0001)),
    L=chainKey==='base'?10n**18n:10n**23n,growth=(2n**128n)*(10n**BigInt(tokens[0].decimals))/2n/L;
  const requests=[];let heads=0;
  function call(to,bytes,block){
    const selector=bytes.slice(0,10);
    if(to===chain.factory){const a='0x'+bytes.slice(34,74),b='0x'+bytes.slice(98,138),f=Number(BigInt('0x'+bytes.slice(138,202)));
      if(missingDiscovery&&f===100)return {ok:false,data:'0x'};
      return {ok:true,data:data(!empty&&f===fee&&[a,b].includes(stable.address)?BigInt(pool):0n)};}
    if(selector==='0x313ce567'){const token=[chain.uni,...chain.stables].find(t=>t.address===to);return {ok:true,data:data(token.decimals)};}
    if(selector==='0x70a08231')return {ok:true,data:data(to===chain.uni.address?1000n*10n**18n:10000n*10n**BigInt(stable.decimals))};
    if(to!==pool)return {ok:false,data:'0x'};
    if(archiveFailure&&block<head)return {ok:false,data:'0x'};
    const values={
      '0x3850c7bd':data(sqrt,tick,0,1,1,0,1),'0x1a686502':data(L),'0xd0c93a7c':data(10),'0xc45a0155':data(BigInt(chain.factory)),
      '0x0dfe1681':data(BigInt(tokens[0].address)),'0xd21220a7':data(BigInt(tokens[1].address)),'0xddca3f43':data(fee),
      '0xf3058399':data(100n+(block===head?growth:0n)),'0x46141319':data(200),
    };
    return {ok:true,data:values[selector]||data(0)};
  }
  function multicall(encoded,block){
    const h=encoded.slice(10),n=Number(BigInt('0x'+h.slice(64,128))),rows=[];
    for(let i=0;i<n;i++){const offset=64+Number(BigInt('0x'+h.slice(128+i*64,192+i*64))),at=offset*2,to='0x'+h.slice(at+24,at+64),
      dynamic=Number(BigInt('0x'+h.slice(at+128,at+192)))*2+at,len=Number(BigInt('0x'+h.slice(dynamic,dynamic+64))),bytes='0x'+h.slice(dynamic+64,dynamic+64+len*2);
      rows.push(call(to,bytes,block));}
    let tails='',offsets='';for(const row of rows){offsets+=pad(n*32+tails.length/2);const bytes=row.data.slice(2);tails+=pad(row.ok?1:0)+pad(64)+pad(bytes.length/2)+bytes.padEnd(Math.ceil(bytes.length/64)*64,'0');}
    return '0x'+pad(32)+pad(n)+offsets+tails;
  }
  const swap={address:pool,blockNumber:'0x'+(head-10).toString(16),logIndex:'0x1',transactionHash:'0x'+'3'.repeat(64),topics:[UNI_SWAP_TOPIC],
    data:data(1000n*10n**BigInt(tokens[0].decimals),-125n*10n**BigInt(tokens[1].decimals),sqrt,L,tick)};
  const rpc=async(method,params)=>{
    requests.push({method,params});
    if(method==='eth_chainId')return '0x'+chain.id.toString(16);
    if(method==='eth_blockNumber')return '0x'+head.toString(16);
    if(method==='eth_getBlockByNumber'){const n=Number(BigInt(params[0]));if(n===head)heads++;return {number:params[0],timestamp:'0x'+(now-(head-n)*2).toString(16),hash:'0x'+pad(n+(reorg&&heads>1?1:0))};}
    if(method==='eth_call'){if(params[0].to!==UNI_MULTICALL)throw Error('Unexpected direct call');return multicall(params[0].data,Number(BigInt(params[1])));}
    if(method==='eth_getCode')return '0x6000';
    if(method==='eth_getLogs'){if(logsFailure)throw Error('Provider timed out');return empty?[]:[swap];}
    throw Error('Unsupported closed RPC');
  };
  return {chain,rpc,now,pool,requests,swap};
}
