import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
function fixture() {
  const data = structuredClone(stockPricingFixture);
  const order = data.state.orders.find((item) => item.id === "ORDER-RELEASE");
  Object.assign(order, { source: "平台下单", platformOrderNo: "REFUND-TEST", paymentChannel: "douyin", paymentAccount: "test-account",
    plannedShipDate: "2026-11-05", contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor" });
  data.state.orders = [order, { ...structuredClone(order), id: "COMPLETED", orderNo: "SO-COMPLETED", status: "completed", platformOrderNo: "REFUND-COMPLETED",
    items: [{ stockItemId: "ordered-completed", productId: "price-product", price: 123.45 }] }];
  data.state.stock.find((item) => item.id === "ordered-completed").sold = true;
  data.state.shipments = [{ id: "delivered", orderId: "COMPLETED", status: "delivered", siteId: "nanjing",
    shipMethod: "express", itemStockIds: ["ordered-completed"], actualShippingFee: 0, packingProof: ["one", "two"] }];
  return data;
}
async function setup(t, customize = () => {}) {
  const data = fixture(); customize(data);
  const server = await startMutableRouteServer(data); t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const write = (path, body, role = "editor") => server.request(path, { token: tokens[role], body });
  const history = (id = "release-follower", role = "editor") => server.request(`/api/stock/status-history?stockItemId=${id}`, { token: tokens[role] });
  return { ...server, tokens, write, history };
}

test("returning a fish atomically clears sold and records server-owned cancellation; duplicate return does not duplicate history", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  ok(await s.write("/api/orders/return-item", { orderId: "ORDER-RELEASE", stockItemId: "release-follower",
    operator: "forged", changedAt: "1900", stockStatusHistory: [{ id: "evil" }] }));
  const after = await s.readPersistedState();
  assert.equal(after.stock.find((item) => item.id === "release-follower").sold, false);
  assert.equal(after.stockStatusHistory.length, 1);
  const record = after.stockStatusHistory[0];
  assert.equal(record.eventType, "order_release"); assert.equal(record.previousSold, true); assert.equal(record.sold, false);
  assert.equal(record.orderNo, "ORDER-RELEASE"); assert.equal(record.orderId, "ORDER-RELEASE");
  assert.equal(record.operator, "pricing-editor"); assert.equal(record.operatorId, "pricing-editor");
  assert.equal(record.operatorName, "价格测试editor"); assert.equal(record.source, "order_return_item");
  assert.ok(Number.isFinite(Date.parse(record.changedAt))); assert.notEqual(record.changedAt, "1900");
  assert.equal(record.status, before.stock.find((item) => item.id === record.stockItemId).status);
  const response = await s.history(); ok(response); assert.equal(response.body.total, 1);
  assert.equal(response.body.records[0].orderNo, "ORDER-RELEASE");
  assert.equal((await s.write("/api/orders/return-item", { orderId: "ORDER-RELEASE", stockItemId: "release-follower" })).response.status, 400);
  assert.deepEqual(await s.readPersistedState(), after);
});

test("edits and order deletion append release events, preserve old history and order-number snapshots", async (t) => {
  const s = await setup(t, (data) => { data.state.stockStatusHistory = [{ id: "old", stockItemId: "release-follower", status: "healthy", source: "bio_details" }]; });
  const current = (await s.readPersistedState()).orders[0];
  ok(await s.write("/api/orders/update", { ...current, orderId: current.id, items: current.items.slice(1) }));
  let state = await s.readPersistedState();
  assert.equal(state.stockStatusHistory.length, 2); assert.equal(state.stockStatusHistory[0].id, "old");
  assert.equal(state.stockStatusHistory[1].source, "order_update");
  const filtered = await s.request("/api/stock/status-history?stockItemId=release-follower&eventType=order_release&limit=1", { token: s.tokens.editor });
  ok(filtered); assert.equal(filtered.body.total, 1); assert.equal(filtered.body.records[0].eventType, "order_release");
  assert.equal((await s.request("/api/stock/status-history?stockItemId=release-follower&eventType=arbitrary", { token: s.tokens.editor })).response.status, 400);
  ok(await s.write("/api/orders/delete", { orderId: current.id }));
  state = await s.readPersistedState(); assert.equal(state.stockStatusHistory.length, 4);
  assert.deepEqual(state.stockStatusHistory.slice(2).map((record) => record.source), ["order_delete", "order_delete"]);
  assert.ok(!state.orders.some((order) => order.id === current.id));
  const history = await s.history("release-manual"); ok(history);
  assert.equal(history.body.records[0].orderNo, current.orderNo);
});

test("another effective order reservation suppresses both sold release and cancellation journal", async (t) => {
  const s = await setup(t, (data) => { data.state.orders.push({ ...structuredClone(data.state.orders[0]), id: "OTHER",
    orderNo: "OTHER", items: [data.state.orders[0].items[0]] }); });
  ok(await s.write("/api/orders/return-item", { orderId: "ORDER-RELEASE", stockItemId: "release-follower" }));
  const state = await s.readPersistedState();
  assert.equal(state.stock.find((item) => item.id === "release-follower").sold, true);
  assert.equal(state.stockStatusHistory, undefined);
});

test("completed refunds preserve all order/stock/shipment states and remain pending finance verification", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  const response = await s.write("/api/orders/refund", { orderId: "COMPLETED", id: "refund-completed", amount: 20,
    notes: "测试退款", operator: "forged", verificationStatus: "verified", verifiedAt: "1900" }); ok(response);
  const after = await s.readPersistedState(); const oldOrder = before.orders.find((item) => item.id === "COMPLETED");
  const order = after.orders.find((item) => item.id === "COMPLETED");
  assert.deepEqual({ ...order, payments: [] }, oldOrder);
  assert.equal(order.payments.length, 1); assert.equal(order.payments[0].verificationStatus, "pending");
  assert.equal(order.payments[0].recordedBy, "pricing-editor"); assert.equal(order.payments[0].type, "refund");
  assert.equal(order.payments[0].recordSource, "order"); assert.equal(order.payments[0].refundMethod, "platform");
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
  assert.equal(after.stockStatusHistory, undefined);
  assert.equal((await s.write("/api/orders/refund", { orderId: "COMPLETED", id: "refund-completed", amount: 20 })).response.status, 400);
  assert.deepEqual(await s.readPersistedState(), after);
  assert.equal((await s.write("/api/orders/return-item", { orderId: "COMPLETED", stockItemId: "ordered-completed" })).response.status, 400);
});

