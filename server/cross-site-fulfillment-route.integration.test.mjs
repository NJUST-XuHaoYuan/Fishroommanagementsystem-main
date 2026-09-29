import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./test-support/cross-site-fulfillment-fixture.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
async function setup(t, options = {}) {
  const fixture = crossSiteFulfillmentFixture(options);
  const server = await startMutableRouteServer(fixture); t.after(() => server.stop());
  const admin = await server.login("pricing-admin", FULFILLMENT_TEST_PASSWORD);
  const dual = await server.login("dual-editor", FULFILLMENT_TEST_PASSWORD);
  return { ...server, fixture, admin, dual };
}

for (const [origin, destination] of [["nanjing", "jiangyin"], ["jiangyin", "nanjing"]]) {
  for (const method of ["express", "pickup"]) {
    test(`${origin} order with fish moved to ${destination}: existing edit and ${method} fulfillment preserve financial ownership`, async (t) => {
      const s = await setup(t, { origin, destination, method });
      const original = (await s.readPersistedState()).orders[0];
      const edited = await s.request("/api/orders/update", { token: s.dual, body: { ...original, orderId: original.id, notes: "更新出货备注" } }); ok(edited);
      assert.equal(edited.body.order.siteId, origin);
      assert.equal(edited.body.order.items[0].price, 188);
      const before = await s.readPersistedState();
      const out = await s.request("/api/shipments/outbound", { token: s.dual, body: {
        orderId: original.id, selectedItemIds: ["moved-fish"], shipMethod: method, carrier: "顺丰", shipDate: "2026-09-28",
      } }); ok(out);
      assert.equal(out.body.shipment.siteId, origin, "shipment retains order/accounting ownership");
      assert.equal(out.body.shipment.status, method === "pickup" ? "delivered" : "outbound");
      assert.deepEqual(out.body.inventoryProjection.outStockIds, ["moved-fish"]);
      const after = await s.readPersistedState();
      assert.equal(after.orders[0].siteId, origin);
      assert.deepEqual(after.orders[0].items, before.orders[0].items);
      assert.deepEqual(after.orders[0].payments, before.orders[0].payments);
      assert.deepEqual(after.stock, before.stock);
    });
  }
}

test("order editors cannot add arbitrary fish from the moved fish's destination or change original order site", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); const original = before.orders[0];
  for (const extra of [
    { items: [...original.items, { stockItemId: "unrelated-fish", productId: "price-product", price: 200 }] },
    { siteId: "jiangyin" },
  ]) {
    const result = await s.request("/api/orders/update", { token: s.admin, body: { ...original, orderId: original.id, ...extra } });
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
  }
  const after = await s.readPersistedState(); assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.stock, before.stock);
});

test("original-site-only editor cannot change a retained fish now in an unauthorized physical site", async (t) => {
  const s = await setup(t); const staff = await s.login("pricing-editor", FULFILLMENT_TEST_PASSWORD);
  const before = await s.readPersistedState(); const order = before.orders[0];
  const result = await s.request("/api/orders/update", { token: staff, body: {
    ...order, orderId: order.id, items: order.items.map((item) => ({ ...item, price: 999 })),
  } });
  assert.equal(result.response.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, "STOCK_SITE_FORBIDDEN");
  const after = await s.readPersistedState(); assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.stock, before.stock);
});

test("cross-site fulfillment cannot bypass an unpaid private-online order's credit approval gate", async (t) => {
  const fixture = crossSiteFulfillmentFixture();
  Object.assign(fixture.state.orders[0], { source: "私域线上", customerId: "fulfillment-customer", paymentChannel: "cash", shippingAddress: "测试地址" });
  const s = await startMutableRouteServer(fixture); t.after(() => s.stop());
  const token = await s.login("pricing-admin", FULFILLMENT_TEST_PASSWORD);
  const before = await s.readPersistedState();
  const result = await s.request("/api/shipments/outbound", { token, body: {
    orderId: "moved-order", selectedItemIds: ["moved-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-09-28",
    expectedStockLocations: { "moved-fish": { siteId: "jiangyin", subTankId: "tank-j" } },
  } });
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "CREDIT_SALE_CONFIRMATION_REQUIRED");
  const after = await s.readPersistedState();
  assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.orders, before.orders);
});
