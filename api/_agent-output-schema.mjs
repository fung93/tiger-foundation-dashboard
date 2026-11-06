/* The model selects a reviewed explanation or read-only tool. Financial facts,
   calculations and preference authorization remain independently checked in code. */
export const AGENT_OUTPUT_SCHEMA_VERSION = 'agent-output-v1';
export const AGENT_EXPLANATIONS = Object.freeze({
  apr: 'APR is an annualized observation of recent earnings. It is not a guaranteed return or forecast. A short observation period or a missing post-deposit baseline can make the rate unstable or unavailable.',
  lp_holding: 'Holding means retaining the verified token amounts placed into the LP, valued at the same comparison time. LP plus earnings includes the position value and its attributed fees or rewards. The difference is the LP advantage; it is not added to portfolio wealth again.',
  fee_routing: 'Trading fees from staked Sushi LPs on Katana go to the DAO. The position earns its attributed Merkl KAT instead. Other LPs follow their actual fee-routing rules.',
  reward_carry: 'Unclaimed KAT may follow a verified replacement LP in the same wallet. It remains part of rewards and net wealth, but inherited rewards are excluded from the replacement position’s APR.',
  health_lltv: 'Health equals oracle collateral value multiplied by market LLTV, divided by debt. Health exactly one is the liquidation boundary and remains healthy; strictly below it permits liquidation. A personal target does not change the protocol’s LLTV.',
  oracle_ratio: 'For avKAT/KAT, the relevant lending variable is the avKAT-to-KAT oracle ratio. A common KAT dollar-price move on both sides does not create a single KAT dollar liquidation price. Ratio sensitivity holds debt, collateral and the other oracle inputs fixed; it is not a forecast.',
  coverage: 'A saved portfolio snapshot is historical. When current coverage is incomplete, only verified subtotals are available and portfolio-wide allocation sizing is blocked. A failed read is unavailable, not a zero balance.',
  readonly: 'I can review verified readings and run read-only calculations. I cannot sign, trade, repay, vote or move funds. You make the investment decisions.',
  policy: 'The persistent agent strategy policy is separate from alert preferences and the Lending page’s per-visit settings. Policy changes require a preview and your explicit confirmation in the policy editor.',
  greeting: 'Hello. I can review your portfolio coverage, lending risk, LP positions and KAT exposure, or explain the dashboard’s accounting.',
  clarify_market_target: 'Which lending market and target health should I use? You can also enter them in the verified lending tool.',
  clarify_position: 'Which LP position and chain should I review?',
  clarify_request: 'Please specify the position or topic you want to review. I can show verified portfolio coverage, lending risk, LP positions or KAT exposure.',
});

const preferenceKeys = ['healthThreshold', 'ltvThreshold', 'alertsEnabled', 'dailyEnabled', 'dailyTime', 'pausedUntil'];
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const tool = (name, args) => object({ tool: object({ name: { type: 'string', enum: [name] }, args }) });
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Cloudflare's json_schema mode takes this schema directly. Legacy reply and
// calculation forms remain parser compatibility paths, never advertised output.
export const AGENT_OUTPUT_SCHEMA = freeze({
  oneOf: [
    object({
      explanationId: { type: 'string', enum: Object.keys(AGENT_EXPLANATIONS) },
      preferenceChanges: { type: 'array', minItems: 0, maxItems: preferenceKeys.length,
        items: object({ key: { type: 'string', enum: preferenceKeys }, value: text(200),
          evidence: { type: 'string', minLength: 3, maxLength: 4000 } }) },
    }),
    tool('getPortfolioSnapshot', object({})),
    tool('getLendingRisk', object({ market: text(200) }, [])),
    tool('calculateTargetHealth', object({ market: text(200),
      targetHealth: { type: 'number', minimum: 1, maximum: 100 } })),
    tool('getLPPosition', object({ positionId: text(500), chain: { type: 'string',
      enum: ['katana', 'robinhood', 'arc', 'solana'] }, owner: text(200) }, ['positionId'])),
    tool('getKATExposure', object({})),
  ],
});
