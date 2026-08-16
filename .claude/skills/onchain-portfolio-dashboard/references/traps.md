# Traps

Every one of these shipped before it was caught. Check here first when something is behaving
oddly — the symptom is rarely where the cause is.

## Data and correctness

| Symptom | Cause | Fix |
|---|---|---|
| Ledger values drift over time | Historical events re-priced at today's price on every load | Price at the event's block; keep stored prices for days already booked |
| A ledger is empty but there was definitely activity | Wrong `topics[0]` — a wrong hash matches nothing and raises no error | Discover topics empirically by grouping an unfiltered window |
| Every healthy item flagged as a problem | Comparing `status !== 'IN'` when the producer emits `'in'` | Test for the specific bad values; let unknown statuses read as fine |
| Tick maths produces absurd numbers | Signed ints read as unsigned — a negative tick becomes ~2^256 | Sign-extend words before use |
| Position value understated | Uncollected fees not added to the reconstructed amounts | Add `tokensOwed0/1` from `positions()` |
| A staked position vanishes from the total | Ownership check misses NFTs held by the staking contract | Check the staker's holdings as well as the wallet's |
| A closed position's P&L changes between page loads | Priced at read time rather than at its own block — settled history cannot move | Use it as a diagnostic: reload twice, and if the number moves you have found the bug |
| Someone else's liquidity appears in your position | Pool-level `Mint`/`Burn` carry the position manager as `owner`, not your wallet — filtering by tick range aggregates every user in that range | Read positions from the NFT manager keyed by token id, not from pool events |
| A price is off by a clean power of ten | `sqrtPriceX96` used without the `10**(decimals0-decimals1)` adjustment | Apply it — and note a same-decimals pair hides the bug entirely |
| A price is inverted for some pools but not others | token0/token1 are ordered by address; the quote token is not reliably token1 | Compare the addresses rather than assuming |
| Same event on different days for different viewers | Day key computed in local time | Fix the boundary to one timezone offset |

## Network and freshness

| Symptom | Cause | Fix |
|---|---|---|
| One whole section is empty, no error in the console | A method that **hangs** rather than erroring, so no `catch` fires | Cap every fetch with a timeout ~5× the measured good latency; find a narrower method |
| Refresh takes 20s+ | Repeatedly retrying a dead endpoint every pass | Memoise dead endpoints for the session |
| The page seems to run old code after a deploy | Service worker serving a cached shell | Bump the cache version on every shell change |
| The page seems to run old code **locally** | The dev server died, so the SW correctly fell back to cache | Check the server is up *before* blaming the cache |
| Two windows show different totals | One reached a live source, the other fell back to the snapshot | Decompose the total and diff the components; it is one component |
| Every value fails at once | The price API rate-limited you — everything derives from it | Set the refresh interval from the price API's ceiling, not the chain's |
| A rate-limit response is reported as a network error | `fetch` resolves on any HTTP status; a 429 body then fails at `.json()` | Check `res.ok` before parsing, so you can back off rather than treat it as an outage |
| A "live" clock reads *now* beside figures that are hours old | The clock ticks off wall time regardless of whether the last pass succeeded | Drive the clock from the last successful pass, or show freshness separately from the time |
| A failed component silently shows a snapshot value | Fallback goes straight to the committed snapshot rather than the last good live read | Fall back live → last-good-live → snapshot, and only reach the snapshot on a cold start |

## Layout

| Symptom | Cause | Fix |
|---|---|---|
| A card grows to an absurd height | `aspect-ratio` + `align-self: stretch` feeds the image's natural size back into the layout | Give the element an explicit width, and comment why |
| Rows peek above a sticky header | The scroll container has `padding-top`; sticky pins to the scrollport edge, not the padding box | Zero that container's top padding |
| Sticky header does nothing | `position: sticky` applied to `tr` | Apply it to `th` |
| A partial row at the fold | Height computed from header + rows + padding | Measure the distance to the first hidden row's top instead |
| A modal shrinks on page 2 | Height locked while the modal was still hidden, so page 1's height never recorded | Lock after the element is visible |
| Text fits at 375px, overflows at 320px | Fixed font sizes | `clamp()` against `vw` |
| A button stays highlighted after tapping | `:hover` latches on touch devices | Wrap hover rules in `@media (hover: hover)` |
| A wordmark highlights when tapping a nearby control | Second tap registers as a double-click, which selects the nearest word | `user-select: none` on the block |
| A visible element captures no clicks (or vice versa) | An invisible overlay | `document.elementFromPoint(x, y)` |

## Formatting

| Symptom | Cause | Fix |
|---|---|---|
| `$0.9535` beside `$4.95K` | Abbreviating formatter switching to 4dp under a dollar | Use the exact formatter for P&L, the abbreviating one for headlines |
| Same amount shown two ways in two places | Abbreviation threshold applied before currency conversion | Convert first, then abbreviate |
| Foreign symbol against unconverted numbers on load | Saved currency applied before its rate arrived | Open in the base currency; switch when the rate lands |

## Animation

| Symptom | Cause | Fix |
|---|---|---|
| An element jumps to its end position instead of animating | Transitioning `left` to a percentage | Animate `transform` in px |
| Two elements that should move together look unglued | They start from different points on the same scale | Snap both to a true zero, then one transition |
| A "snap" glides instead | `transition:none` → change → restore, all in one tick | Force a reflow (`void el.offsetWidth`) between |
| An element yanks backwards mid-animation | A render fired during the animation | `if (ANIMATING) return;` at the top of the placement function |

## Process

| Symptom | Cause | Fix |
|---|---|---|
| An edit has no effect | Two copies of the file; the server serves the other one | Prefer one path. If you cannot, script the copy — never do it by hand |
| A push is rejected | The scheduled job committed while you worked | Fetch and rebase; it only touches JSON so conflicts are rare |
| A push appears to hang | Slow network — it may or may not have landed | Verify by comparing local and remote HEAD; never assume either way |
| A phantom interaction fires on load in a preview pane | Environment artifact, not your code | Confirm the handler is only bound where you think, then ignore it |
