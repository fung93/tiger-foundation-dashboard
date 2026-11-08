# Flexible LP analysis and Katana MCP

The dashboard and Telegram agent share a server-side connection to
`https://mcp.katana.network/mcp`. This is a remote server: the Worker installs the
client bridge, without a desktop process, extra paid host or wallet connection.

The owner supplied that exact endpoint on 8 November 2026 after the workspace
proxy blocked the linked [Katana setup document](https://docs.katana.network/katana/get-started/setup-mcp-server/#what-can-you-build).
Direct documentation and MCP initialize requests received proxy HTTP 403,
including outside the sandbox. The complete documentation, current real catalog,
provider format/authentication and live connectivity were not verified from this
workspace at the original release. The owner subsequently reports a completed
real Check Katana MCP showing “Connected · response format needs verification.”
That establishes a deployed handshake/catalog/approved-read success, with zero
rows extracted by the old adapter. The owner then supplied its actual field/type
diagnostic: forty gauge rows with `gauge`, `votes`, `sharePercent` and `isAlive`.
This identifies the missing address alias. Actual response values are not captured
here; regression fixtures use hypothetical addresses and voting data.

## What changes in conversation

Ask in normal words, without filling a financial form:

- “Based on current market conditions, suggest a USDC/WBTC range to earn $10 of
  KAT daily.” The answer compares the detected position and campaign against the
  goal, explains the range buffer and makes a conditional keep/reset judgment.
- “Is resetting worth it?” The same LP and owner-stated daily goal carry into
  the follow-up. The answer shows the indicative token sale/purchase, planning
  gas and swap/slippage costs when verified, and conditional cost recovery.
- “What if KAT drops 10%?” or “What if KAT is $0.0033?” A short response shows
  that price-only scenario and its effect on the income goal.
- “My floor is $7/day.” The answer calculates the KAT price needed at the same
  reward pace. It is an income threshold; no analyst/support-level claim is made.
- “What if BTC drops 5%?” The answer values the current LP and the same current
  tokens held outside it, checks range exit, and explains the reward consequence.
- “What about $12/day?” changes the conversation scenario. No settings change.

Related follow-ups retain the most recent owner goal/floor/cadence from bounded
shared conversation history. A different pair/chain or unrelated loan/notification
topic cannot silently inherit the LP goal. An omitted period in a clear LP/KAT
income question is labelled as an assumed daily scenario. Explicit other horizons
are not reinterpreted. The model cannot invent dollar targets, floors or price
cases. A focused follow-up does not repeat the entire earlier range report.

## Calculation and source authority

`api/_agent-lp-advice.mjs` composes deterministic calculations from the existing
Strategy and LP Book engines. The existing six-tool model selector chooses a
focus; there is no extra prose inference or arbitrary generated financial advice.
Price cases and period-assumption flags are server-derived, not new model tools.

- Fresh current KAT reward rates still use eligible liquidity with the owner's
  existing share removed before simulating a replacement. DAO fees and inherited
  rewards do not become new income.
- LP Book APR now exposes its existing native token delta additively. A validated
  6–26-hour KAT delta supports recorded reward pace. It includes any time out of
  range and variable competition, so it is separate from the spot in-range rate.
  There is no new ledger, repricing, claim attribution or APR formula.
- Reset token inventory uses the actual LP liquidity and equal-capital new band
  at the observed quote. It does not call a route or execute a swap. Pool fees use
  the actual tier; 0.5% slippage is an explicit planning allowance. Gas uses the
  existing pinned funding view, reconciles raw gas price/units/native valuation,
  and remains unknown on failure. Paying costs from LP capital reduces the
  replacement rate before computing incremental-reward recovery. Downtime and
  borrowing costs remain outside that conditional estimate.
- The “keep a small gap” judgment is a disclosed comparison heuristic, not an
  invented owner risk limit. Range edges, incomplete relevant history, budget,
  campaign expiry, cost recovery and saved policy take priority. A spot target
  alone never establishes a safe/optimal range or a net-profit winner.
- Approximately 24-hour KAT change uses the existing recorded hourly pool close
  and fresh quote. A one-day LP tick envelope is added to Strategy's existing
  history reading without new scans. Missing/inconsistent history is unavailable.

MCP is **additional indexed evidence**. The transport negotiates Streamable HTTP
with JSON or bounded SSE, including negotiated session/protocol headers. It uses
one fixed endpoint, manual redirects, a 4.5-second total deadline, bounded bodies
and four requests: initialize, initialized notification, tools/list and one read.
The session is request-local; no wallet, transcript, policy, secret or model
prompt is sent to MCP.

The exact approved resource is `get_kat_gauges`, already recorded as read-only in
AGENTS.md on 1 November. Unknown tools, destructive annotations and required
unknown arguments are not executed. An advertised readOnlyHint is not permission
to use another method. Server instructions/descriptions are never model input.
Further tools require reviewed adapters against the real catalog.

An immutable hash receipt and matching pool reference remain in private results.
Only explicit pool identities and named KAT/day fields are parsed. Retrieval time
does not prove source freshness. Indexed votes never imply staking eligibility or
campaign income. Chain/Merkl observations always win when MCP disagrees; an MCP
outage does not fail the first-party readers or erase existing portfolio data.

### Response-format follow-up

The initial adapter accepted an array, `gauges` or `data.gauges` containing plain
JSON. The same zero-row status represented unsupported structure and a genuine
empty result. The follow-up adds bounded known JSON wrappers (`result`, `data`,
`pools`, `gauges`, `rows`, and related collection wrappers), one fenced/encoded
JSON document, explicit `pool_address`/nested pool identity, and address-keyed
collections. Traversal has depth/node/row budgets. Unknown wrapper semantics and
undocumented Markdown figures are diagnosed rather than numerically guessed.
Conflicting identities/duplicate pools and explicit foreign chains remain
excluded. Source timestamps can be inherited only when explicitly supplied.

An upstream logical error is distinct from a transport failure, unknown format
and empty collection. Private diagnostics retain schema keys/types, collection
paths/counts and a reason, with their own 6,000-character ceiling. They never copy
the provider's data values, error prose, model/server instructions or session.
The owner can expand **MCP format details → Copy MCP format** and share that
diagnostic if the actual response is still unsupported. Copy has no provider or
AI side effect; logout clears the details and invalidates late responses.

Before/after tests demonstrate the actual previous adapter returning zero and the
new adapter returning one reference for nested, fenced and address-map fixtures.
Those initial tests did not identify the owner's then-unseen layout. The actual
diagnostic subsequently identified the voting-gauge layout described below.

### Katana voting-gauge identity

The reported rows use `gauge` for the address. In this Katana voter integration,
the gauge address is the vote target used for a pool: see `vkat-core.mjs` and the
existing `gaugeVotes(pool)` calls in `api/strategy.mjs`. Normalize that address as
the pool lookup key and require an exact match to the independently read LP pool
before attaching its reference to an LP analysis. Other gauges are not additional
owner positions. Reject malformed addresses, conflicting pool/gauge identities
and explicitly foreign chains.

The adapter retains all forty reported references, with an eighty-reference cap;
the selected LP can be at the end of the catalog. Only its matching reference is
retained in a private LP answer. Large voting-power and vote-share strings remain
source text with unspecified units. `isAlive` remains a voting lifecycle flag.
None supplies KAT/day, the owner's liquidity share, a new reward price or a reason
to erase an existing funded Merkl campaign. No timestamp is invented when absent.

The exact field-schema regression failed with zero rows before this fix and
passes with forty after it. Native Worker/chat tests use that reported schema
with hypothetical values, including a matching inactive gauge at row forty and a
separately active reward campaign. Direct live access and actual Free CPU remain
account checks; the owner can confirm the new deployed check's positive state.

## Configuration and live acceptance

Deploy current Vercel assets/APIs and the existing Worker. Browser cache is 161.
The voting-gauge identity fix is server-only and retains that browser cache.
Wrangler includes `AGENT_KATANA_MCP_ENABLED=true`; set it to `false` to disable the
extra resource. No new D1 migration, binding, dependency, configured credential or
paid fallback is added. Existing Qwen, budgets, authentication, Telegram linking,
monitoring, accounting and Lending's per-visit reset remain unchanged. Ordinary
scheduled observations still make zero AI/MCP requests.

1. Confirm the new source commit is **Ready** in Cloudflare. If manually managing
   variables, the MCP enable flag is a regular variable, not a secret.
2. Open **Agent → Advanced analysis and journal → Connection & usage → Check
   Katana MCP**. This private action checks the actual provider and records only
   bounded metadata. “Check connection” itself makes no provider request.
3. A connected catalog alone is distinct from a successful approved read. A
   successful read with zero usable parsed references distinguishes empty data,
   a logical upstream failure and unknown format. If verification is still needed,
   share **MCP format details → Copy MCP format**. Only schema metadata is copied.
   An error category/date stays visible; no raw errors or session headers are exposed.
4. Ask the original question through dashboard and Telegram, then a reset and
   price-case follow-up. Cross-check the selected LP, KAT quote, campaign and
   recorded native reward interval against the current dashboard. Inspect the
   private result's sources/assumptions when assessing a proposed change.
5. Verify actual Worker latency/Free CPU/usage and the real MCP schema. Local
   fixture/workerd tests cannot establish those account-specific facts.

Source, operator acceptance and validation evidence are tracked in
`TIGER_AGENT_PROGRESS.md`. No example prices, payout figures, historical-loss
claims or analyst levels from the owner's illustrative answer are saved as facts.
