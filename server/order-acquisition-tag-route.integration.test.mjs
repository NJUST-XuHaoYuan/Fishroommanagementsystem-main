import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

async function setup(t, fixture = stockPricingFixture) {
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const tag = (order, value, role = "admin", extra = {}) => server.request("/api/orders/acquisition-tag", {
    token: tokens[role], body: { orderId: order.id, isAcquisitionOrder: value,
      expectedIsAcquisitionOrder: order.isAcquisitionOrder === true,
      expectedAcquisitionOrderUpdatedAt: order.acquisitionOrderUpdatedAt ?? "", ...extra },
  });
  return { ...server, tokens, tag };
}
const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const orderAt = (state, id = "ORDER-PENDING") => state.orders.find((order) => order.id === id);

test("admin marks/unmarks pending, completed and cancelled orders without changing amounts, stock or status", async (t) => {
  const s = await setup(t);
  const baseline = await s.readPersistedState();
  for (const id of ["ORDER-PENDING", "ORDER-COMPLETED", "ORDER-CANCELLED"]) {
    const before = orderAt(baseline, id);
    const marked = await s.tag(before, true, "admin", { acquisitionOrderUpdatedBy: "spoof", status: "cancelled", items: [] }); ok(marked);
    assert.equal(marked.body.order.isAcquisitionOrder, true);
    assert.equal(marked.body.order.acquisitionOrderUpdatedBy, "pricing-admin");
    assert.equal(marked.body.order.acquisitionOrderUpdatedByName, "价格测试admin");
    assert.match(marked.body.order.acquisitionOrderUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const { isAcquisitionOrder, acquisitionOrderUpdatedAt, acquisitionOrderUpdatedBy, acquisitionOrderUpdatedByName, ...unchanged } = marked.body.order;
    assert.deepEqual(unchanged, before);
    const logCount = (await s.readPersistedState()).operationLogs.length;
    const duplicate = await s.tag(before, true); ok(duplicate);
    assert.equal(duplicate.body.unchanged, true);
    assert.equal(duplicate.body.operationLog, undefined);
    assert.equal((await s.readPersistedState()).operationLogs.length, logCount);
    const unmarked = await s.tag(marked.body.order, false); ok(unmarked);
    assert.equal(unmarked.body.order.isAcquisitionOrder, false);
    assert.ok(unmarked.body.order.acquisitionOrderUpdatedAt > marked.body.order.acquisitionOrderUpdatedAt);
  }
  const after = await s.readPersistedState();
  assert.deepEqual(after.stock, baseline.stock);
  assert.deepEqual(after.shipments, baseline.shipments);
  assert.deepEqual(after.products, baseline.products);
  assert.equal(after.operationLogs.length - baseline.operationLogs.length, 6);
  assert.ok(after.operationLogs.slice(0, 6).every((log) => log.operator === "pricing-admin" && log.module === "订单管理" && log.action === "获新订单标记"));
});

test("staff including full order editors cannot mark; unauthenticated requests are rejected; staff can read persisted badge", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); const order = orderAt(before);
  for (const role of ["editor", "viewer", "anonymous"]) {
    const result = await s.tag(order, true, role, { accessRole: "admin", username: "pricing-admin" });
    assert.equal(result.response.status, role === "anonymous" ? 401 : 403, JSON.stringify(result.body));
  }
  assert.deepEqual((await s.readPersistedState()).orders, before.orders);
  ok(await s.tag(order, true));
  const read = await s.request("/api/state/slice?keys=orders", { token: s.tokens.editor }); ok(read);
  assert.equal(orderAt(read.body.data).isAcquisitionOrder, true);
});

test("stale tag writes return current order and cannot reverse a newer decision; malformed inputs do not write", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); const original = orderAt(before);
  const marked = await s.tag(original, true); ok(marked);
  const stale = await s.tag(original, false);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "ORDER_ACQUISITION_TAG_CONFLICT");
  assert.deepEqual(stale.body.order, marked.body.order);
  const unmarked = await s.tag(marked.body.order, false); ok(unmarked);
  const aba = await s.tag(original, true);
  assert.equal(aba.response.status, 409);
  assert.equal(aba.body.order.isAcquisitionOrder, false);
  for (const extra of [{ isAcquisitionOrder: "true" }, { expectedIsAcquisitionOrder: "false" }, { expectedAcquisitionOrderUpdatedAt: null }]) {
    const result = await s.tag(unmarked.body.order, true, "admin", extra);
    assert.ok([400, 409].includes(result.response.status), JSON.stringify(result.body));
  }
  const after = await s.readPersistedState();
  assert.equal(after.operationLogs.length - before.operationLogs.length, 2);
  assert.deepEqual(orderAt(after), unmarked.body.order);
});

test("missing, duplicate, and invalid-site order IDs fail closed before tag changes", async (t) => {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.orders.push({ ...fixture.state.orders[0] });
  fixture.state.orders.push({ ...fixture.state.orders[0], id: "ORDER-BAD-SITE", siteId: "deleted-site" });
  const s = await setup(t, fixture); const before = await s.readPersistedState();
  for (const [id, status] of [["", 400], ["missing", 404], ["ORDER-CONFIRMED", 409], ["ORDER-BAD-SITE", 403]]) {
    const result = await s.tag({ id }, true); assert.equal(result.response.status, status, JSON.stringify(result.body));
  }
  assert.deepEqual((await s.readPersistedState()).orders, before.orders);
});

test("concurrent duplicate marks are idempotent with one audit event", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); const order = orderAt(before);
  const results = await Promise.all([s.tag(order, true), s.tag(order, true)]);
  results.forEach(ok);
  assert.equal(results.filter((result) => result.body.unchanged).length, 1);
  const after = await s.readPersistedState();
  assert.equal(after.operationLogs.length - before.operationLogs.length, 1);
  assert.equal(orderAt(after).isAcquisitionOrder, true);
});

test("ordinary create ignores injected acquisition metadata even for order editors", async (t) => {
  const s = await setup(t); const result = await s.request("/api/orders/create", { token: s.tokens.editor, body: {
    siteId: "nanjing", source: "平台下单", platformOrderNo: "ACQUISITION-INJECTED-CREATE", date: "2026-09-01",
    paymentChannel: "douyin", plannedShipDate: "2026-09-27", contactPersonnelId: "pricing-editor",
    items: [{ stockItemId: "follower", price: 150 }], shippingFeeMode: "collect",
    isAcquisitionOrder: true, acquisitionOrderUpdatedAt: "forged", acquisitionOrderUpdatedBy: "pricing-admin", acquisitionOrderUpdatedByName: "管理员",
  } }); ok(result);
  for (const key of ["isAcquisitionOrder", "acquisitionOrderUpdatedAt", "acquisitionOrderUpdatedBy", "acquisitionOrderUpdatedByName"]) {
    assert.equal(result.body.order[key], undefined, `${key} must be server-owned`);
  }
});
