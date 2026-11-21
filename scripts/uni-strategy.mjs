/* Independent strategy-cash checkpoint; never rewrites LP/trade histories. */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {advanceUniStrategy} from '../api/_uni-strategy-reader.mjs';
import {validateUniStrategy,replayUniStrategy} from '../uni-strategy-core.mjs';
export async function updateUniStrategy(root,{advance=advanceUniStrategy}={}){
 const path=resolve(root,'uni-strategy.json'),[saved,trades,lpBook]=await Promise.all(['uni-strategy.json','uni-trades.json','lpbook.json'].map(async file=>JSON.parse(await readFile(resolve(root,file),'utf8'))));
 validateUniStrategy(saved);
 const trade={book:trades,trades:trades.trades,wallets:trades.walletReadings||[],quotes:trades.quotes||{}},next=await advance(saved,{trade,lpBook,job:true,maxWindows:2500});
 validateUniStrategy(next.book);
 let complete=next.complete===true;const errors={...next.errors};
 if(complete)try{replayUniStrategy(next.book);}catch{complete=false;errors.accounting='Strategy costs or cash receipts are still being verified.';}
 const book={...next.book,lastAttempt:next.at,complete,errors};
 await writeFile(path+'.tmp',JSON.stringify(book,null,2)+'\n');await rename(path+'.tmp',path);
 console.log(JSON.stringify({complete,receipts:book.events.length,chains:Object.fromEntries(Object.entries(book.chains).map(([key,s])=>[key,{cursor:s.cursor,head:s.head}])),errors}));
 return {book,complete};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await updateUniStrategy(fileURLToPath(new URL('../',import.meta.url)));
