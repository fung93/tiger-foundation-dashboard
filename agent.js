/* Dashboard and Telegram share the server-owned conversation and preferences.
   Session credentials stay in the HttpOnly cookie; no chat or key is stored here. */
const $=id=>document.getElementById(id);
let state=null,busy=false,loading=false,settingsDirty=false,lastMessages='',sources=[],pendingChat=null;
let policyState=null,policyDraft=null,policyDirty=false,policyFormVersion=null,policyConflict=false,policyLoading=false,toolBusy=false,toolResult=null;
let privateViewVersion=0,statusRequestVersion=0;
let telegramSetup=null,telegramSetupBusy=false;
let researchSources=[],researchSourcesLoaded=false,researchLoading=false,researchBusy=false,researchReport=null,pendingResearch=null;
let pendingComparison=null,comparisonBusy=false,comparisonReport=null;
let journalSelection=null,journalCursor=null,journalEventCursor=null,journalBusy=false,journalPending=null;
const samePrivateView=version=>version===privateViewVersion&&state?.authenticated===true;
const embedded=document.documentElement.classList.contains('agent-embedded');
const epoch=value=>{
  if(typeof value==='number')return Number.isFinite(value)?(value<1e12?value*1000:value):NaN;
  return typeof value==='string'?Date.parse(value):NaN;
};
const date=value=>{const n=epoch(value);return Number.isFinite(n)?new Date(n).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false})+' MYT':'';};
function element(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;}
function notice(message='',error=false){$('agentNotice').textContent=message;$('agentNotice').dataset.error=String(error);}
async function request(action,body){
  const response=await fetch('/api/agent'+(body===undefined?'?action='+encodeURIComponent(action):''),{
    method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
    ...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify({action,...body})}),
    signal:AbortSignal.timeout(60000),
  });
  let data;
  try{data=await response.json();}catch{throw new Error('The agent returned an unreadable answer. Please try again.');}
  if(!response.ok){const error=new Error(typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:'The agent could not finish this request. Please try again.');error.status=response.status;error.category=typeof data.errorCategory==='string'?data.errorCategory:null;throw error;}
  return data;
}
function setBusy(value){
  busy=value;
  $('agentChatForm').setAttribute('aria-busy',String(value));
  const canChat=!!state?.authenticated;
  $('agentMessage').disabled=value||!canChat;$('agentSend').disabled=value||!canChat;
  document.querySelectorAll('[data-question]').forEach(button=>{button.disabled=value||!canChat;});
  $('agentState').textContent=value?'Checking readings…':canChat?(state?.readiness?.ai===true?'Ready':'Factual mode'):'Chat unavailable';
  $('agentState').dataset.state=!value&&canChat?'ready':'';
}
function renderMessages(messages){
  const valid=Array.isArray(messages)?messages.filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.content==='string'):[];
  const signature=JSON.stringify(valid);
  if(signature===lastMessages)return;
  const box=$('agentMessages'),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  const first=!lastMessages;lastMessages=signature;box.replaceChildren();
  if(!valid.length){
    const welcome=element('div','agent-empty');welcome.append(element('div','agent-empty-mark','✦'),element('h3','','What would you like to know?'),element('p','','Ask about your positions, earnings or lending health. Your conversation follows you between the dashboard and Telegram.'));box.append(welcome);
  }
  for(const message of valid){
    const item=element('article','agent-message');item.dataset.role=message.role;
    const meta=element('div','agent-message-meta');meta.append(element('span','agent-message-name',message.role==='user'?'You':'Agent'));
    const stamp=date(message.ts);if(stamp)meta.append(element('time','',stamp));
    if(message.source==='telegram')meta.append(element('span','','via Telegram'));
    item.append(meta,element('div','agent-message-text',message.content));box.append(item);
  }
  if(atBottom||first)box.scrollTop=box.scrollHeight;
}
function renderSources(){
  const box=$('agentSources');box.replaceChildren();
  for(const source of sources){
    if(!source||typeof source.name!=='string')continue;
    const status=typeof source.status==='string'?source.status:'unavailable',stamp=date(source.ts);
    const name=({lending:'Lending',lp:'LP Book',portfolio:'Portfolio',history:'Recorded history'})[source.name]||source.name;
    const chip=element('span','agent-source',name+' · '+status+(stamp?' · '+stamp:''));chip.dataset.state=status.toLowerCase();box.append(chip);
  }
  box.hidden=!box.children.length;
}
function renderSettings(){
  if(settingsDirty)return;
  const settings=state?.settings||{};
  $('agentHealthThreshold').value=Number.isFinite(settings.healthThreshold)?String(settings.healthThreshold):'1.2';
  $('agentLtvThreshold').value=Number.isFinite(settings.ltvThreshold)?String(settings.ltvThreshold):'70';
  $('agentAlertsEnabled').checked=settings.alertsEnabled!==false;
  $('agentDailyEnabled').checked=settings.dailyEnabled===true;
  $('agentDailyTime').value=/^\d{2}:\d{2}$/.test(settings.dailyTime||'')?settings.dailyTime:'09:00';
  const paused=epoch(settings.pausedUntil)>Date.now();
  $('agentPauseNote').textContent=paused?'Alerts paused until '+date(settings.pausedUntil)+'.':'Alerts use the latest successful scheduled check.';
  $('agentPause').hidden=paused;$('agentResume').hidden=!paused;
}
function renderTelegram(){
  const linked=state?.telegram?.connected===true,available=state?.readiness?.telegram===true;
  $('agentTelegramState').textContent=linked?'Linked':available?'Not linked':'Setup required';$('agentTelegramState').dataset.state=linked?'ready':'';
  $('agentPair').hidden=linked;$('agentPair').disabled=!available||telegramSetupBusy||$('agentPair').getAttribute('aria-busy')==='true';
  $('agentPair').title=available?'Create your private Telegram linking code.':'Add the Telegram secrets in your Cloudflare Worker, then deploy and refresh.';
  $('agentUnlink').hidden=!linked;$('agentUnlink').disabled=telegramSetupBusy||$('agentUnlink').getAttribute('aria-busy')==='true';
  $('agentTelegramNote').textContent=linked?'Your private Telegram chat shares this conversation and these preferences.':available?'First check Telegram setup and connect the webhook. Then choose Link Telegram to create a fresh private linking code.':'Setup required: add TELEGRAM_BOT_TOKEN and a TELEGRAM_WEBHOOK_SECRET of at least 24 characters in Cloudflare → your Worker → Settings → Variables and Secrets. Deploy, then refresh this page.';
  if(linked)$('agentPairing').hidden=true;
  renderTelegramSetup();
}
function telegramFeedback(message='',error=false){$('agentTelegramFeedback').textContent=message;$('agentTelegramFeedback').dataset.error=String(error);}
function clearTelegramSetup(){
  telegramSetup=null;telegramSetupBusy=false;
  for(const id of ['agentTelegramCheck','agentTelegramConnect']){$(id)?.setAttribute('aria-busy','false');if($(id))$(id).disabled=false;}
  for(const id of ['agentTelegramSetup','agentTelegramReplaceLabel','agentTelegramConnect'])if($(id))$(id).hidden=true;
  for(const id of ['agentTelegramPreview','agentTelegramFeedback'])$(id)?.replaceChildren();
  if($('agentTelegramReplace'))$('agentTelegramReplace').checked=false;
}
function renderTelegramSetup(){
  const available=state?.readiness?.telegram===true,pairBusy=['agentPair','agentUnlink'].some(id=>$(id).getAttribute('aria-busy')==='true');
  $('agentTelegramCheck').disabled=!available||telegramSetupBusy||pairBusy;
  $('agentTelegramSetup').hidden=!telegramSetup;
  const box=$('agentTelegramPreview');box.replaceChildren();
  if(!telegramSetup){$('agentTelegramConnect').hidden=true;$('agentTelegramReplaceLabel').hidden=true;return;}
  const setup=telegramSetup,registered=setup.registered===true;
  box.append(element('p','','Bot: @'+setup.botUsername));
  const descriptions={missing:'Telegram has no webhook for this bot. Connect it below to deliver messages here.',matches:'Telegram points to this agent. Reconnect below to refresh its verification secret.',different:'This bot currently delivers messages to another service. Connecting here will replace that destination.'};
  box.append(element('p','',registered?(state?.telegram?.connected?'Webhook registered. Send a new question to your linked bot to confirm delivery.':'Webhook registered. Send a fresh linking code to confirm message delivery.'):descriptions[setup.webhookStatus]||'Check the webhook before connecting.'));
  box.append(element('p','','Destination: '+setup.targetWebhookUrl));
  if(!registered&&setup.updatesStatus==='missing_messages')box.append(element('p','','The current webhook does not accept all required messages. Reconnect to update it.'));
  const errors={unauthorized:'Telegram’s last delivery was rejected by the webhook. Reconnect to refresh its verification secret.',not_found:'Telegram could not find the webhook. Check that the latest Worker deployment is ready.',server_error:'Telegram reported a Worker error on a previous delivery.',timeout:'Telegram reported a delivery timeout.',tls_or_dns:'Telegram reported a connection problem reaching the webhook.',reported:'Telegram reported a previous delivery error.'};
  if(!registered&&errors[setup.deliveryError])box.append(element('p','',errors[setup.deliveryError]));
  if(Number.isSafeInteger(setup.pendingUpdates)&&setup.pendingUpdates>0)box.append(element('p','',String(setup.pendingUpdates)+' message(s) waiting for delivery.'));
  box.append(element('p','',(registered?'Registered ':'Checked ')+date(registered?setup.registeredAt:setup.checkedAt)));
  $('agentTelegramReplaceLabel').hidden=registered||setup.requiresReplacement!==true;
  const button=$('agentTelegramConnect');button.hidden=registered;button.textContent=setup.requiresReplacement?'Replace and connect webhook':'Connect webhook';
  button.disabled=telegramSetupBusy||pairBusy||!available||(setup.requiresReplacement===true&&!$('agentTelegramReplace').checked);
}
async function runTelegramSetup(connecting){
  if(telegramSetupBusy||!state?.authenticated||['agentPair','agentUnlink'].some(id=>$(id).getAttribute('aria-busy')==='true'))return;
  if(connecting&&(!telegramSetup||telegramSetup.registered||telegramSetup.requiresReplacement&&!$('agentTelegramReplace').checked))return;
  const view=privateViewVersion,button=$(connecting?'agentTelegramConnect':'agentTelegramCheck');
  telegramSetupBusy=true;button.setAttribute('aria-busy','true');
  if(!connecting){telegramSetup=null;$('agentTelegramReplace').checked=false;}
  if(connecting){$('agentPairing').hidden=true;$('agentPairCode').textContent='';$('agentPairExpiry').textContent='';$('agentPairLink').removeAttribute('href');}
  renderTelegram();telegramFeedback(connecting?'Connecting Telegram to this agent…':'Checking the bot and webhook…');
  try{
    const answer=await request(connecting?'telegramConnect':'telegramCheck',connecting?{draftId:telegramSetup.draftId,...(telegramSetup.requiresReplacement?{replaceExisting:true}:{})}:{});
    if(!samePrivateView(view))return;
    const setup=answer.setup;
    if(!setup||typeof setup.draftId!=='string'||typeof setup.botUsername!=='string'||typeof setup.targetWebhookUrl!=='string')throw new Error('The Telegram setup check could not be read. Please check again.');
    telegramSetup=setup;$('agentTelegramReplace').checked=false;
    telegramFeedback(connecting?(state?.telegram?.connected?'Webhook registered. Send a new question to your bot in Telegram to test delivery.':'Webhook registered. Choose Link Telegram, open your bot and send the new linking message.'):'Check complete. Review the connection below before connecting.');
  }catch(error){
    if(!samePrivateView(view))return;
    // A failed connection can have reached Telegram. Require a new preview;
    // never encourage blind registration retries or reuse an older invitation.
    if(connecting)telegramSetup=null;
    telegramFeedback(error.message,true);
  }finally{if(view===privateViewVersion){telegramSetupBusy=false;button.setAttribute('aria-busy','false');renderTelegram();}}
}
function renderAlerts(){
  const box=$('agentAlerts');box.replaceChildren();
  const alerts=Array.isArray(state?.alerts)?state.alerts.slice(-8).reverse():[];
  if(!alerts.length)box.append(element('p','agent-help','No recent alerts.'));
  for(const alert of alerts){
    const text=alert?.message||alert?.text||alert?.title;if(typeof text!=='string')continue;
    const item=element('div','agent-alert');item.append(element('p','',text));
    const stamp=date(alert.ts||alert.createdAt);if(stamp)item.append(element('time','',stamp));box.append(item);
  }
  const checked=state?.last_check;
  const stamp=date(checked?.ts||checked?.checkedAt||checked);
  $('agentLastCheck').textContent=stamp?(checked?.status==='failed'||checked?.degraded||Date.now()-epoch(checked?.ts)>600000?'Monitoring degraded · last attempt ':'Last monitoring check ')+stamp+(checked?.nextIntendedCheck?' · next intended '+date(checked.nextIntendedCheck):''):state?.readiness?.monitor===false?'Background monitoring is not connected yet.':'Monitoring has not reported a check yet.';
}
function render(){
  const configured=state?.configured===true,authenticated=configured&&state?.authenticated===true;
  $('agentSetup').hidden=configured;$('agentLogin').hidden=!configured||authenticated;
  $('agentWorkspace').hidden=!authenticated;$('agentLogout').hidden=!authenticated;
  if(!authenticated){lastMessages='';sources=[];$('agentMessages').replaceChildren();$('agentSources').replaceChildren();$('agentPairing').hidden=true;}
  if(!authenticated)clearPrivateAnalysis();
  if(authenticated){
    if(state.policy)renderPolicy(state.policy);
    renderMessages(state.messages);renderSettings();renderTelegram();renderAlerts();
    if(Array.isArray(state.sources))sources=state.sources;renderSources();
  }
  setBusy(busy);
}
async function loadStatus({quiet=false}={}){
  if(loading)return;loading=true;const view=privateViewVersion,ticket=++statusRequestVersion;
  try{
    // POST keeps private history out of older service workers' GET API caches.
    const next=await request('status',{});if(view!==privateViewVersion)return;
    if(state?.authenticated===true&&next.authenticated!==true)privateViewVersion++;
    state=next;render();
    if(!quiet){
      if(!state.configured)notice('Setup is needed before your agent can answer questions.');
      else if(!state.authenticated)notice('Your agent conversation is private.');
      else if(state.readiness?.ai!==true)notice('AI explanations are unavailable. You can still request verified readings.');
      else notice(typeof state.message==='string'?state.message:'');
    }
    if(state.authenticated&&!policyState&&!policyLoading)await loadPolicy({quiet:true});
    if(state.authenticated&&!researchSourcesLoaded&&!researchLoading)await loadResearchSources({quiet:true});
  }catch(error){
    if(view!==privateViewVersion)return;
    if(!quiet)notice(error.message,true);
    // A failed status read keeps the current view, never pretends the connection is live.
    $('agentState').textContent='Connection unavailable';$('agentState').dataset.state='';
  }finally{if(ticket===statusRequestVersion)loading=false;}
}
$('agentLoginForm').addEventListener('submit',async event=>{
  event.preventDefault();const view=++privateViewVersion;statusRequestVersion++;loading=false;clearPrivateAnalysis();
  const key=$('agentAccessKey'),button=event.currentTarget.querySelector('button'),accessKey=key.value;key.value='';button.disabled=true;notice('Signing in…');
  try{await request('login',{accessKey});if(view!==privateViewVersion)return;await loadStatus();if(samePrivateView(view))$('agentMessage').focus();}
  catch(error){if(view!==privateViewVersion)return;notice(error.message,true);key.focus();}
  finally{if(view===privateViewVersion)button.disabled=false;}
});
$('agentLogout').addEventListener('click',async()=>{
  const view=++privateViewVersion;statusRequestVersion++;loading=false;clearPrivateAnalysis();pendingChat=null;setBusy(false);
  try{await request('logout',{});if(view!==privateViewVersion)return;settingsDirty=false;state={configured:true,authenticated:false};sources=[];lastMessages='';render();await loadStatus();}
  catch(error){if(view===privateViewVersion)notice(error.message,true);}
});
$('agentChatForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const input=$('agentMessage'),message=input.value.trim();if(!message)return;
  if(!pendingChat||pendingChat.message!==message)pendingChat={message,requestId:crypto.randomUUID()};
  const view=privateViewVersion;
  setBusy(true);notice('Reading your portfolio…');
  try{
    const answer=await request('chat',{message,requestId:pendingChat.requestId});
    if(!samePrivateView(view))return;
    if(Array.isArray(answer.messages))state.messages=answer.messages;
    else if(typeof answer.reply==='string')state.messages=[...(state.messages||[]),{role:'user',content:message,ts:Date.now(),source:'dashboard'},{role:'assistant',content:answer.reply,ts:Date.now(),source:'dashboard'}];
    if(answer.settings){state.settings=answer.settings;settingsDirty=false;}
    if(Array.isArray(answer.sources))sources=answer.sources;
    if(Array.isArray(answer.alerts))state.alerts=answer.alerts;
    input.value='';pendingChat=null;render();$('agentMessages').scrollTop=$('agentMessages').scrollHeight;
    notice('');await loadStatus({quiet:true});
  }catch(error){
    if(!samePrivateView(view))return;
    notice(error.message,true);
    if(error.status===401)await loadStatus();
  }finally{if(view===privateViewVersion){setBusy(false);if(!$('agentMessage').disabled)$('agentMessage').focus();}}
});
$('agentMessage').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('agentChatForm').requestSubmit();}});
document.querySelectorAll('[data-question]').forEach(button=>button.addEventListener('click',()=>{$('agentMessage').value=button.dataset.question;$('agentChatForm').requestSubmit();}));
$('agentSettingsForm').addEventListener('input',()=>{settingsDirty=true;});
async function saveSettings(patch){
  const view=privateViewVersion;
  const buttons=$('agentSettingsForm').querySelectorAll('button');buttons.forEach(button=>{button.disabled=true;});
  try{const answer=await request('settings',{settings:patch});if(!samePrivateView(view))return;if(answer.settings)state.settings=answer.settings;settingsDirty=false;await loadStatus({quiet:true});if(!samePrivateView(view))return;renderSettings();notice('Preferences saved for dashboard and Telegram.');}
  catch(error){if(samePrivateView(view))notice(error.message,true);}
  finally{if(view===privateViewVersion)buttons.forEach(button=>{button.disabled=false;});}
}
$('agentSettingsForm').addEventListener('submit',event=>{
  event.preventDefault();if(!event.currentTarget.reportValidity())return;
  saveSettings({healthThreshold:Number($('agentHealthThreshold').value),ltvThreshold:Number($('agentLtvThreshold').value),alertsEnabled:$('agentAlertsEnabled').checked,dailyEnabled:$('agentDailyEnabled').checked,dailyTime:$('agentDailyTime').value});
});
$('agentPause').addEventListener('click',()=>saveSettings({pausedUntil:new Date(Date.now()+8*3600000).toISOString()}));
$('agentResume').addEventListener('click',()=>saveSettings({pausedUntil:null}));
$('agentTelegramCheck').addEventListener('click',()=>runTelegramSetup(false));
$('agentTelegramConnect').addEventListener('click',()=>runTelegramSetup(true));
$('agentTelegramReplace').addEventListener('change',renderTelegramSetup);
$('agentPair').addEventListener('click',async()=>{
  const view=privateViewVersion,button=$('agentPair');if(telegramSetupBusy||button.getAttribute('aria-busy')==='true')return;
  button.disabled=true;button.setAttribute('aria-busy','true');
  renderTelegramSetup();
  try{
    const pair=await request('pair',{});
    if(!samePrivateView(view))return;
    if(typeof pair.code!=='string'||!pair.code)throw new Error('A Telegram linking code could not be created.');
    $('agentPairCode').textContent='/start '+pair.code;
    $('agentPairExpiry').textContent=date(pair.expiresAt)?'Expires '+date(pair.expiresAt):'Use this code within 10 minutes.';
    $('agentPairLink').hidden=true;
    if(typeof pair.url==='string'){
      try{const url=new URL(pair.url);if(url.protocol==='https:'&&['t.me','telegram.me'].includes(url.hostname)){$('agentPairLink').href=url.href;$('agentPairLink').hidden=false;}}catch{}
    }
    $('agentPairing').hidden=false;telegramFeedback('Open your bot in Telegram and send the linking message.');notice('Open your bot in Telegram and send the linking message.');
  }catch(error){if(samePrivateView(view)){telegramFeedback(error.message,true);notice(error.message,true);}}
  finally{if(view===privateViewVersion){button.setAttribute('aria-busy','false');renderTelegram();}}
});
$('agentUnlink').addEventListener('click',async()=>{
  const view=privateViewVersion,button=$('agentUnlink');if(telegramSetupBusy||button.getAttribute('aria-busy')==='true')return;
  button.disabled=true;button.setAttribute('aria-busy','true');renderTelegramSetup();
  try{await request('unlink',{});if(!samePrivateView(view))return;$('agentPairCode').textContent='';await loadStatus({quiet:true});if(samePrivateView(view))notice('Telegram unlinked. Your dashboard conversation is still available.');}
  catch(error){if(samePrivateView(view))notice(error.message,true);}
  finally{if(view===privateViewVersion){button.setAttribute('aria-busy','false');renderTelegram();}}
});
$('agentRefresh').addEventListener('click',()=>loadStatus());
initVerifiedControls();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)loadStatus({quiet:true});});
window.addEventListener('message',event=>{
  if(!embedded||event.origin!==location.origin||event.source!==parent)return;
  if(event.data?.type==='tiger-agent-focus'){
    const input=state?.authenticated?$('agentMessage'):$('agentAccessKey');if(!input.disabled)input.focus();
  }
});
document.addEventListener('keydown',event=>{if(embedded&&event.key==='Escape')parent.postMessage({type:'tiger-agent-close'},location.origin);});
loadStatus();
setInterval(()=>{if(!document.hidden&&!busy)loadStatus({quiet:true});},20000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});


