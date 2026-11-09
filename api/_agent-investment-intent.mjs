/* Owner wording selects read-only reviews; model-selected focus never supplies
   wallet identities, financial assumptions or preference changes. */
import {requestedLPPair} from './_agent-lp-range.mjs';
import {isLPIncomeQuestion} from './_agent-lp-income.mjs';
import {requestedPortfolioStress} from '../agent-portfolio-stress.mjs';
const textOf=value=>String(value||'').replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g,' ');
export function investmentScope(message,{messages=[]}={}){
 const text=textOf(message),scope={},pair=requestedLPPair(text),id=text.match(/(?:#|\b(?:LP|position)\s+#?)(\d{1,78})\b/i),
   chains=[...new Set((text.match(/\b(?:katana|robinhood|arc|solana)\b/gi)||[]).map(s=>s.toLowerCase()))];
 if(pair)scope.pair=pair;if(id)scope.positionId=id[1];if(chains.length===1)scope.chain=chains[0];
 if(!pair&&!id&&/\b(?:that|this|same|those|it|instead)\b/i.test(text)){
  const prior=(Array.isArray(messages)?messages:[]).filter(row=>row?.role==='user').slice(-4).reverse();
  for(const row of prior){const old=textOf(row.content);if(!/\b(?:LP|pool|liquidity|range|position)\b/i.test(old)&&!requestedLPPair(old))break;
   const previous=investmentScope(old);if(previous.pair||previous.positionId)return {...previous,...scope};}
 }
 return scope;
}
export function investmentQuestion(message,{messages=[]}={}){
 const text=textOf(message),scope=investmentScope(text,{messages});
 if(isLPIncomeQuestion(text))return null;
 if(/\b(?:stress|shock|crash|depeg|what if|market falls?|market drops?)\b/i.test(text)&&/\b(?:portfolio|all my|whole|combined|investments)\b/i.test(text))
  return {focus:'stress',scenarios:requestedPortfolioStress(text)};
 if(/\b(?:past (?:advice|decisions|recommendations)|previous (?:advice|suggestions|decisions)|decision (?:quality|evidence|outcomes))\b/i.test(text)
   ||/\b(?:recommendations?|suggestions?|advice)\b/i.test(text)&&/\b(?:worked|helped|performed|improved|paid off|track record)\b/i.test(text))return {focus:'evaluation',...scope};
 if(/\b(?:protocol (?:watch|updates|sources|news)|incentive changes|campaign changes)\b/i.test(text)
   ||/\b(?:changed|changing|news|ending|expiry|updates|expiring)\b/i.test(text)&&/\b(?:campaigns?|incentives?|protocols?|merkl|morpho)\b/i.test(text))return {focus:'protocols',...scope};
 if(/\b(?:compare|review|analyse|analyze|rebalance|recenter|reset|widen)\b/i.test(text)&&/\b(?:my LP choices|my liquidity choices|(?:all|my|open|current) (?:open )?LPs?|LP options|my range)\b/i.test(text))return {focus:'ranges',...scope};
 if((/\b(?:performance|attribution|actual profit|real profit|true profit|fees? (?:cover|offset)|profit breakdown|making money|worth it)\b/i.test(text)
   ||/\b(?:fees?|rewards?)\b.*\b(?:loss|IL|impermanent|divergence)\b/i.test(text))&&/\b(?:my|our|portfolio|LPs?|positions?|fees?|rewards?|holdings|we)\b/i.test(text))
   return {focus:'performance',...scope};
 return null;
}
