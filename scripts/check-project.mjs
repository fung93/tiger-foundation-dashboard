/* Portable, network-free checks. Never run collectors or backfills from setup. */
import {readdirSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
if(Number(process.versions.node.split('.')[0])<20)throw new Error('Node 20 or newer is required');
function run(args){
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
if(!process.argv.includes('--tests-only')){
  const scripts=[...readdirSync(path.join(root,'api')).filter(f=>f.endsWith('.mjs')).map(f=>'api/'+f),
    ...readdirSync(path.join(root,'scripts')).filter(f=>f.endsWith('.mjs')).map(f=>'scripts/'+f),
    'lending.js','lpbook.js','lpcards.js','sw.js','morpho-core.mjs','portfolio-core.mjs','strategy.js','strategy-core.mjs','kat.js','kat-core.mjs','vkat.js','vkat-core.mjs','theme.js','agent.js','agent-language.mjs','agent-lp-summary.mjs','agent-launcher.js','cloudflare/worker.mjs','cloudflare/runtime.mjs','cloudflare/review-workflow.mjs'];
  for(const file of scripts)run(['--check',file]);
  for(const file of ['index.html','vercel/index.html','lp.html','lp-all.html','lending.html','strategy.html','kat.html','vkat.html','widget.html','agent.html']){
    const html=readFileSync(path.join(root,file),'utf8');
    for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new Function(match[1]);
  }
  if(!readFileSync(path.join(root,'index.html')).equals(readFileSync(path.join(root,'vercel/index.html'))))throw new Error('Portfolio copies differ');
  console.log('Syntax and Portfolio copies verified.');
}
for(const file of readdirSync(path.join(root,'scripts')).filter(f=>/^test-.+\.mjs$/.test(f)).sort())run(['scripts/'+file]);
console.log('All project checks passed. No chain collectors or history writers were run.');