const POLICY_MARKETS=[['avkat-kat','avKAT / KAT',77],['avkat-usdc','avKAT / vbUSDC',62.5],['kat-usdc','KAT / vbUSDC',62.5]];
const POLICY_ANALYSES=['portfolio','lending','lp','kat','research','strategy'];
const POLICY_FIELDS={horizonDays:'agentPolicyHorizon',minLiquidReserveUsd:'agentPolicyReserve',reviewFrequencyDays:'agentPolicyReview'};
const POLICY_LABELS={horizonDays:'Evaluation horizon',minLiquidReserveUsd:'Minimum liquid reserve',reviewFrequencyDays:'Review frequency',eligibleAssets:'Eligible assets',eligibleProtocols:'Eligible protocols',exposureLimits:'Exposure limits',marketLimits:'Market limits',lpReviewTriggers:'LP review triggers',allowedAnalysisTypes:'Allowed analysis'};
function policyNumber(input,label){
  const raw=input.value.trim();if(raw==='')return null;
  const value=Number(raw);if(!Number.isFinite(value))throw new Error('Enter a valid '+label+'.');return value;
}
function policyList(input){const values=input.value.split(',').map(value=>value.trim()).filter(Boolean);return values.length?[...new Set(values)]:null;}
function optionalObject(value){return Object.keys(value).length?value:null;}
function policyPatch(){
  const patch={};for(const [key,id] of Object.entries(POLICY_FIELDS))patch[key]=policyNumber($(id),POLICY_LABELS[key].toLowerCase());
  patch.eligibleAssets=policyList($('agentPolicyAssets'));patch.eligibleProtocols=policyList($('agentPolicyProtocols'));
  const exposure=Object.create(null),seen=new Set();
  for(const row of $('agentPolicyExposures').querySelectorAll('[data-policy-exposure]')){
    const asset=row.querySelector('[data-exposure-asset]').value.trim(),limit=policyNumber(row.querySelector('[data-exposure-limit]'),'exposure limit');
    if(!asset&&limit===null)continue;if(!asset||limit===null)throw new Error('Give each exposure limit an asset and percentage.');
    if(seen.has(asset.toLowerCase()))throw new Error('Use one exposure limit for each asset.');seen.add(asset.toLowerCase());exposure[asset]=limit;
  }
  patch.exposureLimits=optionalObject(exposure);const markets={};
  for(const row of $('agentPolicyMarkets').querySelectorAll('[data-policy-market]')){
    const values={};for(const key of ['targetHealth','maxLtvPct']){const value=policyNumber(row.querySelector('[data-market-field="'+key+'"]'),'market limit');if(value!==null)values[key]=value;}
    if(Object.keys(values).length)markets[row.dataset.policyMarket]=values;
  }
  patch.marketLimits=optionalObject(markets);const triggers={},range=$('agentPolicyOutOfRange').value;
  if(range==='true'||range==='false')triggers.outOfRange=range==='true';
  for(const [key,id] of [['priceMovePct','agentPolicyPriceMove'],['rewardChangePct','agentPolicyRewardChange'],['maxOutOfRangeHours','agentPolicyOutHours']]){
    const value=policyNumber($(id),'LP review trigger');if(value!==null)triggers[key]=value;
  }
  patch.lpReviewTriggers=optionalObject(triggers);
  const analyses=[...$('agentPolicyAnalysisTypes').querySelectorAll('input')].filter(input=>input.checked).map(input=>input.value);
  patch.allowedAnalysisTypes=analyses.length?analyses:null;return patch;
}
function addExposureRow(asset='',limit=''){
  const row=element('div','agent-exposure-row');row.dataset.policyExposure='';
  const token=element('input');token.type='text';token.maxLength=40;token.placeholder='Asset';token.value=asset;token.dataset.exposureAsset='';token.setAttribute('aria-label','Asset for exposure limit');
  const cap=element('input');cap.type='number';cap.min='0';cap.max='100';cap.step='any';cap.placeholder='Max %';cap.value=limit;cap.dataset.exposureLimit='';cap.setAttribute('aria-label','Maximum exposure percent');
  const remove=element('button','agent-text-button','Remove');remove.type='button';remove.setAttribute('aria-label','Remove exposure limit');remove.addEventListener('click',()=>{row.remove();if(!$('agentPolicyExposures').children.length)addExposureRow();markPolicyDirty();});
  row.append(token,cap,remove);$('agentPolicyExposures').append(row);
}
function markPolicyDirty(){
  policyDirty=true;policyDraft=null;if($('agentPolicyPreviewPanel'))$('agentPolicyPreviewPanel').hidden=true;
}
function policyDescription(value){
  if(value===null||value===undefined)return 'Unset';
  if(Array.isArray(value))return value.length?value.join(', '):'None';
  if(typeof value==='object')return Object.entries(value).map(([key,item])=>key+': '+policyDescription(item)).join('; ');
  return typeof value==='boolean'?(value?'Yes':'No'):String(value);
}
function renderPolicy(value,{force=false}={}){
  if(!$('agentPolicyForm')||!value||typeof value!=='object')return;
  const next=value.policy||value;if(!Number.isSafeInteger(next.version)||next.version<0)return;
  if(policyFormVersion!==null&&next.version!==policyFormVersion&&(policyDirty||policyDraft)&&!force){policyConflict=true;policyDraft=null;$('agentPolicyPreviewPanel').hidden=true;}
  if(force)policyConflict=false;
  policyState=next;
  $('agentPolicyState').textContent=policyConflict?'A newer policy is available. Reload it before preparing changes.':next.status==='confirmed'?'Confirmed policy · version '+next.version+(date(next.confirmedAt)?' · '+date(next.confirmedAt):''):'No confirmed strategy policy. Preferences remain unspecified.';
  if((policyDirty||policyDraft)&&!force)return;
  policyFormVersion=next.version;policyConflict=false;const constraints=next.constraints||{};
  for(const [key,id] of Object.entries(POLICY_FIELDS))$(id).value=Number.isFinite(constraints[key])?String(constraints[key]):'';
  $('agentPolicyAssets').value=Array.isArray(constraints.eligibleAssets)?constraints.eligibleAssets.join(', '):'';
  $('agentPolicyProtocols').value=Array.isArray(constraints.eligibleProtocols)?constraints.eligibleProtocols.join(', '):'';
  $('agentPolicyExposures').replaceChildren();const limits=constraints.exposureLimits;
  if(limits&&typeof limits==='object'&&!Array.isArray(limits))for(const [asset,limit] of Object.entries(limits))addExposureRow(asset,String(limit));
  if(!$('agentPolicyExposures').children.length)addExposureRow();
  for(const row of $('agentPolicyMarkets').querySelectorAll('[data-policy-market]'))for(const key of ['targetHealth','maxLtvPct']){
    const value=constraints.marketLimits?.[row.dataset.policyMarket]?.[key];row.querySelector('[data-market-field="'+key+'"]').value=Number.isFinite(value)?String(value):'';
  }
  const triggers=constraints.lpReviewTriggers||{};$('agentPolicyOutOfRange').value=typeof triggers.outOfRange==='boolean'?String(triggers.outOfRange):'';
  for(const [key,id] of [['priceMovePct','agentPolicyPriceMove'],['rewardChangePct','agentPolicyRewardChange'],['maxOutOfRangeHours','agentPolicyOutHours']])$(id).value=Number.isFinite(triggers[key])?String(triggers[key]):'';
  for(const input of $('agentPolicyAnalysisTypes').querySelectorAll('input'))input.checked=Array.isArray(constraints.allowedAnalysisTypes)&&constraints.allowedAnalysisTypes.includes(input.value);
  updateResearchValidity();
}
async function loadPolicy({quiet=false,force=false}={}){
  if(policyLoading||!state?.authenticated)return;const view=privateViewVersion;policyLoading=true;
  try{const value=await request('policy',{});if(!samePrivateView(view))return;if(force){policyDirty=false;policyDraft=null;$('agentPolicyPreviewPanel').hidden=true;}renderPolicy(value,{force});}
  catch(error){if(!samePrivateView(view))return;if(!quiet)notice(error.message,true);else if($('agentPolicyState'))$('agentPolicyState').textContent='Saved policy could not be read. No strategy preference has been assumed.';}
  finally{if(view===privateViewVersion)policyLoading=false;}
}
function policyButtons(disabled){for(const button of [$('agentPolicyPreview'),$('agentPolicyConfirm'),$('agentPolicyReload')])if(button)button.disabled=disabled;}
async function previewPolicy(event){
  event.preventDefault();if(!state?.authenticated||!event.currentTarget.reportValidity())return;
  const view=privateViewVersion;policyButtons(true);
  try{
    if(policyConflict)throw new Error('Reload the saved policy before preparing changes.');
    if(!policyState)throw new Error('Read the saved policy before preparing changes.');
    const answer=await request('policyDraft',{patch:policyPatch(),expectedVersion:policyFormVersion});const draft=answer.draft||answer;
    if(!samePrivateView(view))return;
    if(typeof draft.draftId!=='string'||!Array.isArray(draft.changes))throw new Error('The policy preview could not be read. Nothing has been confirmed.');
    policyDraft=draft;const changes=$('agentPolicyChanges');changes.replaceChildren();
    if(!draft.changes.length)changes.append(element('p','agent-help','No policy changes.'));
    for(const change of draft.changes){const row=element('div','agent-policy-change');row.append(element('strong','',POLICY_LABELS[change.field]||change.field),element('p','',policyDescription(change.before)+' → '+policyDescription(change.after)));changes.append(row);}
    $('agentPolicyDraftExpiry').textContent=date(draft.expiresAt)?'Preview expires '+date(draft.expiresAt)+'. Confirm to save a new policy version.':'Confirm to save a new policy version.';
    $('agentPolicyPreviewPanel').hidden=false;$('agentPolicyConfirm').hidden=!draft.changes.length;notice('Review the policy changes below. Your confirmed policy has not changed.');
  }catch(error){if(!samePrivateView(view))return;notice(error.message,true);if(error.status===409)policyConflict=true;}
  finally{if(view===privateViewVersion)policyButtons(false);}
}
async function confirmPolicy(){
  if(!policyDraft||!state?.authenticated)return;
  if(Number.isFinite(epoch(policyDraft.expiresAt))&&epoch(policyDraft.expiresAt)<=Date.now()){policyDraft=null;$('agentPolicyPreviewPanel').hidden=true;notice('The policy preview expired. Preview your changes again.',true);return;}
  const draft=policyDraft,view=privateViewVersion;policyButtons(true);
  try{const answer=await request('policyConfirm',{draftId:draft.draftId});if(!samePrivateView(view))return;policyDraft=null;policyDirty=false;policyConflict=false;$('agentPolicyPreviewPanel').hidden=true;renderPolicy(answer,{force:true});if(state)state.policy=answer.policy||answer;notice('Strategy policy confirmed. Alert preferences and Lending page settings are separate.');}
  catch(error){if(!samePrivateView(view))return;notice(error.message,true);if(error.status===409){policyDraft=null;policyConflict=true;$('agentPolicyPreviewPanel').hidden=true;}}
  finally{if(view===privateViewVersion)policyButtons(false);}
}
function renderToolResult(answer){
  const result=answer?.result||answer?.toolResult;if(!result||typeof result!=='object')throw new Error('The verified result could not be read.');
  toolResult=result;const panel=$('agentToolPanel'),meta=$('agentToolMeta');meta.replaceChildren();
  for(const text of [result.status||'unavailable',Number.isSafeInteger(result.policyVersion)?'Policy '+result.policyVersion:null,date(result.observedAt)?'Observed '+date(result.observedAt):'Observation time unavailable',result.calculationId?'Calculation '+result.calculationId:null,result.snapshotId?'Snapshot '+result.snapshotId:null])if(text)meta.append(element('span','agent-source',text));
  $('agentToolResult').textContent=typeof answer.reply==='string'?answer.reply:'A verified explanation is unavailable.';
  const limits=$('agentToolLimits');limits.replaceChildren();
  for(const [label,values] of [['Assumptions',result.assumptions],['Limitations',result.limitations]])if(Array.isArray(values)&&values.length){limits.append(element('h4','',label));const list=element('ul');for(const value of values)list.append(element('li','',typeof value==='string'?value:policyDescription(value)));limits.append(list);}
  if(result.roundingPolicy)limits.append(element('p','agent-help','Rounding: '+policyDescription(result.roundingPolicy)));
  panel.hidden=false;updateToolValidity();
}
function updateToolValidity(){
  if(!toolResult||!$('agentToolValidity'))return;const expires=epoch(toolResult.validUntil),expired=Number.isFinite(expires)&&expires<=Date.now();
  $('agentToolState').textContent=expired?'Stale result':toolResult.status==='ready'?'Ready':toolResult.status==='blocked'?'Unavailable':'Partial data';
  $('agentToolState').dataset.state=!expired&&toolResult.status==='ready'?'ready':'';
  $('agentToolValidity').textContent=expired?'This dated result has expired. Refresh the tool before using its amounts.':Number.isFinite(expires)?'Valid until '+date(toolResult.validUntil)+'. Refresh for a newer reading.':'No current validity window is available; review the limitations.';
}
async function runVerifiedTool(name,args={}){
  if(toolBusy||!state?.authenticated)return;const view=privateViewVersion;toolBusy=true;const buttons=document.querySelectorAll('.agent-tools button');buttons.forEach(button=>{button.disabled=true;});$('agentToolState').textContent='Collecting data…';notice('Reading verified data…');
  try{const answer=await request('tool',{tool:name,args});if(!samePrivateView(view))return;renderToolResult(answer);notice('');}
  catch(error){if(!samePrivateView(view))return;notice(error.message,true);$('agentToolState').textContent='Reading unavailable';$('agentToolState').dataset.state='';if(toolResult)$('agentToolValidity').textContent='Refresh failed. The previous result remains dated and has not been relabeled live.';if(error.status===401)await loadStatus();}
  finally{if(view===privateViewVersion){toolBusy=false;buttons.forEach(button=>{button.disabled=false;});}}
}
function renderDiagnostics(value){
  const box=$('agentDiagnosticsResult');box.replaceChildren();const rows=[];
  const components=value.components||{},model=value.model||{},budget=value.budget||{};
  const output=value.lastModelOutput;
  if(output)rows.push(['Model output check',output.stage+' · '+output.reason],['Model response format',output.envelope+' · '+output.contentType+'/'+output.jsonShape],['Model finish',output.finishReason||'Not reported'],['Model output tokens',Number.isSafeInteger(output.usage?.outputTokens)?String(output.usage.outputTokens):'Not reported']);
  if(model.profileVersion)rows.push(['Model profile',model.profileVersion]);
  if(model.plannedDeprecationDate)rows.push(['Planned model retirement',model.plannedDeprecationDate]);
  rows.push(['Session',components.session||'unverified'],['Gateway',components.gateway||'unverified'],['Private storage',components.storage||'unverified'],['AI binding',components.inference||'unverified'],['AI explanations',components.inferenceEnabled===false?'Disabled':'Enabled'],['Model',model.id||'Unavailable'],['Model connection',model.accountConnectivity||'unverified'],['Last successful inference',date(value.lastSuccessfulInference)||'No verified success'],['Last monitor success',date(value.lastMonitorSuccess)||'No verified success'],['Next intended check',date(value.nextIntendedMonitorCheck)||'Not reported'],['Last error',value.lastErrorCategory||'None reported']);
  if(budget.available===false)rows.push(['Usage ledger',budget.errorCategory||'Unavailable']);
  else rows.push(['AI usage · current UTC day',Number.isFinite(budget.chargedNeurons)&&Number.isFinite(budget.dailyLimitNeurons)?budget.chargedNeurons.toFixed(2)+' / '+budget.dailyLimitNeurons+' neurons':'Not reported'],['Uncertain attempts',Number.isSafeInteger(budget.unknownAttempts)?String(budget.unknownAttempts):'Not reported'],['Budget reset',date(budget.resetsAt)||'Not reported']);
  rows.push(['Monitoring',components.monitor||'unverified'],['Storage budget',value.storageUsage?.status||'unverified'],['Private payload',Number.isSafeInteger(value.storageUsage?.payloadBytes)?(value.storageUsage.payloadBytes/1048576).toFixed(2)+' MiB':'Not reported'],['Research execution',value.jobs?.backgroundRunner?'Background runner':'Bounded synchronous requests']);
  rows.push(['Telegram delivery',value.delivery?.pending?'Pending · '+String(value.delivery.remainingItems||0)+' item(s)':'No queued delivery reported']);
  for(const [label,text] of rows){const row=element('div','agent-diagnostic-row');row.append(element('span','',label),element('span','',text));box.append(row);}
}
function clearPrivateAnalysis(){
  $('agentPair')?.setAttribute('aria-busy','false');
  $('agentUnlink')?.setAttribute('aria-busy','false');
  clearTelegramSetup();
  journalSelection=null;journalCursor=null;journalEventCursor=null;journalBusy=false;journalPending=null;
  for(const id of ['agentJournalList','agentJournalMeta','agentJournalBaseline','agentJournalEvents','agentJournalReportText'])$(id)?.replaceChildren();
  for(const id of ['agentJournalDetail','agentJournalMore','agentJournalEventsMore'])if($(id))$(id).hidden=true;
  $('agentJournalForm')?.reset();
  if($('agentJournalSave'))$('agentJournalSave').disabled=false;
  pendingComparison=null;comparisonBusy=false;comparisonReport=null;
  for(const id of ['agentCompareMeta','agentCompareReply'])$(id)?.replaceChildren();
  if($('agentComparePanel'))$('agentComparePanel').hidden=true;
  $('agentCompareForm')?.reset();
  if($('agentCompareSend'))$('agentCompareSend').disabled=false;
  document.querySelectorAll('[data-compare-kind]').forEach(el=>el.hidden=el.dataset.compareKind!==$('agentCompareKind')?.value);
  policyState=null;policyDraft=null;policyDirty=false;policyConflict=false;policyFormVersion=null;toolResult=null;
  policyLoading=false;toolBusy=false;researchSources=[];researchSourcesLoaded=false;researchLoading=false;researchBusy=false;researchReport=null;pendingResearch=null;
  for(const id of ['agentToolMeta','agentToolValidity','agentToolResult','agentToolLimits','agentDiagnosticsResult','agentPolicyChanges'])$(id)?.replaceChildren();
  for(const id of ['agentResearchMeta','agentResearchValidity','agentResearchReply','agentResearchCoverage','agentResearchLimits','agentResearchFacts'])$(id)?.replaceChildren();
  if($('agentToolPanel'))$('agentToolPanel').hidden=true;if($('agentPolicyPreviewPanel'))$('agentPolicyPreviewPanel').hidden=true;
  if($('agentResearchPanel'))$('agentResearchPanel').hidden=true;
  if($('agentMessage'))$('agentMessage').value='';
  for(const id of ['agentTargetForm','agentPositionForm','agentSettingsForm'])$(id)?.reset();
  if($('agentToolState')){$('agentToolState').textContent='Read-only';$('agentToolState').dataset.state='';}
  if($('agentPolicyState'))$('agentPolicyState').textContent='No confirmed strategy policy.';
  if($('agentAlerts'))$('agentAlerts').replaceChildren(element('p','agent-help','No recent alerts.'));
  if($('agentLastCheck'))$('agentLastCheck').textContent='';
  if($('agentResearchForm'))$('agentResearchForm').reset();
  if($('agentResearchProtocol')){const option=element('option','','Sign in to read configured sources');option.value='';$('agentResearchProtocol').replaceChildren(option);$('agentResearchProtocol').disabled=true;$('agentResearchSend').disabled=true;$('agentResearchSourcesRefresh').disabled=false;}
  if($('agentResearchSourcesNote'))$('agentResearchSourcesNote').textContent='';
  if($('agentResearchState')){$('agentResearchState').textContent='Configured sources';$('agentResearchState').dataset.state='';}
  if($('agentPairCode'))$('agentPairCode').textContent='';
  if($('agentPairExpiry'))$('agentPairExpiry').textContent='';
  $('agentPairLink')?.removeAttribute('href');
  for(const button of document.querySelectorAll('.agent-tools button'))button.disabled=false;
  policyButtons(false);if($('agentDiagnosticsRefresh'))$('agentDiagnosticsRefresh').disabled=false;
  if($('agentPolicyForm')){$('agentPolicyForm').reset();$('agentPolicyExposures').replaceChildren();addExposureRow();}
}
function initVerifiedControls(){
  if(!$('agentPolicyForm'))return;
  // Constants are initialized before initial status resolves, but controls are
  // installed synchronously while the module is first evaluated.
  const markets=[['avkat-kat','avKAT / KAT',77],['avkat-usdc','avKAT / vbUSDC',62.5],['kat-usdc','KAT / vbUSDC',62.5]];
  for(const [key,label,max] of markets){const row=element('div','agent-policy-market');row.dataset.policyMarket=key;row.append(element('h5','',label));for(const [field,title,min,upper] of [['targetHealth','Target health',1,100],['maxLtvPct','Maximum LTV %',0.000001,max]]){const wrap=element('label','',title),input=element('input');input.type='number';input.min=String(min);input.max=String(upper);input.step='any';input.placeholder='Unset';input.dataset.marketField=field;wrap.append(input);row.append(wrap);}$('agentPolicyMarkets').append(row);}
  for(const name of ['portfolio','lending','lp','kat','research','strategy']){const wrap=element('label'),input=element('input');input.type='checkbox';input.value=name;wrap.append(input,document.createTextNode(name==='lp'?'LP':name.charAt(0).toUpperCase()+name.slice(1)));$('agentPolicyAnalysisTypes').append(wrap);}
  addExposureRow();$('agentPolicyForm').addEventListener('input',markPolicyDirty);$('agentPolicyForm').addEventListener('change',markPolicyDirty);$('agentPolicyForm').addEventListener('submit',previewPolicy);
  $('agentPolicyAddExposure').addEventListener('click',()=>{if($('agentPolicyExposures').children.length>=12){notice('Keep exposure limits to twelve assets.',true);return;}addExposureRow();markPolicyDirty();});
  $('agentPolicyReload').addEventListener('click',()=>loadPolicy({force:true}));$('agentPolicyConfirm').addEventListener('click',confirmPolicy);$('agentPolicyCancel').addEventListener('click',()=>{policyDraft=null;$('agentPolicyPreviewPanel').hidden=true;});
  document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>runVerifiedTool(button.dataset.tool)));
  $('agentTargetForm')?.addEventListener('submit',event=>{event.preventDefault();if(!event.currentTarget.reportValidity())return;runVerifiedTool('calculateTargetHealth',{market:$('agentTargetMarket').value,targetHealth:Number($('agentTargetHealth').value)});});
  $('agentPositionForm')?.addEventListener('submit',event=>{event.preventDefault();if(!event.currentTarget.reportValidity())return;const args={positionId:$('agentPositionId').value.trim()};if($('agentPositionChain').value)args.chain=$('agentPositionChain').value;if($('agentPositionOwner')?.value.trim())args.owner=$('agentPositionOwner').value.trim();runVerifiedTool('getLPPosition',args);});
  $('agentDiagnosticsRefresh')?.addEventListener('click',async()=>{const view=privateViewVersion,button=$('agentDiagnosticsRefresh');button.disabled=true;try{const value=await request('diagnostics',{});if(samePrivateView(view))renderDiagnostics(value);}catch(error){if(samePrivateView(view))notice(error.message,true);}finally{if(view===privateViewVersion)button.disabled=false;}});
  setInterval(()=>{if(!document.hidden){updateToolValidity();updateResearchValidity();}},15000);
  initResearchControls();
}

