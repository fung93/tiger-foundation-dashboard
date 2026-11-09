/* Official release feeds and first-party incentives. Provider prose is evidence,
   never an instruction, policy authority or model-selected network destination. */
import {createHash} from 'node:crypto';
import {renderInvestmentBrief} from '../agent-investment-brief.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const PROTOCOL_WATCH_SOURCES=Object.freeze([
 {id:'morpho-releases',protocol:'Morpho',repo:'morpho-org/morpho-blue'},
 {id:'sushi-releases',protocol:'Sushi V3',repo:'sushiswap/v3-periphery'},
 {id:'merkl-releases',protocol:'Merkl',repo:'AngleProtocol/merkl-contracts'},
].map(row=>Object.freeze({...row,url:'https://api.github.com/repos/'+row.repo+'/releases?per_page=5'})));
const KEY='investment:protocol-watch',fresh=(ts,now,age=90000)=>Number.isFinite(Date.parse(ts))&&now-Date.parse(ts)>=-30000&&now-Date.parse(ts)<age;
function incentivePools(context,now){
 const pools=context.strategy?.pools||[];if(!context.lp)return pools;
 if(context.lp.status!=='fresh')return [];
 const owned=(context.lp.positions||[]).map(row=>row.canonical).filter(p=>p?.chain==='katana'&&p.status==='observed'&&fresh(p.observedAt,now));
 return pools.filter(pool=>owned.some(p=>p.pool?.toLowerCase()===pool.pool?.toLowerCase()));
}
async function boundedJSON(response){
 if(Number(response.headers.get('content-length'))>65536||!/^application\/(?:json|[^;]+\+json)/i.test(response.headers.get('content-type')||''))throw Error('Unsupported feed');
 const reader=response.body?.getReader();if(!reader)throw Error('Unbounded feed');let size=0,text='';const decoder=new TextDecoder();
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw Error('Oversized feed');}text+=decoder.decode(part.value,{stream:true});}
 return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}
