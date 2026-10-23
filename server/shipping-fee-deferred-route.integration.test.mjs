import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./test-support/cross-site-fulfillment-fixture.mjs";

const ok = ({ response, body }) => assert.equal(response.status, 200, JSON.stringify(body));
const proofs = ["/uploads/synthetic-packing-1.jpg", "/uploads/synthetic-packing-2.jpg"];
const outboundBody = {
  orderId: "moved-order", selectedItemIds: ["moved-fish"], shipMethod: "express",
  carrier: "顺丰", shipDate: "2026-10-23",
};

function fixtureFor(mode, overrides = {}) {
  const fixture = crossSiteFulfillmentFixture({ origin: "nanjing", destination: "nanjing" });
  Object.assign(fixture.state.orders[0], { shippingFeeMode: mode, shippingFee: 20, ...overrides });
  fixture.state.orders.push({ ...structuredClone(fixture.state.orders[0]), id: "historical-order", orderNo: "HISTORICAL",
    status: "completed", items: [], date: "2026-09-01", shippingFee: 15 });
  return fixture;
}

async function setup(t, mode, overrides = {}) {
  const fixture = fixtureFor(mode, overrides);
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", FULFILLMENT_TEST_PASSWORD);
  return { ...server, fixture, admin };
}

for (const mode of ["prepaid", "free"]) {
  test(`${mode}: unknown fee permits outbound, packing proof and receipt, but completion waits for fee`, async (t) => {
    const s = await setup(t, mode);
    const before = await s.readPersistedState();
    const out = await s.request("/api/shipments/outbound", { token: s.admin, body: outboundBody });
    ok(out);
    const shipmentId = out.body.shipment.id;
    assert.equal(out.body.shipment.actualShippingFee, 0, "the estimated fee must not silently become an actual fee");
    assert.equal(out.body.shipment.status, "outbound");
    const missingProof = await s.request("/api/shipments/confirm", { token: s.admin, body: { shipmentId, packingProof: [] } });
    assert.equal(missingProof.response.status, 400);
    assert.match(missingProof.body.error, /2 张打包凭证/);
    const shipped = await s.request("/api/shipments/confirm", { token: s.admin, body: { shipmentId, packingProof: proofs } });
    ok(shipped);
    assert.equal(shipped.body.shipment.status, "shipped");
    assert.equal(shipped.body.shipment.actualShippingFee, 0);
    const delivered = await s.request("/api/shipments/deliver", { token: s.admin, body: { shipmentId } });
    ok(delivered);
    assert.equal(delivered.body.shipment.status, "delivered");
    const pending = await s.request("/api/orders/complete", { token: s.admin, body: { orderId: "moved-order" } });
    assert.equal(pending.response.status, 400, JSON.stringify(pending.body));
    assert.match(pending.body.error, /未填写实际运费/);
    const fee = await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
      shipmentId, expectedActualShippingFee: 0, actualShippingFee: 23.45,
    } });
    ok(fee);
    assert.equal(fee.body.shipment.status, "delivered", "fee recording is independent of logistics status");
    const stale = await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
      shipmentId, expectedActualShippingFee: 0, actualShippingFee: 30,
    } });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "ACTUAL_SHIPPING_FEE_CONFLICT");
    const complete = await s.request("/api/orders/complete", { token: s.admin, body: { orderId: "moved-order" } });
    ok(complete);
    assert.equal(complete.body.order.status, "completed");
    const immutable = await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
      shipmentId, expectedActualShippingFee: 23.45, actualShippingFee: 30,
    } });
    assert.equal(immutable.response.status, 409);
    assert.equal(immutable.body.code, "ORDER_NOT_EDITABLE");
    const after = await s.readPersistedState();
    assert.deepEqual(after.orders[0].items, before.orders[0].items);
    assert.deepEqual(after.orders[0].payments, before.orders[0].payments);
    assert.deepEqual(after.orders[1], before.orders[1], "completed historical orders are not rewritten");
    assert.deepEqual(after.stock, before.stock);
  });

  test(`${mode}: fee can be recorded independently while packing, with scope and money validation intact`, async (t) => {
    const s = await setup(t, mode);
    const out = await s.request("/api/shipments/outbound", { token: s.admin, body: { ...outboundBody, actualShippingFee: 0 } });
    ok(out); const shipmentId = out.body.shipment.id;
    const viewer = await s.login("pricing-viewer", FULFILLMENT_TEST_PASSWORD);
    const forbidden = await s.request("/api/shipments/actual-shipping-fee", { token: viewer, body: {
      shipmentId, expectedActualShippingFee: 0, actualShippingFee: 20,
    } });
    assert.equal(forbidden.response.status, 403);
    for (const actualShippingFee of [0, -1, 1.001, 100001]) {
      const invalid = await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
        shipmentId, expectedActualShippingFee: 0, actualShippingFee,
      } });
      assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
    }
    const saved = await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
      shipmentId, expectedActualShippingFee: 0, actualShippingFee: 18,
    } });
    ok(saved);
    assert.equal(saved.body.shipment.status, "outbound");
    assert.equal(saved.body.shipment.packingProof, undefined);
    const duplicate = await s.request("/api/shipments/outbound", { token: s.admin, body: outboundBody });
    assert.equal(duplicate.response.status, 400);
    assert.match(duplicate.body.error, /已经出库/);
  });
}

