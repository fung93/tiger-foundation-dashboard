# Base Uniswap V3 holdings and LP Book

Requested 18 November 2026: the owner's Base LP is missing from holdings / LP
Book. He confirmed **Uniswap V3** and explicitly requested **fix and push**.

Cause: Base existed only in the independent UNI guide. It was absent from the
portfolio, vault and shared LP Book chain configuration. Merely adding a chain
row would also skip existing positions: an old book without that chain's cursor
previously started after the current head instead of finding its open LP mints.

- [x] Discover both configured wallets' Base Uniswap V3 NFTs automatically.
- [x] Bootstrap Base additively from current open LP mints, without resetting
  book version 9 or rewriting any existing chain's accounting/history.
- [x] Include Base principal, owner fees, range and original deposit/claim values
  in the LP Book, widget, holdings and Tiger Vault, counting each wallet once.
- [x] Keep Base reads independent, pinned and bounded, with public RPC fallback.
  Retain original figures/times on failure; verified zero is different from missing.
- [x] Run failure/recovery, mint migration, principal-versus-fee and chain-identity
  regressions, browser checks and `npm run check`.
- [x] Prepare the authorized release for rebase and push, preserving incoming
  automatic financial-data commits.
- [x] Verify live deployment and actual wallet positions through the read-only
  Actions runner (19 November follow-up below).

No wallet connection, signing, key, paid service, risk-policy change or historical
portfolio rewrite is involved. The public Base RPC probe currently fails in this
workspace (proxy CONNECT 403); local fixtures cannot establish actual balances.

## Validation and deployment

- `node scripts/test-base-lps.mjs`: **370** assertions on the actual ABI reader,
  pinned quotes/ownership, full enumeration, original mint bootstrap, mixed
  principal/fee collections, no duplicate replay, failed future mints and recovery.
- `node scripts/test-portfolio-base.mjs`: **65** assertions on actual browser
  inclusion/totals, both wallet scopes, cached source times and closure/recovery.
- Existing core/API regressions: **100 / 144** assertions, including vault Base
  accounting and separate Base/full-book caches. Existing Katana rollovers,
  historical comparisons and failed-source semantics remain covered.
- **246** Chromium assertions across Portfolio, LP Book and widget, both themes,
  English/Chinese and 320/375/1366 px. Rendered figures match the actual synthetic
  chain reader. Both wallets appear independently; fee and chain records agree.
  The fixture's amounts and NFT IDs **are synthetic, not actual wallet evidence**.
- `npm run check`: all **84** suites pass. No collectors/history writers ran.
  Portfolio copies and the original agent implementation plan are unchanged.
- The full check exposed two existing fixture defects after the date/data moved:
  fixed-Sunday SQLite leases were already expired against SQLite's real clock;
  a rounded negative zero was compared to currency zero. Only tests changed.
- The live read-only **Verify Base LP discovery** GitHub Action runs on relevant
  code pushes or manually. It checks both real wallets and a temporary in-memory
  Base-only book replay. Its summary records actual source blocks and NFT IDs;
  it has read-only repository permission and writes no public financial history.

Changed financial paths: `base-config.mjs`, `api/_base-portfolio.mjs`,
`api/_core.mjs`, `api/lpbook.mjs`, `portfolio-core.mjs`, `scripts/update-data.mjs`
and both Portfolio copies. Shared LP card footers add chain/NFT identity. The
small chart canvas cap prevents overflow when the additional wealth makes the
existing compounding chart visible. Chinese warning copy and cache **177** are
shared by the pages. No new secret, migration, wallet permission or operator
configuration is needed. Real source availability and Vercel deployment still
require the post-push check; successful fixtures are not proof of either.

Local browser/test evidence: `/workspace/tiger-agent-validation/base-browser/`,
`base-browser.log`, `base-lps-test.log` and `base-project-check.log`.

19 November follow-up: cold UNI LP fee/P&L reads exposed a normal six-hour Base
backlog that needed many 5,000-block windows. Base's filtered ledger span now
uses the verified publicnode **50,000-block** limit, retaining the four-window
live budget and existing cursor/history semantics. The regression proves a
150,000-block gap reaches head in one pass without rewriting positions; the old
span leaves 130,000 blocks behind. The Base suite now passes **388** assertions,
including claimed/unclaimed UNI fee totals and unchanged earnings/P&L after a
fee claim. See `docs/UNI-TRADE.md` for the release checklist and live evidence.
Main-branch [verification run 44541917604](https://github.com/fung93/tiger-foundation-dashboard/actions/runs/44541917604)
succeeds after `bcf53a6`, including actual wallet/NFT discovery, fee reads and
LP Book inclusion. The separate live release probe confirms the 50,000-block
provider limit and complete UNI fee/P&L totals; no financial ledger was written.
