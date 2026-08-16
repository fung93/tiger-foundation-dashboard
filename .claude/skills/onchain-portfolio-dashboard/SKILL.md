---
name: onchain-portfolio-dashboard
description: >
  Build or extend a self-hosted crypto portfolio dashboard that reads balances, LP positions,
  lending, staking and reward emissions straight from chain RPCs with no backend, no database
  and no API keys. Use this whenever the user wants to track a wallet's value over time, build a
  net-worth or portfolio tracker, chart on-chain holdings, compute realised or unrealised P&L on
  liquidity positions, reconstruct a claim or trade ledger from event logs, or schedule a job
  that commits chain snapshots to a repo — even if they never say the word "dashboard". Also use
  it when working on an existing dashboard of this shape: batching reads through Multicall3,
  decoding Uniswap or SushiSwap V3 positions, pricing historical events at the block they
  happened, adding a live-refresh loop, or debugging a figure that disagrees between two views.
---

# On-chain portfolio dashboard

A dashboard that reads a portfolio straight off the chain, runs with no backend, and costs
nothing to host. This skill is the architecture, the chain-reading engine, and — most usefully —
the traps, which are where the time actually goes.

## The one constraint that shapes everything

**No backend.** No database, no API server, no key management, nothing to keep alive. That rules
out the obvious design (a service that polls chains and serves JSON) and forces a better one:

**Two clocks read the same chain at different speeds.**

- A **scheduled job** (GitHub Actions cron, every few hours) reads the chain and commits JSON
  files to the repo. This is the backend. It gives you a durable snapshot, a free scheduler,
  version history on every data point, and nothing to operate.
- The **browser** reads the same chain directly, on a short timer. It paints the committed
  snapshot instantly, then overwrites it with live values.

Neither can take the other down. The snapshot exists so the page has something true to show in
the first 200ms; the live pass is what makes the numbers current.

A service worker sits under both: cache-first for the shell, network-first with cache fallback
for the JSON and third-party APIs. That is what makes it open offline.

## Build in this order

Each phase leaves something you can look at. Do not build the engine first and the page last —
you will have no way to tell whether the numbers are right.

1. **Static shell against a hand-written JSON.** Lay out the whole page reading from a
   `data.json` you type by hand. Fix that file's shape now; everything downstream is written to
   match it. *Ships: a page that looks finished and lies about every number.*
2. **The scheduled job, one balance at a time.** A script that reads a single token balance over
   raw JSON-RPC and writes the real number. Then the cron and the commit step. Close the loop —
   schedule, read, commit, deploy — before adding a second call. *Ships: a number that changes
   on its own.*
3. **Batch, then port to the browser.** Collapse the reads into one Multicall3 call, then run
   that same reader in the browser as the live overlay. Rule: a failed overlay leaves the
   snapshot on screen untouched. *Ships: values current at page load.*
4. **Protocol adapters, one at a time, each behind its own `catch`.** LP, lending, staking,
   locks, then the second chain. Check the total against each protocol's own UI as you go.
5. **Ledgers from event logs.** The step that turns a balance viewer into a portfolio tracker.
   See `references/money-math.md` — pricing this wrong is the most expensive mistake available.
6. **History and derived metrics.** Append one row per day, never rewrite the past. ROI, average
   daily earning, peak, ETA and change-over-N-days all derive from that one series.
7. **PWA, offline, live refresh.** See the refresh guards in `references/data-contracts.md`.
8. **The surface.** Type, colour, motion. Last, deliberately — it tempts you to fiddle and none
   of it is worth doing against numbers you do not yet trust.

## Probe the chain before designing around it

Two properties change what the product can honestly claim, and both vary by chain and by
provider. Run the bundled script before you design the ledger:

```bash
node scripts/probe-chain.mjs --rpc <url> [--wallet 0x...] [--contract 0x...]
```

It reports whether the RPC serves **archive state** (can you price a historical event exactly,
or only approximate it?), whether `eth_getLogs` returns **`blockTimestamp` inline** (one call per
log saved), whether **Multicall3** is deployed at the canonical address, and — given a contract —
it groups a window of logs by `topics[0]` so you can **discover topic hashes empirically**.

Never copy a topic hash from a blog post. The same event name has different signatures across
protocol versions, and a wrong hash produces an empty ledger rather than an error.

## Reference material

Read the file that matches what you are doing. Each is self-contained.

| File | Read it when |
|---|---|
| `references/chain-engine.md` | Encoding calls, batching, reading logs, discovering positions |
| `references/money-math.md` | Valuing LP positions, pricing history, P&L, currency display |
| `references/data-contracts.md` | Designing the JSON files, the scheduled job, refresh cadence |
| `references/frontend.md` | Render structure, state across rebuilds, design tokens, motion |
| `references/traps.md` | Something is behaving oddly — check here first |

## The working method that matters most

This is the part that generalises beyond crypto, and it is the reason the traps list is short
rather than long.

**Measure, don't eyeball.** Almost every real bug in this kind of project is invisible to
inspection and obvious to measurement. Read the computed style, the bounding box, the actual
element at a point, the real value in the variable. Screenshots lie — they go stale, they miss
sub-pixel overlap, and a layout can look right while a value is wrong.

**Cross-check every displayed figure against the source it claims to come from.** If two parts
of the page show the same quantity, assert they are equal in the browser, not by reading the
code. This is how you catch a formatter that renders `$0.9535` in one place and `$0.95` in
another, or a comparison against `'IN'` when the producer emits `'in'`.

**Prove the negative case too.** A warning that cannot clear is worse than no warning. When you
add a state, drive it in both directions and confirm it goes away.

**When two views disagree, decompose rather than theorise.** Print the components of the total
on both sides and diff them. The gap is almost always one component, and naming it takes one
comparison. Guessing at causes takes an hour.

## Non-negotiables for correctness

These come from bugs that shipped, not from principle:

- **Never re-value history at today's price.** Price each event at the block it happened, either
  by reading pool state at that block (archive) or by indexing the pool's own `Swap` events,
  which carry the post-swap price and need no archive node. On a volatile pair this is not
  slightly wrong — it understated realised losses by roughly 3× in the project this skill came
  from. The cheap test: a *closed* position's P&L must be identical on every reload. If it
  moves, you are pricing at read time.
- **Once a day's value is booked, it is history.** When merging a live scan over a stored
  record, keep the stored price for days already recorded and use the live price only for new
  ones. Otherwise yesterday silently changes every time someone opens the page.
- **Fix the day boundary to one timezone**, not the viewer's, or the same event lands on
  different days for different readers.
- **Every remote read gets its own `catch`, and every catch leaves the last good value on
  screen.** A dead price API should cost you the price, not the page.
- **Test for the values you mean, not for "not the good one".** `status !== 'IN'` treats an
  unknown status as a problem; `status === 'below' || status === 'above'` treats it as fine.
  Prefer the reading that fails safe when the alternative is crying wolf.
