/* The UNI swap ledger is separate from KAT, LP accounting and portfolio history. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {advanceUniTrades,emptyUniTradeBook,validUniTradeBook} from '../api/_uni-trades.mjs';
export async function updateUniTrades(root,{advance=advanceUniTrades}={}){
 const path=resolve(root,'uni-trades.json');let saved;
 try{saved=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;saved=emptyUniTradeBook();}
 validUniTradeBook(saved);
 const next=await advance(saved,{job:true,maxWindows:2500});
 const quotes={...(saved.quotes||{}),...next.quotes},walletReadings=(saved.walletReadings||[]).filter(w=>!next.wallets.some(n=>n.chain===w.chain&&n.owner===w.owner)).concat(next.wallets);
 const book=validUniTradeBook({...next.book,quotes,walletReadings,lastAttempt:next.at,errors:next.errors,historyErrors:next.historyErrors||{},historyComplete:next.historyComplete===true,
   runs:[...(saved.runs||[]),{at:next.at,complete:next.complete,historyComplete:next.historyComplete===true,errors:next.errors}].slice(-20)});
 await writeFile(path,JSON.stringify(book,null,2)+'\n');
 console.log(JSON.stringify({trades:book.trades.length,complete:next.complete,chains:book.chains,errors:next.errors}));
 return {book,complete:next.complete};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await updateUniTrades(fileURLToPath(new URL('../',import.meta.url)));
