# Portfolio memory and shared decisions

The agent records the configured portfolio without another investment form.
Dashboard and Telegram share private observations and calculated lessons. The
model, financial ledgers, wallet permissions and Lending page defaults are unchanged.

## What is studied

| Area | Evidence and useful lesson |
| --- | --- |
| Holdings | Dated native/ERC20/SOL/USDC readings from the existing configured-wallet adapters; token quantity changes are recorded without calling transfers or deposits profit |
| Open LPs | Canonical chain/contract/NFT/wallet identity, principal, LP Book earnings/net/unclaimed, original LP-versus-holding comparison and capital changes |
| Closed LPs | Up to 100 available complete LP Book closes, preserving original close/claim prices and later accounting versions; grouped outcomes never become current wealth or a win rate |
| Borrowing | Independently dated loan health, LTV and debt; three falling daily health observations increase review priority, while repayment amounts still require the shared integer tool and owner targets |
| KAT trading | Existing reconciled trade-book realised/unrealised results, with its actual tracking scope; incomplete trade histories do not produce totals |
| Locks and votes | Known vKAT/veFABLES locks and verified historical vote rewards, kept separate from liquid cash and wallet wealth |
| LP decisions | Original proposed bands and later, sufficiently covered price-containment outcomes; repeated checks/wallets on the same pool/day are not independent wins |

This is bounded evidence-based rule adaptation. It does not retrain model weights,
rewrite owner policy, invent historical transactions, sign or move funds. It cannot
guarantee higher returns or establish which unexecuted strategy would have earned
more. Incomplete external cash-flow/valuation coverage still blocks portfolio
return and allocation sizing. Unsupported tokens/protocols remain uncovered rather
than being treated as zero.

## How decisions change

The existing pool learner requires three qualified daily cohorts, at least 36
later samples, six covered hours per cohort and at least 80% sampling coverage.
If original 14-day shadow bands miss more than 20% of covered sampled prices,
subsequent automatic **and on-demand** comparisons consider the 30-day lookback.
Learning stays with the pool across replacement LPs and remains policy-versioned.
Actual owner rejection takes precedence; turning off adaptation does not revoke it.

Whole-portfolio observations identify changing borrowing buffers, LP results
relative to holding, capital changes, actual closed outcomes and locked liquidity.
These lessons enter ordinary portfolio/position answers and advanced recurring
reviews. Older memory is labelled with its source time. General memory is separate
from a later observation of a particular journal idea: old facts cannot be recorded
again as a new successful decision outcome.

## Robinhood and Arc fee-paying LPs

The existing `agent-pool` first-party view verifies factory, token identity/decimals,
price, liquidity, fee growth and source block. A uniquely detected owned V3 pool
can now receive range analysis on Robinhood or Arc, including reversed WETH/ETH
pair wording. It never borrows Katana history or KAT emissions.

On-demand reads use the detected pool and owner, not model-proposed addresses.
Current metadata is fetched afresh; stored observations cannot refresh a quote.
Covered 7/14/30-day sampled-price bands stay distinct from swap-log extrema. An
early covered one-day band is explicitly provisional and at least as wide as the
current range. Before enough history exists, the answer still explains the actual
current range and available risk facts without inventing a new numeric band.

A sufficiently covered approximately 24-hour fee-growth window supports a
conditional owner-liquidity-share scenario. Modulo-256 arithmetic and token units
are preserved. Future volume and competing liquidity are assumed stable in that
case, not predicted. Existing owner liquidity is removed before simulating a
replacement; costs reduce replacement capital. Reset inventory, actual pool fee,
pinned planning gas and an explicit 0.5% slippage allowance remain estimates rather
than live route quotes. Unknown costs/rates stay unknown. Base-price follow-ups
compare LP principal with holding the same current tokens, excluding fees/costs.

Katana MCP remains an additional Katana reference. Robinhood/Arc analysis never
calls it. Primary chain/Merkl accounting and the DAO fee/rollover rules are unchanged.

## Where to see it

Open **Agent → Automatic portfolio watch → What the agent is learning**. The summary
is collapsed by default, with dates and only a few useful observations. Full private
evidence stays separate. Logout clears the display and invalidates late responses;
nothing is put in browser storage.

Ask in normal words on either channel:

- “What have you learned from my portfolio?”
- “Suggest a suitable range for my USDG/ETH LP.”
- “Should I keep or reset that range?”
- “What if ETH drops 10%?”
- “Give me my portfolio summary.”

Reading the learning summary consumes no AI inference. Other questions retain the
one-accounted-inference selector and six deterministic tools. Memory cannot enable
a forbidden analysis, invent a target or change notification preferences.

## Storage, cadence and free limits

The existing `agent_state` stores `learning:portfolio` and durable daily records.
The first observation is immutable; later observations never retrofit it. The
working view keeps at most 31 daily cohorts and 192 KiB of observation payload,
dropping whole old cohorts from the working view only. Durable daily originals
and latest records have no cache expiry. Collection is at most every 30 minutes;
loading a question never creates a learned observation. Source-identical retries
cannot become new evidence. Existing original proposal/journal records are retained.

The five-minute Cron still runs independent risk checks and dispatches the existing
Workflow. Full portfolio scans use a computed multiple of five minutes, typically
10–15 minutes for a small portfolio. The application plan accounts for the documented
3,000 Free Workflow steps/day, skipped prepare steps, five manual checks, eight
full reviews, bounded recovery and the existing D1 write target. Larger portfolios
or long claim histories require a slower interval. The page displays the actual
interval. A due enabled Telegram daily summary bypasses the scan wait, so its
chosen MYT delivery time remains eligible on the next Cron tick.

This planning estimate is not the Cloudflare account meter and cannot count other
applications. Actual CPU, D1 rows/storage, Workflow steps and provider quotas remain
live acceptance checks. No paid fallback or automatic plan upgrade is enabled.

## Configuration and rollout

Deploy the existing Worker and dashboard from the same release. No new secret,
database, binding, migration, dependency or wallet permission is needed. The added
regular variable `AGENT_LEARNING_ENABLED=true` enables the new portfolio memory
and shared learned context. Set it to `false` to stop that collection/adaptation
without deleting evidence; existing risk monitoring and accounting remain active.
The original automatic pool learner is part of the existing watch feature and
retains its separate operational tracking control.

Browser cache is 162. Qwen and all existing AI/D1/Workflow/Telegram configuration
remain in place. Qwen's previously documented planned retirement on 20 November
2026 still requires a separate real-account model review; this work changes no model.

After deployment, confirm the current interval and two scheduled scan successes,
open the learning summary, then ask about USDG/ETH on dashboard and Telegram. Verify
identity, range, source date and fee scope against the LP Book. Early history should
show collection/provisional status honestly. Let genuine later days accumulate
before expecting a trend or qualified adaptation. Check real Cloudflare CPU,
Workflow steps, D1 usage and the existing scheduled Telegram delivery.

Local fixtures, native workerd/local D1 and browser tests establish implementation
behavior, not real provider/account connectivity or investment performance.
