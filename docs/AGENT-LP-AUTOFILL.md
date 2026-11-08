# Automatic LP comparison inputs

Open **Agent → Compare strategies → LP ranges vs holding**. The form detects the
current open positions and selects the largest position with supported fresh pool
data. Choose another position in **Open LP position** to switch wallets/LPs without
typing an NFT ID, chain or address. Click **Compare this LP** to calculate.

The result starts with three short points: the tested takeaway, your current LP's
dollar difference versus holding, and the main risk. A four-row table compares
keeping the range, widening it, choosing the proposed range and holding tokens,
including upfront costs. Open **Full scenario breakdown** for every original case.
Detailed definitions and assumptions remain under **Assumptions and checks**.

The holding benchmark closes this LP now and keeps its current token amounts,
including closing gas. The advantage is the difference between the two calculated
final values in the same case. Positive values favor the LP option; negative values
favor holding. A lead applies only to the tested cases. Missing values, ties and
options outside your saved limits stay explicit; no chance of winning is inferred.

The existing comparison has verified pool inputs for configured Katana pools. Other
detected chains remain visible with an unavailable explanation; the form does not
invent missing fee, reward or pool observations to enable an unsupported comparison.

## Inputs and assumptions

| Input | Automatic basis |
| --- | --- |
| Position, wallet, chain, principal, staking and current range | Current LP Book reading with the full position identity |
| Available cash | Same-wallet stablecoin balances on the selected chain, valued at $1 per token; it excludes LP principal, locked assets, volatile tokens and other wallets/chains |
| Gas budget | Current gas price × a 2,000,000-unit planning budget × a verified native-token quote; this is an estimate, not a transaction-specific gas quote |
| Pool swap fee | Current pool fee tier, converted to basis points |
| KAT price and campaign | Current configured Strategy source; projected rewards stop at campaign end |
| Horizon | Confirmed policy horizon, otherwise an illustrative seven-day case |
| Proposed band | The existing deterministic historical-range comparison, otherwise the current verified band |
| Wider band | Illustrative twice-current-width case |
| Price paths | Illustrative −10%, unchanged and +10% endpoints over the horizon |
| Incentives | Current eligibility/rates carried forward as an assumption, plus a no-incentives case for a staked reward LP |
| Other liquidity | Illustrative unchanged competition (multiplier1) |
| Slippage | An editable 0.5% planning assumption, not an observed execution quote |
| Financing | Automatic cases are explicitly **before borrowing costs**; portfolio loans are not attributed to one LP |

Open **Where the automatic inputs come from** for dates, source scope and the
observed/derived/estimate/scenario/owner distinction. Under **Adjust range and
scenario assumptions** and **Costs and thesis**, optional edits override the automatic
case. Editing borrowing costs switches to the ordinary stated-cost case. Your policy
and the Lending page's intentional per-visit settings remain separate.

**Refresh live inputs** refreshes observations while retaining your explicit edits.
**Use automatic values** clears those edits. Changing the position clears its previous
comparison result so one wallet's results cannot appear under another wallet's LP.
The separate Lending comparison draft is restored when switching back to it.

## Freshness and saved cases

Submitting reconstructs the position and funding from new first-party readings; it
does not trust stale or modified browser values as observations. A closed position
cannot produce a new comparison. Failed/old cash or gas reads stay unknown, and a
fully priced comparison stays blocked until those inputs are available or explicitly
supplied as owner assumptions. Historical saved reports keep their original dates.
Retries of a completed request reuse its original immutable report.

After calculation, **Include in recurring reviews** retains the displayed case's
assumptions for the chosen validity. Recurring comparisons refresh position readings
while retaining the explicitly saved cost/path/cash assumptions; they do not silently
change those confirmed assumptions. A saved automatic case retains its financing
scope and original input provenance.

## Implementation and deployment

- The existing owner-authenticated `/api/agent` action `lpCompareSetup` detects and
  prepares positions. The `compare` action accepts an automatic position key plus
  optional validated owner overrides; the existing manual API remains supported.
- The existing first-party `/api/strategy?view=lp-funding&chain=…&owner=…` view reads
  configured wallets only, with fixed RPCs/token metadata and pinned source blocks.
  It adds no new public function, token, paid provider, AI call or database migration.
- New readers: `api/_agent-lp-autofill.mjs` and `api/_lp-autofill-funding.mjs`.
  Changes also cover comparison routes/grammar, the Strategy view, Agent UI/cache
  and closed test fixtures. Public financial ledgers and original plan are unchanged.
- Deploy the updated dashboard/Vercel functions and existing Cloudflare Worker using
  `cloudflare/wrangler.jsonc`. Existing bindings/secrets remain sufficient. Cache157
  loads the updated interface. Real RPC latency, deployed cross-host compatibility,
  actual balances/cost estimates and Free account CPU/quotas require a live check.

Local tests use actual deterministic calculations, SQLite, native workerd/local D1
and Chromium with closed providers. They cover source failures, wallet mismatches,
closure, duplicate requests, preserving edits, saved cases, case switching and logout.
They never contact a real bot/model or change a wallet/public accounting file.
A separate read-only Katana RPC smoke check returned a fresh pinned block, verified
cash and a priced gas budget in 1.523 seconds. Deployed behavior remains unverified.

Changed files: `agent.html`, `agent.js`, `agent.css`, `sw.js`,
`api/_agent-actions.mjs`, `api/_agent-scenarios.mjs`, `api/strategy.mjs`, the two new
readers listed above, `scripts/test-agent-lp-autofill.mjs`,
`scripts/test-agent-lp-autofill-api.mjs`, `scripts/fixtures/agent-lp-autofill.mjs`,
`scripts/check-agent-review-runtime.mjs`, `AGENTS.md`, `TIGER_AGENT_PROGRESS.md`,
`docs/AGENT-SETUP.md` and this guide. No new dependencies are required.

The concise-analysis follow-up also adds `agent-lp-summary.mjs` and
`scripts/test-agent-lp-summary.mjs`, and registers the shared module in
`scripts/check-project.mjs` and the service-worker shell. Cache 158 replaces 157.
The shared renderer reads existing outcomes without rewriting saved calculations.
Update Vercel for the dashboard view and the existing Worker for concise replies;
there are no additional configuration values, bindings or migrations.
