import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, history, panel, orders;
const originalWindow = globalThis.window;
before(async () => {
  globalThis.window = { localStorage: { getItem: () => null, removeItem() {} } };
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  history = await server.ssrLoadModule("/src/app/components/StockOrderReleaseHistory.tsx");
  panel = await server.ssrLoadModule("/src/app/components/StockStatusHistoryPanel.tsx");
  orders = await server.ssrLoadModule("/src/app/components/OrdersView.tsx");
});
after(async () => {
  await server?.close();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

const record = {
  id: "release-1", stockItemId: "fish-a", eventType: "order_release", previousSold: true, sold: false,
  orderId: "order-a", orderNo: "SO-2026-3011", previousStatus: "healthy", status: "healthy",
  changedAt: "2026-11-04T01:02:03.000Z", operator: "staff-a", operatorName: "员工甲", source: "order_return_item",
};

test("release audit is shown as sold to unsold, not a fabricated health change", () => {
  for (const html of [renderToStaticMarkup(createElement(history.StockOrderReleaseDetails, { record })),
    renderToStaticMarkup(createElement(panel.StockStatusHistoryList, { records: [record] }))]) {
    for (const value of ["订单取消：", "SO-2026-3011", "状态调整：已售", "未售", "操作时间：", "09:02:03", "操作员：", "员工甲", "staff-a"]) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /未知状态|正常.*正常/);
    assert.doesNotMatch(html, /<button|改时间|删除记录/);
  }
  const html = renderToStaticMarkup(createElement(history.StockOrderReleaseDetails, { record }));
  assert.match(html, /此记录不表示整单取消，也不表示已退款/);
});

test("release audit date aligns with existing China wall-clock timeline and preserves snapshot after order removal", () => {
  const result = history.stockOrderReleaseTimelineEvents([record]);
  assert.deepEqual(result, [{ type: "order_release", date: "2026-11-04T09:02:03", record }]);
  const timeline = [{ date: "2026-11-04T08:00:00", type: "record" }, ...result, { date: "2026-11-04T10:00:00", type: "record" }].sort((a, b) => a.date.localeCompare(b.date));
  assert.equal(timeline[1].record.orderNo, "SO-2026-3011");
});

test("release history fetches all filtered pages, with no-store and correct fish scope", async () => {
  const calls = [];
  const result = await history.fetchStockOrderReleaseHistory("fish-a", new AbortController().signal, async (url, options) => {
    const query = new URL(url, "http://localhost").searchParams;
    calls.push(query);
    assert.equal(query.get("stockItemId"), "fish-a");
    assert.equal(query.get("eventType"), "order_release");
    assert.equal(query.get("limit"), "100");
    assert.equal(options.cache, "no-store");
    const offset = Number(query.get("offset"));
    return { ok: true, json: async () => ({ ok: true, stockItemId: "fish-a", offset, total: 2, records: [{ ...record, id: `release-${offset}` }] }) };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].get("offset"), "1");
  assert.equal(result.length, 2);
});

test("incomplete or mismatched release responses never render another fish or a health record", async () => {
  for (const override of [{ stockItemId: "fish-b" }, { eventType: undefined }, { sold: true }, { orderId: "" }, { changedAt: "bad" }]) {
    await assert.rejects(history.fetchStockOrderReleaseHistory("fish-a", new AbortController().signal, async () => ({ ok: true,
      json: async () => ({ ok: true, stockItemId: "fish-a", offset: 0, total: 1, records: [{ ...record, ...override }] }),
    })), /不匹配/);
  }
  await assert.rejects(history.fetchStockOrderReleaseHistory("fish-a", new AbortController().signal, async () => ({ ok: true,
    json: async () => ({ ok: true, stockItemId: "fish-a", offset: 0, total: 1, records: [] }),
  })), /未加载完整/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(history.fetchStockOrderReleaseHistory("fish-a", controller.signal, async () => assert.fail("no aborted request")), { name: "AbortError" });
});

test("load failures are explicit and can retry, not mistaken for no cancellation records", () => {
  const html = renderToStaticMarkup(createElement(history.StockOrderReleaseLoadState, { loading: false, error: "网络连接失败", retry() {} }));
  assert.match(html, /role="alert"/); assert.match(html, /网络连接失败/); assert.match(html, /重新加载/); assert.match(html, /min-h-11/);
  const loading = renderToStaticMarkup(createElement(history.StockOrderReleaseLoadState, { loading: true, error: "", retry() {} }));
  assert.match(loading, /role="status"/);
  assert.doesNotMatch(loading, /暂无/);
});

test("completed shipped orders expose refund action only to editors; ordinary shipped orders keep damage workflow", () => {
  for (const status of ["pending", "confirmed", "completed", "cancelled"]) for (const shipped of [false, true]) for (const canUpdate of [false, true]) {
    const expected = canUpdate && (status === "completed" || !shipped);
    assert.equal(orders.canRegisterOrderRefund({ status }, shipped, canUpdate), expected);
    const html = renderToStaticMarkup(createElement(orders.OrderRefundAction, { order: { status }, hasActuallyShipped: shipped, canUpdate, onOpen() {} }));
    assert.equal(html.includes("登记退款"), expected, `${status}/${shipped}/${canUpdate}`);
    if (expected) assert.match(html, /min-h-11/);
  }
  assert.equal(orders.canRegisterOrderRefund(null, false, true), false);
  const saving = renderToStaticMarkup(createElement(orders.OrderRefundAction, { order: { status: "completed" }, hasActuallyShipped: true, canUpdate: true, saving: true, onOpen() {} }));
  assert.match(saving, /disabled=""/);
});

test("both biological timelines receive immutable release events independently of the collapsed state history", async () => {
  for (const name of ["DailyView", "OrdersView"]) {
    const source = await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8");
    assert.match(source, /useStockOrderReleaseHistory\(/);
    assert.match(source, /stockOrderReleaseTimelineEvents\(orderReleaseHistory\.records\)/);
    assert.match(source, /<StockOrderReleaseLoadState \{\.\.\.orderReleaseHistory\} \/>/);
    assert.match(source, /type === "order_release" \? <StockOrderReleaseDetails/);
    assert.match(source, /<StockStatusHistoryPanel/);
  }
  const source = await readFile(new URL("./StockOrderReleaseHistory.tsx", import.meta.url), "utf8");
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /isNewCustomerSessionCurrent\(session\)/);
  assert.match(source, /snapshot\.key === key/);
});

test("refund submission locks duplicates, reuses draft id, scopes response to viewer and discloses inventory effects", async () => {
  const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("const submitOrderRefund ="), source.indexOf("const completeOrder ="));
  assert.match(submit, /refundSaveLock\.current/);
  assert.match(submit, /canRegisterOrderRefund\(order, hasActuallyShipped, permission\.canUpdate\)/);
  assert.match(submit, /captureNewCustomerSession\(\)/);
  assert.match(submit, /isNewCustomerSessionCurrent\(session\)/);
  assert.match(submit, /refundContextRef\.current !== requestContext/);
  assert.match(submit, /applyOrderApiResult\(setState, result, \{ session: session!/);
  assert.match(submit, /\.\.\.draft/);
  assert.doesNotMatch(submit, /id: uid\(\)/);
  const dialog = source.slice(source.indexOf("function OrderRefundDialog("), source.indexOf("export function canRegisterOrderRefund"));
  assert.match(dialog, /id: uid\(\)/);
  assert.match(dialog, /不自动退鱼、不取消已售标记/);
  assert.match(dialog, /role="alert"/);
  assert.match(dialog, /disabled=\{busy\}/);
  assert.match(dialog, /onUploadingChange=\{setProofUploading\}/);
  assert.match(source, /<OrderRefundAction[^]*?<div className="flex-1" \/>/);
});
