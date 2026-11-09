# Investment decision tools

The Agent page has an **Investment review** card. It reads current positions;
there are no new investment forms. The same questions work in the linked
private Telegram chat:

| Review | Example question | What it establishes |
| --- | --- | --- |
| Performance | Show my actual profit breakdown | LP capital P&L, claims at their recorded prices, current claimable rewards and identified gas evidence |
| LP choices | Compare my LP choices | Equal starting capital across keep, recenter, wider and available historical bands; five explicit price/income paths |
| Stress test | Stress test my whole portfolio if BTC drops 20% and KAT drops 30% | A combined fixed-balance asset, LP and debt sensitivity |
| Decision evidence | Review my decision evidence | Later principal marks against the original prospective choices and token holding benchmark |
| Protocol watch | Check protocol updates and incentive changes | Configured official releases, current campaign deadlines and source availability |

Answers lead with **Suggestion / Why / Trade-off / Recheck when**. The dashboard
keeps tables and source links under **Calculations and evidence**. Reviews use
deterministic calculations and spend no model inference allowance. The existing
message limits still apply. Ordinary conversation continues using the existing
free Workers AI configuration, with no paid fallback.

## What runs automatically

The existing automatic Workflow reads wallets, LPs, loans and recorded outcomes
at its Free resource-aware cadence. The independent risk Cron remains every five
minutes. Full scans can be less frequent; Agent shows the actual intended time.

When verified LP geometry is available, a private daily original records the
current capital, bands and assumptions before future observations arrive. A pool
without sufficient price history can still record the current-band baseline;
this does not turn a short history into a numeric historical recommendation.
At most one later evaluation per position/policy/six-hour window is retained.
Existing qualified containment learning continues separately. Neither process
trains model weights, changes the owner's policy or executes a transaction.

Official release feeds are checked at most once per six hours; unavailable feeds
retry after 30 minutes. Fresh campaign deadlines are checked with the current
primary incentive reading. Campaign date changes and cumulative pool-emission
changes of at least 5% are also checked against a saved baseline; an unread rate
cannot become zero. Pool emissions are separate from the owner's reward share.
Incentive notices require a freshly observed owned Katana LP in that pool.
New source/campaign notices enter the existing
acknowledged Telegram outbox when alerts are enabled. Explicit summaries and
existing LP/risk delivery retain priority. Source expiry, changed recipient,
paused tracking, changed policy or disabled research cancels an invalid notice.
The bounded queue leaves omitted current conditions eligible for a later retry.

## Accounting and coverage

The LP Book's existing numbers and accounting are preserved. New attribution
separates deposited/withdrawn principal, principal P&L, original claim-date dollar
values, unclaimed rewards at the current quote, and the existing book result at
current token prices. Claimed rewards must reconcile in native token amounts.
Incomplete original ownership/capital/claim-price coverage stays unavailable.

The receipt reader samples up to six known event blocks and eight identified LP
transactions. It verifies the NFT event, transaction/block hashes, success and
paying wallet, then uses actual gas usage and a historical ETH-price proxy. A
transaction touching several NFTs is shared rather than charged to every LP.
The sample cannot prove all lifetime approvals, swaps, shared operations or
financing costs. It always reports incomplete cost coverage. Historical WETH or
vbETH quotes are proxies and inherit the underlying quote-token assumptions.

**Fully net performance and complete portfolio cash-flow-adjusted profit remain
unavailable without complete evidence.** The pure portfolio flow calculator
distinguishes owner transfers and protocol movements from external flows, but
there is no new exhaustive wallet transfer-history collector in this release.
No missing flow, price, interest or cost becomes zero. A change in saved portfolio
wealth is not automatically investment profit or a time-weighted return.

## LP comparison assumptions

The fixed-chain reader pins bitmap and initialized-tick queries to the verified
pool block: three bitmap words and at most 96 initialized ticks. Dense, malformed
or uncovered regions cannot become invented liquidity. No model or MCP response
chooses the RPC destination. Katana, Robinhood and Arc verified V3 pools use the
existing identity checks; unsupported position types remain uncovered.

Each comparison considers up to six bands and five unweighted paths over the
saved horizon (seven days when unset): flat, −15%, +15%, a down/up round trip,
and lower income. In the income case, trading volume/rewards halve and KAT price
falls 20%. These are stated assumptions, not probabilities or forecasts.

Reset gas, the pool fee and a 0.5% slippage case reduce replacement capital before
liquidity and earnings are calculated. This is a planning estimate, not a live
swap route. Fees follow the verified tick curve where covered. KAT projections
use primary Merkl rules, eligible liquidity and campaign dates, with future
eligible competition explicitly held at its observed value. Total pool liquidity
does not establish Merkl eligibility. Staked Sushi trading fees remain DAO fees.
Unknown staking or campaign evidence cannot turn into zero rewards or owner fees.

