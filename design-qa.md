# Mini-program catalog: approved compact variant

Date: 2026-09-08

## Visual evidence

- Source: `/Users/xuhaoyuan/.codex/generated_images/019edf7b-cbed-7512-bffd-ea1594ba6d82/exec-5fd35d52-d7c3-4f37-9e75-ce5fccc6bb78.png` (853 x 1844).
- Evidence directory: `/Users/xuhaoyuan/Documents/New project/miniprogram-preview-20260908/`.
- Native implementation: `catalog-compact-390.jpg` (1149 x 768 developer-tool window); content crop `catalog-compact-390-screen.jpg` (244 x 528).
- Full-view comparison: `catalog-reference-normalized.png` and `catalog-compact-normalized.jpg`, both normalized to 390 px width and viewed together. The implementation is an enlarged simulator capture, not a full-resolution device screenshot; do not infer pixel-perfect sharpness from it.
- Additional native check: `catalog-compact-320.jpg`, iPhone 5 / 320 x 568. Standard check: iPhone 12/13 / 390 x 844. Also observed at iPhone 15 Pro Max / 430 x 932.
- State: loaded catalog from the production public API. No mocked stock or changes to production data.

## Findings and intentional differences

- No actionable P0/P1/P2 layout defects in the checked home states. Titles, counts and two-column rows do not overlap at 320, 390 or 430 px.
- Typography: fixed 22 px category headings, 15 px subcategory names and 12 px metadata. System Chinese fonts preserve readability rather than reproducing generated glyph artifacts.
- Layout: white canvas, flat inset category bands, single-line headings/counts, left accent bars, two-column subcategory grid, full-width single-category rows and horizontal rules without vertical dividers or section cards. Rows retain at least 56 px touch height and grow for text.
- Color: teal, ruby, olive and blue groups each have a distinct light tint. Coral styling is present but cannot be visually checked against live content because the current public catalog has no available coral group.
- Assets: original frameless logo and handwritten slogan remain unchanged, at existing native-navigation dimensions. The oversized brand in the generated illustration is intentionally not used; native status bar and capsule need safe space.
- Content: labels/counts are bound to the public catalog. The illustration's coral inventory and abbreviated metadata are not substituted for real data. Empty categories remain hidden according to the existing catalog contract.
- Focused check: inspected header/count alignment and two-column row typography in the normalized pair and native 320 px capture. Screenshot scaling limits assessment of raster sharpness; original brand assets are unchanged.

## Validation

- 13 focused Node tests passed: layout contract/navigation, privacy/cache rules, and video preview regression tests.
- Native WeChat compilation succeeded. Debugger reported zero errors after recompilation and after category navigation; warnings remain and were not treated as proof of zero warnings.
- Tapped a category, verified the corresponding product list and counts, and returned to the catalog through its existing return button.
- Only homepage WXML/WXSS and focused tests changed. Public data logic and video controls are untouched.
- Physical-device visual acceptance remains for the user's preview scan. No production publication or review submission is part of this change.

Comparison history: initial implementation compared with the selected image; no additional visual-fix iteration was required. Differences above are deliberate native-app and real-data constraints.

final result: passed

## Product images and identical-specimen groups

Date: 2026-09-09

- Product-level return navigation is explicitly left aligned, overriding native mini-button margins. Product cards use the configured product image, then the species default or placeholder; actual specimen media remains in the next level.
- Arrival, feeding/health and special-price tags wrap and can coexist. Product tags that apply to only part of the inventory include the matching quantity.
- Groups require matching product, site, batch, tank, arrival, status, price, notes and complete maintenance history. Private history is represented by an opaque server-generated signature. Missing or ambiguous evidence keeps fish separate; list-level media summaries are not used as proof of equality.
- Display grouping does not merge database records. Each member retains its original selection code; switching members loads that fish's detail and temporarily disables copying. The member picker has a bounded, scrollable height for larger groups.
- Existing central catalog visibility, exclusion and quantity-cap policies remain intact. No production inventory records were changed.

### Evidence and validation

- Native WeChat simulator captures in the evidence directory above: `product-default-tags-320.jpg`, `product-default-tags-430.jpg`, `specimen-groups-430.jpg`, and `group-detail-code-switch-430.jpg`.
- Checked 320 px and 430 px product views: default images, left navigation, wrapping tags, aligned prices, and no horizontal text overflow. The developer-tool screenshots are scaled window captures, not physical-device renders.
- A live product with 56 specimens displayed as five distinct groups. Sampled members from four groups had identical full public histories. A 13-member detail picker scrolled to its last member, updated the selection code, re-enabled copying, and retained one shared history display.
- 541 Node tests passed, including the actual PostgreSQL history-signature fixture and public API privacy/visibility regression tests. Vite production build passed; its existing large-chunk warning remains.
- Read-only clone benchmark: full maintenance data was about 17.4 MB; SQL history digests about 0.87 MB, with a roughly 339 ms projection query and 19 ms application signature step in this run. These measurements are not a production latency guarantee.
- Backend revision `78bc21b0d8967f2397f3078bbd9fc2579efd76fa` was deployed after verifying the previous live revision was merged and taking a database backup. Health, version and live catalog checks passed. Existing frontend and database containers were not recreated.
- Mini-program delivery is a preview only. No official upload, review submission or publication was performed. Physical-device acceptance remains for the user's preview scan.
