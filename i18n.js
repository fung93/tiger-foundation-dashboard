/* Shared, local-only UI language. Never changes API payloads, amounts or form values. */
(function () {
  'use strict';
  if (window.TFI18n) return;
  var KEY='tf_language_v1',root=document.documentElement,language='en';
  var records=new WeakMap(),attributes=new WeakMap(),pending=new Set(),scheduled=false,observer=null;
  var dictionary=Object.create(null),catalog=window.TF_ZH||{},phrases=[];
  Object.keys(catalog).forEach(function (key) { dictionary[key.toLowerCase()]=catalog[key]; });
  // These are identifiers, not prose. Keep even standalone ticker/currency labels original.
  delete dictionary.usd;
  Object.keys(dictionary).sort(function(a,b){return b.length-a.length;}).forEach(function(key){
    phrases.push(key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  });
  var phrasePattern=new RegExp('(?<![A-Za-z0-9_])(?:'+phrases.join('|')+')(?![A-Za-z0-9_])','gi');
  var skip='script,style,noscript,textarea,pre,code,blockquote,[contenteditable],'+
    '[translate="no"],[data-i18n-skip],.agent-message-text,.agent-result-text,.agent-research-link,'+
    '.agent-owner-text,#agentJournalBaseline,#agentJournalReportText,#agentResearchReply,'+
    '#agentJournalRationale,#agentJournalOutcome,#agentJournalTransaction';
  function selected(value){return value==='zh-CN'?'zh-CN':'en';}
  function saved(){try{return selected(localStorage.getItem(KEY));}catch(e){return language;}}
  var months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function month(value){return months[value.slice(0,3).toLowerCase()];}
  var quantityPattern=[/(\d[\d,.]*) (positions?|markets?|samples|locks|blocks|hours?|minutes?|seconds?|days?)\b/gi,function(_,n,unit){var units={position:'个仓位',market:'个市场',sample:'条样本',lock:'个锁仓',block:'个区块',hour:'小时',minute:'分钟',second:'秒',day:'天'};return n+' '+units[unit.toLowerCase().replace(/s$/,'')];}];
  var patterns=[
    [/incl\. (\$[\d,.]+) added/gi,'含 $1 追加资金'],
    [/for (\$[\d,.]+) at (\$[\d,.]+)/gi,'以 $2 的价格投入 $1'],
    [/(\d+) sales/gi,'$1 笔卖出'],
    [/^Start with ([A-Za-z0-9]+)\. Buy UNI if its price falls\.$/i,function(_,token){return '投入 '+token+'，价格下跌进入区间后逐步买入 UNI。';}],
    [/\b(\d+) open · (\d+) chains/gi,'$1 个当前仓位 · $2 个网络'],
    [/\b(\d+) closed · over ([\d.]+) days/gi,'$1 个已关闭仓位 · 共 $2 天'],
    [/\b(\d+) closed · (\d+) rebalances/gi,'$1 个已关闭仓位 · $2 次调仓'],
    [/shortest ([\d.]+) · longest ([\d.]+) days/gi,'最短 $1 天 · 最长 $2 天'],
    [/\bAll ([\d,.]+) ([A-Za-z0-9]+)\./g,'最终持有 $1 $2。'],
    [/\bIncludes all (\d+) recorded deposits\./gi,'包含全部 $1 笔已记录投入。'],
    [/\ball (\d+) recorded deposits/gi,'全部 $1 笔已记录投入'],
    [/\b(\d+) token pairs · funded fee tiers/gi,'$1 个交易对 · 已注资的手续费档位'],
    [/([\d,.]+)% of all KAT/gi,'占全部 KAT 的 $1%'],
    [/Backed by ([\d,.]+[MBK]?) KAT · ([\d,.]+)% of network vKAT/gi,'底层资产为 $1 KAT · 占全网 vKAT 的 $2%'],
    [/\b(\d+) of 4 sources have all 30 reporting days\. Full network revenue remains incomplete\./gi,'4 个收入来源中，$1 个具备完整的 30 天数据；全网收入仍未完整覆盖。'],
    [/Through (.+?) MYT\. Daily = the last completed UTC day \(08:00–08:00 MYT\); weekly\/monthly = 7\/30 completed days\. Missing days are not projected\./gi,'统计截至马来西亚时间 $1。每日为最近一个完整 UTC 日（马来西亚时间 08:00 至次日 08:00），每周及每月分别为 7 和 30 个完整日；缺失日期不作推算。'],
    [/(\d+) priced V3 pools · partial coverage/gi,'$1 个已定价 V3 资金池 · 数据覆盖不完整'],
    [/Protocol fees from (\d+) priced V3 pools out of (\d+) discovered pools\. Other tokens\/deployments are excluded\. Each day uses its closing token prices, before operating costs\./gi,'已发现 $2 个资金池，当前统计其中 $1 个已定价 V3 池的协议手续费。不含其他代币或部署；每日按当日收盘价计值，尚未扣除运营成本。'],
    [/\bReported through /gi,'报告截至 '],
    [/Could not read the trades yet \((.*?)\)\. Retrying\./gi,'暂时无法读取交易记录（$1），正在重试。'],
    [/The protocol keeps ([\d,.]+)% of each swap's ([\d,.]+)% fee; LPs share the rest/gi,'每笔兑换的手续费率为 $2%，其中 $1% 归协议，其余由 LP 分配'],
    [/(\$[\d,.]+) traded in the last 24 h; LP fees (\$[\d,.]+) at the observed protocol split/gi,'过去 24 小时交易量 $1；按已观测协议分成计算的 LP 手续费为 $2'],
    [/The 7-day fee-growth rate applied to today's active liquidity is about (\$[\d,.]+) a day; it is an estimate, not the pool's historical fee total/gi,'以七天手续费增长率和当前活跃流动性估算，每日约 $1；此为估算，并非资金池实际历史手续费总额'],
    [/Range rounds to (.*?) – (.*?) ([A-Za-z0-9]+) per ([A-Za-z0-9]+), Sushi's nearest price steps\. Deposit about (.*?) at today's price; no staking, the fees collect in the position\. Fees at the last 7 days' rate\./gi,'按 Sushi 允许的价格刻度，实际区间为 $1–$2 $3/$4。按当前价格约需投入 $5；无需质押，手续费累积在仓位内，估算采用最近七天的费率。'],
    [/\b([A-Za-z][A-Za-z0-9]*) per ([A-Za-z][A-Za-z0-9]*)\b/g,'$1/$2'],
    [/\b([+-]?[\d,.]+%) a day/gi,'每日 $1'],[/\b([+-]?[\d,.]+%) a month/gi,'每月 $1'],
    [/\b([\d,.]+) wallet \+ ([\d,.]+) lending collateral/gi,'$1 在钱包 + $2 为借贷抵押品'],
    [/backed 1:1 by locked KAT/gi,'由等量锁定 KAT 支撑'],[/([\d.]+)d cooldown to exit/gi,'退出需冷却 $1 天'],
    [/\b(\d{1,2}) (Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (\d{4})\b/gi,function(_,d,m,y){return y+'年'+month(m)+'月'+d+'日';}],
    [/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/gi,function(_,d,m){return month(m)+'月'+d+'日';}],
    [/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\b/gi,function(_,m,y){return y+'年'+month(m)+'月';}],
    [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) '(\d{2})/gi,function(_,m,y){return '20'+y+'年'+month(m)+'月';}],
    [/\bupdated /gi,'更新于 '],[/\babout /gi,'约 '],[/\bwallet /gi,'钱包 '],
    [/\bto (?=\d)/gi,'至 '],[/\bin (?=\d)/gi,'于 '],[/\bsince (?=\d)/gi,'自 '],
    [/\bfor (?=\d)/gi,'持续 '],[/\bover (?=\d)/gi,'共 '],[/\bon (?=\$|\d)/gi,'基于 ']
  ];
  // Match complete messages before the generic number/unit substitutions.
  patterns.push(quantityPattern);
  function translate(value,target){
    var text=String(value==null?'':value);
    if(selected(target||language)==='en'||!/[A-Za-z]/.test(text))return text;
    if(/^\s*(?:https?:\/\/|0x[0-9a-f]{8}|(?:calc|portfolio):)/i.test(text))return text;
    if(/^\s*[\[{]/.test(text)){try{JSON.parse(text);return text;}catch(e){/* Ordinary interface prose still translates. */}}
    var normalized=text.replace(/\s+/g,' ').trim(),exact=dictionary[normalized.toLowerCase()];
    var lead=text.match(/^\s*/)[0],tail=text.match(/\s*$/)[0];
    if(exact!==undefined)return lead+exact+tail;
    var output=text;patterns.forEach(function(pair){output=output.replace(pair[0],pair[1]);});
    return output.replace(phrasePattern,function(key){return dictionary[key.toLowerCase()];});
  }
  function excluded(element){return !element||!!element.closest(skip);}
  function source(record,current){return record&&current===record.rendered?record.original:current;}
  function textNode(node){
    if(excluded(node.parentElement))return;
    var current=node.data,original=source(records.get(node),current),translated=translate(original);
    // An option without value uses its label as the value. Pin the original value
    // before translating its visible label so existing form semantics stay intact.
    var option=node.parentElement.closest('option');
    if(option&&!option.hasAttribute('value')&&translated!==current)option.value=option.textContent;
    records.set(node,{original:original,rendered:translated});
    if(translated!==current)node.data=translated;
  }
  var attrNames=['title','aria-label','aria-valuetext','placeholder','data-label','alt'];
  function elementAttrs(element){
    if(excluded(element))return;
    var cache=attributes.get(element)||Object.create(null);
    attrNames.forEach(function(name){
      if(!element.hasAttribute(name))return;
      var current=element.getAttribute(name),original=source(cache[name],current),translated=translate(original);
      cache[name]={original:original,rendered:translated};
      if(translated!==current)element.setAttribute(name,translated);
    });
    attributes.set(element,cache);
  }
  function scan(node){
    if(node.nodeType===3){textNode(node);return;}
    if(node.nodeType!==1&&node.nodeType!==9)return;
    if(node.nodeType===1&&excluded(node))return;
    if(node.nodeType===1)elementAttrs(node);
    var walker=document.createTreeWalker(node,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
    for(var next=walker.nextNode();next;next=walker.nextNode()){
      if(next.nodeType===3)textNode(next);else elementAttrs(next);
    }
  }
  function observe(){if(observer)observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:attrNames});}
  function flush(){
    scheduled=false;if(observer)observer.disconnect();
    try{pending.forEach(function(node){if(node.isConnected)scan(node);});pending.clear();}
    finally{observe();}
  }
  function enqueue(node){
    pending.add(node);if(scheduled)return;scheduled=true;Promise.resolve().then(flush);
  }
  function controls(){
    document.querySelectorAll('[data-tf-language]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.tfLanguage===language));});
    var bar=document.querySelector('.tf-language-bar');
    if(bar)bar.setAttribute('aria-label',language==='zh-CN'?'界面语言':'Interface language');
  }
  function installControl(){
    if(document.querySelector('.tf-language-bar'))return;
    var bar=document.createElement('div');bar.className='tf-language-bar';bar.setAttribute('data-i18n-skip','');bar.setAttribute('role','group');
    [['en','EN'],['zh-CN','中文']].forEach(function(pair){
      var button=document.createElement('button');button.type='button';button.className='tf-language-button';
      button.dataset.tfLanguage=pair[0];button.lang=pair[0];button.textContent=pair[1];
      button.setAttribute('aria-label',pair[0]==='en'?'Use English':'使用简体中文');
      button.addEventListener('click',function(){apply(pair[0],true);});bar.appendChild(button);
    });
    var header=document.querySelector('header,.hdr');
    if(header&&header.parentElement===document.body)header.insertAdjacentElement('afterend',bar);
    else document.body.insertBefore(bar,document.body.firstChild);
    controls();
  }
  // Chart.js text is drawn on canvas, so it needs a presentation plugin as well
  // as DOM translation. Numeric datasets and callback inputs remain unchanged.
  var chartRecords=new WeakMap(),wrappedCallbacks=new WeakMap(),chartInstalled=false;
  function translatedProperty(object,key){
    if(!object||typeof object[key]!=='string')return;
    var cache=chartRecords.get(object)||{},original=source(cache[key],object[key]),rendered=translate(original);
    cache[key]={original:original,rendered:rendered};chartRecords.set(object,cache);object[key]=rendered;
  }
  function wrapCallbacks(callbacks){
    if(!callbacks)return;
    ['label','title','footer','afterLabel','beforeLabel'].forEach(function(key){
      var fn=callbacks[key];if(typeof fn!=='function'||wrappedCallbacks.has(fn))return;
      var wrapped=function(){var value=fn.apply(this,arguments);return Array.isArray(value)?value.map(function(s){return translate(s);}):typeof value==='string'?translate(value):value;};
      wrappedCallbacks.set(wrapped,fn);callbacks[key]=wrapped;
    });
  }
  function installCharts(){
    if(chartInstalled||!window.Chart||typeof window.Chart.register!=='function')return;
    chartInstalled=true;
    window.Chart.register({id:'tfInterfaceLanguage',beforeUpdate:function(chart){
      (chart.data.datasets||[]).forEach(function(dataset){translatedProperty(dataset,'label');});
      var plugins=chart.config.options?.plugins;
      if(plugins){translatedProperty(plugins.title,'text');wrapCallbacks(plugins.tooltip?.callbacks);}
    }});
  }
  function refreshCharts(){
    installCharts();if(!chartInstalled)return;
    Object.values(window.Chart.instances||{}).forEach(function(chart){chart.update('none');});
  }
  function apply(next,remember){
    var previous=language;language=selected(next);root.lang=language;root.dataset.language=language;
    if(remember)try{localStorage.setItem(KEY,language);}catch(e){}
    controls();if(document.body){enqueue(document.documentElement);refreshCharts();}
    if(previous!==language)window.dispatchEvent(new CustomEvent('tf-language-change',{detail:{language:language,locale:language==='zh-CN'?'zh-CN':'en-GB'}}));
  }
  window.TFI18n=Object.freeze({translate:translate,setLanguage:function(value){apply(value,true);},getLanguage:function(){return language;},refresh:function(){enqueue(document.documentElement);}});
  language=saved();root.lang=language;root.dataset.language=language;
  function ready(){
    installControl();installCharts();scan(document.documentElement);
    observer=new MutationObserver(function(mutations){
      if(language==='en')return;
      mutations.forEach(function(mutation){
        if(mutation.type==='childList')mutation.addedNodes.forEach(enqueue);
        else enqueue(mutation.target);
      });
    });observe();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
  window.addEventListener('storage',function(event){if(event.key===KEY||event.key===null)apply(saved(),false);});
  window.addEventListener('pageshow',function(event){if(event.persisted)apply(saved(),false);});
})();