function researchDate(value){const n=epoch(value);return Number.isFinite(n)?new Date(n).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' MYT':'';}
function researchCitationUrl(value){
  if(typeof value!=='string'||value.length>2000)return null;
  try{
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.+$/,'');
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')
      ||!host.includes('.')||host.endsWith('.local')||host.endsWith('.localhost')
      ||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host))return null;
    return url.href;
  }catch{return null;}
}
function renderResearchSources(value){
  const rows=Array.isArray(value)?value:Array.isArray(value?.sources)?value.sources:[];
  researchSources=rows.slice(0,30).filter(source=>source&&typeof source.protocol==='string'
    &&/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(source.protocol)).map(source=>({protocol:source.protocol,
      label:typeof source.label==='string'?source.label.slice(0,100):source.protocol,
      available:source.available===true,sourceCount:Number.isSafeInteger(source.sourceCount)&&source.sourceCount>=0?source.sourceCount:null}));
  const select=$('agentResearchProtocol'),chosen=select.value;select.replaceChildren();
  const available=researchSources.filter(source=>source.available);
  const prompt=element('option','',available.length?'Choose a protocol':'No configured sources available');prompt.value='';select.append(prompt);
  for(const source of researchSources){
    const option=element('option','',source.label+(source.available?'':' · unavailable'));option.value=source.protocol;option.disabled=!source.available;select.append(option);
  }
  select.value=available.some(source=>source.protocol===chosen)?chosen:'';
  select.disabled=!available.length||researchBusy;$('agentResearchSend').disabled=!available.length||researchBusy;
  $('agentResearchSourcesNote').textContent=available.length?available.length+' configured protocol'+(available.length===1?'':'s')+'. Availability is checked again for each request.':'No verified configured sources are available. Research remains unavailable until sources are configured.';
  researchSourcesLoaded=true;
}
async function loadResearchSources({quiet=false}={}){
  if(researchLoading||!state?.authenticated||!$('agentResearchProtocol'))return;
  const view=privateViewVersion;researchLoading=true;$('agentResearchSourcesRefresh').disabled=true;
  try{const value=await request('researchSources',{});if(!samePrivateView(view))return;renderResearchSources(value);}
  catch(error){if(!samePrivateView(view))return;$('agentResearchSourcesNote').textContent='The configured source list could not be read. No wider web search is available.';if(!quiet)notice(error.message,true);}
  finally{if(samePrivateView(view)){researchLoading=false;$('agentResearchSourcesRefresh').disabled=false;}}
}
function researchStatusLabel(report){
  const status=report.status;
  if(status==='superseded')return 'Superseded policy';
  if(status==='blocked')return 'Research unavailable';
  if(status==='ready')return 'Report ready';
  return 'Partial research';
}
function renderResearchReport(answer){
  const report=answer?.report;
  if(!report||typeof report!=='object'||!['ready','partial','blocked','superseded'].includes(report.status)
    ||typeof report.reportId!=='string'||report.reportId.length>300)throw new Error('The research report could not be read. The previous report remains dated.');
  researchReport=report;
  const meta=$('agentResearchMeta');meta.replaceChildren();
  for(const text of [researchStatusLabel(report),'Configured sources',researchDate(report.createdAt)?'Created '+researchDate(report.createdAt):'Creation time unavailable',
    Number.isSafeInteger(report.policyVersion)?'Policy '+report.policyVersion:null,'Report '+report.reportId,report.snapshotId?'Snapshot '+String(report.snapshotId):null])
    if(text)meta.append(element('span','agent-source',text));
  $('agentResearchState').textContent=researchStatusLabel(report);$('agentResearchState').dataset.state=report.status==='ready'?'ready':'';
  const assessment=typeof report.assessment==='string'?report.assessment:typeof answer.reply==='string'?answer.reply:'Review the retrieved excerpts, source dates and coverage below.';
  $('agentResearchReply').textContent=(report.objective?'Focus: '+String(report.objective).slice(0,1000)+'\n\n':'')+assessment.slice(0,5000);
  const coverage=$('agentResearchCoverage');coverage.replaceChildren();
  const sources=Array.isArray(report.sourceCoverage)?report.sourceCoverage:Array.isArray(report.sourceCoverage?.sources)?report.sourceCoverage.sources:[];
  if(!sources.length)coverage.append(element('p','agent-help','Coverage is limited to the configured sources in this report.'));
  for(const source of sources.slice(0,12)){
    if(!source||typeof source!=='object')continue;
    const label=typeof source.title==='string'?source.title:typeof source.sourceId==='string'?source.sourceId:typeof source.id==='string'?source.id:'Configured source';
    const status=typeof source.status==='string'?source.status:'unavailable';
    const row=element('p','agent-help',label+' · '+status+(researchDate(source.retrievedAt)?' · retrieved '+researchDate(source.retrievedAt):''));row.dataset.state=status;coverage.append(row);
  }
  const limits=$('agentResearchLimits');limits.replaceChildren();
  for(const [label,values] of [['Limitations',report.limitations],['Conflicting sources',report.conflicts]])if(Array.isArray(values)&&values.length){
    limits.append(element('h4','',label));const list=element('ul');for(const value of values.slice(0,20))list.append(element('li','',typeof value==='string'?value:policyDescription(value)));limits.append(list);
  }
  if(researchDate(report.nextReviewAt))limits.append(element('p','agent-help','Review by '+researchDate(report.nextReviewAt)+'.'));
  const facts=$('agentResearchFacts');facts.replaceChildren();
  const ids=new Set(Array.isArray(report.sourceIds)?report.sourceIds.filter(id=>typeof id==='string'):[]);let omitted=0;
  for(const fact of (Array.isArray(report.facts)?report.facts:[]).slice(0,4)){
    const url=researchCitationUrl(fact?.url),id=fact?.evidenceId;
    if(typeof id!=='string'||!ids.has(id)||!url||typeof fact.passage!=='string'){omitted++;continue;}
    const item=element('article','agent-research-fact'),link=element('a','agent-research-link',typeof fact.title==='string'?fact.title.slice(0,240):'Open configured source');
    link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';
    item.append(link,element('blockquote','',fact.passage.slice(0,4000)));
    const dates=[];if(researchDate(fact.retrievedAt))dates.push('Retrieved '+researchDate(fact.retrievedAt));
    dates.push(researchDate(fact.publishedAt)?'Published '+researchDate(fact.publishedAt):'Publication time not supplied');
    item.append(element('p','agent-help',dates.join(' · ')),element('p','agent-research-reference','Evidence '+id));facts.append(item);
  }
  const empty=!facts.children.length;
  if(empty)facts.append(element('p','agent-help','No supported source excerpts are available for this report.'));
  if(omitted)limits.append(element('p','agent-help','Unsupported citation details were omitted. No claim is supported by those omitted references.'));
  if((omitted||empty)&&report.status!=='blocked'&&report.status!=='superseded'){
    $('agentResearchState').textContent='Partial research';$('agentResearchState').dataset.state='';if(meta.firstElementChild)meta.firstElementChild.textContent='Partial research';}
  $('agentResearchPanel').hidden=false;updateResearchValidity();
}
function updateResearchValidity(){
  if(!researchReport||!$('agentResearchValidity'))return;
  const expired=Number.isFinite(epoch(researchReport.nextReviewAt||researchReport.validUntil))&&epoch(researchReport.nextReviewAt||researchReport.validUntil)<=Date.now();
  const hasVersions=Number.isSafeInteger(policyState?.version)&&Number.isSafeInteger(researchReport.policyVersion);
  const superseded=researchReport.status==='superseded'||hasVersions&&policyState.version>researchReport.policyVersion;
  const editorBehind=hasVersions&&policyState.version<researchReport.policyVersion;
  $('agentResearchValidity').textContent=superseded?'This report used an earlier strategy policy. Request a new review.':researchReport.status==='blocked'?'Research is unavailable. Review the missing source coverage and limitations.':expired?'This dated report is due for refresh. Its source dates have not been renewed.':editorBehind?'This report used a newer policy than the editor. Reload the saved policy before preparing changes.':'This is a dated report from configured sources. Review coverage and source dates before relying on it.';
  if(superseded||expired&&researchReport.status!=='blocked'){const label=superseded?'Superseded policy':'Refresh due';$('agentResearchState').textContent=label;$('agentResearchState').dataset.state='';const first=$('agentResearchMeta').firstElementChild;if(first)first.textContent=label;}
}
async function runResearch(event){
  event.preventDefault();if(researchBusy||!state?.authenticated||!event.currentTarget.reportValidity())return;
  const protocol=$('agentResearchProtocol').value,query=$('agentResearchQuery').value.trim();
  if(!query||!researchSources.some(source=>source.protocol===protocol&&source.available))return;
  const signature=protocol+'\n'+query;
  if(!pendingResearch||pendingResearch.signature!==signature)pendingResearch={signature,protocol,query,requestId:crypto.randomUUID()};
  const pending=pendingResearch,view=privateViewVersion;researchBusy=true;$('agentResearchSend').disabled=true;$('agentResearchProtocol').disabled=true;
  $('agentResearchState').textContent='Collecting sources…';$('agentResearchState').dataset.state='';notice('Reading configured sources…');
  try{const answer=await request('research',{protocol,query,requestId:pending.requestId});if(!samePrivateView(view))return;renderResearchReport(answer);pendingResearch=null;notice('');}
  catch(error){if(!samePrivateView(view))return;notice(error.message,true);$('agentResearchState').textContent='Research unavailable';$('agentResearchState').dataset.state='';
    $('agentResearchSourcesNote').textContent=researchReport?'Refresh failed. The previous report keeps its original date and has not been relabeled current.':'Research could not finish. Try again to reuse this request reference.';if(error.status===401)await loadStatus();}
  finally{if(samePrivateView(view)){researchBusy=false;const enabled=researchSources.some(source=>source.available);$('agentResearchSend').disabled=!enabled;$('agentResearchProtocol').disabled=!enabled;}}
}
function initResearchControls(){
  if(!$('agentResearchForm'))return;
  $('agentResearchForm').addEventListener('submit',runResearch);
  $('agentResearchSourcesRefresh').addEventListener('click',()=>loadResearchSources());
}

