/* Network-free checks for language storage and financial/identifier-safe copy. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let checks=0;const ok=(v,n)=>{assert.ok(v,n);checks++;},eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;};
const store=new Map(),events=[],listeners=new Map(),root={lang:'en',dataset:{}};
const document={documentElement:root,readyState:'loading',body:null,addEventListener(){},querySelectorAll(){return [];},querySelector(){return null;}};
const window={addEventListener(name,fn){listeners.set(name,fn);},dispatchEvent(event){events.push(event);}};
let blocked=false;
const context=vm.createContext({window,document,WeakMap,Set,Promise,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
  localStorage:{getItem(key){if(blocked)throw Error('Storage disabled');return store.get(key)||null;},setItem(key,value){if(blocked)throw Error('Storage disabled');store.set(key,value);}}});
vm.runInContext(readFileSync(new URL('../i18n-zh.js',import.meta.url),'utf8'),context);
vm.runInContext(readFileSync(new URL('../i18n.js',import.meta.url),'utf8'),context);
const ui=window.TFI18n;
eq(root.lang,'en','The default interface remains English');
eq(ui.translate('Net PnL'),'Net PnL','English source copy is preserved');
ui.setLanguage('zh-CN');eq(root.lang,'zh-CN','The document declares Simplified Chinese');
eq(ui.translate('UNI Trade'),'UNI 交易','New UNI Trade destination has reviewed Chinese copy');
eq(ui.translate('Paid / received'),'支付 / 收到','Mobile trade labels retain their meaning');
eq(store.get('tf_language_v1'),'zh-CN','The language has its own preference key');
eq(store.size,1,'Language changes cannot persist lending targets or touch financial cache keys');
eq(ui.translate('Upper edge P&L'),'上边界盈亏','P&L retains its meaning rather than being forced to profit');
eq(ui.translate('Lower edge P&L'),'下边界盈亏','The lower boundary is not mistranslated as a guaranteed loss');
eq(ui.translate('RECORDED'),'已记录','Recorded status is distinct from live');
eq(ui.translate('LIVE'),'实时','Live status has its own translation');
eq(ui.translate('Fees claimed'),'已领取手续费','Claimed fees are distinct from projected fees');
eq(ui.translate('Estimated fees / day'),'预计每日手续费','The conditional estimate remains labeled as an estimate');
eq(ui.translate('While in range'),'价格在区间内时','Time-in-range qualification survives');
eq(ui.translate('{"status":"ready","market":"KAT / USDC","amount":123.45}'),'{"status":"ready","market":"KAT / USDC","amount":123.45}','Machine-readable diagnostics remain valid original JSON');
eq(ui.translate('Start with USDC. Buy UNI if its price falls.'),'投入 USDC，价格下跌进入区间后逐步买入 UNI。','Dynamic single-sided copy preserves asset identity');
for(const value of ['$1,234.56','−$42.01','0.000001 vbWBTC','77%','1.1035','KAT / vbUSDC','avKAT','BNB','USD','0xb378207ab46aa2105eb1cb94ae8a5bab57316de1','https://app.uniswap.org/explore/pools/base/0x1261d6c23a2d719e2543d2d51aec87656050b70d','calc:1234567890abcdef'])
  eq(ui.translate(value),value,'An amount, ticker, identifier or URL remains unchanged');
for(const value of ['At this price: $0.00/day · 0% APR.','cost $56.08 · value $56.04','3 open · 2 chains · excl. fees','Upper edge · $70,041','The protocol keeps 50% of each swap\'s 0.30% fee; LPs share the rest']){
 const numbers=s=>(s.match(/\d[\d,.]*/g)||[]).sort();
 eq(numbers(ui.translate(value)),numbers(value),'Financial numbers survive prose translation: '+value);
}
ok(ui.translate('The protocol keeps 50% of each swap\'s 0.30% fee; LPs share the rest').includes('0.30%'),'The fee tier and protocol share cannot be confused');
eq(ui.translate('15 Nov 2026, 09:12 MYT'),'2026年11月15日, 09:12 MYT','Dates remain in the original MYT reporting timezone');
eq(ui.translate('  Fees claimed  '),'  已领取手续费  ','Whitespace around inline text remains intact');
eq(ui.translate('Estimated fees / day','en'),'Estimated fees / day','Callers can request the original English explicitly');
ok(!ui.translate('No active liquidity in this fee tier.').includes('No'),'Missing liquidity is explained coherently');
store.set('tf_language_v1','en');listeners.get('storage')({key:'tf_language_v1'});
eq(ui.getLanguage(),'en','Other tabs and frames receive the shared language preference');
ui.setLanguage('invalid');eq(root.lang,'en','Unknown locale values safely select English');
blocked=true;ui.setLanguage('zh-CN');eq(root.lang,'zh-CN','The control works for the current visit when storage is unavailable');
ok(events.some(event=>event.type==='tf-language-change'&&event.detail.locale==='zh-CN'),'Canvas/UI listeners receive a locale change without a page reload');
for(const file of ['index.html','vercel/index.html','lp.html','lp-all.html','lending.html','strategy.html','uni.html','uni-trade.html','vkat.html','kat.html','widget.html','agent.html','dashboard.html','local.html']){
 const html=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 ok(html.includes('/i18n-zh.js?v=189')&&html.includes('/i18n.js?v=189')&&html.includes('/i18n.css?v=189'),'Every page includes the same local translation assets: '+file);
 ok(html.indexOf('/i18n-zh.js?v=189')<html.indexOf('/i18n.js?v=189'),'Copy is available before the translator: '+file);
}
const worker=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
for(const asset of ['i18n.js','i18n-zh.js','i18n.css'])ok(worker.includes("'/"+asset+"?v=189'"),'The bilingual interface remains available in the offline shell');
console.log(`Shared English/Chinese language preference and financial copy: ${checks} assertions passed.`);
