import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const path = "/api/shipments/fulfillment-correction";
const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
function fixture() {
  const fixture = structuredClone(stockPricingFixture), state = fixture.state;
  const original = state.orders[0];
  state.orders = ["outbound", "delivered", "completed"].map((stage, index) => ({
    ...structuredClone(original), id: `correction-order-${stage}`, orderNo: `SO-CORRECTION-${stage}`,
    status: stage === "completed" ? "completed" : stage === "outbound" ? "pending" : "shipped",
    createdAt: "2026-11-01T08:00:00", date: "2026-11-01", shippingFeeMode: "collect", shippingFee: 0,
    items: [{ stockItemId: `correction-fish-${stage}`, productId: "price-product", fishCode: `CF-${index}`, price: 100 + index }],
    payments: [{ id: `correction-payment-${stage}`, type: "balance", amount: 100 + index, time: "2026-11-01T10:00:00", verificationStatus: "verified" }],
  }));
  const stock = state.stock[0];
  state.stock = state.orders.map(order => ({ ...structuredClone(stock), id: order.items[0].stockItemId, code: order.items[0].fishCode, sold: true }));
  state.shipments = state.orders.map((order, index) => ({
    id: `correction-shipment-${index}`, orderId: order.id, siteId: "nanjing", itemStockIds: [order.items[0].stockItemId],
    status: index ? "delivered" : "outbound", shipMethod: "express", shipDate: "2026-11-02", outboundDate: "2026-11-01",
    createdAt: "2026-11-01T11:00:00", ...(index ? { shippedAt: "2026-11-02T11:00:00", deliveredAt: "2026-11-07T11:00:00" } : {}),
    carrier: "合成快递", trackingNo: `CORRECTION-${index}`, packingProof: ["synthetic-proof-1", "synthetic-proof-2"], actualShippingFee: 0,
  }));
  state.operationLogs = [{ id: "prior-log", time: "2026-11-01T01:00:00Z", module: "test", action: "prior", detail: "keep prior" }];
  state.commissionLedgerV1 = { testSentinel: "fulfillment correction must not recalculate money" };
  return fixture;
}
async function setup(t) {
  const server = await startMutableRouteServer(fixture()); t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const staff = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const detail = async (shipmentId = "correction-shipment-1", token = admin) => server.request(`${path}?shipmentId=${shipmentId}`, { token });
  const write = async (body, token = admin) => server.request(path, { token, body });
  const correct = async (shipmentId, changes = {}) => {
    const read = await detail(shipmentId); ok(read);
    return write({ shipmentId, expectedVersion: read.body.expectedVersion, baselineToken: read.body.baselineToken,
      shippingTimeStatus: "unknown", receiptStatus: "unknown", reason: "根据反馈暂按同一原鱼延迟发；实际日期待核实", ...changes });
  };
  return { ...server, admin, staff, detail, write, correct };
}
function withoutCorrection(shipment) {
  const copy = structuredClone(shipment);
  delete copy.fulfillmentCorrection; delete copy.fulfillmentCorrectionHistory;
  return copy;
}

test("admin correction records uncertainty beside original facts without changing stock, funds, order state or commission", async t => {
  const server = await setup(t); const before = await server.readPersistedState();
  const result = await server.correct("correction-shipment-2"); ok(result);
  const after = await server.readPersistedState();
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.batches, before.batches);
  assert.deepEqual(after.commissionLedgerV1, before.commissionLedgerV1);
  assert.deepEqual(after.shipments.map(withoutCorrection), before.shipments);
  assert.deepEqual(after.operationLogs.filter(log => log.id === "prior-log"), before.operationLogs);
  const current = after.shipments[2].fulfillmentCorrection;
  assert.equal(current.shippingTimeStatus, "unknown"); assert.equal(current.receiptStatus, "unknown");
  assert.equal(current.actualShippedAt, undefined); assert.equal(current.actualDeliveredAt, undefined);
  const detail = await server.detail("correction-shipment-2"); ok(detail);
  assert.equal(detail.body.original.deliveredAt, "2026-11-07T11:00:00");
  assert.equal(detail.body.current.receiptStatus, "unknown");
  assert.equal(detail.body.order.status, "completed", "bookkeeping completion is kept as the original system record");
  const ordinary = await server.request("/api/shipments/deliver", { token: server.admin, body: { shipmentId: "correction-shipment-2" } });
  assert.ok(ordinary.response.status >= 400, "legacy delivery endpoint cannot silently turn an uncertain completed record into verified receipt");
});

