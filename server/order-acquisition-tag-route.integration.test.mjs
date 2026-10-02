import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

test("legacy acquisition tagging is retired for every authenticated role and does not write", async (t) => {
  const server = await startMutableRouteServer(stockPricingFixture); t.after(() => server.stop());
  const tokens = [];
  for (const role of ["admin", "editor", "viewer"]) tokens.push(await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD));
  const before = await server.readPersistedState();
  for (const token of [...tokens, undefined]) {
    const result = await server.request("/api/orders/acquisition-tag", { token, body: { orderId: "ORDER-PENDING", isAcquisitionOrder: true } });
    assert.equal(result.response.status, token ? 410 : 401, JSON.stringify(result.body));
  }
  assert.deepEqual(await server.readPersistedState(), before);
});

test("ordinary order creation discards forged legacy tags and new customer approval payloads", async (t) => {
  const server = await startMutableRouteServer(stockPricingFixture); t.after(() => server.stop());
  const token = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const result = await server.request("/api/orders/create", { token, body: {
    siteId: "nanjing", source: "平台下单", platformOrderNo: "ACQUISITION-INJECTED-CREATE", date: "2026-09-01",
    paymentChannel: "douyin", plannedShipDate: "2026-09-27", contactPersonnelId: "pricing-editor",
    items: [{ stockItemId: "follower", price: 150 }], shippingFeeMode: "collect", createdAt: "2020-01-01T00:00:00",
    isAcquisitionOrder: true, newCustomerApproval: { status: "approved", reviewedBy: "pricing-admin", version: 999 },
  } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.order.newCustomerApproval, undefined);
  assert.equal(result.body.order.isAcquisitionOrder, undefined);
  assert.notEqual(result.body.order.createdAt, "2020-01-01T00:00:00");
});
