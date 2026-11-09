/* Reuse the monitor lease, honor its existing risk outbox, and persist every
   acknowledged Telegram part. No delivery can change policy or a wallet. */
import { automaticInputs, autoPaused, automationEnabled, autoFresh } from './_agent-auto-state.mjs';
import { getAgentOrigin } from './_agent-http.mjs';
import { sendTelegram } from './_agent-notifications.mjs';
import {currentProtocolWarnings} from './_agent-protocol-watch.mjs';

export async function deliverAutomaticNotices({store,env,fetcher=fetch,now=Date.now}={}) {
  const lease=await store.lock('monitor',90);if(!lease)return {status:'queued'};
  const clock=()=>typeof now==='function'?now():now;
  const ready=async()=>{
    const input=await automaticInputs(store,['automation:pending','automation:latest','telegram','monitor:pending']);
    const {controls,settings,policy,raw}=input,item=raw['automation:pending']?.[0],binding=raw.telegram;
    if(raw['monitor:pending'])return {...input,status:'risk_delivery_first'};
    if(!item)return {...input,status:'empty'};
    if(!env.TELEGRAM_BOT_TOKEN)return {...input,status:'configuration_missing'};
    const position=raw['automation:latest']?.positions?.find(position=>position.key===item.positionKey);
    const protocolWarning=currentProtocolWarnings(raw['automation:latest']?.protocolWatch,clock()).find(warning=>warning.id===item.warningId);
    const permitted=item.trigger==='manual'||(item.trigger==='daily'?settings.dailyEnabled:settings.alertsEnabled);
    const valid=automationEnabled(env)&&controls.enabled&&!autoPaused(settings,clock())&&permitted
      &&controls.revision===item.controlsRevision&&policy.version===item.policyVersion&&!!binding&&!!env.TELEGRAM_BOT_TOKEN
      &&String(binding.chatId)===String(item.chatId)&&String(binding.userId)===String(item.userId)
      &&Date.parse(item.expiresAt)>clock()&&Date.parse(item.validUntil)>clock()
      &&(item.trigger!=='alert'||position?.current&&position.conditions?.[item.condition]?.active&&autoFresh(position.market?.ts,clock()))
      &&(item.trigger!=='protocol'||env.AGENT_RESEARCH_ENABLED!=='false'&&env.AGENT_INVESTMENT_ENABLED!=='false'&&protocolWarning);
    return {...input,item,binding,status:valid?'ready':'cancelled'};
  };
  const commit=async(make)=>{
    const owner=await store.lock('owner',15);if(!owner)throw Error('Private update in progress');
    try{const current=await automaticInputs(store,['automation:pending','automation:latest','alerts']);
      const entries=make(current);if(entries.length)await lease.commit(entries,{alsoOwned:[owner]});
    }finally{await owner.release();}
  };
  try{
    const initial=await ready();
    if(['empty','risk_delivery_first','configuration_missing'].includes(initial.status))return {status:initial.status};
    if(initial.status==='cancelled'){
      await commit(({raw})=>{
        const entries=[{key:'automation:pending',value:(raw['automation:pending']||[]).filter(item=>item.id!==initial.item.id)}],latest=raw['automation:latest'];
        if(initial.item.trigger==='protocol'&&latest){const signals={...(latest.telegramSignalIds||{})};delete signals[initial.item.warningId];
          entries.push({key:'automation:latest',value:{...latest,telegramSignalIds:signals}});}
        return entries;
      });
      return {status:'cancelled'};
    }
    const {item,binding}=initial;
    try{
      await sendTelegram(binding.chatId,item.text,{env,fetcher,origin:getAgentOrigin(env),startPart:item.sentParts||0,
        beforePart:async()=>{
          await lease.assertOwned();const current=await ready();
          if(current.status!=='ready'||current.item.id!==item.id)throw Error('Fresh delivery authorization changed');
        },onPart:async sentParts=>commit(({raw})=>[{key:'automation:pending',value:(raw['automation:pending']||[]).map(notice=>notice.id===item.id?{...notice,sentParts}:notice)}])});
      await commit(({raw})=>{
        const latest=raw['automation:latest'],alerts=(raw.alerts||[]).map(alert=>alert.id===item.id?{...alert,telegramSent:true}:alert);
        return [{key:'automation:pending',value:(raw['automation:pending']||[]).filter(notice=>notice.id!==item.id)},
          {key:'alerts',value:alerts},...(latest?[{key:'automation:latest',value:{...latest,delivery:{status:'sent',id:item.id,at:new Date(clock()).toISOString()}}}]:[])];
      });return {status:'sent'};
    }catch{
      await commit(({raw})=>raw['automation:latest']?[{key:'automation:latest',value:{...raw['automation:latest'],delivery:{status:'queued',at:new Date(clock()).toISOString()}}}]:[]);
      return {status:'queued'};
    }
  }finally{await lease.release();}
}
