# Front end

Structure, state, design and motion for a dashboard that redraws itself on a timer.

## Contents

- [Render structure](#render-structure)
- [State that must survive a rebuild](#state-that-must-survive-a-rebuild)
- [Failure boundaries](#failure-boundaries)
- [Design system](#design-system)
- [Mobile is where the layout is decided](#mobile-is-where-the-layout-is-decided)
- [Motion](#motion)
- [Verifying a change](#verifying-a-change)

## Render structure

One `render(data, isLive)` that paints every headline figure, plus a handful of independent
builders for sections that own their own state — ledger tables, the chart, derived-metric cards.

Two rules hold it together.

**Live must never be overwritten by stale.** Both paths are racing. The snapshot usually wins,
but on a cold cache with a fast RPC the live read can land first, and without the guard the page
visibly steps backwards:

```js
function render(d, isLive){
  if (liveRendered && !isLive) return;   // a late snapshot cannot undo a live overlay
  LAST_DATA = d;                          // kept so a currency switch repaints without refetching
  ...
  if (isLive) liveRendered = true;
}
```

**Keep the last payload.** Any display-only change — currency, units, a toggle — should repaint
from `LAST_DATA` rather than re-reading the chain.

## State that must survive a rebuild

Once the page refreshes itself, every rebuilt section is a chance to yank the interface out from
under the reader. Anything they have adjusted must be restored explicitly:

- **Scroll position** inside an open modal — save it, rebuild, restore it.
- **Pagination** — keep the page index in a variable that outlives the builder.
- **Measured heights** — an element that locks its height must measure while it is *visible*.
  Measuring behind `display:none` records zero and the lock silently does nothing.
- **Delegated handlers** — a button inside a rebuilt section is a new element every time; a
  direct listener is lost on the first refresh. Delegate from `document`.

## Failure boundaries

Every remote read gets its own `catch`, and every catch leaves the last good value on screen.
In practice: a timeout on each fetch, a memo that skips an endpoint already known dead this
session, and a fallback endpoint list per chain.

Worth knowing about the trade: a silent fallback means two windows can legitimately disagree —
one reached the API, one fell back to the snapshot. That is the design working. If you want the
page to distinguish "the number moved" from "the source is down", have the fallback mark itself
(`stale: true`) and surface it; just be aware it adds a UI state that must clear correctly.

## Design system

A dashboard is scanned, not read. The craft is information design more than typography: summary
before detail, state encoded in form as well as number, and a clear line between the accent
colour and the semantic ones.

- **Tokens for everything**, so a theme change is one block.
- **Give the neutrals a hue bias** toward the accent (or a consistent cool/warm cast). A pure
  mid-grey reads as unconsidered.
- **Semantic colour is separate from the accent** and never decorative. If green appears, it
  means something is up.
- **Monospace suits a page that is mostly numbers** and gives columns free alignment. Wherever
  digits line up, `font-variant-numeric: tabular-nums`.
- **Encode state in form**, not only in value: a badge, a chip, a severity stripe, so what needs
  attention reads at a glance.

## Mobile is where the layout is decided

Fixed sizes that fit at 375px overflow at 320px and look lost at 430px. Size anything that must
stay on one line with `clamp()` against `vw`, and it holds at every width rather than the one
you happened to test.

Three techniques do most of the work:

- `clamp(min, Nvw, max)` for headline text that must not wrap.
- `flex: 1 1 0` on the element that should yield when space runs out — pick which side loses
  deliberately rather than letting the browser decide.
- `position: sticky` on `th`, **not** on `tr` — sticky does not work on table rows. And zero the
  scroll container's `padding-top`, or rows scroll visibly through the gap above the pinned
  header.

Guard hover behind `@media (hover: hover)`. On a touch device `:hover` latches onto the last
element tapped and stays there, which reads as one option being special when they are all the
same.

## Motion

Motion earns its place when it explains something — a marker travelling the bar as the value
loads shows the value arriving; a bar that simply appears does not. Four rules, each from a real
bug:

1. **Animate `transform` in pixels, never `left` in percentages.** A transition to a percentage
   pins at the start value in some engines.
2. **Two elements that move together must start from the same point on the same scale.** A bar
   starting at `width:0` beside a marker at `translateX(0)` are half a marker apart; the bar
   trails and closes the gap, and the two read as unglued. Snap both to a true zero first, then
   let one transition carry them across.
3. **Flush before you restore.** Setting `transition:none`, changing a transform, and restoring
   the transition in the same tick produces a glide, not a snap. Force a reflow
   (`void el.offsetWidth`) between them.
4. **Guard against re-entry.** A render firing mid-animation yanks the element back. One
   `if (ANIMATING) return;` at the top of the placement function is the whole fix.

Housekeeping: honour `prefers-reduced-motion`; clean up particles on `animation.finished` with a
timeout as a backstop for backgrounded tabs; and put `-webkit-tap-highlight-color: transparent`
plus `user-select: none` on anything tappable — a second tap registers as a double-click and the
browser answers by selecting the nearest word.

## Verifying a change

Drive the real page and read real values. Do not rely on screenshots alone — they go stale in
some preview panes, and a layout can look right while a figure is wrong.

Useful checks, in rough order of value:

```js
// does what the page shows agree with the source it claims to come from?
document.getElementById('totalVal').textContent   // vs the value in the variable

// is this element actually where and what I think?
el.getBoundingClientRect(); getComputedStyle(el).display;
document.elementFromPoint(x, y)                    // catches invisible overlays

// does the container actually scroll / clip where intended?
el.scrollHeight > el.clientHeight

// after a state change, does it clear?  drive it both ways
```

For a responsive rule, check the extremes of the breakpoint and one width in the middle. For
anything currency- or unit-dependent, check every unit — a formatter that is right in one is not
necessarily right in another.
