import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, OrderCompletionActions;
before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, entries: [] },
    esbuild: { jsx: "automatic" },
  });
  ({ OrderCompletionActions } = await server.ssrLoadModule("/src/app/components/OrderCompletionActions.tsx"));
});
after(async () => { await server?.close(); });

const render = (checks, saving = false) => renderToStaticMarkup(createElement(OrderCompletionActions, {
  checks, saving, orderNo: "SO-2026-TEST", amountDue: 120, verifiedNetReceived: 120,
  onNavigate() {}, async onComplete() { return true; },
}));
const buttons = html => html.match(/<button\b[\s\S]*?<\/button>/g) || [];

test("unmet completion requirements stay inspectable while completing the order is disabled", () => {
  const html = render([
    { id: "delivery", label: "签收已完成", complete: true },
    { id: "finance", label: "款项已核验", complete: false, detail: "有退款待核验", target: "cashier" },
  ]);
  const [checklist, completion] = buttons(html);
  assert.match(checklist, /完成条件 · 1项待办/);
  assert.doesNotMatch(checklist, /disabled=""/);
  assert.match(completion, /disabled=""/);
  assert.match(completion, /完成订单/);
});

test("ready state exposes two labelled dialog triggers without activating completion", () => {
  const html = render([{ id: "finance", label: "款项已核验", complete: true }]);
  assert.match(html, /role="group" aria-label="订单完成操作"/);
  assert.match(html, /完成条件 · 全部满足/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.equal(buttons(html).length, 2);
  for (const button of buttons(html)) assert.match(button, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /role="alertdialog"/);
});

test("missing checks do not unlock completion and in-flight saves disable both triggers", () => {
  const unknown = render([]);
  assert.match(unknown, /完成条件 · 待检查/);
  assert.match(buttons(unknown)[1], /disabled=""/);
  const saving = render([{ id: "finance", label: "款项已核验", complete: true }], true);
  for (const button of buttons(saving)) assert.match(button, /disabled=""/);
  assert.match(saving, /完成中…/);
});