function comparisonInput(){
  const n=id=>$(id).value.trim()===''?null:Number($(id).value),kind=$('agentCompareKind').value;
  const list=id=>$(id).value.trim()===''?[]:$(id).value.split(',').map(x=>Number(x.trim()));
  const lines=id=>$(id).value.split('\n').map(x=>x.trim()).filter(Boolean);
  const input={kind,horizonDays:n('agentCompareDays'),cashUsd:n('agentCompareCash'),gasUsd:n('agentCompareGas')};
  if(kind==='lending')Object.assign(input,{market:$('agentCompareMarket').value,targetHealth:n('agentCompareHealth'),
    annualRatePct:n('agentCompareRate'),oracleMovesPct:list('agentCompareOracle')});
  if(kind==='lp'){
    const factors=list('agentCompareRewardCases');if(!factors.length)factors.push(1);
    const paths=list('agentCompareMoves').flatMap(move=>factors.map(factor=>({label:move+'% price · incentives ×'+factor,
      points:[{day:0,ratio:1},{day:input.horizonDays,ratio:1+move/100}],rewardFactor:factor})));
    Object.assign(input,{positionId:$('agentComparePosition').value.trim(),chain:$('agentCompareChain').value,
      widenFactor:n('agentCompareWiden'),lowerPrice:n('agentCompareLower'),upperPrice:n('agentCompareUpper'),paths,
      rewardEligible:$('agentCompareEligible').value===''?null:$('agentCompareEligible').value==='true',
      rewardPriceUsd:n('agentCompareRewardPrice'),competingLiquidityMultiplier:n('agentCompareCompetition'),
      borrowingCostUsd:n('agentCompareBorrowCost'),useObservedRates:$('agentCompareObserved').checked});
  }
  if(kind==='kat')Object.assign(input,{katPriceUsd:n('agentCompareKatPrice'),katAmount:n('agentCompareKatAmount')});
  Object.assign(input,{swapFeeBps:n('agentCompareSwap'),slippageBps:n('agentCompareSlippage'),
    thesis:$('agentCompareThesis').value.trim(),catalysts:lines('agentCompareCatalysts'),invalidationConditions:lines('agentCompareInvalidation'),
    evidenceIds:$('agentCompareEvidence').value.split(',').map(x=>x.trim()).filter(Boolean)});
  if($('agentCompareReview').value)input.reviewAt=$('agentCompareReview').value+'T01:00:00Z';
  return input;
}
function initComparisonControls(){
  if(!$('agentCompareForm'))return;
  const update=()=>document.querySelectorAll('[data-compare-kind]').forEach(el=>el.hidden=el.dataset.compareKind!==$('agentCompareKind').value);
  $('agentCompareKind').addEventListener('change',update);update();
  $('agentCompareForm').addEventListener('submit',async event=>{
    event.preventDefault();if(comparisonBusy||!state?.authenticated)return;
    const input=comparisonInput(),signature=JSON.stringify(input),view=privateViewVersion;
    if(!pendingComparison||pendingComparison.signature!==signature)pendingComparison={signature,requestId:crypto.randomUUID()};
    comparisonBusy=true;$('agentCompareSend').disabled=true;notice('Calculating conditional scenarios…');
    try{
      const answer=await request('compare',{input,requestId:pendingComparison.requestId});if(!samePrivateView(view))return;
      if(!answer.report||typeof answer.reply!=='string')throw new Error('The comparison could not be verified.');
      comparisonReport=answer.report;updateComparisonValidity();
      $('agentCompareReply').textContent=answer.reply;$('agentComparePanel').hidden=false;pendingComparison=null;notice('');
    }catch(error){if(samePrivateView(view))notice(error.message,true);}
    finally{if(samePrivateView(view)){comparisonBusy=false;$('agentCompareSend').disabled=false;}}
  });
}
function updateComparisonValidity(){
  if(!comparisonReport||!state?.authenticated)return;
  const report=comparisonReport,newPolicy=Number.isSafeInteger(policyState?.version)&&policyState.version!==report.policyVersion,
    expired=Number.isFinite(epoch(report.nextReviewAt))&&epoch(report.nextReviewAt)<=Date.now();
  const status=newPolicy?'Superseded by newer policy':expired?'Dated scenario · fresh review required':report.status;
  $('agentCompareMeta').textContent=status+' · created '+researchDate(report.createdAt)+' · policy '+report.policyVersion+' · '+report.reportId;
}
initComparisonControls();
setInterval(updateComparisonValidity,5000);

