/* Execute the real policy form/action helpers with a small local DOM fixture.
   No browser dependency, external service, model, wallet or Telegram is contacted. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source=readFileSync(new URL('../agent.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../agent.html',import.meta.url),'utf8');
let checks=0;
const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);checks++;};
const plain=value=>JSON.parse(JSON.stringify(value));
class Node {
  constructor(text=''){this.children=[];this._text=text;this.value='';this.hidden=false;this.checked=false;this.disabled=false;this.dataset={};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;this._text='';}
  get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  set textContent(value){this._text=String(value);this.children=[];}
  querySelectorAll(){return [];}
  get firstElementChild(){return this.children.find(child=>child instanceof Node)||null;}
}
const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Node()]));
const get=id=>{if(!nodes.has(id))throw Error('Missing fixture element '+id);return nodes.get(id);};
const names=['portfolio','lending','lp','kat','research','strategy'];
const analyses=names.map(value=>Object.assign(new Node(),{value}));
const markets=['avkat-kat','avkat-usdc','kat-usdc'].map(key=>{
  const row=new Node(),fields={targetHealth:new Node(),maxLtvPct:new Node()};row.dataset.policyMarket=key;
  row.querySelector=selector=>fields[selector.match(/"([^"]+)"/)[1]];row.fields=fields;return row;
});
let exposures=[];
function exposure(asset='',limit=''){
  const row=new Node(),token=Object.assign(new Node(),{value:asset}),cap=Object.assign(new Node(),{value:limit});
  row.querySelector=selector=>selector==='[data-exposure-asset]'?token:cap;return row;
}
get('agentPolicyExposures').querySelectorAll=()=>exposures;
get('agentPolicyMarkets').querySelectorAll=()=>markets;
get('agentPolicyAnalysisTypes').querySelectorAll=()=>analyses;
const calls=[],notices=[];
const context=vm.createContext({$,Date,Number,Set,Object,Array,String,JSON,Error,Math,URL,crypto:{randomUUID},
  state:{authenticated:true},policyState:{version:0,status:'unconfirmed',constraints:{}},policyFormVersion:0,
  privateViewVersion:0,
  policyDirty:true,policyConflict:false,policyDraft:null,
  element:(_tag,_cls,text)=>new Node(text===undefined?'':String(text)),
  notice:(message,error)=>notices.push({message,error}),
  policyButtons:()=>{},renderPolicy:policy=>{context.renderedPolicy=policy;},
  date:value=>value?String(value):'',epoch:value=>Date.parse(value),
  request:async(action,body)=>{
    calls.push({action,body:plain(body)});
    if(action==='policyDraft')return {draftId:'local-draft',baseVersion:0,status:'draft',constraints:body.patch,
      changes:[{field:'horizonDays',before:null,after:body.patch.horizonDays}],expiresAt:new Date(Date.now()+60000).toISOString()};
    return {version:1,status:'confirmed',constraints:{horizonDays:30}};
  },
});
function $(id){return get(id);}
function part(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,'Real helper markers remain present');return source.slice(start,end);}
vm.runInContext(source.match(/^const samePrivateView=.*$/m)[0]+'\n'+part('const POLICY_MARKETS=','function addExposureRow')
  +part('function markPolicyDirty','function renderPolicy')
  +part('async function previewPolicy','function renderToolResult')
  +part('function renderDiagnostics','function clearPrivateAnalysis')
  +'\nglobalThis.helpers={policyPatch,previewPolicy,confirmPolicy,markPolicyDirty,renderDiagnostics,policyDescription};',context);
const helpers=context.helpers;
const empty=plain(helpers.policyPatch());
for(const [key,value] of Object.entries(empty))check(value,null,'Unknown '+key+' remains unset instead of inheriting notification/page defaults');
get('agentPolicyHorizon').value='30';get('agentPolicyReserve').value='0';get('agentPolicyReview').value='7';
get('agentPolicyAssets').value='KAT, avKAT, KAT';get('agentPolicyProtocols').value='Morpho, Sushi';
exposures=[exposure('KAT','0')];markets[0].fields.targetHealth.value='1.5';markets[0].fields.maxLtvPct.value='70';
get('agentPolicyOutOfRange').value='false';get('agentPolicyOutHours').value='0';analyses[1].checked=true;
const populated=plain(helpers.policyPatch());
check(populated.minLiquidReserveUsd,0,'A zero reserve is explicit rather than unknown');
check(populated.exposureLimits,{KAT:0},'A zero exposure cap is preserved');
check(populated.lpReviewTriggers,{outOfRange:false,maxOutOfRangeHours:0},'False and zero review triggers remain explicit');
check(populated.eligibleAssets,['KAT','avKAT'],'Named asset lists are normalized without a JSON editor');
check(populated.marketLimits,{'avkat-kat':{targetHealth:1.5,maxLtvPct:70}},'Each market remains separate');
check(populated.allowedAnalysisTypes,['lending'],'Only selected analysis types enter the policy');
check(Object.hasOwn(populated,'healthThreshold'),false,'Notification settings cannot become strategy policy fields');
check(Object.hasOwn(populated,'ltvThreshold'),false,'Alert LTV defaults never become a strategy mandate');
exposures=[exposure('KAT','20'),exposure('kat','30')];assert.throws(()=>helpers.policyPatch(),/one exposure/);checks++;
exposures=[exposure('KAT','')];assert.throws(()=>helpers.policyPatch(),/asset and percentage/);checks++;
exposures=[exposure('__proto__','10')];const special=plain(helpers.policyPatch());
check(Object.hasOwn(special.exposureLimits,'__proto__'),true,'Special asset input cannot mutate a client object prototype before server validation');
exposures=[];get('agentPolicyReserve').value='not-a-number';assert.throws(()=>helpers.policyPatch(),/valid minimum liquid reserve/);checks++;
get('agentPolicyReserve').value='0';
const event={preventDefault(){},currentTarget:{reportValidity:()=>true}};
context.state={authenticated:false};await helpers.previewPolicy(event);check(calls.length,0,'Signed-out preview cannot invoke a private mutation');
context.state={authenticated:true};context.policyConflict=true;await helpers.previewPolicy(event);check(calls.length,0,'A remote policy conflict requires reload before preparing a new draft');
context.policyConflict=false;await helpers.previewPolicy(event);
check(calls.map(call=>call.action),['policyDraft'],'Preview issues no confirmation request');
check(calls[0].body.expectedVersion,0,'Preview is tied to the edited policy version');
check(get('agentPolicyPreviewPanel').hidden,false,'The owner receives a distinct review step');
check(context.policyState.version,0,'Preview does not change confirmed policy');
helpers.markPolicyDirty();check(context.policyDraft,null,'Any edit revokes the client preview reference');
check(get('agentPolicyPreviewPanel').hidden,true,'Editing hides the stale confirmation step');
await helpers.confirmPolicy();check(calls.length,1,'A revoked preview cannot be confirmed');
await helpers.previewPolicy(event);await helpers.confirmPolicy();
check(calls.map(call=>call.action),['policyDraft','policyDraft','policyConfirm'],'Only explicit confirmation writes the new policy');
check(calls.at(-1).body,{draftId:'local-draft'},'Confirmation references the server draft rather than resending unchecked fields');
check(context.renderedPolicy.version,1,'The confirmed server version is displayed');
check(context.policyDraft,null,'Successful confirmation consumes the client draft');
context.policyDraft={draftId:'expired',expiresAt:new Date(Date.now()-1).toISOString()};const before=calls.length;
await helpers.confirmPolicy();check(calls.length,before,'Expired previews cannot reach the confirmation API');
helpers.renderDiagnostics({components:{session:'verified',gateway:'verified',storage:'reachable',inferenceEnabled:false},
  model:{id:'@cf/qwen/qwen3-30b-a3b-fp8',accountConnectivity:'unverified'},budget:{chargedNeurons:4,dailyLimitNeurons:5000,unknownAttempts:1},
  delivery:{pending:true,remainingItems:2},secret:'DO_NOT_RENDER_PRIVATE_VALUE'});
const diagnostics=get('agentDiagnosticsResult').textContent;
check(diagnostics.includes('DO_NOT_RENDER_PRIVATE_VALUE'),false,'Diagnostics renders approved fields rather than dumping response objects');
check(diagnostics.includes('unverified'),true,'Configured models do not imply a verified account connection');
check(diagnostics.includes('4.00 / 5000 neurons'),true,'The application budget is visible without keys');
check(source.includes('localStorage'),false,'The agent module does not persist policy, reports or conversations in localStorage');
check(html.includes('agentPolicyPreviewPanel')&&html.includes('agentPolicyConfirm'),true,'Policy preview and confirmation have separate controls');
for(const select of html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g))check((select[1].match(/<option\b/g)||[]).length,(select[1].match(/<\/option>/g)||[]).length,'Named selects have complete opening and closing option elements');
context.researchSources=[];context.researchSourcesLoaded=false;context.researchLoading=false;context.researchBusy=false;
context.researchReport=null;context.pendingResearch=null;context.state={authenticated:true};context.policyState={version:1};
vm.runInContext(part('function researchDate','function initResearchControls')
  +'\nObject.assign(globalThis.helpers,{researchCitationUrl,renderResearchSources,loadResearchSources,renderResearchReport,runResearch,updateResearchValidity});',context);
calls.length=0;
helpers.renderResearchSources({sources:[{protocol:'morpho',label:'Morpho',available:true,sourceCount:2},
  {protocol:'katana',label:'Katana',available:false,sourceCount:1},{protocol:'https://unconfigured.invalid',available:true}]});
check(plain(context.researchSources).map(source=>source.protocol),['morpho','katana'],'Only configured protocol identifiers enter the source selector');
check(get('agentResearchProtocol').children.length,3,'The selector includes a prompt and configured sources only');
check(get('agentResearchProtocol').children[2].disabled,true,'An unavailable protocol is visibly disabled');
check(get('agentResearchSend').disabled,false,'Available configured sources enable focused research');
for(const value of ['javascript:alert(1)','data:text/html,x','http://docs.example/','https://owner:secret@docs.example/',
  'https://127.0.0.1/','https://127.1/','https://2130706433/','https://[::1]/','https://localhost./','https://service.local/',
  'https://service.localhost/','https://docs.example:8443/'])check(helpers.researchCitationUrl(value),null,'Unsafe or unsupported citation destinations are omitted');
check(helpers.researchCitationUrl('https://docs.example/protocol#risk'),'https://docs.example/protocol#risk','A source HTTPS citation retains its canonical path');
const now=Date.now(),report={schemaVersion:'agent-report-v1',reportId:'report:fixture:1',status:'ready',createdAt:new Date(now).toISOString(),
  policyVersion:1,snapshotId:'portfolio:fixture',objective:'Review risk',assessment:'Quoted configured-source excerpts.',sourceIds:['evidence:verified'],
  sourceCoverage:[{sourceId:'official-docs',status:'fresh'}],facts:[{evidenceId:'evidence:verified',title:'Official docs <script>ignored</script>',
    url:'https://docs.example/protocol',passage:'Source excerpt <img src=x onerror=alert(1)>',retrievedAt:new Date(now).toISOString(),publishedAt:null}],
  limitations:[],nextReviewAt:new Date(now+60000).toISOString()};
helpers.renderResearchReport({report});
check(get('agentResearchPanel').hidden,false,'A server report opens the research result panel');
check(get('agentResearchState').textContent,'Report ready','Supported report status is visible');
check(get('agentResearchMeta').textContent.includes('Policy 1'),true,'Reports retain the policy version used');
check(get('agentResearchFacts').textContent.includes('<img src=x onerror=alert(1)>'),true,'Source passages are rendered as inert quoted text');
check(get('agentResearchFacts').textContent.includes('Publication time not supplied'),true,'Retrieval time never becomes an invented publication time');
const citation=get('agentResearchFacts').children[0].children[0];
check(citation.href,'https://docs.example/protocol','A referenced fact links to its server-supplied safe canonical URL');
check(citation.rel,'noopener noreferrer','External citations do not receive an opener');
check(get('agentResearchMeta').textContent.includes(new Date(now).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric'})),true,'Research dates include their year');
helpers.renderResearchReport({report:{...report,sourceIds:[]}});
check(get('agentResearchFacts').textContent.includes('Source excerpt'),false,'A fact without a referenced evidence ID cannot render a citation or claim');
check(get('agentResearchState').textContent,'Partial research','Missing citation references cannot look like complete research');
helpers.renderResearchReport({report:{...report,facts:[{...report.facts[0],url:'javascript:alert(1)'}]}});
check(get('agentResearchFacts').textContent.includes('Source excerpt'),false,'An unsafe citation URL also omits its unsupported fact');
helpers.renderResearchReport({report:{...report,status:'blocked',facts:[],sourceIds:[],limitations:['The official source could not be retrieved.']}});
check(get('agentResearchState').textContent,'Research unavailable','Unavailable retrieval cannot masquerade as current research');
check(get('agentResearchLimits').textContent.includes('could not be retrieved'),true,'Missing source coverage remains visible');
helpers.renderResearchReport({report:{...report,nextReviewAt:new Date(now-1).toISOString()}});
check(get('agentResearchState').textContent,'Refresh due','An expired report retains its original date and asks for a refresh');
check(get('agentResearchValidity').textContent.includes('have not been renewed'),true,'Expiry does not relabel retained evidence as fresh');
context.policyState={version:2};helpers.renderResearchReport({report});
check(get('agentResearchState').textContent,'Superseded policy','An old-policy report cannot remain a current recommendation');
context.policyState={version:0};helpers.renderResearchReport({report});
check(get('agentResearchState').textContent,'Report ready','An editor behind the server cannot incorrectly declare a newer report superseded');
check(get('agentResearchValidity').textContent.includes('Reload the saved policy'),true,'A newer server policy prompts the editor to reload');
context.policyState={version:1};helpers.renderResearchReport({report});
get('agentResearchProtocol').value='morpho';get('agentResearchQuery').value='Explain configured risks.';
let fail=true;context.request=async(action,body)=>{calls.push({action,body:plain(body)});if(fail){fail=false;throw Error('Fixture unavailable');}return {report};};
await helpers.runResearch(event);const retryId=calls.at(-1).body.requestId;
check(get('agentResearchSourcesNote').textContent.includes('previous report'),true,'A failed refresh retains dated research visibly');
await helpers.runResearch(event);
check(calls.at(-1).body.requestId,retryId,'Retrying the same failed question reuses its logical request ID');
check(Object.keys(calls.at(-1).body).sort(),['protocol','query','requestId'],'Research sends a configured protocol and question, never a chosen URL');
await helpers.runResearch(event);
check(calls.at(-1).body.requestId===retryId,false,'A new successful review can request a newer dated report');
context.request=async(action,body)=>{calls.push({action,body:plain(body)});throw Error('Fixture unavailable');};
await helpers.runResearch(event);const priorId=calls.at(-1).body.requestId;get('agentResearchQuery').value='A different focused question.';
await helpers.runResearch(event);check(calls.at(-1).body.requestId===priorId,false,'A changed question receives a different idempotency reference');
let complete;context.request=async()=>new Promise(resolve=>{complete=resolve;});
const delayed=helpers.runResearch(event);context.privateViewVersion++;context.state={authenticated:false};
get('agentResearchPanel').hidden=true;get('agentResearchFacts').replaceChildren();context.researchReport=null;
complete({report});await delayed;
check(get('agentResearchPanel').hidden,true,'A response started before sign-out cannot reopen private research');
check(get('agentResearchFacts').children.length,0,'An old response cannot restore source passages after sign-out');
context.researchBusy=false;context.state={authenticated:true};context.privateViewVersion++;
const beforeSignedOut=calls.length;context.state={authenticated:false};await helpers.runResearch(event);
check(calls.length,beforeSignedOut,'Signed-out research cannot invoke the private API');
helpers.renderResearchSources({sources:[]});check(get('agentResearchSend').disabled,true,'An empty registry leaves research unavailable');
check(html.includes('type="url"'),false,'Research does not accept arbitrary destination URLs');
vm.runInContext(part('function comparisonInput','function initComparisonControls')+'\nglobalThis.readComparison=comparisonInput;',context);
get('agentCompareKind').value='lending';get('agentCompareDays').value='30';get('agentCompareCash').value='0';get('agentCompareGas').value='0';
get('agentCompareMarket').value='avkat-kat';get('agentCompareHealth').value='1.5';get('agentCompareRate').value='0';get('agentCompareOracle').value='-10, 0, 10';
let comparison=plain(context.readComparison());
check(comparison.annualRatePct,0,'An explicit zero projected rate is not an invented missing value');
check(comparison.cashUsd,0,'Owner cash assumptions preserve zero');
check(comparison.oracleMovesPct,[-10,0,10],'Oracle scenarios come from owner-entered percentages');
get('agentCompareKind').value='lp';get('agentComparePosition').value='493879';get('agentCompareChain').value='katana';
get('agentCompareMoves').value='-10,0';get('agentCompareRewardCases').value='0,1';
comparison=plain(context.readComparison());
check(comparison.paths.length,4,'Price and incentive cases are explicit conditional combinations');
check(comparison.paths[0].points,[{day:0,ratio:1},{day:30,ratio:.9}],'All price paths share the same starting point and owner horizon');
check(comparison.rewardEligible,null,'Unknown reward eligibility is never silently true or false');
check(comparison.widenFactor,null,'An unspecified range assumption stays unknown');
check(Object.hasOwn(comparison,'targetHealth'),false,'Unrelated lending inputs cannot leak into LP assumptions');
check(comparison.paths.some(path=>Object.hasOwn(path,'probability')),false,'The interface supplies no invented scenario probabilities');
console.log('Agent interface policy and privacy: '+checks+' assertions passed.');
