import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite, Panel, Context, storedSession;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => storedSession, removeItem: () => { storedSession = null; } } } });
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ OrderFollowupPanel: Panel } = await vite.ssrLoadModule("/src/app/components/OrderFollowupPanel.tsx"));
  ({ StoreContext: Context } = await vite.ssrLoadModule("/src/app/store.ts"));
});
after(async () => {
  await vite?.close();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
});
const user = { username: "synthetic-worker", role: "staff", visibleSiteIds: ["nanjing"] };
const login = () => { storedSession = JSON.stringify({ ...user, token: "synthetic-session", expiresAt: Date.now() + 100000 }); };
const render = (activeSiteId = "nanjing", viewer = user) => renderToStaticMarkup(createElement(Context.Provider, { value: { state: { user: viewer }, activeSiteId } }, createElement(Panel, { orderId: "synthetic-order", siteId: "nanjing" })));

test("logged-out or replaced identity never renders a follow-up editor", () => {
  storedSession = null;
  assert.match(render(), /登录状态已变化/);
  login();
  const html = render("nanjing", { ...user, username: "other-worker" });
  assert.match(html, /登录状态已变化/);
  assert.doesNotMatch(html, /<textarea|保存回访记录/);
});

test("switching to another concrete site hides order history and draft entry", () => {
  login(); const html = render("jiangyin");
  assert.match(html, /请选择订单所在的具体场地/);
  assert.doesNotMatch(html, /<textarea|刷新|synthetic-order/);
});

test("an authorized context shows loading without a premature canCreate assumption", () => {
  login(); const html = render();
  assert.match(html, /aria-label="订单回访记录"/);
  assert.match(html, /正在加载回访记录/);
  assert.match(html, /刷新/);
  assert.doesNotMatch(html, /<textarea|保存回访记录|尚无回访记录/);
  assert.match(render("all"), /正在加载回访记录/);
});
