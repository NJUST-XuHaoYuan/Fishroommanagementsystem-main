import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let OrderAcquisitionBadge;
let OrderAcquisitionTag;
let mergeAcquisitionOrderTags;
before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, entries: [] },
    esbuild: { jsx: "automatic" },
  });
  ({ OrderAcquisitionBadge, OrderAcquisitionTag, mergeAcquisitionOrderTags } = await server.ssrLoadModule("/src/app/components/OrderAcquisitionTag.tsx"));
});
after(async () => { await server?.close(); });

const render = (props = {}) => renderToStaticMarkup(createElement(OrderAcquisitionTag, {
  order: { id: "order-1" },
  isAdmin: true,
  saving: false,
  error: "",
  updatedAtLabel: "",
  onToggle() {},
  ...props,
}));

test("acquisition labels require an explicit saved true value; legacy orders stay unmarked", () => {
  assert.equal(renderToStaticMarkup(createElement(OrderAcquisitionBadge, {})), "");
  assert.equal(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { marked: false })), "");
  assert.equal(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { marked: "true" })), "");
  assert.match(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { marked: true })), /获新订单/);
  assert.match(render(), /未标记/);
  assert.match(render(), /标记为获新订单/);
  assert.match(render(), /不影响金额、状态或提成/);
});

test("only administrators receive the reversible marking action; staff have read-only labels", () => {
  const marked = { id: "order-1", isAcquisitionOrder: true, acquisitionOrderUpdatedByName: "管理员甲" };
  assert.match(render({ order: marked }), /取消获新标记/);
  assert.equal(render({ isAdmin: false }), "");
  const staff = render({ order: marked, isAdmin: false, updatedAtLabel: "2026-09-28 09:15" });
  assert.match(staff, /获新订单/);
  assert.match(staff, /最近调整：管理员甲 · 2026-09-28 09:15/);
  assert.doesNotMatch(staff, /<button|取消获新标记|标记为获新订单/);
});

test("pending and failed saves are accessible and never show an optimistic marked state", () => {
  const pending = render({ saving: true });
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /disabled=""/);
  assert.match(pending, /保存中…/);
  assert.match(pending, /未标记/);
  const failed = render({ error: "保存失败，请重试" });
  assert.match(failed, /role="alert"[^>]*>保存失败，请重试/);
  assert.match(failed, /标记为获新订单/);
  assert.match(failed, /aria-describedby="order-acquisition-help-order-1"/);
});

test("order detail sends the dedicated server mutation with the observed value and version", async () => {
  const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  assert.match(source, /postOrderApi\("orders\/acquisition-tag",\s*\{\s*orderId,\s*isAcquisitionOrder,\s*expectedIsAcquisitionOrder: order\.isAcquisitionOrder === true,\s*expectedAcquisitionOrderUpdatedAt: order\.acquisitionOrderUpdatedAt \?\? "",/);
  assert.match(source, /if \(!permission\.isAdmin\)/);
  assert.match(source, /if \(!order \|\| acquisitionTagRequestPending\.current\) return/);
  assert.match(source, /ORDER_ACQUISITION_TAG_CONFLICT/);
  assert.match(source, /applyAcquisitionTagResult\(result\)/);
  assert.match(source, /applyAcquisitionTagResult\(\{ order: error\.payload\.order \}\)/);
  assert.match(source, /<OrderAcquisitionBadge marked=\{order\.isAcquisitionOrder\}/);
  assert.match(source, /order\.isAcquisitionOrder === true \? "获新订单" : ""/);
});

test("tag responses update only metadata and cannot overwrite newer order edits or reinsert missing orders", () => {
  const current = [{ id: "order-1", status: "completed", discount: 50, siteId: "nanjing", items: [{ price: 300 }] }];
  const incoming = {
    id: "order-1", isAcquisitionOrder: true,
    acquisitionOrderUpdatedAt: "2026-09-28T01:00:00.000Z",
    acquisitionOrderUpdatedBy: "admin", acquisitionOrderUpdatedByName: "管理员甲",
    status: "confirmed", discount: 0, siteId: "jiangyin", items: [],
  };
  const [updated] = mergeAcquisitionOrderTags(current, incoming);
  assert.equal(updated.isAcquisitionOrder, true);
  assert.equal(updated.acquisitionOrderUpdatedByName, "管理员甲");
  assert.equal(updated.status, "completed");
  assert.equal(updated.discount, 50);
  assert.equal(updated.siteId, "nanjing");
  assert.deepEqual(updated.items, [{ price: 300 }]);
  assert.deepEqual(mergeAcquisitionOrderTags([], incoming), []);
  assert.strictEqual(mergeAcquisitionOrderTags(current, { ...incoming, id: "missing" })[0], current[0]);
  const newer = { ...updated, isAcquisitionOrder: false, acquisitionOrderUpdatedAt: "2026-09-28T01:00:01.000Z" };
  assert.strictEqual(mergeAcquisitionOrderTags([newer], incoming)[0], newer);
});
