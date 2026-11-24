# 订单管理本地测试版 · Design QA

Date: 2026-11-24
Scope: order-list toolbar, filters, contextual export selection, desktop/mobile integration. Local only; no production deployment or shared baseline push.

## Visual target and evidence

- Selected direction: design 1 (chosen as the conservative existing-product layout after the user asked to implement locally).
- Source: /Users/xuhaoyuan/.codex/generated_images/01a00a9b-b53c-7610-8cd6-5b29b236c6f9/exec-a5266ce9-d2fc-4cbe-b928-c40ac3cf1c7b.png
- Implementation: http://127.0.0.1:8787 → 销售管理 → 订单管理.
- Source and desktop capture: 1487 × 1058 px; desktop CSS viewport 1487 × 1058, DPR 1.
- Final desktop: .data/orders-ui-qa/desktop-final.png
- Full-view combined comparison: .data/orders-ui-qa/desktop-comparison.jpg
- Focused toolbar combined comparison: .data/orders-ui-qa/toolbar-comparison.jpg
- Mobile CSS viewport/capture: 390 × 844 px, DPR 1. No horizontal overflow (scrollWidth = innerWidth = 390).
- Final mobile: .data/orders-ui-qa/mobile-final.png
- Mobile before/after combined comparison: .data/orders-ui-qa/mobile-comparison.jpg
- Date-range drawer: .data/orders-ui-qa/mobile-filter-range.png
- State: 南京; all orders; no selected rows or active filters. Source uses sample data; implementation uses the independent local production-data copy (2,202 Nanjing orders). These differences are intentional, not fabricated production state.

## Findings and comparison history

1. [P2, fixed] Global mobile button minimum height stretched order switches and checkboxes vertically. Evidence: mobile-default.png. Added order-page-scoped control sizing, retained larger label click targets; mobile-final.png and mobile-comparison.jpg confirm normal proportions. Mobile summary pairs retain two columns so each card is more compact.
2. Capturing immediately after changing browser viewport produced one incomplete frame (489 px wide). Re-captured after observing the final DOM viewport and verified the saved image is 1487 × 1058 before regenerating comparisons. Incomplete comparison was replaced, not used to pass QA.
3. No remaining actionable P0/P1/P2 findings in the final combined comparisons.

## Required fidelity surfaces

- Typography: uses the existing system font and 14 px root, with the established table/body scale. Preserves the real product's denser typography rather than enlarging the whole app to match the illustrative mock. Headline, active status tab and order number have clear hierarchy. Labels remain legible and do not clip at tested widths.
- Spacing/layout: header actions are grouped at the right; status navigation, search/filter row, result count and table are separate. Dates and wholesale are in a sheet. Zero-selection export bar is removed. Full existing navigation is retained rather than replacing it with the mock's thin illustrative sidebar. Desktop table displays 20 rows per page; mobile keeps existing 12-row cards.
- Colors/tokens: existing gray background, white cards, charcoal primary actions, border and focus tokens retained. Existing source/payment/fulfillment status colors remain because this task does not redesign those business indicators.
- Images/icons: existing Marine Forest logo retained. UI controls use existing Lucide icons. No placeholder raster assets or recreated brand art.
- Copy/content: “我的未完成” preserves the original responsible-person/unfinished scope. “已出库待发货” clearly names the actual filter and excludes pickup. Today/tomorrow are planned dates and may include already-shipped orders; explanations are present in the sheet and button titles. Counts on shortcuts refer to current-site totals; result count reflects combined filters. All orders includes cancelled orders.

## Interaction verification

Performed through the in-app browser against the actual local app:

- Desktop page selection: 20 rows on page 1, 40 after also selecting page 2.
- Search for SO-2026-3341 clears previous selection, shows one matching order and selects only that order.
- Mobile page selection: 12 rows. Explicit select-all-results chooses exactly 2,202 matching orders.
- Switching to Jiangyin clears Nanjing selection; restored Nanjing afterward.
- Pending-outbound filter shows 7 orders without automatically selecting them. Export dialog explicitly limits output to selected pending-outbound items.
- Today shows 5 matching orders; tomorrow shows zero with a clear empty state and disabled page-selection checkbox; repeated shortcut click clears the condition.
- My unfinished combines with the planned date and selects the unfinished status; clear all restores all orders.
- Native calendar selection verified order dates 2026-11-23 through 2026-11-24 combined with planned shipment 2026-11-24 through 2026-11-25 (3 results). Removing the shipment-date chip fully clears both shipment boundaries while retaining the order-date range (6 results).
- Wholesale filter, condition chips and clear all operate without changing unrelated business data.
- New-order source chooser and payment-claim dialog open successfully; closed without submitting business changes.
- No browser console errors observed.
- Existing targeted checks: 25/25 pass across order-date-filters, orderSearch, OrderWholesaleTag and StockPickerBioDialog. Production build succeeds.
- No actual order creation, financial verification, shipment or data mutation was submitted; export dialog scope was checked without writing business data.

