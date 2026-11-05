/* Dashboard and Telegram share the server-owned conversation and preferences.
   Session credentials stay in the HttpOnly cookie; no chat or key is stored here. */
const $=id=>document.getElementById(id);
let state=null,busy=false,loading=false,settingsDirty=false,lastMessages='',sources=[],pendingChat=null;
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
  if(!response.ok){const error=new Error(typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:'The agent could not finish this request. Please try again.');error.status=response.status;throw error;}
  return data;
}
function setBusy(value){
  busy=value;
  $('agentChatForm').setAttribute('aria-busy',String(value));
  const canChat=!!state?.authenticated&&state?.readiness?.ai===true;
  $('agentMessage').disabled=value||!canChat;$('agentSend').disabled=value||!canChat;
  document.querySelectorAll('[data-question]').forEach(button=>{button.disabled=value||!canChat;});
  $('agentState').textContent=value?'Checking readings…':canChat?'Ready':'Chat unavailable';
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
  $('agentTelegramState').textContent=linked?'Linked':'Not linked';$('agentTelegramState').dataset.state=linked?'ready':'';
  $('agentPair').hidden=linked;$('agentPair').disabled=!available;
  $('agentUnlink').hidden=!linked;
  $('agentTelegramNote').textContent=linked?'Your private Telegram chat shares this conversation and these preferences.':available?'Connect your private Telegram chat for questions and alerts while the dashboard is closed.':'The Telegram connection still needs to be set up. You can use dashboard chat once the agent is connected.';
  if(linked)$('agentPairing').hidden=true;
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
  $('agentLastCheck').textContent=stamp?'Last monitoring check '+stamp:state?.readiness?.monitor===false?'Background monitoring is not connected yet.':'Monitoring has not reported a check yet.';
}
function render(){
  const configured=state?.configured===true,authenticated=configured&&state?.authenticated===true;
  $('agentSetup').hidden=configured;$('agentLogin').hidden=!configured||authenticated;
  $('agentWorkspace').hidden=!authenticated;$('agentLogout').hidden=!authenticated;
  if(!authenticated){lastMessages='';sources=[];$('agentMessages').replaceChildren();$('agentSources').replaceChildren();$('agentPairing').hidden=true;}
  if(authenticated){
    renderMessages(state.messages);renderSettings();renderTelegram();renderAlerts();
    if(Array.isArray(state.sources))sources=state.sources;renderSources();
  }
  setBusy(busy);
}
async function loadStatus({quiet=false}={}){
  if(loading)return;loading=true;
  try{
    // POST keeps private history out of older service workers' GET API caches.
    state=await request('status',{});render();
    if(!quiet){
      if(!state.configured)notice('Setup is needed before your agent can answer questions.');
      else if(!state.authenticated)notice('Your agent conversation is private.');
      else if(state.readiness?.ai!==true)notice('AI chat still needs to be connected. Your saved preferences remain available.');
      else notice(typeof state.message==='string'?state.message:'');
    }
  }catch(error){
    if(!quiet)notice(error.message,true);
    // A failed status read keeps the current view, never pretends the connection is live.
    $('agentState').textContent='Connection unavailable';$('agentState').dataset.state='';
  }finally{loading=false;}
}
$('agentLoginForm').addEventListener('submit',async event=>{
  event.preventDefault();const key=$('agentAccessKey'),button=event.currentTarget.querySelector('button');button.disabled=true;notice('Signing in…');
  try{await request('login',{accessKey:key.value});key.value='';await loadStatus();$('agentMessage').focus();}
  catch(error){key.value='';notice(error.message,true);key.focus();}
  finally{button.disabled=false;}
});
$('agentLogout').addEventListener('click',async()=>{
  try{await request('logout',{});settingsDirty=false;state={configured:true,authenticated:false};sources=[];lastMessages='';pendingChat=null;render();await loadStatus();}
  catch(error){notice(error.message,true);}
});
$('agentChatForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const input=$('agentMessage'),message=input.value.trim();if(!message)return;
  if(!pendingChat||pendingChat.message!==message)pendingChat={message,requestId:crypto.randomUUID()};
  setBusy(true);notice('Reading your portfolio…');
  try{
    const answer=await request('chat',{message,requestId:pendingChat.requestId});
    if(Array.isArray(answer.messages))state.messages=answer.messages;
    else if(typeof answer.reply==='string')state.messages=[...(state.messages||[]),{role:'user',content:message,ts:Date.now(),source:'dashboard'},{role:'assistant',content:answer.reply,ts:Date.now(),source:'dashboard'}];
    if(answer.settings){state.settings=answer.settings;settingsDirty=false;}
    if(Array.isArray(answer.sources))sources=answer.sources;
    if(Array.isArray(answer.alerts))state.alerts=answer.alerts;
    input.value='';pendingChat=null;render();$('agentMessages').scrollTop=$('agentMessages').scrollHeight;
    notice('');await loadStatus({quiet:true});
  }catch(error){
    notice(error.message,true);
    if(error.status===401)await loadStatus();
  }finally{setBusy(false);if(!$('agentMessage').disabled)$('agentMessage').focus();}
});
$('agentMessage').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('agentChatForm').requestSubmit();}});
document.querySelectorAll('[data-question]').forEach(button=>button.addEventListener('click',()=>{$('agentMessage').value=button.dataset.question;$('agentChatForm').requestSubmit();}));
$('agentSettingsForm').addEventListener('input',()=>{settingsDirty=true;});
async function saveSettings(patch){
  const buttons=$('agentSettingsForm').querySelectorAll('button');buttons.forEach(button=>{button.disabled=true;});
  try{const answer=await request('settings',{settings:patch});if(answer.settings)state.settings=answer.settings;settingsDirty=false;await loadStatus({quiet:true});renderSettings();notice('Preferences saved for dashboard and Telegram.');}
  catch(error){notice(error.message,true);}
  finally{buttons.forEach(button=>{button.disabled=false;});}
}
$('agentSettingsForm').addEventListener('submit',event=>{
  event.preventDefault();if(!event.currentTarget.reportValidity())return;
  saveSettings({healthThreshold:Number($('agentHealthThreshold').value),ltvThreshold:Number($('agentLtvThreshold').value),alertsEnabled:$('agentAlertsEnabled').checked,dailyEnabled:$('agentDailyEnabled').checked,dailyTime:$('agentDailyTime').value});
});
$('agentPause').addEventListener('click',()=>saveSettings({pausedUntil:new Date(Date.now()+8*3600000).toISOString()}));
$('agentResume').addEventListener('click',()=>saveSettings({pausedUntil:null}));
$('agentPair').addEventListener('click',async()=>{
  const button=$('agentPair');button.disabled=true;
  try{
    const pair=await request('pair',{});
    if(typeof pair.code!=='string'||!pair.code)throw new Error('A Telegram linking code could not be created.');
    $('agentPairCode').textContent='/start '+pair.code;
    $('agentPairExpiry').textContent=date(pair.expiresAt)?'Expires '+date(pair.expiresAt):'Use this code within 10 minutes.';
    $('agentPairLink').hidden=true;
    if(typeof pair.url==='string'){
      try{const url=new URL(pair.url);if(url.protocol==='https:'&&['t.me','telegram.me'].includes(url.hostname)){$('agentPairLink').href=url.href;$('agentPairLink').hidden=false;}}catch{}
    }
    $('agentPairing').hidden=false;notice('Open your bot in Telegram and send the linking message.');
  }catch(error){notice(error.message,true);}
  finally{button.disabled=state?.readiness?.telegram!==true;}
});
$('agentUnlink').addEventListener('click',async()=>{
  const button=$('agentUnlink');button.disabled=true;
  try{await request('unlink',{});$('agentPairCode').textContent='';await loadStatus({quiet:true});notice('Telegram unlinked. Your dashboard conversation is still available.');}
  catch(error){notice(error.message,true);}
  finally{button.disabled=false;}
});
$('agentRefresh').addEventListener('click',()=>loadStatus());
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
