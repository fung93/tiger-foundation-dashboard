/* Interpret approved public MCP data only. Structural wrappers are flexible;
   pool identity, chain, units and observation time remain explicit. No values,
   raw response text, sessions or instructions belong in format diagnostics. */
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const address=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)?v.toLowerCase():null;
const clean=(v,max=1600)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):null;
const number=v=>(typeof v==='number'||typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v))
  &&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=1e12?Number(v):null;
const stamp=v=>{const n=typeof v==='number'?(v<1e12?v*1000:v):typeof v==='string'?Date.parse(v):NaN;
  return Number.isFinite(n)&&n>0&&n<8640000000000000?new Date(n).toISOString():null;};
const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v==='string'?(address(v)?'address_string':'string'):typeof v;
const key=v=>/^[a-z][a-z0-9_ -]{0,39}$/i.test(v)?v:address(v)?'<address-key>':'<other-key>';
const WRAPPERS=new Set(['gauges','pools','data','result','results','items','records','rows','entries','response','output']);
const MAX_REFERENCES=80;
const chains=v=>[v?.chainId,v?.chain_id,v?.chain?.id].filter(n=>n!=null);
function shape(value,depth=0,budget={nodes:0}){
  if(++budget.nodes>60)return {type:'omitted'};
  const out={type:type(value)};
  if(Array.isArray(value)){out.length=value.length;if(depth<3&&value.length)out.item=shape(value[0],depth+1,budget);}
  else if(object(value)){
    const entries=Object.entries(value);out.keys=entries.slice(0,12).map(([name])=>key(name));
    if(depth<3)out.fields=entries.slice(0,8).map(([name,v])=>({key:key(name),...shape(v,depth+1,budget)}));
  }
  return out;
}
function jsonDocument(value){
  if(object(value)||Array.isArray(value))return {value,format:'json'};
  if(typeof value!=='string'||value.length>131072)return null;
  let text=value.trim().replace(/^\uFEFF/,'');
  const fences=[...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  if(fences.length>1)return {error:'multiple_json_documents'};
  let format='json';if(fences.length===1){text=fences[0][1].trim();format='fenced_json';}
  try{
    let parsed=JSON.parse(text);
    if(typeof parsed==='string'){parsed=JSON.parse(parsed);format='encoded_json';}
    return object(parsed)||Array.isArray(parsed)?{value:parsed,format}:null;
  }catch{return null;}
}
function textShape(text){
  const bounded=text.slice(0,12000),labels=[],lines=bounded.split(/\r?\n/).slice(0,100),tables=[];
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(v=>v.trim());
  const cellType=v=>{const s=v.replace(/^`(.*)`$/,'$1');return address(s)?'address_string':/\]\([^)]*0x[0-9a-f]{40}[^)]*\)/i.test(s)?'link_with_address'
    :/^[-+]?\$?\d[\d,.]*%?(?:\s+(?:KAT|votes))?$/i.test(s)?'formatted_number':s?'text':'empty';};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const label=line.match(/^\s*(?:[-*]\s*)?\*{0,2}([a-z][a-z _-]{1,35})\*{0,2}\s*:/i)?.[1];
    if(label&&!labels.includes(label))labels.push(label);
    if(i>0&&tables.length<2&&line.includes('|')){
      const separator=cells(line),headers=cells(lines[i-1]),sample=cells(lines[i+1]||'');
      if(separator.length>=2&&separator.every(v=>/^:?-{3,}:?$/.test(v))&&headers.length===separator.length){
        tables.push({columns:headers.slice(0,12).map((name,j)=>({name:/^[a-z][a-z0-9_ /%()-]{0,39}$/i.test(name.replaceAll('*',''))?name.replaceAll('*',''):'<other-column>',
          itemType:sample.length===headers.length?cellType(sample[j]):'unknown'}))});
      }
    }
  }
  return {type:'text',characters:text.length,startsWith:/^\s*```/.test(text)?'fence':/^\s*[\[{]/.test(text)?'json_like':/^\s*#/.test(text)?'heading':'text',
    table:lines.some(line=>/^\s*\|.*\|\s*$/.test(line)),labels:labels.slice(0,10),tables};
}
function parseDocument(document){
  const rows=[],collections=[];let nodes=0,limited=false,recognized=false,invalid=0,empty=false,upstreamErrors=0;
  const visit=(value,path='$',depth=0,inherited={time:null,chainValid:true},implicit=null,rowContext=false)=>{
    if(++nodes>512||depth>6){limited=true;return;}
    if(!object(value)&&!Array.isArray(value))return;
    if(object(value)&&(value.error||value.ok===false||value.success===false||['error','failed'].includes(value.status))){recognized=true;upstreamErrors++;return;}
    const chainValid=inherited.chainValid&&chains(value).every(n=>(typeof n==='number'||typeof n==='string')&&Number(n)===747474);
    if(!chainValid){invalid++;return;}
    const time=stamp(value.observedAt??value.updatedAt??value.timestamp??value.updated_at)||inherited.time;
    if(Array.isArray(value)){
      recognized=true;empty||=value.length===0;
      if(collections.length<8)collections.push({path,length:value.length,itemType:type(value[0]),itemKeys:object(value[0])?Object.keys(value[0]).slice(0,12).map(key):[]});
      if(value.length>80)limited=true;
      for(const row of value.slice(0,80))visit(row,path+'[]',depth+1,{time,chainValid},null,true);
      return;
    }
    // The approved Katana voting tool calls the pool address `gauge` (the same
    // mapping used by VOTER.gaugeVotes(pool) in strategy.mjs and vkat-core.mjs).
    const gauge=address(value.gauge);
    const ids=[value.pool,value.poolAddress,value.pool_address,value.pool?.address,value.pool?.id,gauge,
      rowContext?value.address:null].map(address).filter(Boolean);
    if(!ids.length&&implicit)ids.push(implicit);
    if(ids.length){
      recognized=true;
      if(new Set(ids).size!==1){invalid++;return;}
      const rates=[value.katPerDay,value.kat_per_day].filter(v=>v!=null).map(number);
      rows.push({pool:ids[0],katPerDay:rates.length&&rates.every(n=>n!==null&&n===rates[0])?rates[0]:null,
        gauge,identityBasis:gauge?'katana_voting_gauge_is_pool':'explicit_pool',
        votes:number(value.votes),votesText:typeof value.votes==='string'?clean(value.votes,120):null,
        voteSharePercentText:typeof value.sharePercent==='string'?clean(value.sharePercent,120):null,
        isAlive:typeof value.isAlive==='boolean'?value.isAlive:null,
        voteUnits:'not_supplied_by_source',observedAt:time,raw:clean(JSON.stringify(value))});
      return;
    }
    const entries=Object.entries(value);
    const mapped=entries.filter(([name,row])=>address(name)&&object(row));
    if(mapped.length){
      recognized=true;
      if(collections.length<8)collections.push({path:path+'.<address-key>',length:mapped.length,itemType:'object',itemKeys:Object.keys(mapped[0][1]).slice(0,12).map(key)});
      if(mapped.length>80)limited=true;
      for(const [name,row]of mapped.slice(0,80))visit(row,path+'.<address-key>',depth+1,{time,chainValid},address(name),true);
    }
    for(const [name,row]of entries.slice(0,80)){
      if(!WRAPPERS.has(name)||!object(row)&&!Array.isArray(row)&&typeof row!=='string')continue;
      const decoded=typeof row==='string'?jsonDocument(row):{value:row};
      if(decoded?.value)visit(decoded.value,path+'.'+name,depth+1,{time,chainValid});
    }
  };
  visit(document);
  const seen=new Map();for(const row of rows)seen.set(row.pool,(seen.get(row.pool)||0)+1);
  const unique=rows.filter(row=>seen.get(row.pool)===1);
  invalid+=rows.length-unique.length;
  if(unique.length>MAX_REFERENCES)limited=true;
  return {gauges:unique.slice(0,MAX_REFERENCES),collections,recognized,limited,invalid,upstreamErrors,
    reason:unique.length?'pool_references_found':upstreamErrors?'tool_reported_error':invalid?'conflicting_or_foreign_identity':empty?'empty_collection':recognized?'pool_identity_unrecognized':'collection_unrecognized'};
}

export function inspectKatanaMCPResult(result){
  const content=Array.isArray(result?.content)?result.content.slice(0,12):[];
  const texts=content.filter(row=>row?.type==='text'&&typeof row.text==='string').map(row=>row.text);
  const format={schemaVersion:'katana-mcp-format-v2',document:'unknown',reason:'content_unrecognized',
    contentTypes:[...new Set(content.map(row=>['text','image','audio','resource','resource_link'].includes(row?.type)?row.type:'other'))],
    structuredShape:result?.structuredContent==null?null:shape(result.structuredContent),dataShape:null,collections:[]};
  const finish=gauges=>{
    if(JSON.stringify(format).length>6000){
      for(const value of [format.structuredShape,format.dataShape])if(value?.fields)delete value.fields;
      format.collections=format.collections.slice(0,4).map(row=>({...row,itemKeys:row.itemKeys.slice(0,8)}));
      format.detailsOmitted=true;
    }
    return {gauges,format};
  };
  const structured=jsonDocument(result?.structuredContent);
  if(structured?.value){
    const parsed=parseDocument(structured.value);
    if(parsed.recognized){Object.assign(format,{document:'structured_'+structured.format,dataShape:shape(structured.value),reason:parsed.reason,collections:parsed.collections,
      limited:parsed.limited,rejectedRows:parsed.invalid,upstreamErrors:parsed.upstreamErrors});return finish(parsed.gauges);}
  }
  const docs=texts.map(jsonDocument).filter(Boolean);
  if(docs.some(row=>row.error)||docs.length>1){format.document='text';format.reason='multiple_json_documents';return finish([]);}
  const doc=docs[0]||structured;
  if(doc?.value){
    const parsed=parseDocument(doc.value);Object.assign(format,{document:docs.length?'text_'+doc.format:'structured_'+doc.format,
      dataShape:shape(doc.value),reason:parsed.reason,collections:parsed.collections,limited:parsed.limited,rejectedRows:parsed.invalid,upstreamErrors:parsed.upstreamErrors});
    return finish(parsed.gauges);
  }
  if(texts.length){format.document='text';format.reason='not_json';format.dataShape=textShape(texts.join('\n'));}
  return finish([]);
}
