/* Isolated, append-only revenue snapshot. Never changes LP/claim/trade histories.
   The regular job collects a few missing Perps days; provider gaps stay explicit. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {collectKatanaRevenue} from '../api/_katana-revenue.mjs';
import {validateRevenueLedger} from '../katana-revenue-core.mjs';
export async function updateKatanaRevenue(root,options={}){
 const path=resolve(root,'katana-revenue.json'),saved=validateRevenueLedger(JSON.parse(readFileSync(path,'utf8'))),
  result=await collectKatanaRevenue(saved,{maxPerpsDays:4,maxRequests:96,timeoutMs:120000,...options});
 writeFileSync(path,JSON.stringify(validateRevenueLedger(result.ledger),null,2)+'\n');
 console.log('Katana revenue: '+result.view.sources.map(s=>s.name+' '+s.periods[30].coveredDays+'/30 days').join(' · '));
 return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
 await updateKatanaRevenue(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