test("refund-only writes do not cancel sold; shipped incomplete orders still require shipment damage flow", async (t) => {
  const s = await setup(t, (data) => {
    data.state.orders.push({ ...structuredClone(data.state.orders[1]), id: "SHIPPED", orderNo: "SHIPPED", status: "shipped" });
    data.state.shipments.push({ ...structuredClone(data.state.shipments[0]), id: "shipment-incomplete", orderId: "SHIPPED" });
  });
  const before = await s.readPersistedState();
  ok(await s.write("/api/orders/refund", { orderId: "ORDER-RELEASE", amount: 10, id: "refund-pending" }));
  const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock); assert.equal(after.stockStatusHistory, undefined);
  const shipped = await s.write("/api/orders/refund", { orderId: "SHIPPED", amount: 10 });
  assert.equal(shipped.response.status, 400); assert.match(shipped.body.error, /报损退款/);
  for (const amount of [0, -1, "not-a-number"]) {
    assert.equal((await s.write("/api/orders/refund", { orderId: "COMPLETED", amount })).response.status, 400);
  }
  assert.deepEqual(await s.readPersistedState(), after);
});

test("unauthorized, cross-site, revoked and generic forgery paths cannot create release or refund records", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const path of ["/api/orders/refund", "/api/orders/return-item", "/api/orders/delete"]) {
    const body = { orderId: "ORDER-RELEASE", stockItemId: "release-follower", amount: 10 };
    const denied = await s.write(path, body, "viewer");
    assert.ok([400, 403].includes(denied.response.status), JSON.stringify(denied.body));
    assert.match(denied.body.error, /权限/);
  }
  for (const patch of [{ stockStatusHistory: [{ id: "forged" }] }, { stock: before.stock.map((item) => ({ ...item, sold: false })) },
    { orders: before.orders.map((order) => order.id === "ORDER-RELEASE" ? { ...order, items: order.items.slice(1) } : order) }]) {
    const response = await s.write("/api/state/patch", { patch, basePatch: Object.fromEntries(Object.keys(patch).map((key) => [key, before[key] ?? []])) }, "admin");
    assert.ok(response.response.status >= 400);
  }
  assert.deepEqual(await s.readPersistedState(), before);
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["jiangyin"] });
  assert.equal((await s.write("/api/orders/refund", { orderId: "COMPLETED", amount: 10 })).response.status, 403);
  assert.equal((await s.history()).response.status, 404);
  await s.patchTestPersonnel("pricing-editor", { accountEnabled: false });
  assert.equal((await s.write("/api/orders/refund", { orderId: "COMPLETED", amount: 10 })).response.status, 401);
});

