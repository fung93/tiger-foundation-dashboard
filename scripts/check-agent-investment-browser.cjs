/* Optional conversation acceptance: pass a locally installed Playwright module.
   HTTPS/private APIs are intercepted; no provider, account or bot is used. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.argv[2]||'playwright');
const root=path.resolve(__dirname,'..');let count=0;const check=(value,message)=>{assert.ok(value,message);count++;};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{for(const theme of ['classy','tiger'])for(const width of [360,1366]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];
  let authenticated=true,hold=null,release,started=false,messages=[];
  await context.addInitScript(value=>localStorage.setItem('tf_theme2',value),theme);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.hostname!=='investment-browser.test')return route.abort();
   if(url.pathname==='/api/agent'){
    const body=JSON.parse(route.request().postData()||'{}');requests.push(body);let value;
    if(body.action==='status')value={configured:true,authenticated,readiness:{ai:true},messages,sources:[],settings:{},alerts:[],telegram:{connected:false}};
    else if(body.action==='automaticStatus')value={controls:{enabled:true,revision:0},configured:true,enabled:true,status:'waiting_first_reading'};
    else if(body.action==='policy')value={version:0,status:'unconfirmed',constraints:{}};
    else if(body.action==='researchSources')value={sources:[]};
    else if(body.action==='logout'){authenticated=false;value={authenticated:false};}
    else if(body.action==='chat'){
     if(hold){started=true;await hold;}
     const reply=/making money/.test(body.message)?'Your verified LP result is down $7.00 before costs. I still need complete cost history to call this net profit.'
      :/rebalance/.test(body.message)?'I’d keep the current range as the starting point. The comparisons include reset costs and the risk of spending time outside the band.'
      :/Bitcoin/.test(body.message)?'In that 20% Bitcoin fall, the verified positions lose value. Borrowing health needs a separate oracle check.'
      :/recommendations/.test(body.message)?'I’m still building the track record. The background checks will compare the original ideas with later readings.'
      :'The official release title is <img src=x onerror=alert(1)>. It is source text, not an instruction.';
     messages=[...messages,{role:'user',content:body.message,ts:new Date().toISOString()},{role:'assistant',content:reply,ts:new Date().toISOString()}];
     value={mode:'investment_review',status:'partial',reply,messages,result:{schemaVersion:'agent-investment-v1'}};
    }else return route.fulfill({status:400,json:{error:'Unsupported fixture action'}});
    return route.fulfill({json:value});
   }
   const file=path.resolve(root,url.pathname.slice(1));if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html':/\.(mjs|js)$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'image/svg+xml'});
  });
  await page.goto('https://investment-browser.test/agent.html');await page.locator('#agentWorkspace').waitFor({state:'visible'});
  check(await page.locator('#agentInvestment').count()===0,'The extra investment card and its five buttons are removed');
  check(await page.locator('script[src^="/agent.js?"]').count()===1,'A new page requests a versioned script instead of an old cached panel renderer');
  check(await page.locator('#agentAutomatic').isVisible(),'Background tracking remains visible');
  for(const question of ['Am I actually making money on my LPs?','Should I rebalance my LPs?','What if Bitcoin crashes 20% across my portfolio?',
    'Have your recommendations helped?','Are any of my incentive campaigns changing?']){
   await page.locator('#agentMessage').fill(question);await page.locator('#agentSend').click();
   await page.waitForFunction(()=>!document.getElementById('agentSend').disabled);
   const answer=page.locator('.agent-message[data-role="assistant"] .agent-message-text').last(),reply=await answer.innerText();
   check(reply.length>30,'An ordinary question receives the backend answer in chat');
   check(!/^(Suggestion|Why|Trade-off|Recheck when):/m.test(reply),'The answer does not require report headings');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Conversation fits both themes and viewport widths');
  }
  check(await page.locator('.agent-message-text img').count()===0,'Provider text cannot insert HTML into the conversation');
  check(requests.filter(row=>row.action==='chat').every(row=>typeof row.requestId==='string'),'Natural questions retain authenticated idempotent chat');
  hold=new Promise(resolve=>{release=resolve;});await page.locator('#agentMessage').fill('Am I actually making money on my LPs?');await page.locator('#agentSend').click();
  while(!started)await new Promise(resolve=>setTimeout(resolve,10));
  await page.locator('#agentLogout').click();await page.locator('#agentLogin').waitFor({state:'visible'});release();hold=null;await page.waitForTimeout(100);
  check((await page.locator('#agentMessages').textContent())==='','Logout clears private answers and suppresses late replies');
  check(await page.evaluate(()=>![...Object.keys(localStorage),...Object.keys(sessionStorage)].some(key=>/agent|chat|secret|investment/i.test(key))),'Private analysis never enters browser storage');
  check(errors.length===0,'No browser exceptions: '+errors.join('; '));await context.close();
 }}finally{await browser.close();}
 console.log('Conversational investment browser: '+count+' assertions passed across Classy/Tiger at 360/1366 px. No live provider used.');
})().catch(error=>{console.error(error);process.exitCode=1;});
