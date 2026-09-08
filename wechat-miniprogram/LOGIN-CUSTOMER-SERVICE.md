# Optional Customer Login and WeChat Customer Service

## Scope

- Catalog, search, specimen history and customer service remain available without login.
- Home adds customer service and My Account entries. Product and stock lists contain no customer-service actions. Product consultation is on detail only, with a fully floating, safe-area-aware 64px round brand-green button at the lower right. A white Lucide headset icon sits above a visible customer-service label; the button also has an accessible name. There is no full-width background behind it.
- Detail inquiries carry the corresponding specimen or identical-stock group link, with a photo and descriptive title. Customers no longer need to copy selection codes; business specimen numbers remain visible.
- Login uses `wx.login` and the server-side WeChat `code2Session` endpoint, not profile or phone-number authorization.
- Accounts are independent of staff, personnel, orders and management privileges. No automatic customer/order association is performed.
- The server stores a keyed hash of the app-scoped OpenID, a random account ID, consent version and timestamps. It does not persist OpenID, UnionID or session_key.
- Seven-day opaque sessions are stored as hashes server-side. At most five active sessions per account. Logout revokes the current session; account deletion cascades to all sessions.
- Public catalog requests do not carry customer tokens. No personal details are sent in customer-service page parameters.

## Configuration Gates

1. Set `WECHAT_MINIPROGRAM_APP_ID=wxb2bc8f8635f3003b` and the corresponding `WECHAT_MINIPROGRAM_APP_SECRET` only in the backend environment. Never commit the secret or include it in the Mini Program package.
2. Set `WECHAT_MINIPROGRAM_IDENTITY_SECRET` to a stable random value of at least 32 characters. If blank, the server uses `AUTH_SESSION_SECRET`. Preserve the selected secret across upgrades and credential rotation; changing it would produce new visitor identities. Back it up with protected server configuration.
3. Deploy the integrated backend before enabling client login. `/api/mini/config` indicates configuration presence, not proof that credentials work. An actual `wx.login` and code exchange is required to verify activation.
4. In the WeChat public platform customer-service management, bind `marineforest2024` as a receiving customer-service operator. The owner may need to scan/confirm. A client-side WeChat handle alone cannot bind an operator or route the native contact conversation.
5. Update the platform privacy declaration before uploading/review: app-scoped user identifier for optional login; writing the customer-service handle to the clipboard; customer-initiated contact conversation. Do not declare collection of profile, phone, precise location or photo library merely because login exists.
6. Retest on a real phone after binding. WeChat's native contact UI offers a suggested product card; the user still chooses to send it. It does not silently send a chat message. Customer-service response availability/windows are controlled by WeChat.

The My Account screen also provides copying `marineforest2024` as an alternative contact method. WeChat currently documents that native `button open-type="contact"` is not supported on HarmonyOS. Keep the alternative contact method available.

Native contact and its suggested product card do not depend on optional login or the server AppSecret. Operator binding and real-device conversation delivery are separate from login activation.

## Routes and Security

