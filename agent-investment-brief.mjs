/* One human-readable decision format shared by private dashboard and Telegram. */
export function renderInvestmentBrief(brief) {
  if(!brief||!['suggestion','evidence','tradeOff','recheck'].every(key=>typeof brief[key]==='string'&&brief[key].trim()&&brief[key].length<=1000))
    return 'I need a verified reading before preparing this review.';
  return ['Suggestion: '+brief.suggestion,'Why: '+brief.evidence,'Trade-off: '+brief.tradeOff,'Recheck when: '+brief.recheck].join('\n');
}
