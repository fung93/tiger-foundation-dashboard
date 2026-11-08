# Automatic portfolio and LP watch

The ordinary Agent view needs no financial form. It reads the dashboard's
configured wallets, existing LP Book, Morpho markets, KAT rewards and known
vKAT/veFABLES positions, then shows a short suggestion. It uses deterministic
code and the existing Cloudflare Free Worker, Workflow, D1 and Telegram bot.
Automatic observations make **zero Workers AI calls**. Existing chat and advanced
reviews keep the Qwen model and shared inference limits.

## What happens automatically

1. The existing five-minute Cron dispatches `mode: observe` to the existing
   `PORTFOLIO_REVIEWS` / `PortfolioReviewWorkflow`. It adds no D1 query to the
   risk Cron. Each read/calculation/persistence/delivery group runs in its own
   bounded Workflow step, with durable checkpoints and short fenced writes.
2. Native/configured ERC20 balances are read for both tracked EVM wallets on
   Katana, Robinhood and Arc. Solana reads its configured wallet and USDC account.
   Fixed RPCs/ABI methods are read-only. Token decimals, account ownership, pool
   factory and source blocks are checked. avKAT uses `convertToAssets`, never 1:1.
   Broader token/protocol discovery still follows the dashboard's existing
   collectors; the agent does not claim exhaustive chain coverage.
3. Full chain/wallet/contract/NFT identities, daily balance/LP observations,
   liquidity/staking/claim changes and original timestamps are stored privately.
   Known vKAT and veFABLES observations are separate from wallet/LP wealth to
   prevent double counting. Missing amounts stay unavailable; refresh failures
   retain dated last-good observations. SOL and unknown-token USD prices can
   remain unpriced. The stablecoin $1 anchor remains explicit in source details.
4. Pool prices, range edges, sampled volatility, liquidity drops, incentive drops
   and campaign endings are monitored. Out-of-range warnings are immediate;
   ordinary warnings need two distinct source readings. Unchanged alerts have
   a one-hour cooldown. The default edge threshold is 10% of logarithmic band
   width; movement/realized volatility 3%, liquidity drop 30%, reward drop 25%.
   These are observational triggers, not owner investment limits. Sampling can
   miss moves between checks and is not continuous time in range.
5. Current LP inputs, same-wallet cash and estimated gas feed the existing
   cost-aware four-option engine. Default comparison: seven-day horizon,
   fourteen-day historical band, bounded price/rate/slippage cases, **before
   borrowing costs**. Confirmed policy takes precedence. The comparison is a
   conditional planning aid, not an optimal-profit or guaranteed-safe range.
   Insufficient history means waiting or a clearly provisional band at least as
   wide as the current range. A live risk warning never silently narrows it.
   Failed cash/policy checks remove the suggested numeric change.
6. Original proposals and paper comparisons are retained before later prices
   arrive. Subsequent distinct samples assess the original boundaries. At least
   twelve later samples, six observed hours and 80% sampling coverage qualify
   an outcome. One independent pool/day cohort is retained, over twelve days
   and four policy versions. Three qualified cohorts and 36 samples can justify
   comparing the wider 30-day band when earlier 14-day bands missed more than
   20% of sampled prices. Evidence follows the same pool across replacement LPs.
   Original 14-day shadow bands continue to be assessed so old wider suggestions
   do not permanently lock in that preference. This is measured rule adaptation,
   not model retraining or a future success/return estimate. Rejected/invalidated
   journal ideas suppress that position's suggestions under the same policy;
   independent live risk facts remain visible.
7. Complete ownership enumeration can mark a position no longer owned. This
   does not manufacture a close or realised return. Actual closed performance
   comes from the LP Book at its historical close/claim prices. Native claim
   records keep event times; their `usd_now` quote is explicitly an observation
   price, not a claim-time price. Katana DAO fees and reward rollover stay unchanged.

## Default dashboard and Telegram behavior