export function parseReleaseFeed(raw,source,now){
 if(!Array.isArray(raw)||raw.length>5)throw Error('Unsupported release collection');const entries=[];
 for(const row of raw){
   if(row.draft===true||row.prerelease===true)continue;
   const at=Date.parse(row.published_at);let url;try{url=new URL(row.html_url);}catch{throw Error('Unverified release URL');}
   if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.search||url.hash
     ||!url.pathname.toLowerCase().startsWith('/'+source.repo.toLowerCase()+'/releases/tag/')||!Number.isFinite(at)||at>now+30000
     ||!Number.isSafeInteger(row.id)||typeof row.tag_name!=='string'||row.tag_name.length>100)throw Error('Unverified release');
   entries.push({id:row.id,tag:row.tag_name,title:String(row.name||row.tag_name).replace(/[\u0000-\u001f]/g,'').slice(0,120),
     url:url.href,publishedAt:new Date(at).toISOString(),excerpt:String(row.body||'').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').slice(0,500)});
 }
 if(new Set(entries.map(row=>row.id)).size!==entries.length)throw Error('Duplicate release IDs');return entries;
}
export function incentiveWarnings(context,now=Date.now()){
 const warnings=[];
 for(const pool of incentivePools(context,now)){
   if(!fresh(pool.ts||context.strategy.ts,now)||!Number.isFinite(pool.campaign?.end))continue;
   const days=(pool.campaign.end-now/1000)/86400;if(days>3)continue;
   warnings.push({id:'campaign:'+pool.pool+':'+pool.campaign.end,protocol:'Merkl',pool:pool.pool,severity:'warning',
     message:pool.base+'/'+pool.quote+': '+(days<=0?'the recorded KAT campaign has ended.':'the KAT campaign ends within '+Math.max(1,Math.ceil(days))+' day(s).'),
     sourceTime:pool.ts||context.strategy.ts,validUntil:new Date(Date.parse(pool.ts||context.strategy.ts)+90000).toISOString(),
     recheck:'Verify the next funded campaign before relying on the same reward rate.'});
 }
 return warnings.slice(0,6);
}
export function compareIncentives(context,previous={},now=Date.now()){
 const current=incentivePools(context,now).filter(pool=>fresh(pool.ts||context.strategy.ts,now)&&/^0x[0-9a-f]{40}$/i.test(pool.pool||'')
   &&(pool.chain||'katana')==='katana'&&Number.isFinite(pool.katPerDay)&&pool.katPerDay>=0
   &&Number.isFinite(pool.campaign?.start)&&Number.isFinite(pool.campaign?.end)&&pool.campaign.end>pool.campaign.start).slice(0,8)
   .map(pool=>({pool:pool.pool.toLowerCase(),pair:pool.base+'/'+pool.quote,katPerDay:pool.katPerDay,start:pool.campaign.start,end:pool.campaign.end,
     sourceTime:pool.ts||context.strategy.ts}));
 const signature=row=>hash([row.pool,row.katPerDay,row.start,row.end]),warnings=[];
 for(const row of current){const prior=previous.incentives?.find(old=>old.pool===row.pool),reference=prior?.noticeRate??prior?.katPerDay,
   changed=prior&&Date.parse(row.sourceTime)>Date.parse(prior.sourceTime)
   &&(prior.start!==row.start||prior.end!==row.end||Math.abs(row.katPerDay-reference)>=Math.max(.000001,reference*.05));
   row.noticeRate=changed?row.katPerDay:reference??row.katPerDay;
   const retained=(previous.incentiveEvents||previous.warnings||[]).find(warning=>warning.kind==='incentive_change'&&warning.targetSignature===signature(row)&&now-Date.parse(warning.noticedAt)<86400000);
   if(!changed&&!retained)continue;
   warnings.push({...retained,id:retained?.id||'incentive-change:'+signature(row),kind:'incentive_change',targetSignature:signature(row),protocol:'Merkl',pool:row.pool,
     severity:'warning',noticedAt:retained?.noticedAt||new Date(now).toISOString(),sourceTime:row.sourceTime,validUntil:new Date(Date.parse(row.sourceTime)+90000).toISOString(),
     message:retained?.message||(prior.start!==row.start||prior.end!==row.end?row.pair+': the recorded KAT campaign dates changed.'
       :row.pair+': recorded pool KAT emissions changed from '+reference.toFixed(2)+' to '+row.katPerDay.toFixed(2)+' KAT/day.'),
     recheck:'Recalculate the owner reward share, campaign coverage and reset costs. Pool emissions are not the wallet’s daily income.'});
 }
 const events=[...new Map([...warnings,...(previous.incentiveEvents||previous.warnings||[])].filter(row=>row.kind==='incentive_change'&&now-Date.parse(row.noticedAt)<86400000)
   .map(row=>[row.id,row])).values()].slice(0,8);
 return {incentives:[...current,...(previous.incentives||[]).filter(old=>!current.some(row=>row.pool===old.pool))].slice(0,8),warnings,incentiveEvents:events};
}
export async function checkProtocolWatch({store,context={},fetcher=fetch,now=Date.now(),enabled=true}={}){
 if(!enabled)return {schemaVersion:'agent-protocol-watch-v1',status:'disabled',sources:[],warnings:[]};
 const lease=await store.lock(KEY,30);if(!lease)throw Error('Protocol sources are being checked');
 try{
   const previous=await store.get(KEY),due=!fresh(previous?.feedsCheckedAt,now,previous?.status==='ready'?21600000:1800000),sources=[];
   if(due)for(const source of PROTOCOL_WATCH_SOURCES){
     const prior=previous?.sources?.find(row=>row.id===source.id);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
     try{
       const response=await fetcher(source.url,{headers:{accept:'application/vnd.github+json','user-agent':'TigerFoundationReadOnlyAgent',...(prior?.etag?{'if-none-match':prior.etag}:{})},
         redirect:'manual',cache:'no-store',signal:controller.signal});
       if(response.redirected||response.url&&response.url!==source.url)throw Error('Redirect');
       let entries;if(response.status===304&&prior?.etag&&prior?.entries)entries=prior.entries;else{
         if(!response.ok)throw Error('Unavailable feed');entries=parseReleaseFeed(await boundedJSON(response),source,now);
       }
       const contentHash=hash(entries),evidenceId='protocol:'+hash([source.id,contentHash]),newEntries=prior?.checkedAt&&Array.isArray(prior.entries)
         ?entries.filter(row=>!prior.entries.some(old=>old.id===row.id)):[];
       if(contentHash!==prior?.contentHash)await store.putImmutable(evidenceId,{schemaVersion:'agent-release-evidence-v1',sourceId:source.id,
         canonicalUrl:source.url,contentHash,entries,firstRetrievedAt:new Date(now).toISOString(),scope:'Official repository releases; not exhaustive announcements/governance.'});
       sources.push({...source,status:'fresh',checkedAt:new Date(now).toISOString(),etag:response.headers.get('etag')?.slice(0,240)||prior?.etag||null,
         contentHash,evidenceId,entries,newEntries});
     }catch{sources.push({...source,status:prior?.entries?'stale':'unavailable',checkedAt:prior?.checkedAt||null,etag:prior?.etag||null,
       contentHash:prior?.contentHash||null,evidenceId:prior?.evidenceId||null,
       entries:prior?.entries||[],newEntries:[],errorCategory:'source_unverified'});}finally{clearTimeout(timer);}
   }else sources.push(...previous.sources);
   const changes=compareIncentives(context,previous||{},now),warnings=[...changes.warnings,...incentiveWarnings(context,now)];
   for(const source of sources)if(source.status==='fresh'&&fresh(source.checkedAt,now,21600000))for(const entry of source.newEntries||[])warnings.push({
     id:'release:'+source.id+':'+entry.id,protocol:source.protocol,severity:'info',message:source.protocol+': official release '+entry.tag+' was published.',
     sourceTime:source.checkedAt,validUntil:new Date(Date.parse(source.checkedAt)+21600000).toISOString(),url:entry.url,
     recheck:'Review the official release and its relevance to the held deployment; a repository release does not prove a live contract upgrade.'});
   const record={schemaVersion:'agent-protocol-watch-v1',status:sources.every(row=>row.status==='fresh')?'ready':'partial',checkedAt:new Date(now).toISOString(),
     feedsCheckedAt:due?new Date(now).toISOString():previous.feedsCheckedAt,sources,incentives:changes.incentives,incentiveEvents:changes.incentiveEvents,warnings:warnings.slice(0,8),
     scope:'Configured official release feeds plus current first-party campaign readings. No broad news/governance coverage is claimed.'};
   await lease.commit([{key:KEY,value:record}]);return record;
 }finally{await lease.release();}
}
export async function protocolWatchView(store,{now=Date.now()}={}){
 const record=await store.get(KEY);if(!record)return {schemaVersion:'agent-protocol-watch-v1',status:'waiting_first_check',sources:[],warnings:[]};
 return {...record,warnings:(record.warnings||[]).filter(row=>Date.parse(row.validUntil)>now),
   status:fresh(record.checkedAt,now,21600000)?record.status:'stale'};
}
export function currentProtocolWarnings(record,now=Date.now()){
 return (record?.warnings||[]).filter(row=>typeof row.id==='string'&&typeof row.message==='string'
   &&Date.parse(row.sourceTime)<=now+30000&&Date.parse(row.validUntil)>now).slice(0,8);
}
export function renderProtocolNotice(warning){
 return renderInvestmentBrief({suggestion:'Review this protocol or incentive change.',evidence:warning.message,
  tradeOff:'This notice does not establish an exploit, a live contract upgrade or guaranteed future rewards.',recheck:warning.recheck})
  +(warning.url?'\nOfficial source: '+warning.url:'');
}
