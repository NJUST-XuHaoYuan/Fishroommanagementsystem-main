import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let ui;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ui = await server.ssrLoadModule("/src/app/components/OrderWholesaleTag.tsx");
});
after(async () => { await server?.close(); });

const renderPanel = (props = {}) => renderToStaticMarkup(createElement(ui.OrderWholesaleTag, {
  order: { id: "order-1", isWholesaleOrder: false }, viewer: { username: "sales-a", role: "staff" }, canUpdate: true, onOrderUpdated() {}, ...props,
}));

test("wholesale badges distinguish explicit order tags from absent or false values", () => {
  for (const marked of [undefined, false]) {
    assert.equal(renderToStaticMarkup(createElement(ui.OrderWholesaleBadge, { marked })), "");
  }
  const markup = renderToStaticMarkup(createElement(ui.OrderWholesaleBadge, { marked: true }));
  assert.match(markup, /批发订单/);
  assert.match(markup, /不代表客户类型/);
});

test("filter uses the independent order flag and never infers retail or wholesale from customer type", () => {
  const orders = [{ id: "a", customerType: "B" }, { id: "b", customerType: "C", isWholesaleOrder: true }, { id: "c", isWholesaleOrder: false }];
  assert.deepEqual(orders.filter(order => ui.matchesWholesaleOrderFilter(order, "all")).map(order => order.id), ["a", "b", "c"]);
  assert.deepEqual(orders.filter(order => ui.matchesWholesaleOrderFilter(order, "wholesale")).map(order => order.id), ["b"]);
  assert.deepEqual(orders.filter(order => ui.matchesWholesaleOrderFilter(order, "unmarked")).map(order => order.id), ["a", "c"]);
  const markup = renderToStaticMarkup(createElement(ui.OrderWholesaleFilter, { value: "unmarked", onChange() {} }));
  assert.match(markup, /筛选订单批发标记/);
  assert.match(markup, /全部订单/);
  assert.match(markup, /未标记批发/);
  assert.doesNotMatch(markup, /零售|B端|C端/);
});

test("order update permission controls the reversible action and status does not prevent tagging", () => {
  assert.match(renderPanel(), /标记为批发订单/);
  for (const status of ["pending", "confirmed", "completed", "cancelled", "damaged"]) {
    assert.match(renderPanel({ order: { id: "order-1", status, isWholesaleOrder: true } }), /取消批发标记/);
  }
  const readOnly = renderPanel({ canUpdate: false, order: { id: "order-1", isWholesaleOrder: true } });
  assert.match(readOnly, /当前账号仅可查看/);
  assert.doesNotMatch(readOnly, /<button/);
  assert.match(renderPanel(), /不改变客户类型、订单金额、提成或发货流程/);
  assert.match(renderPanel(), /点击后直接保存，可随时取消/);
  assert.match(renderPanel(), /min-h-\[44px\]/);
});