test("correction requires fresh admin-only review and uncertain shipment cannot advance through ordinary endpoints or generic patches", async t => {
  const server = await setup(t);
  const read = await server.detail(); ok(read);
  assert.equal(read.response.headers.get("cache-control"), "no-store, private");
  assert.equal((await server.detail("correction-shipment-1", server.staff)).response.status, 403);
  const body = { shipmentId: "correction-shipment-1", expectedVersion: read.body.expectedVersion, baselineToken: read.body.baselineToken,
    shippingTimeStatus: "unknown", receiptStatus: "not_received", reason: "原鱼延迟发，收到情况待核实" };
  assert.equal((await server.write(body, server.staff)).response.status, 403);
  ok(await server.write(body));
  assert.equal((await server.write(body)).response.status, 409, "stale review cannot overwrite correction history");
  for (const [route, requestBody] of [
    ["/api/shipments/deliver", { shipmentId: body.shipmentId }],
    ["/api/orders/complete", { orderId: "correction-order-delivered" }],
  ]) {
    const denied = await server.request(route, { token: server.admin, body: requestBody });
    assert.equal(denied.response.status, 409, JSON.stringify(denied.body));
  }
  ok(await server.correct("correction-shipment-0"));
  const confirm = await server.request("/api/shipments/confirm", { token: server.admin,
    body: { shipmentId: "correction-shipment-0", packingProof: ["synthetic-proof-1", "synthetic-proof-2"] } });
  assert.equal(confirm.response.status, 409, JSON.stringify(confirm.body));
  const state = await server.readPersistedState();
  const shipments = state.shipments.map(shipment => shipment.id === body.shipmentId
    ? { ...shipment, fulfillmentCorrection: { ...shipment.fulfillmentCorrection, receiptStatus: "received", actualDeliveredAt: "2026-11-19T12:00:00" } } : shipment);
  const forged = await server.request("/api/state/patch", { token: server.admin, body: { patch: { shipments }, basePatch: { shipments: state.shipments } } });
  assert.equal(forged.response.status, 409, JSON.stringify(forged.body));
  assert.deepEqual((await server.readPersistedState()).shipments, state.shipments);
  const alteredOriginals = state.shipments.map(shipment => shipment.id === body.shipmentId
    ? { ...shipment, deliveredAt: "2026-11-19T12:00:00" } : shipment);
  const altered = await server.request("/api/state/patch", { token: server.admin, body: { patch: { shipments: alteredOriginals }, basePatch: { shipments: state.shipments } } });
  assert.ok(altered.response.status >= 400, JSON.stringify(altered.body));
  assert.deepEqual((await server.readPersistedState()).shipments, state.shipments);

});

test("known actual times are validated independently and receipt with no verified date remains explicitly uncertain", async t => {
  const server = await setup(t);
  for (const changes of [
    { shippingTimeStatus: "known", actualShippedAt: "2026-10-31T10:00:00" },
    { shippingTimeStatus: "known", actualShippedAt: "2999-11-19T10:00:00" },
    { shippingTimeStatus: "known", actualShippedAt: "2026-11-19T10:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-18T10:00:00" },
    { reason: "" },
  ]) assert.equal((await server.correct("correction-shipment-1", changes)).response.status, 400, JSON.stringify(changes));
  const result = await server.correct("correction-shipment-1", { shippingTimeStatus: "known", actualShippedAt: "2026-11-17T10:00:00", receiptStatus: "received" }); ok(result);
  const detail = await server.detail(); ok(detail);
  assert.equal(detail.body.current.receiptStatus, "received");
  assert.equal(detail.body.current.actualDeliveredAt, undefined);
  const complete = await server.request("/api/orders/complete", { token: server.admin, body: { orderId: "correction-order-delivered" } });
  assert.equal(complete.response.status, 409, "raw deliveredAt must not fill a missing actual receipt date");
});

