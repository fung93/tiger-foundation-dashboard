# LP ranges for a daily KAT reward goal

Questions such as “What range for Katana vbUSDC/WBTC would earn $10 worth of KAT
daily?” now receive a goal assessment, using the current owned LP without a form.
“Can my BTC/USDC LP earn $10/day?” uses the same calculation. Pair aliases and
reversed names resolve to the actual pool. Several owned positions in that pool
require a specific position so another wallet's capital is never silently used.

The answer leads with feasibility, then gives the current KAT/day and USD/day
estimate, a historical-band comparison, the tighter target-only band if one
exists, and a conditional capital requirement. It ends with a short trade-off
and the current campaign end. A history-based candidate must match the saved or
question-only review cadence. Incomplete relevant history remains incomplete.

The subsequent [flexible-analysis and MCP extension](AGENT-KATANA-MCP.md) adds
keep/reset judgment, recorded native reward pace, costs, price cases and contextual
follow-ups. That extension uses browser cache 160 and an optional MCP enable flag;
the original rollout notes below describe the earlier income-only release.

## Calculation

`api/_agent-lp-income.mjs` reuses `strategy-core.mjs` for range valuation and
campaign reward estimates. Numbers never come from generated model prose.

- Verify fresh LP identity, token order/decimals, raw liquidity, current pool
  quote, KAT dollar quote, staking and active campaign. Raw principal must agree
  with the existing LP Book principal within the same 0.5%/two-cent tolerance
  used by the existing strategy comparison.
- Support the currently verified 100% fee/liquidity-scored Katana campaigns.
  Missing or different scoring is explicit; token weights are not invented.
- Current owner rewards use actual existing liquidity / eligible liquidity.
  Replacing the position removes its currently eligible liquidity before adding
  the proposed position. An out-of-range owner position is not removed from an
  in-range total. Never count the owner's position twice as competition.
- Convert the dollar target to KAT using the fresh KAT/USD quote. Current
  campaign emissions bound every result. A target equal to the entire pool
  budget cannot be reached at finite capital while competitors remain.
- Evaluate outward-rounded historical 7/14/30-day bands at the same capital.
  Prefer the widest qualifying historical band that meets the rate goal.
- The single usable tick interval containing the current tick bounds the rate
  attainable at this capital. If it can meet the goal, a bounded binary search
  finds the widest balanced usable-tick band around the current quote that
  still meets it. This is a target-only comparison, not a global optimum or a
  forecast. Its historical coverage is checked independently.
- Required total LP capital in the preferred historical band follows
  `other liquidity × target / (pool dollar budget − target)` divided by
  liquidity per dollar. Round up to a sufficient cent and verify with the same
  Strategy reward engine. No available cash, allocation approval or funding
  transaction is inferred. Invalid/asymptotic requirements stay unavailable.

Estimates concern **new gross KAT rewards**. Trading fees routed to the DAO,
old claimed/unclaimed/carried rewards, transaction costs and borrowing costs are
excluded. Price exits, competing liquidity and emission/KAT-price changes can
reduce income. A current daily rate does not promise a full day after campaign
expiry; answer validity cannot extend past the campaign end.

## Conversation and authority

The existing `analyzeLPRange` tool accepts optional `dailyRewardTargetUsd`; there
is no seventh tool, paid provider, new secret or extra inference round. The
latest owner message independently establishes the target. A model cannot
invent it, turn it into notification settings or hide it behind a generic
portfolio review. A short “weekly” follow-up may retain the previous explicit
goal and pair as an answer-only assumption. No persistent strategy policy or
Lending setting changes. After-cost/net-profit requests are distinguished from
gross rewards and directed to the existing scenario comparison.

Cloudflare's closed selector remains in use, with its updated argument schema.
Qwen, output limits, shared inference accounting and read-only wallet access
remain unchanged. Structured results retain raw observations and assumptions;
conversation text keeps internal IDs and raw limitation codes out of the reply.

## Rollout and acceptance

Deploy the current existing Worker and dashboard API code. No migration, binding,
dependency, new secret or browser asset change is required; cache stays 159.

After the new Worker is Ready, ask the original question through Agent and
Telegram. Check the selected LP, current capital, KAT quote and campaign against
the live dashboard. The response should name the $10/day goal, explain whether
it is supported, and distinguish the historical band from any target-only band.
Local/native fixtures establish implementation behavior; actual account source
freshness, response compatibility and Free CPU/usage remain live acceptance gates.
