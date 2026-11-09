/* Shared concise rendering. No browser storage, credentials or model prose. */
import { agentReadingTime } from './agent-language.mjs';
export function renderPortfolioLearning(summary,{compact=false}={}) {
  if(summary?.status==='disabled')return 'Portfolio learning is switched off.';
  if(!summary?.checkedAt)return 'I’m starting your portfolio memory. The next successful automatic checks will record your positions and outcomes.';
  const lines=[summary.retained?'From my recorded portfolio observations:':'What I have learned from your portfolio:'];
  for(const row of (summary.lessons||[]).slice(0,compact?2:5))lines.push('• '+row.message+' '+row.suggestion);
  if(!summary.lessons?.length)lines.push('I have a baseline; more later readings are needed to identify a pattern.');
  lines.push('Recorded '+(summary.coveredDays||1)+' day'+(summary.coveredDays===1?'':'s')+' · '+agentReadingTime(summary.checkedAt)+'.');
  const c=summary.coverage;
  if(c&&(!c.lpComplete||!c.lendingComplete||c.walletChains.length<4||c.kat===false||c.closedOmitted||c.omittedBalances))
    lines.push('Some sources remain incomplete; these lessons cover the verified readings.');
  return lines.join('\n');
}
