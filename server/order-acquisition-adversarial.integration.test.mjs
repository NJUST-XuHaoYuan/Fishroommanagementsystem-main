import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { ORDER_ACQUISITION_TAG_FIELDS } from "./order-acquisition-tag.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const tag = (order) => Object.fromEntries(ORDER_ACQUISITION_TAG_FIELDS.map((key) => [key, order[key]]));
async function setup(t) {
  const fixture = structuredClone(stockPricingFixture);
  const order = fixture.state.orders.find((item) => item.id === "ORDER-PENDING");
  Object.assign(order, { source: "平台下单", platformOrderNo: "ACQ-ADVERSARIAL", douyinOrderNo: "ACQ-ADVERSARIAL",
    paymentChannel: "douyin", paymentAccount: "synthetic-account", plannedShipDate: "2026-09-15",
    contactPersonnelId: "pricing-admin", contactPerson: "价格测试admin" });
  fixture.state.orders = [order];
  fixture.state.shipments = [];
  fixture.state.logs = [];
  fixture.state.checks = [];
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const staff = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const result = await server.request("/api/orders/update", { token: admin, body: { ...order, orderId: order.id } });
  ok(result);
  const readOrder = async () => (await server.readPersistedState()).orders.find((item) => item.id === order.id);
  const mark = async (value, previous = null) => {
    const before = previous ?? await readOrder();
    return server.request("/api/orders/acquisition-tag", { token: admin, body: {
      orderId: order.id, isAcquisitionOrder: value,
      expectedIsAcquisitionOrder: before.isAcquisitionOrder === true,
      expectedAcquisitionOrderUpdatedAt: before.acquisitionOrderUpdatedAt ?? "",
    } });
  };
  return { ...server, admin, staff, readOrder, mark, original: result.body.order };
}

test("generic patches cannot delete acquisition fields or forge metadata, while unchanged stale snapshots preserve new tag", async (t) => {
  const s = await setup(t);
  ok(await s.mark(true));
  const marked = await s.readOrder();
  for (const token of [s.admin, s.staff]) {
    const deleted = { ...marked, notes: "attempted tag removal" };
    for (const key of ORDER_ACQUISITION_TAG_FIELDS) delete deleted[key];
    const attempted = [deleted, { ...marked, acquisitionOrderUpdatedBy: "forged-admin" }, { ...marked, isAcquisitionOrder: false }];
    for (const changed of attempted) {
      const result = await s.request("/api/state/patch", { token, body: { patch: { orders: [changed] }, basePatch: { orders: [marked] } } });
      assert.equal(result.response.status, 409, JSON.stringify(result.body));
      assert.deepEqual(tag(await s.readOrder()), tag(marked));
    }
  }
  // A true three-way patch alters only notes. Neither old snapshot contains the
  // newer server-owned tag, so it must be retained rather than silently deleted.
  const stale = await s.request("/api/state/patch", { token: s.staff, body: {
    patch: { orders: [{ ...s.original, notes: "ordinary stale note edit" }] }, basePatch: { orders: [s.original] },
  } });
  ok(stale);
  assert.equal((await s.readOrder()).notes, "ordinary stale note edit");
  assert.deepEqual(tag(await s.readOrder()), tag(marked));
});

test("ordinary order edit ignores forged tag fields and preserves concurrent administrator marking", async (t) => {
  const s = await setup(t);
  ok(await s.mark(true));
  const marked = await s.readOrder();
  const forged = await s.request("/api/orders/update", { token: s.staff, body: {
    ...s.original, orderId: s.original.id, notes: "staff business edit", isAcquisitionOrder: false,
    acquisitionOrderUpdatedAt: "1900-01-01", acquisitionOrderUpdatedBy: "forged", acquisitionOrderUpdatedByName: "forged",
  } });
  ok(forged);
  assert.deepEqual(tag(forged.body.order), tag(marked));
  assert.equal((await s.readOrder()).notes, "staff business edit");
  assert.deepEqual(tag(await s.readOrder()), tag(marked));
});

test("a pending inventory approval applied after tagging preserves the live order-owned tag", async (t) => {
  const s = await setup(t);
  const state = await s.readPersistedState();
  const stock = state.stock.find((item) => item.id === "ordered-pending");
  const request = await s.request("/api/stock/save", { token: s.staff, body: {
    upsert: [], deleteIds: [stock.id], expectedOperations: { [stock.id]: "delete" }, expectedBefore: { [stock.id]: stock },
  } });
  ok(request);
  assert.equal(request.body.pendingApproval, true);
  ok(await s.mark(true));
  const marked = await s.readOrder();
  const approval = await s.request("/api/approvals/stock", { token: s.admin, body: { requestId: request.body.approvalRequestId, decision: "approve" } });
  ok(approval);
  const after = await s.readOrder();
  assert.ok(after.items[0].inventoryRemovedAt);
  assert.deepEqual(tag(after), tag(marked));
  assert.equal((await s.readPersistedState()).stock.some((item) => item.id === stock.id), false);
});