test("prepaid: later actual fee updates receivable and cannot bypass the payment completion gate", async (t) => {
  const s = await setup(t, "prepaid", {
    source: "私域线上", customerId: "fulfillment-customer", shippingAddress: "测试地址", paymentChannel: "cash",
    payments: [{ id: "paid", type: "balance", amount: 208, time: "2026-10-20T12:00:00+08:00",
      verifiedAt: "2026-10-20T12:00:00+08:00", verificationStatus: "verified" }],
  });
  const out = await s.request("/api/shipments/outbound", { token: s.admin, body: outboundBody }); ok(out);
  const shipmentId = out.body.shipment.id;
  ok(await s.request("/api/shipments/confirm", { token: s.admin, body: { shipmentId, packingProof: proofs } }));
  ok(await s.request("/api/shipments/deliver", { token: s.admin, body: { shipmentId } }));
  ok(await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
    shipmentId, expectedActualShippingFee: 0, actualShippingFee: 30,
  } }));
  const blocked = await s.request("/api/orders/complete", { token: s.admin, body: { orderId: "moved-order" } });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, "CREDIT_SALE_CONFIRMATION_REQUIRED");
  assert.equal((await s.readPersistedState()).orders[0].status, "shipped");
});

test("free: delayed fee remains seller expense and does not create customer arrears", async (t) => {
  const s = await setup(t, "free", {
    source: "私域线上", customerId: "fulfillment-customer", shippingAddress: "测试地址", paymentChannel: "cash",
    payments: [{ id: "paid", type: "balance", amount: 188, time: "2026-10-20T12:00:00+08:00",
      verifiedAt: "2026-10-20T12:00:00+08:00", verificationStatus: "verified" }],
  });
  const out = await s.request("/api/shipments/outbound", { token: s.admin, body: outboundBody }); ok(out);
  const shipmentId = out.body.shipment.id;
  ok(await s.request("/api/shipments/confirm", { token: s.admin, body: { shipmentId, packingProof: proofs } }));
  ok(await s.request("/api/shipments/deliver", { token: s.admin, body: { shipmentId } }));
  ok(await s.request("/api/shipments/actual-shipping-fee", { token: s.admin, body: {
    shipmentId, expectedActualShippingFee: 0, actualShippingFee: 30,
  } }));
  ok(await s.request("/api/orders/complete", { token: s.admin, body: { orderId: "moved-order" } }));
});