test("actual automatic-transition function pauses only uncertain corrections and uses corrected dates when facts are known", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { fulfillmentCorrectionBlocksProgress } = await import("./shipment-fulfillment-correction.mjs");
  const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function applyAutomaticOrderTransitions(state = {})");
  const end = source.indexOf("\nconst ORDER_STATUS_VALUES", start);
  assert.ok(start >= 0 && end > start);
  const apply = runInNewContext(`(${source.slice(start, end)})`, {
    todayInChina: () => "2026-11-20", nowDatetimeInChina: () => "2026-11-20T04:00:00",
    addDaysToDateString: (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10),
    datePart: value => String(value ?? "").slice(0, 10), isDateOnOrBefore: (value, threshold) => Boolean(value) && value <= threshold,
    currentStationNotifications: state => state.notifications ?? [], fulfillmentCorrectionBlocksProgress,
    shipmentPaymentGateForOrder: () => ({ canShip: true }), ensureOrderCreditSaleNotifications: () => { throw Error("Unexpected blocked payment branch"); },
    paymentEvidenceShipmentSnapshot: shipment => shipment, calcAmountDueForOrder: () => 100,
    countsAsCompletionShipment: shipment => shipment.status !== "preparing",
    shipmentIsResolvedForCompletion: shipment => ["delivered", "damaged"].includes(shipment.status),
    validateOrderCanComplete: () => undefined, uid: prefix => `${prefix}-auto-test`, pushOperationLog: (logs, log) => [log, ...(logs ?? [])],
    closeEndedOrderOwnerAssignments: (_before, after) => after, console,
  });
  const state = fixture().state;
  state.orders = [state.orders[1], { ...state.orders[1], id: "unaffected-old" }, { ...state.orders[1], id: "corrected-recent-delivery" }, { ...state.orders[1], id: "corrected-recent-shipping" }];
  const old = state.shipments[1];
  state.shipments = [
    { ...old, fulfillmentCorrection: { version: 1, shippingTimeStatus: "unknown", receiptStatus: "unknown" } },
    { ...old, id: "unaffected", orderId: "unaffected-old" },
    { ...old, id: "known-delivery", orderId: "corrected-recent-delivery", fulfillmentCorrection: { version: 1, shippingTimeStatus: "known", actualShippedAt: "2026-11-17T10:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-19T12:00:00" } },
    { ...old, id: "known-shipping", orderId: "corrected-recent-shipping", status: "shipped", fulfillmentCorrection: { version: 1, shippingTimeStatus: "known", actualShippedAt: "2026-11-18T10:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-19T12:00:00" } },
  ];
  const result = apply(state);
  assert.equal(result.state.orders.find(order => order.id === "correction-order-delivered").status, "shipped", "uncertainty blocks auto-completion despite old deliveredAt");
  assert.equal(result.state.orders.find(order => order.id === "unaffected-old").status, "completed", "ordinary orders keep their existing automatic transition");
  assert.equal(result.state.orders.find(order => order.id === "corrected-recent-delivery").status, "shipped", "completion timer uses actualDeliveredAt rather than original old deliveredAt");
  assert.equal(result.state.shipments.find(shipment => shipment.id === "known-shipping").status, "shipped", "delivery timer uses actualShippedAt rather than original old shippedAt");
  assert.equal(result.summary.autoCompletedCount, 1);
  assert.equal(result.summary.autoDeliveredCount, 0);
});
