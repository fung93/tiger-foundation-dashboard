/* Exercise the Portfolio's actual reading status, including failed refreshes,
   delayed repaints and recovery. No network access or browser dependency. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const names=['portfolioReadState','renderPortfolioStatus','markPortfolioStale'];
const functions=names.map(name=>{
  const match=source.match(new RegExp('function '+name+'\\([\\s\\S]*?\\n}'));
  assert.ok(match,'The tested Portfolio function must exist: '+name);
  return match[0];
});
let checks=names.length;
const eq=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);checks++;};
const ok=(condition,note)=>{assert.ok(condition,note);checks++;};
const START=Date.parse('2026-10-26T12:00:00.000Z');
let now=START;
class ControlledDate extends Date {
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
}
const elements=new Map();
function element(id){
  if(!elements.has(id)){
    const classes=new Set();
    elements.set(id,{innerHTML:'',textContent:'',classList:{
      toggle(name,on){if(on===undefined)on=!classes.has(name);if(on)classes.add(name);else classes.delete(name);return on;},
      contains(name){return classes.has(name);}
    }});
  }
  return elements.get(id);
}
const context=vm.createContext({Date:ControlledDate,console,
  LIVE_ON:false,liveRendered:false,LAST_DATA:null,
  clockNow:()=> '23:59:59',
  document:{getElementById:element}});
vm.runInContext(functions.join('\n'),context,{filename:'Portfolio status functions from index.html'});
const ticks=[];
context.setInterval=(fn,delay)=>{ticks.push({fn,delay});};
const interval=source.slice(source.indexOf('function clockNow')).match(/setInterval\(function\(\)\{[\s\S]*?},1000\);/);
assert.ok(interval,'The running Portfolio clock must have a testable one-second callback');checks++;
vm.runInContext(interval[0],context,{filename:'Portfolio clock callback from index.html'});
eq(ticks.length,1,'The test captures the actual clock callback');
const clone=value=>JSON.parse(JSON.stringify(value));
const reading=(at=START,warnings=[])=>({last_updated:new Date(at-3600000).toISOString(),
  summary:{grand_total_usd:1234},live_health:{read_at:new Date(at).toISOString(),warnings:[...warnings]}});
const state=(data,isLive=true,at=now)=>clone(context.portfolioReadState(data,isLive,at));

const full=reading(),before=JSON.stringify(full);
eq(state(full).live,true,'A complete fresh reading is LIVE');
eq(state(full).ts,START,'Freshness uses the actual read time, not the older snapshot time');
eq(state(full).warnings,[],'A complete fresh reading has no warnings');
eq(state(full,false).live,false,'A saved snapshot is never labelled LIVE');
eq(state(full,false).ts,START,'Displaying a snapshot does not invent a later reading time');
eq(state(full,true,START+90000).live,true,'Exactly ninety seconds is still inside the freshness boundary');
eq(state(full,true,START+91000).live,false,'A reading older than ninety seconds becomes stale');
eq(JSON.stringify(full),before,'Reading the status does not mutate the stored data');
const partial=reading(START,['Katana LP read failed']);
eq(state(partial).live,false,'An incomplete fresh reading is not LIVE');
ok(state(partial).warnings.includes('Katana LP read failed'),'The failed component remains named');
eq(state({last_updated:new Date(START).toISOString()}).ts,START,'Legacy data uses its original last_updated time');
eq(state(null).live,false,'A missing reading cannot be LIVE');
eq(state({}).live,false,'A reading without a timestamp cannot be LIVE');
eq(state({last_updated:'invalid',live_health:{read_at:'invalid',warnings:[]}}).live,false,
  'An invalid reading time cannot be LIVE');

const header=element('lastUpdated'),note=element('portfolioHealth');
context.LAST_DATA=clone(full);context.liveRendered=true;
context.renderPortfolioStatus(context.LAST_DATA,true);
eq(context.LIVE_ON,true,'A successful reading starts the LIVE clock');
ok(header.innerHTML.includes('LIVE'),'The header shows LIVE after a complete reading');
ok(header.innerHTML.includes('23:59:59'),'A healthy header may show the running clock');
eq(note.classList.contains('on'),false,'A complete reading clears the warning');

context.markPortfolioStale('Katana LP could not be refreshed');
eq(context.LIVE_ON,false,'A failed refresh stops the LIVE clock');
ok(header.innerHTML.includes('STALE'),'A failed refresh marks the displayed reading stale');
ok(!header.innerHTML.includes('23:59:59'),'A stale header does not use the running clock');
ok(note.textContent.includes('Katana LP could not be refreshed'),'A failed refresh explains the missing component');
eq(note.classList.contains('on'),true,'The failed-refresh warning is visible');
eq(context.LAST_DATA.live_health.read_at,full.live_health.read_at,'A failure preserves the original reading time');
eq(context.LAST_DATA.summary.grand_total_usd,1234,'A failure preserves the displayed wealth');
context.markPortfolioStale('Katana LP could not be refreshed');
eq(context.LAST_DATA.live_health.warnings.filter(w=>w==='Katana LP could not be refreshed').length,1,
  'Repeated failures do not duplicate the same warning');

now+=15000;
context.renderPortfolioStatus(context.LAST_DATA,context.liveRendered);
eq(context.LIVE_ON,false,'A later vault or currency repaint cannot revive failed data as LIVE');
ok(header.innerHTML.includes('STALE'),'The stale state survives an unrelated repaint');
eq(context.LAST_DATA.live_health.read_at,full.live_health.read_at,'An unrelated repaint cannot restart freshness');

context.LAST_DATA=reading(now);context.renderPortfolioStatus(context.LAST_DATA,true);
eq(context.LIVE_ON,true,'A complete recovery restores LIVE');
ok(header.innerHTML.includes('LIVE'),'The recovered header shows LIVE');
eq(note.classList.contains('on'),false,'A complete recovery removes the warning');
eq(note.textContent,'','A recovered reading clears the old warning text');
now+=91000;
ticks[0].fn();
eq(context.LIVE_ON,false,'Time alone makes an old full reading stale');
ok(header.innerHTML.includes('STALE'),'The header cannot remain LIVE indefinitely after polling stops');
eq(note.classList.contains('on'),true,'An expired full reading explains its stale state');

context.LAST_DATA=reading(now);context.renderPortfolioStatus(context.LAST_DATA,false);
eq(context.LIVE_ON,false,'A fresh snapshot keeps the running clock off');
ok(header.innerHTML.includes('SNAPSHOT'),'Snapshot-only data is labelled SNAPSHOT');
context.LAST_DATA=null;
assert.doesNotThrow(()=>context.markPortfolioStale('Initial refresh failed'));checks++;

// Drive the real refresh orchestration too: the catch must retain values and
// mark them stale, rather than relying only on callers using the status helpers.
const refreshMatch=source.match(/function refreshLive\([\s\S]*?\n}/);
assert.ok(refreshMatch,'The actual refreshLive orchestration must exist');checks++;
const activity={load:0,render:0,claims:0,fees:0,positions:0};
Object.assign(context,{
  console:{warn(){}},REFRESHING:false,LAST_SNAP:{meteora_refs:['saved-position']},
  CFG:{meteoraRefs:[]},POSITIONS:{},
  render(data,isLive){activity.render++;context.LAST_DATA=data;if(isLive)context.liveRendered=true;context.renderPortfolioStatus(data,isLive);},
  scanLiveClaims(){activity.claims++;return Promise.resolve({days:{}});},
  scanLiveFees(){activity.fees++;return Promise.resolve();},
  scanLivePositions(){activity.positions++;return Promise.resolve({open:[],closed:[]});},
  keepingScroll(fn){fn();},buildClaims(){},buildPositions(){}
});
vm.runInContext(refreshMatch[0],context,{filename:'refreshLive from index.html'});
context.LAST_DATA=reading(now);context.liveRendered=true;
context.renderPortfolioStatus(context.LAST_DATA,true);
const retained=context.LAST_DATA,originalTime=retained.live_health.read_at;
context.loadLive=()=>{activity.load++;return Promise.reject(new Error('Katana LP slot0 unavailable'));};
await context.refreshLive();
eq(context.LAST_DATA,retained,'The actual failed refresh retains the displayed reading');
eq(context.LAST_DATA.summary.grand_total_usd,1234,'The actual failed refresh cannot reduce displayed wealth');
eq(context.LAST_DATA.live_health.read_at,originalTime,'The actual failed refresh preserves the original time');
eq(context.REFRESHING,false,'A failed refresh releases the polling guard');
eq(context.LIVE_ON,false,'The actual rejection path turns LIVE off');
ok(header.innerHTML.includes('STALE'),'The actual rejection path paints a stale header');
ok(note.textContent.includes('Katana LP slot0 unavailable'),'The actual rejection path names the failed LP reading');
eq(activity.render,0,'A rejected reading is not rendered as a smaller portfolio');
eq(activity.claims+activity.fees+activity.positions,0,'A rejected main reading does not run dependent scans');
context.renderPortfolioStatus(context.LAST_DATA,context.liveRendered);
eq(context.LIVE_ON,false,'A later vault or currency repaint cannot revive an actually failed refresh');

now+=15000;
const recovered=reading(now);recovered.summary.grand_total_usd=2345;
context.loadLive=()=>{activity.load++;return Promise.resolve(recovered);};
await context.refreshLive();
eq(context.LAST_DATA,recovered,'The actual recovery adopts the new complete reading');
eq(context.LAST_DATA.summary.grand_total_usd,2345,'The actual recovery updates wealth');
eq(context.LIVE_ON,true,'The actual recovery restores LIVE');
eq(note.classList.contains('on'),false,'The actual recovery removes the old warning');
eq(context.REFRESHING,false,'A successful refresh releases the polling guard');
eq([activity.claims,activity.fees,activity.positions],[1,1,1],'Dependent scans run after the complete recovery');

let finishPending;
context.loadLive=()=>{activity.load++;return new Promise(resolve=>{finishPending=resolve;});};
const inFlight=context.refreshLive(),loads=activity.load;
eq(context.REFRESHING,true,'An in-flight refresh holds the polling guard');
await context.refreshLive();
eq(activity.load,loads,'Another timer tick does not overlap the in-flight read');
now+=91000;ticks[0].fn();
eq(context.LIVE_ON,false,'An in-flight refresh cannot leave old data LIVE beyond ninety seconds');
finishPending(reading(now));await inFlight;
eq(context.LIVE_ON,true,'Completion of the delayed full read restores LIVE');
eq(context.REFRESHING,false,'The delayed refresh releases its guard after completing');

console.log(`Portfolio reading status: ${checks} assertions passed.`);
