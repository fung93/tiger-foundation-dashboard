# Data contracts, the scheduled job, and refresh cadence

The backend is a cron job that commits JSON. This is what it writes and how often anything runs.

## Contents

- [Four files, four jobs](#four-files-four-jobs)
- [Two conventions that carry weight](#two-conventions-that-carry-weight)
- [The scheduled job](#the-scheduled-job)
- [Refresh cadence and the rate ceiling](#refresh-cadence-and-the-rate-ceiling)
- [Four guards the refresh loop needs](#four-guards-the-refresh-loop-needs)
- [Service worker](#service-worker)

## Four files, four jobs

Keeping them separate means a failure in one scan cannot corrupt another, and each file's git
diff stays readable — which matters more than it sounds, because the commit history becomes your
audit trail.

| File | Holds | Write pattern |
|---|---|---|
| `data.json` | Current state: totals, per-chain, per-position, rewards, plus rediscovered references | Overwritten each run |
| `history.json` | One row per day: total and its components | Append-only; today's row updated in place |
| `claims.json` | Rewards by day, each with the token price at claim time, plus `last_block` | Append-only, resumes from `last_block` |
| `positions.json` | Open positions keyed by id; closed positions with open/close value and P&L | Append-only for closed; open rebuilt each run |

Shapes worth copying:

```jsonc
// history.json
{ "created": "...", "target_usdc": 10000,
  "data": [ { "date":"2026-08-09", "timestamp":"...", "onchain_usd":45.3,
              "pending_usd":2.1, "lp_usd":2029.3, "total_usd":2917.4 } ] }

// claims.json  — price stored per day, never recomputed
{ "tz":"UTC+8", "start_date":"2026-08-01", "last_block":9412233,
  "days": { "2026-08-08": { "kat":1823.1, "kat_price":0.0046, "value_usd":8.38 } } }

// positions.json
{ "start_date":"...", "last_block":9412233,
  "open": { "424319": { "pair":"USDC / KAT", "opened":"2026-08-02", "open_value_usd":1199.9 } },
  "closed": [ { "id":"422640", "opened":"...", "closed":"...",
                "open_value_usd":1000, "close_value_usd":977.6,
                "pnl_usd":-22.4, "pnl_pct":-2.24 } ] }
```

## Two conventions that carry weight

**Every ledger stores `last_block`.** A scan resumes instead of re-reading history. Without it
the job gets slower every day until it times out.

**Every day key is computed in a fixed timezone offset.** Not the runner's, not the viewer's.
Otherwise the same claim lands on different days depending on who looks.

## The scheduled job

GitHub Actions, Node 20, zero dependencies — native `fetch` and `BigInt` cover everything, and
no `npm install` step means nothing to break.

```yaml
on:
  schedule: [{ cron: '0 */6 * * *' }]
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: update-data          # two runs writing the same files will conflict
  cancel-in-progress: false
```

The commit step should be a no-op when nothing changed, or you get an empty commit every run:

```bash
git add data.json history.json claims.json positions.json
git diff --staged --quiet && echo "No changes" || git commit -m "chore: auto-update dashboard data" && git push
```

**Expect this job to commit while you are working.** Fetch and rebase before pushing your own
changes; the conflicts are rare because it only touches JSON, but the rejected push is not.

Share code between the job and the browser by keeping the encoding helpers identical in both.
They are small enough that duplication costs less than a build step to share them.

## Refresh cadence and the rate ceiling

Two cadences, set by different limits:

- **The scheduled job**: how often the data meaningfully changes. Every few hours is plenty.
- **The browser refresh**: set by whichever upstream has the tightest rate limit — and that is
  almost always **the price API, not the chain**.

Work out the ceiling before choosing an interval. Every figure on the page usually derives from
one price call. A free tier that starts returning 429 in the low tens of requests per minute
puts the floor around 15 seconds (4/min, with headroom). At 3 seconds you would be at 20/min and
the price starts failing — which takes down every value, not just one. The chain RPCs would take
the faster rate happily.

Put the interval in one named constant so it is one number to change.

## Four guards the refresh loop needs

Adding a timer to a page that was written for one-shot loading breaks things quietly. All four
of these came from real breakage:

1. **A pass in flight blocks the next one**, so slow passes cannot stack.
2. **A failed pass leaves the last good values on screen** and waits for the next.
3. **Stop on `visibilitychange` to hidden; refresh immediately on return.** Phones throttle
   background timers anyway, and you want the catch-up instant rather than an interval late.
4. **Open UI keeps its scroll position and page index across the rebuild.** An auto-refresh that
   yanks a ledger back to the top under the reader's finger is worse than stale data.

## Service worker

- Cache-first for the shell (HTML, icons, any CDN library).
- Network-first with cache fallback for the JSON files and third-party APIs.
- **Bump the cache version on every shell change.** Forgetting this is the single most confusing
  bug in the whole stack, because the browser serves your old code and everything you deduce
  from it is wrong.
- Strip cache-busting query params when forming the cache key for the data files, or offline
  lookups miss.

One diagnostic worth internalising: **if the page seems to be running old code, check the dev
server is actually up before blaming the cache.** A dead server makes the service worker fall
back to its cached shell — which is correct behaviour that looks exactly like a caching bug.