All `/api/mini/*` routes are handled in the dedicated customer handler, before staff authentication and business-state initialization. Unknown paths/methods return 404; they never fall through into staff endpoints.

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/mini/config` | GET | Public; readiness boolean and privacy version only |
| `/api/mini/login` | POST | One-time WeChat code, current consent version, JSON <= 1 KB, rate limit |
| `/api/mini/session` | GET | Customer bearer token |
| `/api/mini/logout` | POST | Customer bearer token; idempotent revocation |
| `/api/mini/account/delete` | POST | Customer bearer token; UI confirmation |

Tokens never use staff cookies. Code exchange has an eight-second timeout, disallows redirects and suppresses upstream credential-bearing errors. Invalid/configuration failures never synthesize a visitor account. Tables initialize lazily under a PostgreSQL advisory lock, without editing `app_state`. SQL uses bound parameters. Login attempts are limited per server process (120/minute globally, 30/minute per socket peer); behind a proxy the peer limit is shared, so reassess this before high-traffic rollout without trusting arbitrary forwarding headers.

## Verification

- Unit tests cover optional login, explicit consent, missing configuration, concurrent-click deduplication, expired code, error redaction, stale sessions and guest contact access.
- Isolated-schema PostgreSQL tests cover repeated login identity, cross-AppID isolation, session hashes, five-session limit, expiry, logout and cascading account deletion. They do not touch inventory/order/personnel tables.
- Identical-stock inquiries carry a group card with available quantity, without claiming that a particular member was selected. Individual inquiries carry the business specimen number where available. Internal IDs are only used in the deep link, not the visible card title. Contact is disabled during refresh to avoid sending stale metadata.
- Real-device login and customer-service delivery remain separate checks; passing fixture tests or uploading a preview does not certify those checks or formal publication.

### 2026-09-09 Validation

- Full repository test command passed 558 tests with no failures or skipped tests, including the isolated PostgreSQL auth lifecycle in `fishroom-prod-clone-backend`.
- Vite production build passed; the existing large-chunk warning remains.
- WeChat Developer Tools preview build passed, 220376 bytes (215.2 KB). Preview artifacts are in the local task output folder `miniprogram-preview-20260909/login-customer-service/`.
- User supplied a WeChat platform screenshot confirming a customer-service operator named MarineForest is bound on 2026-09-09, with a masked handle ending in 2024. Chat delivery has not yet been verified.
- Browser configuration work stopped because the active URL was restricted. No further browser access was attempted after the restriction. Real-device visual review and end-to-end WeChat login are still pending.
- AppSecret server configuration is not verified. The new backend code is not deployed, and this work has not been committed, submitted for review or formally published. Production still reports revision `11458fb7c66f772986d6953d4576a06c39366f40`.

### Product Contact Cards Follow-up

- Added native contact actions to every product and stock card and retained the fixed detail action. Inquiry titles include product name/specification/origin and the business specimen number or identical-stock quantity as appropriate.
- Removed the customer-facing selection-code copy and group-member picker. Group identity, specimen numbers, individual notes and maintenance history remain intact. Existing internal IDs and public deep links remain compatible.
- Full repository tests passed: 563 tests, zero failures and zero skips. Vite build passed with the existing chunk-size warning.
- Native Developer Tools iPhone 5 preview was inspected: the detail action fits the small viewport, the stock-card action remains reachable by scrolling, and contact opens the native simulated conversation instead of navigating into detail. The simulator states that actual conversations require a real device. Observed console warnings concern getSystemInfo/HarmonyOS guidance, SharedArrayBuffer deprecation and unsupported worker telemetry; no JavaScript errors were shown.
- The new phone-preview attempt failed with `code 10: needs login`. A fresh Developer Tools login QR was generated in `miniprogram-preview-20260909/product-contact-cards/`. No new successful preview upload or actual card delivery is claimed yet. This follow-up has not been committed or formally published.

### Detail-only Contact Layout Follow-up

- Removed consultation from both product and stock lists. Their original whole-card navigation remains, including the separate catch-tap video preview control.
- Detail keeps its fixed bottom consultation action, now pure black with white text and a white Lucide icon. Native contact still carries the current specimen/group card without requiring login or copying a code.
- Replaced the oversized page-bottom inset and extra detail padding with a spacer sharing the fixed bar's exact height, including the device safe area. This avoids the exposed gray strip without hiding the final maintenance record.
- Full repository tests passed: 563 tests, zero failures and zero skips. New contracts cover absent list actions, preserved detail-card payload, black/white styling and the shared safe-area height.
- Login is now active in Developer Tools. Native phone-preview compilation succeeded at 218181 bytes (213.1 KB), with artifacts in `miniprogram-preview-20260909/detail-contact-layout/`. This is a preview, not a formal publication or verification of actual customer-service delivery.
- The native simulator's navigation did not complete reliably during this follow-up, including after reopening this project. CSS/WXML contracts and package compilation passed; the updated end-of-page layout still needs real-device visual confirmation. No production data or release state was changed.

### Floating Button Follow-up

- Removed the full-width fixed bottom container entirely. Only the black consultation button is fixed, inset 16px horizontally and 10px above the device bottom safe area. Its surrounding region does not paint or intercept input.
- The in-flow spacer is transparent and derives from the same button height and safe-area inset. List consultation remains absent and the detail contact-card payload is unchanged.
- Full repository tests passed: 563 tests, zero failures and zero skips. Native preview compilation passed at 218031 bytes (212.9 KB); artifacts are in `miniprogram-preview-20260909/floating-contact/`.
- Native iPhone 15 Pro Max simulator checks covered mid-scroll and the bottom of a detail with eight history entries: content is visible below/around the floating button, there is no full-width backdrop or separator, and the last record clears the button. Existing media network failures and simulator WXSS warnings were visible; this check does not certify video playback or real-device customer-service delivery. No formal version was published.

### Login-inclusive Review Preflight (2026-09-09)

- The owner requested deploying and verifying optional login before submitting the combined Mini Program for review; do not hide login and submit a contact-only version instead.
- Final detail contact uses a 64px circular green floating action with a white Lucide headset and visible customer-service label. Product-card context and guest access remain unchanged.
- Full repository tests passed: 563 tests. Vite production build passed with the existing large-chunk warning.
- Production `/api/version` still reports `11458fb7c66f772986d6953d4576a06c39366f40`; `/api/mini/config` returns 401, so the dedicated customer-login backend is not deployed.
- Local Developer Tools reports `login: true`. The public-platform browser connection timed out; this does not prove any review state.
- Deployment preflight is blocked on the existing server connection credential and server-only AppSecret configuration. No production service or database has been changed, and no combined version has been uploaded or submitted for review during this preflight.

Official references:
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html
- https://developers.weixin.qq.com/miniprogram/dev/component/button.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/customer-message.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html
