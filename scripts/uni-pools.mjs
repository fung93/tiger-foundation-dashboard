/* The UNI guide's own public snapshot. Never reads wallets or modifies accounting. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readUniPools} from '../api/_uni-reader.mjs';
import {validateUniSnapshot,mergeUniSnapshots} from '../uni-core.mjs';

export async function updateUniPools(root,{read=readUniPools}={}){
  const file=resolve(root,'uni-pools.json'),saved=validateUniSnapshot(JSON.parse(readFileSync(file,'utf8'))),
    next=validateUniSnapshot(await read({saved,currentTimeoutMs:30000,historyTimeoutMs:90000,archiveTimeoutMs:30000,maxHistoryRequests:600})),merged=validateUniSnapshot(mergeUniSnapshots(saved,next));
  writeFileSync(file,JSON.stringify(merged,null,2)+'\n');
  console.log('UNI snapshot: '+merged.chains.map(c=>`${c.name} ${c.status}${c.reason?' ('+c.reason+')':''}, ${merged.pools.filter(p=>p.chain===c.key).length} recorded pools`).join(' · '));
  return merged;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  await updateUniPools(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