test("injected persistence failure rolls back order release, sold state and journal together", async (t) => {
  const s = await setup(t, (data) => { data.failStatusHistoryWrite = true; }); const before = await s.readPersistedState();
  const failed = await s.write("/api/orders/return-item", { orderId: "ORDER-RELEASE", stockItemId: "release-follower" });
  assert.equal(failed.response.status, 400); assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.write("/api/orders/return-item", { orderId: "ORDER-RELEASE", stockItemId: "release-follower" }));
  assert.equal((await s.readPersistedState()).stockStatusHistory.length, 1);
});

test("concurrent retry of the same return or refund writes once under the order lock", async (t) => {
  const s = await setup(t);
  const returns = await Promise.all([1, 2].map(() => s.write("/api/orders/return-item", {
    orderId: "ORDER-RELEASE", stockItemId: "release-follower",
  })));
  assert.deepEqual(returns.map((result) => result.response.status).sort(), [200, 400]);
  assert.equal((await s.readPersistedState()).stockStatusHistory.length, 1);
  const refunds = await Promise.all([1, 2].map(() => s.write("/api/orders/refund", {
    orderId: "COMPLETED", id: "same-refund", amount: 10,
  })));
  assert.deepEqual(refunds.map((result) => result.response.status).sort(), [200, 400]);
  const state = await s.readPersistedState();
  assert.equal(state.orders.find((item) => item.id === "COMPLETED").payments.length, 1);
  assert.equal(state.stockStatusHistory.length, 1);
});

test("completed refund affects commission only after finance verifies it and never reopens the order", async (t) => {
  const s = await setup(t, (data) => {
    const order = data.state.orders.find((item) => item.id === "COMPLETED");
    const now = new Date(Date.now() - 3_600_000).toISOString();
    Object.assign(order, { createdAt: now, date: now.slice(0, 10), source: "私域线上", customerId: "customer",
      paymentChannel: "cash", paymentAccount: "cash-qa", paymentMethodId: "pm-cash", paymentMethodName: "现金",
      payments: [{ id: "receipt", type: "balance", amount: 100, time: now, channel: "cash", account: "cash-qa",
        verificationStatus: "verified", verifiedAt: now, verifiedBy: "pricing-admin", recordSource: "manual", notes: "", proof: [] }] });
    data.state.customers = [{ id: "customer", name: "退款测试客户" }];
  });
  const total = async () => {
    const result = await s.request("/api/commissions/me", { token: s.tokens.editor }); ok(result); return result.body.personalAmount;
  };
  const before = await total(); assert.equal(before, 0.2);
  ok(await s.write("/api/orders/refund", { orderId: "COMPLETED", id: "refund-verify", amount: 20 }));
  assert.equal(await total(), before);
  ok(await s.write("/api/orders/payment", { orderId: "COMPLETED", action: "verify", paymentId: "refund-verify" }, "admin"));
  assert.equal(await total(), 0.16);
  const state = await s.readPersistedState();
  assert.equal(state.orders.find((item) => item.id === "COMPLETED").status, "completed");
  assert.equal(state.stock.find((item) => item.id === "ordered-completed").sold, true);
  assert.equal(state.stockStatusHistory, undefined);
});

