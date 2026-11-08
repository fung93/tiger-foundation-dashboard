/* Field names/types follow the owner's 8 Nov format diagnostic. All addresses,
   votes, shares and lifecycle flags below are hypothetical, not captured values. */
export function katanaGaugeSource(selected='0x'+'8'.repeat(40)){
  const gauges=Array.from({length:40},(_,i)=>({gauge:i===39?selected:'0x'+(1000+i).toString(16).padStart(40,'0'),
    votes:i===39?'35600000000000000000000000':String(i*1000000),sharePercent:i===39?'15.6':'0.1',isAlive:i%3!==0}));
  return {gauges,totalGauges:gauges.length,totalVotingPowerCast:'228205128205128205128205128'};
}