## Local runtime evidence

Frontend source commit: d28f2fed96c6ad7c16beed5deca3a786d42b5153.
Frontend image: fishroom-local-test-frontend:d28f2fed96c6ad7c16beed5deca3a786d42b5153.
Built and container JS SHA-256 match: ba4c440a494afb93f65302e8f959ca8f11f7a40780bd1f9510a75726d9010005.
Backend and database containers retained; backend API version remains its existing local version. Startup and stop shortcuts include the frontend-only Compose override, so restarting preserves the new local UI.

## Follow-up polish

- [P3] Existing detailed status tags and mobile card information remain relatively dense. Revisit only after user feedback on this local version.

final result: passed


## 2026-11-25 amendment: wholesale choice during creation

- User requested wholesale selection directly at the first new-order step. Added an independent ordinary/wholesale type selector above the existing source cards and in the subsequent form summary.
- Choosing a source or returning to the source screen preserves classification; closing and reopening resets to ordinary. The submit label and confirmation reflect wholesale.
- The create route saves the initial wholesale flag, server-generated operator/time, stock reservation and operation log in one transaction. Subsequent flag changes retain the existing update permission and concurrency protection.
- 16 backend helper/integration checks and 16 existing frontend wholesale/fish-detail regression checks passed. Frontend production build passed (existing large-bundle warning remains).
- Real local browser checks: 1487 × 1058 desktop; 390 × 844 mobile. Wholesale state is visibly selected; source/back navigation and reopen reset verified; mobile scrollWidth equals innerWidth (390). No console errors. No business records were submitted in the local data copy; persistence/rollback were verified in isolated route fixtures.
- Captures: .data/wholesale-create-qa/desktop-wholesale.png, mobile-wholesale.png, mobile-form.png, chooser-detail.png.
- Local frontend and backend deployed from 7f59a498de0acb265683143201954095f981ecef. Both healthy; API revision matches. Built frontend asset SHA-256 matches runtime: bbbf07fa5636c309fb1195c2af032521b8d2a534b89c91195579a405ec31ac42. Backend wholesale helper SHA-256 matches runtime: 64eb62379f3be6de55bb7dbca0d117b9262210b93202da2fb84aa4a4d8a6e450.
- Database container unchanged (c4f5ec96dd2d); pre-update local dump saved privately. Backend remains on internal local-test network, local database fishroom_test, background tasks disabled and cloud integration credentials empty. Restart shortcuts retain the updated frontend/backend override.
- No production deployment or shared-baseline push. Final amendment result: passed.


## 2026-11-25 correction: six parallel order entries

This section supersedes the independent type selector described above. User clarified that wholesale is the sixth peer entry; the other five entries create retail orders.

- First step is now six cards: 抖音、闲鱼、微拍堂、线上私域、线下自提、批发. No ordinary/wholesale toggle remains. Form classification derives from the selected source, so returning and choosing any retail card cannot retain a stale wholesale flag.
- New wholesale source uses the customer/address/payment/planned-shipment flow. Address entry, edit preservation, detail display and export were checked and aligned with private-channel shipping orders.
- Server derives new classification from source, rejects conflicting client flags, and changes classification atomically when an editable order crosses into/out of wholesale. Existing historical manual tags retain compatibility. Wholesale-source completed orders accurately state that their type cannot be changed.
- Verification: 31 backend checks, 17 frontend regression checks and production build passed. Browser verified all five retail forms after wholesale, wholesale address field, desktop 1487 × 1058 and mobile 390 × 844 with no horizontal overflow, no console errors. No business records submitted in the local copy; persisted create/update/rollback tested with isolated fixtures.
- Local source/image/API revision: 8bf8e47c2f5272f5f4784d07e43368e52782b50a. Frontend built/runtime SHA-256 matches: c41d4da1e5e2ba815759e3968c86a67c3bfa46e59bc31e110ffb0186fbaeff0f. Wholesale backend helper built/runtime SHA-256 matches: 043a6141e359dc07fe92aef415badf6159fac7ab7ed45ac0b23541da8f666f4d. Services healthy, database container unchanged (c4f5ec96dd2d). Production untouched.
- Evidence: .data/wholesale-six-qa/desktop.png, chooser-detail.png, mobile-chooser.png, mobile-form.png.
- Final result: passed; no outstanding P0/P1/P2 findings.