Holding marks the same token amounts held at the decision's starting observation,
not necessarily the original mint amounts. Hypothetical exit/claim gas, future
interest, execution downtime and alternative realized fees are not established.
Carried/accrued rewards are prior wealth, excluded from new projected income.
The efficient choices have different trade-offs; no arbitrary weighted winner or
guaranteed yield is reported. A chat review covers up to two priority LPs and
states that coverage; the background watcher retains its existing broader roster.

## Stress and decision evidence

Stress values economic assets once, reprices both LP legs, subtracts debt once
and keeps locked holdings separate from spendable wallet cash. A KAT dollar-price
fall cancels on both sides of an avKAT/KAT loan; an independent oracle-ratio shock
can still cross its actual LLTV boundary. Repayment targets use existing exact
raw-unit lending math and require the saved policy. Funds on another chain or in
another wallet are not automatically available for repayment.

Defaults include KAT −30%, BTC −20%/ETH −25%, USDG −5%, and a combined case with
avKAT/KAT oracle ratio −10%. Explicit signed percentage cases and a phrase such
as `avKAT/KAT oracle ratio drops 5%` are supported. Unpriced/stale/uncovered
holdings produce a scoped subtotal rather than complete stressed NAV. Current
accrued debt is included; future borrowing interest is not forecast.

Later decision marks require fresh matching owner/chain/pool/token identity and
a genuinely later quote. A capital or policy change ends comparability. Original
recommendations are immutable; alternative principal marks do not become actual
executed returns. Alternative fees and financing stay unknown, and no net winner
or investment win rate is invented. Original data and private reports are stored
in D1; browser storage contains no private review history.

## Official-source scope

Three fixed official GitHub release feeds cover Morpho Blue, Sushi V3 periphery
and Merkl contracts. Immutable evidence retains source URL, publication time,
content hash and first retrieval time. The first check baselines existing
releases without alerting on old news. Failed checks retain older evidence with
its original time. A repository release does not prove an upgrade of a held
deployment. This does not establish broad announcements, security incidents,
governance proposals, emissions decisions or general web coverage.

Katana MCP remains the existing reviewed, fixed read-only adapter. Its indexed
gauge references are additional evidence, never pool reward rates or permission
to invoke a newly advertised method. Wallet access remains read-only.

## Configuration and release verification

Add the regular Worker variable **`AGENT_INVESTMENT_ENABLED=true`** (included in
Wrangler). No new secret, database migration, dependency, Cron Trigger, signing
permission or paid service is needed. Existing authentication, policy, research,
strategy, automation, pause and recipient controls remain effective. The Lending
page's per-visit reset remains separate from persistent agent policy. The shell
cache is version 164 (the investment tools first shipped with 163).

If the review card is missing, verify the Vercel **Production source commit**.
On 9 November the owner reported `38ac666`, immediately before the `1a03883`
investment release. A fresh main push with cache 164 requests another automatic
build; it does not establish that Vercel accepted or published it. If necessary,
create a Vercel deployment from Git reference `main` using the Production
environment. A Ready Cloudflare Worker is a separate backend deployment and does
not publish `agent.html`. Rebuilding an old Vercel entry reuses its old source;
check the source commit rather than relying on a new deployment timestamp. If no
new build appears, inspect the project's Git connection/production branch; if it
fails, use its actual error to diagnose the blocker.

Local acceptance includes portable regression suites, real local workerd/D1 chat
and Workflow checks, both dashboard themes at 360/1366 px, and Wrangler dry run.
Fixtures never send real Telegram messages or contact production providers.

On 9 November 2026 (MYT), this workspace's proxy returned **CONNECT 403** for the
dashboard, Worker and all three release feeds. No local Cloudflare deployment
credentials are configured. Production deployment/version, receipt and tick RPC
latency, actual official-feed availability, real Telegram acknowledgements and
the account's CPU/storage/AI/Workflow quotas still require live verification.
Source failure must show partial/unavailable evidence rather than successful
monitoring. Local query counts and modeled steps are not account billing or CPU
measurements. No live success or investment profitability is claimed here.

Main changed files: `agent-performance.mjs`, `agent-liquidity.mjs`,
`agent-lp-frontier.mjs`, `agent-portfolio-stress.mjs`, `agent-investment-brief.mjs`;
the new private `_agent-cost-reader`, `_agent-liquidity-reader`,
`_agent-investment-context`, `_agent-investment`, `_agent-decision-evaluation` and
`_agent-protocol-watch` modules; LP Book/observation/range/context/service/automatic
integration; `agent.html`, `agent.js`, `sw.js`, Wrangler, project checks, eight
focused portable suites and optional runtime/browser acceptance checks.