async function loadJournal(older=false){
  if(journalBusy||!state?.authenticated)return;const view=privateViewVersion;journalBusy=true;
  try{const page=await request('decisions',{cursor:older?journalCursor:null});if(!samePrivateView(view))return;
    const box=$('agentJournalList');if(!older)box.replaceChildren();
    if(!page.items?.length&&!older)box.append(element('p','agent-help','No saved briefs yet. Research or compare a strategy to begin a prospective record.'));
    for(const item of page.items||[]){const row=element('article','agent-alert');row.append(element('p','',item.thesis||'Saved brief'),element('p','agent-help',item.state+' · '+item.reviewStatus+' · '+date(item.createdAt)+' · policy '+item.policyVersion));
      const button=element('button','agent-button agent-quiet','Review entry');button.type='button';button.addEventListener('click',()=>openJournal(item.decisionId));row.append(button);box.append(row);}
    journalCursor=page.cursor||null;$('agentJournalMore').hidden=!journalCursor;
  }catch(error){if(samePrivateView(view))notice(error.message,true);}finally{if(samePrivateView(view))journalBusy=false;}
}
async function openJournal(id,more=false){
  const view=privateViewVersion;
  try{const value=await request('decision',{decisionId:id,cursor:more?journalEventCursor:null});if(!samePrivateView(view))return;
    journalSelection=value.decision;journalEventCursor=value.cursor||null;
    $('agentJournalMeta').textContent=value.decision.state+' · version '+value.decision.version+' · original '+date(value.decision.createdAt)+' · policy '+value.decision.policyVersion;
    $('agentJournalBaseline').textContent=value.decision.thesis+'\n'+value.decision.assessment+'\nInvalidation: '+(value.decision.invalidationConditions||[]).join('; ')+'\nReview: '+(date(value.decision.reviewAt)||'Unspecified');
    if(!more){$('agentJournalEvents').replaceChildren();$('agentJournalReportText').replaceChildren();$('agentJournalForm').reset();journalPending=null;
      const choice=$('agentJournalChoice'),unset=element('option','','No option chosen');unset.value='';choice.replaceChildren(unset);
      for(const option of value.decision.options||[]){const node=element('option','',option.label+' · '+option.status);node.value=option.id;choice.append(node);}}
    for(const event of value.events||[]){const row=element('article','agent-alert');row.append(element('p','agent-help',date(event.ts)+' · '+event.type+' · '+event.provenance),element('p','',event.rationale||event.measurement||'Original proposal recorded.'),element('p','',event.outcome||''));
      if(event.transaction)row.append(element('p','', 'Owner-reported transaction · unverified: '+event.transaction.description));
      for(const mark of event.marks||[])if(Number.isFinite(mark.paperMarkBeforeEarningsUsd))row.append(element('p','',mark.optionId+' · paper mark before earnings $'+mark.paperMarkBeforeEarningsUsd.toFixed(2)+' · versus hold $'+mark.differenceBeforeEarningsUsd.toFixed(2)));
      if(event.earningsLimit)row.append(element('p','agent-help',event.earningsLimit));
      if(event.limitations)row.append(element('p','agent-help',event.limitations.join(' ')));$('agentJournalEvents').append(row);}
    $('agentJournalEventsMore').hidden=!journalEventCursor;$('agentJournalDetail').hidden=false;
  }catch(error){if(samePrivateView(view))notice(error.message,true);}
}
function initJournal(){
  if(!$('agentJournalForm'))return;
  $('agentJournalRefresh').addEventListener('click',()=>loadJournal());$('agentJournalMore').addEventListener('click',()=>loadJournal(true));
  $('agentJournalEventsMore').addEventListener('click',()=>journalSelection&&openJournal(journalSelection.decisionId,true));
  $('agentJournalReport').addEventListener('click',async()=>{if(!journalSelection)return;const view=privateViewVersion,id=journalSelection.reportId;
    try{const value=await request('getReport',{reportId:id});if(samePrivateView(view)&&journalSelection?.reportId===id)$('agentJournalReportText').textContent=value.reply;}catch(error){if(samePrivateView(view))notice(error.message,true);}});
  $('agentJournalObserve').addEventListener('click',async()=>{if(!journalSelection||journalBusy)return;const view=privateViewVersion,id=journalSelection.decisionId;journalBusy=true;
    try{await request('decisionObserve',{decisionId:id});if(samePrivateView(view))await openJournal(id);}catch(error){if(samePrivateView(view))notice(error.message,true);}finally{if(samePrivateView(view))journalBusy=false;}});
  $('agentJournalForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!journalSelection||journalBusy||!state?.authenticated)return;
    const view=privateViewVersion,input={decisionId:journalSelection.decisionId,expectedVersion:journalSelection.version,state:$('agentJournalState').value,
      choice:$('agentJournalChoice').value,rationale:$('agentJournalRationale').value,outcome:$('agentJournalOutcome').value,transaction:$('agentJournalTransaction').value};
    const signature=JSON.stringify(input);if(!journalPending||journalPending.signature!==signature)journalPending={signature,requestId:crypto.randomUUID()};
    journalBusy=true;$('agentJournalSave').disabled=true;
    try{await request('decisionRecord',{input:{...input,requestId:journalPending.requestId}});if(!samePrivateView(view))return;journalPending=null;await openJournal(input.decisionId);notice('Your decision is recorded. Acceptance is for review only.');}
    catch(error){if(samePrivateView(view))notice(error.message,true);}finally{if(samePrivateView(view)){journalBusy=false;$('agentJournalSave').disabled=false;}}
  });
}
initJournal();