Open **Agent → Automatic portfolio watch**. The first brief gives the current
LP value/net/unclaimed summary, highest-priority lending issue, a short update
for each tracked LP, ranges to compare when evidence permits, and the next check.
Higher-risk LPs come first without hiding the other positions. Large portfolios
that exceed the brief's length budget show an explicit shown/total count.
Full position details, holdings, calculations and learning evidence are
collapsed below it. Historical LP
performance is read-only. Existing manual tools/research/comparisons/journal
are retained under **Advanced analysis and journal**.

**Check now** reuses a reading under 90 seconds old or queues a fresh Workflow;
data refreshes are limited to three/minute and five/MYT day. Automatic checks
continue independently. **Pause tracking** stops observations and their delivery
without changing persistent strategy policy or the Lending page's per-visit reset.
The existing temporary global pause is also respected.

Telegram alerts follow **Alerts & daily summary**. Daily Telegram updates require
the existing Daily summary preference; ordinary checks do not send a message
every five minutes. A manual background check can send its requested update to
the originally linked owner. A recently successful automatic runner owns the
daily brief; the original monitor is its fallback when paused or overdue. An
already recorded daily brief prevents a second automatic copy that day.
Existing lending/risk outbox delivery has priority.
Every part rechecks current preferences, policy, pause, linked human, active
condition and quote expiry. Acknowledged parts are checkpointed. Unknown external
Telegram outcomes can still be retried: exactly-once external delivery cannot be
guaranteed after a network acknowledgement is lost.

## Free limits and storage

At most thirty current LPs receive individual automatic monitoring. Coverage
truncation is explicit and cannot prove another position closed. Recent pool
data is bounded to 96 samples and 31 days of hourly buckets. Daily records and
original journal/proposal/claim/realised evidence are durable, not cache.
Temporary Workflow contexts expire logically after 30 minutes and are deleted
on success; bounded cleanup removes expired failed-job payloads.

The write estimate `(100 + 28 × positions) × 288` targets 45,000 daily D1 writes
for this path, leaving headroom for the existing dashboard agent. Up to two LPs
keep five-minute observations; larger portfolios use a slower multiple of five
minutes. This is an application estimate, not a Cloudflare account billing meter.
Account-wide CPU, storage and usage still need checking in Cloudflare. No paid
fallback or plan upgrade is enabled. Exhaustion must stay visible; do not claim
that local query-count checks establish production CPU/quota compliance.

## Configuration and rollout

No new secret, binding, database, migration, dependency, paid service or wallet
permission is needed. Keep existing D1 migrations 0001–0003, `AI`,
`PORTFOLIO_REVIEWS`, owner/gateway credentials and Telegram pairing. Deploy the
current Vercel assets/API **and** current existing Worker together. The new read
views reuse `/api/strategy`, avoiding an extra Vercel function.

`AGENT_AUTOMATION_ENABLED` defaults to `true`; set `false` as a feature rollback.
Keep `AGENT_STRATEGY_ENABLED=true` for cost-aware cases. Keep the existing
`CRON_SECRET` (at least 24 characters) and `*/5 * * * *` trigger. A configured
Workflow or successful manual check alone does not prove Cron is running.
The automatic card shows the last scheduled attempt separately from the last
manual/successful reading. Never print any secret or include it in a shared URL.

Real-account acceptance after rollout:

1. Sign in, open Automatic portfolio watch and select Check now. Confirm current
   LP identity, block/time, token units and costs against the original dashboard.
2. Wait for at least two scheduled cycles. Confirm **last scheduled attempt**
   advances without an open dashboard; inspect the existing Workflow for the
   `observe-*` instance and its successful bounded steps.
3. Inspect Cloudflare Free CPU/D1 rows read/written/storage/Workflow metrics.
   Reduce cadence or pause if account headroom is insufficient; never enable paid
   fallback. Compare displayed source status with actual RPC availability.
4. Confirm the existing linked Telegram human receives a requested update and
   the enabled daily summary. Verify a genuine material warning, recovery and
   pause/unlink behavior without creating a risky portfolio position for testing.
5. Check historical LP figures against the original LP Book, then let genuine
   later source data accumulate. First-day evidence must not imply a learned
   strategy or realised return for an unexecuted alternative.

Only the actual account establishes deployment, real source freshness, scheduler,
CPU/quota and delivery success. Closed fixture tests and a Worker dry run do not.
