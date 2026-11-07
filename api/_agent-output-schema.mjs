/* The model selects a reviewed explanation or read-only tool. Financial facts,
   calculations and preference authorization remain independently checked in code. */
export const AGENT_OUTPUT_SCHEMA_VERSION = 'agent-output-v2';
export const AGENT_EXPLANATIONS = Object.freeze({
  apr: 'APR turns recent earnings into a yearly rate. A short earning period can make it look unusually high or low, so use it as a rough guide. After a top-up, I need a fresh earning baseline before the rate is meaningful.',
  lp_holding: 'Holding means keeping the same token amounts you put into the LP and checking what they would be worth at the same time. LP plus earnings includes the position value and its fees or rewards. The difference is your LP advantage; it is a comparison, not another asset to add to your total.',
  fee_routing: 'For staked Sushi LPs on Katana, trading fees go to the DAO. The LP earns its attributed Merkl KAT rewards instead. Each other LP follows its own fee rules.',
  reward_carry: 'When a Katana LP closes, its unclaimed KAT can follow a verified replacement LP in the same wallet. It counts in rewards and net value, but does not inflate the new LP’s APR.',
  health_lltv: 'Health shows your loan’s borrowing buffer. A health of 1 is the liquidation boundary; below 1, the position can be liquidated. It uses the market’s oracle value and LLTV, divided by your debt. Your personal target guides your review; the protocol’s limit stays the same.',
  oracle_ratio: 'For avKAT/KAT, your collateral and debt both move with KAT’s dollar price. The avKAT-to-KAT oracle ratio is what matters for this loan. A ratio sensitivity shows what could happen if that ratio changes while your balances and other inputs stay the same; it is a what-if calculation.',
  coverage: 'Some portfolio values may come from a saved reading. I will show the amounts I can verify and flag a partial total when something is missing. I need a complete current picture before suggesting how much to allocate.',
  readonly: 'I can explain your positions, check lending risk and compare what-if choices. You make the decisions and carry out any wallet transactions.',
  policy: 'Strategy policy saves the preferences used for your reviews and monitoring. To change them, open Strategy policy, preview the changes and confirm. Your notification preferences and the Lending page keep their own controls.',
  greeting: 'Hi. Ask me about your portfolio, loans, LP earnings or KAT holdings. I can also explain how the dashboard works.',
  clarify_market_target: 'Which loan should I check, and what health target would you like to use?',
  clarify_position: 'Which LP position and chain should I review?',
  clarify_request: 'What would you like to check: your portfolio, a loan, an LP position or your KAT holdings?',
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
    tool('analyzeLPRange', object({ pair: text(200), positionId: text(500), reviewFrequencyDays: { type: 'integer', minimum: 1, maximum: 365 }, chain: { type: 'string',
      enum: ['katana', 'robinhood', 'arc', 'solana'] }, owner: text(200) }, [])),
  ],
});
