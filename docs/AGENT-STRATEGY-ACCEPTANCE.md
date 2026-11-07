# Verify research and strategy review

Dashboard questions, private Telegram linking and one scheduled Telegram message have
been confirmed by the owner. This next phase checks a complete strategy review against
the real account. Local tests are separate evidence; they do not confirm your preferences
or replace a live check.

Open [Agent](https://tiger-foundation-dashboard.vercel.app/agent.html) and sign in.

## 1. Confirm your strategy policy

Expand **Strategy policy**. Enter only preferences you have actually chosen:

| Field | What to enter |
| --- | --- |
| Evaluation horizon | The number of days you want a comparison to cover |
| Minimum liquid reserve | Cash you want to retain, in USD; leave blank if undecided |
| Review frequency | How often you want to review a saved strategy, in days |
| Eligible assets/protocols | Your chosen lists, separated by commas |
| Market limits | Your chosen minimum health and/or maximum LTV for each market |
| LP review triggers | The range, price or reward changes you want monitored |
| Allowed analysis types | The analyses you want included |

Blank means unspecified. Zero is an explicit value, such as no minimum cash reserve.
Market limits still respect each market's liquidation boundary. These fields are your
preferences, not values inferred from a notification threshold or an earlier question.

Choose **Preview changes**, review the before/after fields, then **Confirm policy**.
The card should show **Confirmed policy · version …**. Refresh Agent and check that the
same version remains. A later edit creates a new version.

The Lending page retains its separate per-visit 70% / 35% / 35% opening settings. Your
agent policy does not replace those page controls or change the market's on-chain LLTV.

## 2. Check a cited research report

Under **Research a protocol**, choose **Morpho** and ask:

> Explain Morpho Blue's isolated lending markets using the configured official documentation.

Choose **Research configured sources**. The main answer should explain a separate lending
pool and why collateral in one market does not automatically protect another loan.
Open **Sources & details** to check the official IMorpho.sol quotation, source link,
retrieval time and saved preference version. Check that the quotation exists at the
source. Publication time may be unavailable; retrieval time does not establish when
a document was published. The introduction alone cannot support the detailed explanation.

Research currently covers configured official background documents. A question about
the latest governance proposal, announcement or incentive change must disclose missing
event coverage. Morpho and Sushi have configured repository documents; Merkl also has
an unavailable documentation entry, and Katana documentation remains disabled until
its access is verified. General web search is not configured.

## 3. Check a conditional comparison

First, try the range-specific chat path in the dashboard and Telegram:

> What is a suitable LP range for BTC/USDC?

The reply should show the actual Katana pair/fee tier, complete 7/14/30-day historical
ranges, a comparison with your current band when available, and a conditional starting
choice. It should explain what changes in concentration and price-move room. It must
not answer with position value alone. If several pools match or history is unavailable,
it should explain that issue instead of inventing prices. If asked about review cadence,
reply “weekly”; the next answer should use that question-only assumption without saving
policy or repeating the same question. This preliminary shortlist is not a net-profit
winner or a replacement for the cost-aware comparison below.

For the first comparison, choose **Lending** under **Compare strategies**. Select the
market, your target health and horizon. Supply the cash, gas and interest assumptions
you actually want to test. Leave unknown assumptions blank and review the resulting
limitations; an omitted future rate must not silently become zero.

For avKAT/KAT, **Oracle ratio moves · %** changes the collateral-to-debt oracle ratio.
It is not a KAT dollar-price forecast. The result should compare maintaining debt,
reducing debt and adding collateral using the shared deterministic lending calculations.
Check the observation time and cash required. Open **Assumptions and checks** for the
saved preference version and assumptions. To reuse research evidence, select **Use
sources from your latest research** under **Costs and thesis**.

Current incomplete portfolio coverage can keep the comparison marked **Some details
need checking**, even when a
verified individual market is calculable. That status blocks portfolio-wide allocation
claims. A result needing more information should explain the missing input. The comparison is a
conditional paper calculation; it does not perform a repayment or another transaction.

LP and KAT comparisons use the same review flow, with their own explicit assumptions.
LP scenarios retain the same starting capital, exclude carried KAT from new earnings
and stop campaign rewards at their recorded end. Unverified earnings remain unknown.

## 4. Check the decision journal

Choose **Review decisions**. The saved research/comparison brief should appear.
Open the comparison, review its original brief, choose a decision state and enter your
rationale. **Deferred** is available for an initial review; **Accepted for review**
also performs no transaction.

Choose **Record decision**, refresh, and confirm the entry and its separate events
remain. In Telegram, send `/journal` and check that the same brief is listed. A new
policy makes an older brief visibly superseded while retaining its original date and
calculations. Outcome notes remain owner reports; paper observations do not establish
realized returns or a win rate.

## 5. Verify the free model replacement separately

The [official Qwen catalog](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/qwen3-30b-a3b-fp8.json) was rechecked on **7 November 2026** and now lists planned
retirement on **20 November 2026**. Qwen remains selected while it is working.
GLM 4.7 Flash is the explicit next candidate. Its [documented request format](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/glm-4.7-flash.json), reasoning
switch and usage rates are validated locally, but access and valid responses on your
Workers Free account still need a live check.

When testing GLM on the real Worker, set `AGENT_MODEL` to
`@cf/zai-org/glm-4.7-flash` and deploy. Ask one short dashboard question, then one
Telegram question. In **Connection & usage → Check connection**, confirm the model
name, a fresh successful inference and **accepted · valid_selector**. The GLM profile
ends in `2026-11-07:v4`. Its separate completion cap remains 800 tokens; reasoning is
disabled with the model's documented option. The default Qwen request is unchanged.

If that live check fails, use the safe error metadata to investigate; while Qwen is
still available, its exact identifier can be restored explicitly. No automatic model
switch or paid fallback is enabled. Both channels share the same application limits.
No new secret or database migration is needed for this phase.

## Record the live result

Share the policy version, research status, comparison status and whether the journal
entry appears in Telegram. These labels are enough for the next diagnosis; no secret,
full financial report or private database export is needed. CPU, latency and account
allowance still require the real Cloudflare metrics.