test("orders-only access is limited to explicit release history and never bypasses health or site permissions", async (t) => {
  const s = await setup(t, (data) => {
    data.state.personnel.find((person) => person.id === "pricing-editor").permissions = { orders: { create: true } };
    data.state.stockStatusHistory = [
      { id: "health-private", stockItemId: "release-follower", previousStatus: "sick", status: "healthy", changedAt: "2026-11-01T00:00:00.000Z",
        source: "bio_details", operator: "keeper", operatorName: "健康记录操作人" },
      { id: "release-visible", eventType: "order_release", stockItemId: "release-follower", previousSold: true, sold: false,
        previousStatus: "healthy", status: "healthy", orderId: "previous-order", orderNo: "OLD-ORDER", changedAt: "2026-11-02T00:00:00.000Z",
        source: "order_return_item", operator: "operator", operatorName: "取消操作人", operatorId: "sensitive-id", customerName: "客户不应外泄" },
      { id: "other-site-release", eventType: "order_release", stockItemId: "PRIVATE_JY_FOLLOWER", previousSold: true, sold: false,
        orderId: "other-site-order", orderNo: "OTHER-SITE-SECRET", changedAt: "2026-11-02T00:00:00.000Z" },
    ];
  });
  const query = (suffix = "", role = "editor", stockId = "release-follower") => s.request(
    `/api/stock/status-history?stockItemId=${stockId}${suffix}`, { token: s.tokens[role] });
  const allowed = await query("&eventType=order_release"); ok(allowed);
  assert.equal(allowed.body.total, 1); assert.equal(allowed.body.records.length, 1);
  assert.equal(allowed.body.records[0].id, "release-visible"); assert.equal(allowed.body.records[0].orderNo, "OLD-ORDER");
  assert.equal(Object.hasOwn(allowed.body.records[0], "previousStatus"), false);
  assert.equal(Object.hasOwn(allowed.body.records[0], "status"), false);
  assert.doesNotMatch(JSON.stringify(allowed.body), /health-private|健康记录操作人|sensitive-id|客户不应外泄|OTHER-SITE-SECRET/);
  for (const suffix of ["", "&eventType=", "&eventType=&eventType=order_release"]) {
    assert.equal((await query(suffix)).response.status, 403);
  }
  assert.equal((await query("&eventType=healthy")).response.status, 400);
  // URLSearchParams uses the first filter value; an additional empty argument
  // cannot broaden the SQL filter that was authorized.
  const duplicate = await query("&eventType=order_release&eventType="); ok(duplicate);
  assert.equal(duplicate.body.total, 1); assert.equal(duplicate.body.records[0].eventType, "order_release");
  assert.equal((await query("&eventType=order_release", "viewer")).response.status, 403);
  const otherSite = await query("&eventType=order_release", "editor", "PRIVATE_JY_FOLLOWER");
  assert.equal(otherSite.response.status, 404); assert.doesNotMatch(JSON.stringify(otherSite.body), /OTHER-SITE-SECRET/);
  const admin = await query("", "admin"); ok(admin); assert.equal(admin.body.total, 2);
  assert.equal(admin.body.records.find((record) => record.id === "release-visible").status, "healthy");
});
