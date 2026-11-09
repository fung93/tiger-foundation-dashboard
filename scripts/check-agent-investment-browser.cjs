/* Optional browser acceptance: pass a locally installed Playwright module.
   HTTPS and private APIs are intercepted; no provider, account or bot is used. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.argv[2]||'playwright');
const root=path.resolve(__dirname,'..');let count=0;const check=(value,message)=>{assert.ok(value,message);count++;};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{for(const theme of ['classy','tiger'])for(const width of [360,1366]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];
  let authenticated=true,hold=null,release,started=false;
  await context.addInitScript(value=>localStorage.setItem('tf_theme2',value),theme);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.hostname!=='investment-browser.test')return route.abort();
   if(url.pathname==='/api/agent'){
    const body=JSON.parse(route.request().postData()||'{}');requests.push(body);let value;
    if(body.action==='status')value={configured:true,authenticated,readiness:{ai:true},messages:[],sources:[],settings:{},alerts:[],telegram:{connected:false}};
    else if(body.action==='automaticStatus')value={controls:{enabled:true,revision:0},configured:true,enabled:true,status:'waiting_first_reading'};
    else if(body.action==='policy')value={version:0,status:'unconfirmed',constraints:{}};
    else if(body.action==='researchSources')value={sources:[]};
    else if(body.action==='logout'){authenticated=false;value={authenticated:false};}
    else if(body.action==='chat'){
     if(hold){started=true;await hold;}
     const focus=/profit/.test(body.message)?'performance':/LP choices/.test(body.message)?'ranges':/Stress/.test(body.message)?'stress':/decision/.test(body.message)?'evaluation':'protocols';
     const result={schemaVersion:'agent-investment-v1',focus,status:'partial',createdAt:new Date().toISOString()};
     if(focus==='performance')result.performance={rows:[{positionId:'1',pair:'ETH/USDG',attribution:{principalPnlUsd:-10,claimedAtEventUsd:2,unclaimedNowUsd:1,grossCashBasisPnlUsd:-7,identifiedTransactionGasUsd:.2}}]};
     if(focus==='ranges')result.rangeAnalyses=[{data:{pair:'ETH/USDG',frontier:{scenarios:[1,2,3,4,5],assumptions:['Explicit paths; future income remains conditional.'],options:[{
      id:'keep',lowerPrice:2800,upperPrice:3300,costUsd:0,outcomes:[1,2,3,4,5].map(()=>({netBeforeFinancingUsd:500}))}]}}}];
     if(focus==='stress')result.stress={cases:[{id:'combined',label:'Combined fall',verifiedBeforeUsd:1000,verifiedAfterUsd:700,verifiedWalletStableUsd:10,loans:[{health:.99,liquidatable:true}]}]};
     if(focus==='evaluation')result.evaluations=[{baselineAt:new Date(Date.now()-86400000).toISOString(),observedAt:new Date().toISOString(),status:'observed',marks:[{optionId:'keep',principalUsd:500,differenceBeforeUnobservedIncomeUsd:1}]}];
     if(focus==='protocols')result.protocolWatch={sources:[{protocol:'Morpho',status:'fresh',checkedAt:new Date().toISOString(),entries:[{tag:'<img src=x onerror=alert(1)>',url:'https://github.com/morpho-org/morpho-blue/releases/tag/fixture',publishedAt:new Date().toISOString()}]}]};
     value={mode:'investment_review',status:'partial',reply:'Suggestion: Review current evidence.\nWhy: A fixed fixture was checked.\nTrade-off: Unknown costs stay unknown.\nRecheck when: Inputs change.',result};
    }else return route.fulfill({status:400,json:{error:'Unsupported fixture action'}});
    return route.fulfill({json:value});
   }
   const file=path.resolve(root,url.pathname.slice(1));if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html':/\.(mjs|js)$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://investment-browser.test/agent.html');await page.locator('#agentWorkspace').waitFor({state:'visible'});
  check(await page.locator('#agentInvestment [data-question]').count()===5,'All five reviews are available without forms');
  for(const [label,focus]of [['Performance','performance'],['LP choices','ranges'],['Stress test','stress'],['Decision evidence','evaluation'],['Protocol watch','protocols']]){
   await page.locator('#agentInvestment').getByRole('button',{name:label,exact:true}).click();
   await page.waitForFunction(focus=>document.getElementById('agentInvestmentMeta').textContent.startsWith(({performance:'LP performance',ranges:'LP choices',stress:'Portfolio stress test',evaluation:'Decision evidence',protocols:'Protocol watch'})[focus]),focus);
   check((await page.locator('#agentInvestmentBrief').innerText()).split('\n').length===4,'Each review presents four short lines');
   check(!await page.locator('#agentInvestmentEvidence').isVisible(),'Detailed evidence starts collapsed');
   await page.locator('#agentInvestmentDetails summary').click();
   check((await page.locator('#agentInvestmentEvidence').innerText()).length>30,'Calculations and coverage are available on demand');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Evidence fits both themes and viewport widths');
   if(focus==='ranges')check((await page.locator('#agentInvestmentEvidence').innerText()).includes('$500.00'),'The table uses the calculated before-financing value');
   if(focus==='protocols')check(await page.locator('#agentInvestmentEvidence img').count()===0,'Untrusted protocol text cannot insert HTML');
   await page.waitForFunction(()=>!document.getElementById('agentSend').disabled);
  }
  check(requests.filter(row=>row.action==='chat').every(row=>typeof row.requestId==='string'),'Review buttons reuse authenticated idempotent chat');
  hold=new Promise(resolve=>{release=resolve;});await page.locator('#agentInvestment').getByRole('button',{name:'Performance',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('agentSend').disabled);
  while(!started)await new Promise(resolve=>setTimeout(resolve,10));
  await page.locator('#agentLogout').click();await page.locator('#agentLogin').waitFor({state:'visible'});release();hold=null;
  await page.waitForTimeout(100);
  check((await page.locator('#agentInvestmentBrief').textContent())==='','Logout clears investment evidence and suppresses late responses');
  check(await page.evaluate(()=>![...Object.keys(localStorage),...Object.keys(sessionStorage)].some(key=>/agent|chat|secret|investment/i.test(key))),'Private investment data is never placed in browser storage');
  check(errors.length===0,'No browser exceptions: '+errors.join('; '));
  await context.close();
 }}finally{await browser.close();}
 console.log('Investment tools browser: '+count+' assertions passed across Classy/Tiger at 360/1366 px. No live provider used.');
})().catch(error=>{console.error(error);process.exitCode=1;});
