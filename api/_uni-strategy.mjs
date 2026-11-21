/* Separate cash/history overlay. Slow archive reads never block UNI quotes. */
import {advanceUniStrategy} from './_uni-strategy-reader.mjs';
import {readAvailableUniTradeView} from './_uni-trades.mjs';
import {validateUniStrategy,replayUniStrategy} from '../uni-strategy-core.mjs';
import {createLiveCache,fetchJSON,requestOrigin,responseHeaders,savedBookValid} from './_live-cache.mjs';

export function createUniStrategyLoader({readJSON=fetchJSON,readTrades=readAvailableUniTradeView,advance=advanceUniStrategy}={}){
 const checkpoints=new Map(),cache=createLiveCache({complete:view=>view.complete===true});
 return origin=>cache(origin,async()=>{
  const [saved,trade,lpBook]=await Promise.all([readJSON(origin+'/uni-strategy.json'),readTrades(origin),readJSON(origin+'/lpbook.json')]);
  validateUniStrategy(saved);
  if(!savedBookValid(lpBook,9))throw Error('Saved LP history is unavailable.');
  const identity=JSON.stringify(saved),prior=checkpoints.get(origin),input=prior?.identity===identity?prior.book:saved;
  const next=await advance(input,{trade,lpBook}),errors={...next.errors};validateUniStrategy(next.book);
  let complete=next.complete===true;
  if(complete)try{replayUniStrategy(next.book);}catch{complete=false;errors.accounting='Strategy costs or cash receipts are still being verified.';}
  checkpoints.set(origin,{identity,book:next.book});
  if(checkpoints.size>8)checkpoints.delete(checkpoints.keys().next().value);
  return {schemaVersion:'uni-strategy-view-v1',...next,complete,errors,
   coverage:Object.fromEntries(['base','bnb'].map(chain=>[chain,next.book.chains[chain]?'tracked':trade?.historyComplete?'no_recorded_activity':'earlier_history_unverified']))};
 });
}
const read=createUniStrategyLoader();
export async function handleUniStrategy(req,res){
 const query=req.query||Object.fromEntries(new URL(req.url||'/','https://local.invalid').searchParams);
 if(query.view!=='strategy')return false;
 responseHeaders(res);
 try{const view=await read(requestOrigin(req));responseHeaders(res,view.complete);res.status(200).end(JSON.stringify(view));}
 catch{res.status(502).end(JSON.stringify({error:'UNI strategy cash history could not be refreshed.'}));}
 return true;
}
