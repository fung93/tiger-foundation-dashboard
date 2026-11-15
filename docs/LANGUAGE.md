# English / Simplified Chinese interface

Requested 15 November 2026. The owner explicitly approved **push** after local
implementation and validation, including the pending UNI LIVE badge correction.

## Mobile spacing and UNI fields — push requested, 15 November 2026

The owner reported cramped mobile language controls and misaligned UNI inputs,
and explicitly requested fixes and **push**.

- [x] Give mobile language choices at least **44 × 44 px** touch targets, 12 px
  text, separate rounded outlines and a 6 px gap. Keep the group beside LIVE with
  14 px separation from the status; allow room below the brand through 768 px.
- [x] Keep the six navigation links within the viewport between 421 and 768 px,
  using compact labels without icons. The prior English UNI link extended beyond
  the 540 px viewport and made the mobile page wider than its screen.
- [x] Give all UNI labels explicit text spans and a shared flexible label row,
  then place equal-height inputs beneath it. A **15 px** offset was reproduced
  in the tiger theme at 600 px before the fix.
- [x] Preserve desktop styling, calculator values, both languages, theme state,
  original quote times and financial behavior. Bump the shell/assets to **175**.
- [x] **4,304** header/browser assertions pass on all 12 page URLs in both
  themes/languages across eight phone/tablet/desktop widths, including tap target
  size, spacing, clickability, status alignment and navigation fit.
- [x] **5,184** UNI assertions pass for all three pools and all deposit modes in
  both themes/languages across eight widths. Maximum input row offset is **0 px**;
  values and editable ranges survive language changes and estimates still render.
- [x] `npm run check` passes all **82** suites. Final syntax, diff formatting,
  unchanged implementation plan and byte-identical Portfolio copies pass.
- [x] Prepare the approved release and rebase onto the latest main branch,
  preserving the incoming automatic pool snapshot for the requested push.
- [ ] Verify production where network access permits. Direct Vercel reads remain
  proxy blocked in this workspace.

Evidence: `/workspace/tiger-agent-validation/mobile-uni-layout/`.

## Header placement follow-up — approved for publication, 15 November 2026

The owner subsequently requested the language control **next to LIVE**. This
placement change was implemented and validated locally, then explicitly approved
for **push** by the owner.

- [x] Insert the existing EN / 中文 control into the header's status/action group,
  immediately to the right of the LIVE/stale stamp, rather than beneath the header.
- [x] Use the same header position on pages without a LIVE stamp. Retained legacy
  headers wrap their existing timestamp and control in one action group.
- [x] Keep both controls together on narrow phones, below the brand inside the
  header; preserve the reading time, theme and saved language.
- [x] Validate **1,744** browser assertions on all 12 retained page URLs, both
  themes, English/Chinese and 320/360/768/1366 px. Checks cover actual adjacency,
  alignment, bounds, click targets, navigation fit and hidden embedded controls.
- [x] Existing **69** language assertions, syntax, diff formatting and identical
  Portfolio copies pass. No financial calculations or data readers changed.
- [x] Bump shared language assets and the service worker to cache **174**.
- [x] Receive explicit authorization before committing, pushing or deploying this follow-up.

Evidence: `/workspace/tiger-agent-validation/language-placement/`.

## Progress

- [x] Add an accessible **EN / 中文** control to every full dashboard page, LP
  widget and Agent, plus both retained legacy pages.
- [x] Share the language between pages, reloads, open tabs and the embedded Agent.
- [x] Store only the language under `tf_language_v1`. Default remains English;
  unavailable storage still permits switching for the current visit.
- [x] Translate navigation, titles, buttons, cards, forms, help, status messages,
  calculations and dynamically replaced live UI. Render Chart.js labels/tooltips
  in the selected language as well as DOM/SVG labels.
- [x] Restore original English text, including the latest live content, on demand.
- [x] Preserve input/selection values and unsaved edits; avoid reloads and API
  payload changes. Keep the Lending page's per-visit target reset independent.
- [x] Leave saved conversations, owner-authored journal notes, source quotations,
  URLs, wallet addresses, token names and financial data in their original form.
- [x] Keep both existing themes with their switches hidden. Language controls now
  sit beside LIVE/status; see the subsequent placement change above.
- [x] Cache the local translation assets in the PWA shell; published language
  release **173**, local header-placement follow-up **174**.
- [x] Portable language/storage/financial-copy checks pass **69** assertions.
- [x] Multi-page browser checks pass **978** assertions, plus **54** follow-up
  assertions for Lending reset, canvas labels/tooltips, keyboard access and a real
  embedded Agent frame. Both themes, 320/360/1366 px, all retained pages.
- [x] `npm run check` passes all **82** suites. Final syntax, diff formatting,
  unchanged implementation-plan hash and byte-identical Portfolio copies pass.
- [x] Receive explicit authorization before committing, pushing or deploying.
- [ ] Verify the actual deployment. Production Vercel access is proxy blocked
  from this workspace; fixture checks do not establish live deployment status.

## Implementation

`i18n-zh.js` contains the reviewed Chinese copy. `i18n.js` reads the independent
language preference, adds the control and translates visible text and descriptive
attributes. A bounded mutation observer handles newly rendered labels without
changing the financial readers or their JSON. Original text is held in weak maps
and is replaced when an existing node receives a new live value, so English
restoration cannot restore an outdated label. The observer ignores its own writes.

Form values are never translated. An option whose value originally comes from its
label keeps that original value before its visible label changes. Dataset values,
IDs and financial series are untouched. A Chart.js presentation plugin translates
dataset labels and tooltip output, retaining numeric datasets and callback inputs.

Owner conversations and notes, evidence blockquotes and explicit
`data-i18n-skip`/`translate="no"` regions are excluded. This language setting changes
the interface; it does not rewrite saved AI answers, run translation requests,
change the agent's policy or alter Telegram messages.

Dates remain in their original reporting timezone. Chinese date labels do not
revalue or rewrite historical data. All existing freshness decisions and source
timestamps remain authoritative.

No credentials, migrations, paid services or extra dependencies are required.

## Validation evidence

- `node scripts/test-i18n.mjs`: **69** assertions. Covers language persistence,
  cross-tab updates, unavailable storage, original English, financial terminology,
  amounts/identifiers, intact machine-readable JSON, MYT date copy and inclusion
  of local assets on all pages.
- Actual-page closed-browser evidence, screenshots and logs:
  `/workspace/tiger-agent-validation/language/`.
- Retained `local.html` has a pre-existing undefined `HISTORY` reference and narrow
  phone overflow. The language check requires no additional overflow and a usable
  language control; it does not silently change that legacy chart or its data.
- Changes include the separately validated UNI LIVE badge correction.

The feature is approved for publication. Actual production verification remains
pending and must not be inferred from fixture results.