test("panel shows named actor and fixed Beijing timestamp for mark and removal", () => {
  const order = { id: "order-1", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z", wholesaleOrderUpdatedBy: "sales-a", wholesaleOrderUpdatedByName: "销售甲" };
  const markup = renderPanel({ order });
  assert.match(markup, /最近标记/);
  assert.match(markup, /销售甲（sales-a）/);
  assert.match(markup, /2026\/11\/02 10:03:04/);
  assert.match(markup, /北京时间/);
  assert.match(renderPanel({ order: { ...order, isWholesaleOrder: false } }), /最近取消/);
});

test("metadata merge does not roll back order content, remove current fields, or revive deleted orders", () => {
  const current = [{ id: "order-1", status: "completed", customerId: "customer-new", discount: 50, newCustomerApproval: { status: "approved" }, items: [{ id: "latest-item" }], isWholesaleOrder: false }];
  const incoming = { id: "order-1", status: "pending", customerId: "customer-old", discount: 0, items: [], isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z", wholesaleOrderUpdatedBy: "admin", wholesaleOrderUpdatedByName: "管理员" };
  const [merged] = ui.mergeWholesaleOrderTags(current, incoming);
  assert.equal(merged.isWholesaleOrder, true);
  assert.equal(merged.status, "completed");
  assert.equal(merged.customerId, "customer-new");
  assert.equal(merged.discount, 50);
  assert.strictEqual(merged.items, current[0].items);
  assert.strictEqual(merged.newCustomerApproval, current[0].newCustomerApproval);
  assert.deepEqual(ui.mergeWholesaleOrderTags([], incoming), []);
  assert.strictEqual(ui.mergeWholesaleOrderTags(current, { ...incoming, id: "missing" })[0], current[0]);
  assert.strictEqual(ui.mergeWholesaleOrderTags(current, { id: "order-1" })[0], current[0]);
  assert.equal(current[0].isWholesaleOrder, false);
});

test("metadata merge ignores stale responses and allows a newer removal timestamp", () => {
  const current = [{ id: "order-1", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z" }];
  assert.strictEqual(ui.mergeWholesaleOrderTags(current, { id: "order-1", isWholesaleOrder: false, wholesaleOrderUpdatedAt: "2026-11-02T02:03:03.000Z" })[0], current[0]);
  assert.strictEqual(ui.mergeWholesaleOrderTags(current, { id: "order-1", isWholesaleOrder: false })[0], current[0]);
  const updated = ui.mergeWholesaleOrderTags(current, { id: "order-1", isWholesaleOrder: false, wholesaleOrderUpdatedAt: "2026-11-02T02:03:05.000Z", wholesaleOrderUpdatedBy: "sales-a" })[0];
  assert.equal(updated.isWholesaleOrder, false);
  assert.equal(updated.wholesaleOrderUpdatedBy, "sales-a");
});

test("general order responses retain newer tags while applying business changes and their deletion set", () => {
  const current = [
    { id: "order-1", status: "pending", isWholesaleOrder: false, wholesaleOrderUpdatedAt: "2026-11-02T02:03:05.000Z", wholesaleOrderUpdatedBy: "sales-b" },
    { id: "deleted-by-response", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:06.000Z" },
  ];
  const incoming = [{ id: "order-1", status: "completed", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z", wholesaleOrderUpdatedBy: "sales-a" }];
  const result = ui.retainNewerWholesaleOrderTags(current, incoming);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "completed");
  assert.equal(result[0].isWholesaleOrder, false);
  assert.equal(result[0].wholesaleOrderUpdatedBy, "sales-b");
  assert.deepEqual(ui.retainNewerWholesaleOrderTags(current, []), []);
  const newest = { ...incoming[0], wholesaleOrderUpdatedAt: "2026-11-02T02:03:07.000Z" };
  assert.strictEqual(ui.retainNewerWholesaleOrderTags(current, [newest])[0], newest);
  const created = { id: "created-order", isWholesaleOrder: false };
  assert.strictEqual(ui.retainNewerWholesaleOrderTags(current, [created])[0], created);
  assert.equal(ui.retainNewerWholesaleOrderTags(current, [{ id: "order-1", status: "completed" }])[0].wholesaleOrderUpdatedBy, "sales-b");
});

test("API response parser extracts only exact-order tag metadata, including legacy unmarked conflict data", () => {
  assert.deepEqual(ui.wholesaleOrderFieldsFromPayload({ order: { id: "order-1", isWholesaleOrder: true, status: "pending", payments: ["unrelated"], wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z", wholesaleOrderUpdatedBy: "admin" } }, "order-1"), {
    id: "order-1", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z", wholesaleOrderUpdatedBy: "admin", wholesaleOrderUpdatedByName: undefined,
  });
  assert.equal(ui.wholesaleOrderFieldsFromPayload({ order: { id: "order-1" } }, "order-1").isWholesaleOrder, false);
  for (const payload of [null, {}, { order: [] }, { order: { id: "other", isWholesaleOrder: true } }, { order: { id: "order-1", isWholesaleOrder: "true" } }, { order: { id: "order-1", wholesaleOrderUpdatedAt: "bad-time" } }]) {
    assert.equal(ui.wholesaleOrderFieldsFromPayload(payload, "order-1"), null);
  }
});

test("mutation payload carries both optimistic-lock fields and no client-controlled actor or order values", () => {
  assert.deepEqual(ui.wholesaleOrderMutationPayload({ id: "order-1", status: "completed", wholesaleOrderUpdatedBy: "forged" }, true), {
    orderId: "order-1", isWholesaleOrder: true, expectedIsWholesaleOrder: false, expectedWholesaleOrderUpdatedAt: "",
  });
  assert.deepEqual(ui.wholesaleOrderMutationPayload({ id: "order-1", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z" }, false), {
    orderId: "order-1", isWholesaleOrder: false, expectedIsWholesaleOrder: true, expectedWholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z",
  });
});

test("tag endpoint and conflict handling cannot accidentally use generic saves or native confirmation", async () => {
  const source = await readFile(new URL("./OrderWholesaleTag.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!canUpdate \|\| pendingRef.current/);
  assert.match(source, /fetch\("\/api\/orders\/wholesale-tag"/);
  assert.match(source, /method: "POST", headers: authJsonHeaders\(\)/);
  assert.match(source, /response.status === 409/);
  assert.match(source, /if \(updatedOrder\) onOrderUpdated\(updatedOrder, session\)/);
  assert.match(source, /if \(!isWholesaleMutationSessionCurrent\(session\)\) return/);
  assert.match(source, /disabled=\{pending\}/);
  assert.match(source, /currentOrderIdRef.current === orderId/);
  assert.doesNotMatch(source, /confirm\(|confirmWrite|saveState|\/api\/state|isAdmin/);
});

test("orders integration filters desktop/mobile rows and updates current detail from the metadata-only store merge", async () => {
  const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  assert.match(source, /<OrderWholesaleBadge marked=\{order.isWholesaleOrder\}/);
  assert.equal((source.match(/<OrderWholesaleFilter value=\{wholesaleFilter\}/g) || []).length, 2);
  assert.match(source, /!matchesWholesaleOrderFilter\(o, wholesaleFilter\)/);
  assert.match(source, /rankOrderSearchRows\(filteredOrders, mobileSearch\)/);
  assert.match(source, /mobileSearch, statusFilter, wholesaleFilter/);
  assert.match(source, /<OrderWholesaleTag[\s\S]{0,160}canUpdate=\{permission.canUpdate\}/);
  assert.match(source, /viewer=\{state.user\}/);
  assert.match(source, /setState\(\(current\) => mergeWholesaleOrderTagForSession\(current, updatedOrder, session\)\)/);
  assert.match(source, /orders: retainNewerWholesaleOrderTags\(current.orders, mergeApiRecord\(orders, result.order\)\)/);
  assert.match(source, /state.orders.find\(\(o\) => o.id === viewOrder.id\) \?\? null/);
});

test("late tag responses cannot cross logout, expiry, new-token login, or viewer-scope boundaries", () => {
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } };
  const baseSession = { username: "sales-a", role: "staff", token: "test-token-a", expiresAt: Date.now() + 60000, visibleSiteIds: ["jiangyin", "nanjing"] };
  const viewer = { username: "sales-a", role: "staff", visibleSiteIds: ["nanjing", "jiangyin"] };
  const save = (session = baseSession) => values.set("fishroom-auth-session", JSON.stringify(session));
  const incoming = { id: "order-1", isWholesaleOrder: true, wholesaleOrderUpdatedAt: "2026-11-02T02:03:04.000Z" };
  const current = { user: viewer, orders: [{ id: "order-1", status: "completed", isWholesaleOrder: false }] };
  try {
    save();
    const ticket = ui.captureWholesaleMutationSession(viewer);
    assert.ok(ticket);
    assert.equal(ui.isWholesaleMutationSessionCurrent(ticket, viewer), true);
    assert.equal(ui.mergeWholesaleOrderTagForSession(current, incoming, ticket).orders[0].isWholesaleOrder, true);
    assert.strictEqual(ui.mergeWholesaleOrderTagForSession({ ...current, orders: [] }, incoming, ticket).orders.length, 0);
    // A callback may be accepted at response time, but React's deferred updater must recheck independently.
    for (const replacement of [
      null,
      { ...baseSession, username: "sales-b", token: "test-token-b" },
      { ...baseSession, token: "test-token-new-same-user" },
      { ...baseSession, expiresAt: Date.now() - 1 },
      { ...baseSession, expiresAt: baseSession.expiresAt + 1 },
      { ...baseSession, visibleSiteIds: ["jiangyin"] },
    ]) {
      if (replacement) save(replacement); else values.clear();
      assert.equal(ui.isWholesaleMutationSessionCurrent(ticket), false);
      assert.strictEqual(ui.mergeWholesaleOrderTagForSession(current, incoming, ticket), current);
    }
    save();
    for (const changedViewer of [null, { ...viewer, username: "sales-b" }, { ...viewer, role: "admin" }, { ...viewer, visibleSiteIds: ["nanjing"] }]) {
      const changed = { ...current, user: changedViewer };
      assert.strictEqual(ui.mergeWholesaleOrderTagForSession(changed, incoming, ticket), changed);
    }
    assert.equal(ui.captureWholesaleMutationSession({ ...viewer, username: "sales-b" }), null);
    const absent = { ...current, orders: [] };
    assert.strictEqual(ui.mergeWholesaleOrderTagForSession(absent, incoming, ticket), absent);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("app retains newer wholesale metadata when delayed general saves or order responses arrive", async () => {
  const source = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(source, /data.orders = retainNewerWholesaleOrderTags\(current.orders, data.orders\)/);
  assert.match(source, /retainNewerWholesaleOrderTags\(current.orders, scopedStatePatch.orders\)/);
  assert.match(source, /retainNewerWholesaleOrderTags\(current.orders, patch.orders\)/);
  assert.match(source, /retainNewerWholesaleOrderTags\(current.orders, current.orders.map/);
  assert.equal((source.match(/retainNewerWholesaleOrderTags\(current.orders, result.orders\)/g) || []).length, 4);
});
