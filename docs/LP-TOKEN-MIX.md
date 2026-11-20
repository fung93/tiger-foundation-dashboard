# LP card token composition — 20 November 2026

The owner requests token percentages in place of distance-to-edge percentages
on all LP cards, and explicitly requests **push**.

- [x] Inspect the shared LP Book, widget and Current UNI LP renderer and readers.
- [x] Calculate each principal token's value share at the observed pool price.
  Use normalized token amounts and the decimal-adjusted token1/token0 price,
  compare both legs in token1 units, and match the card's readable pair order.
  This works for V3, Arc V4 and Fables without an additional price service.
- [x] Exclude claimed/unclaimed fees and rewards from principal composition.
  Real single-sided inventory shows 100/0; missing or invalid state is unavailable.
- [x] Replace the old center text with two token labels and percentages beneath
  the range endpoints. Keep range prices, marker, badges and backend risk data.
  Round displayed shares together so they total **100.00%**.
- [x] Add English/Chinese copy, preserve both themes and the UNI pink/blue line,
  version shared card and translation assets, and bump the app cache to **183**.
- [x] Pass **42** composition/renderer checks and **102** actual ABI reader
  checks, including V3 single-sided and Fables symmetric principal with fees.
- [x] Pass existing **294** LP Book/widget refresh/failure/recovery checks and
  **73** language checks and **388** Base reader/accounting checks.
- [x] Pass **1,104** Chromium checks on LP Book Live, the standalone widget and
  UNI Trade at 320/375/1366 px, both themes/languages: token labels and percentages,
  single-sided 100/0, missing/recovered readings, translated basis/accessibility
  labels, intact range/marker/UNI gradient, no horizontal overflow and unchanged
  fees/P&L/net. Inspect the 320 px LP card screenshot.
- [x] `npm run check` passes all **91** suites, including syntax, inline scripts
  and identical Portfolio copies. Final diff checks pass; no financial JSON
  history is edited.
- [ ] Publish and verify fresh production API/card assets.

No accounting histories, LP Book version, P&L, APR, fees, wallet permissions,
Lending per-visit settings or persistent agent policy change. The legacy API
also uses the normalized composition, so stripping its internal raw fields does
not remove the new reading. No new credential, paid provider or migration is
required. Production verification remains pending until publication.
