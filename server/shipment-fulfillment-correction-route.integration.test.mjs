import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";

const path = "/api/shipments/fulfillment-correction";
const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const denied = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
async function setup(t, { shipmentStatus = "delivered", orderStatus = "completed", customize = () => {} } = {}) {
  const fixture = paymentProofFixture(); const state = fixture.state;
  state.orders[0].status = orderStatus;
  state.shipments = [{ id: "correction-shipment", orderId: "proof-order", siteId: "nanjing", status: shipmentStatus, shipMethod: "express",
    shipDate: "2026-11-01", outboundDate: "2026-11-01", createdAt: "2026-11-01T10:00:00", shippedAt: "2026-11-04T10:00:00", deliveredAt: "2026-11-09T10:00:00",
    itemStockIds: ["proof-fish"], carrier: "顺丰", trackingNo: "ORIGINAL", packingProof: ["one", "two"], actualShippingFee: 0, notes: "原始履约记录" }];
  state.operationLogs = [{ id: "original", detail: "历史日志不能改写" }]; state.commissionLedgerV1 = { source: "opaque-original-marker" };
  customize(state);
  const server = await startMutableRouteServer(fixture); t.after(server.stop);
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const get = (role = "admin", shipmentId = "correction-shipment") => server.request(`${path}?shipmentId=${shipmentId}`, { token: tokens[role] });
  const save = (body, role = "admin") => server.request(path, { token: tokens[role], body });
  const draft = async (extra = {}) => { const result = await get(); ok(result); return { shipmentId: "correction-shipment", expectedVersion: result.body.expectedVersion,
    baselineToken: result.body.baselineToken, shippingTimeStatus: "unknown", receiptStatus: "unknown", reason: "根据反馈暂按延迟发出，实际鱼只身份及发货签收日期仍待凭证核实", ...extra }; };
  return { ...server, tokens, get, save, draft };
}
function originalStateProjection(state) {
  return { ...state, shipments: state.shipments.map(({ fulfillmentCorrection, fulfillmentCorrectionHistory, ...original }) => original),
    operationLogs: state.operationLogs.filter(log => log.action !== "履约记录更正") };
}

test("completed order amendment persists only correction metadata, returns the saved object and retains every original business field", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const result = await s.save(await s.draft({ status: "outbound", itemStockIds: ["forged"], operator: "forged", shippedAt: "1900" })); ok(result);
  const after = await s.readPersistedState(); assert.deepEqual(originalStateProjection(after), before);
  assert.deepEqual(result.body.shipment, after.shipments[0]); assert.equal(after.shipments[0].fulfillmentCorrection.operator, "pricing-admin");
  assert.equal(after.orders[0].salesAmountSnapshot, undefined, "amendment never migrates old order amounts");
  assert.equal(after.shipments[0].fulfillmentCorrection.actualShippedAt, undefined);
  const detail = await s.get(); ok(detail); assert.equal(detail.body.expectedVersion, 1); assert.equal(detail.body.history.length, 1);
});

test("admin-only and freshly authorized writes reject staff, revoked accounts, invalid sites and duplicate identities", async t => {
  const s = await setup(t); const body = await s.draft(); const before = await s.readPersistedState();
  assert.equal((await s.get("editor")).response.status, 403); assert.equal((await s.save(body, "editor")).response.status, 403);
  assert.equal((await s.get("viewer")).response.status, 403);
  await s.patchTestPersonnel("pricing-admin", { accessRole: "staff" }); denied(await s.save(body));
  const revoked = await s.readPersistedState(); assert.deepEqual(revoked.shipments, before.shipments); assert.deepEqual(revoked.orders, before.orders);
  for (const customize of [state => { state.shipments[0].siteId = "jiangyin"; }, state => { state.orders[0].siteId = "missing-site"; },
    state => { state.shipments.push({ ...state.shipments[0] }); }, state => { state.orders.push({ ...state.orders[0] }); }]) {
    const other = await setup(t, { customize }); const untouched = await other.readPersistedState(); denied(await other.get());
    denied(await other.save({ ...body })); assert.deepEqual(await other.readPersistedState(), untouched);
  }
});

test("parallel and stale edits commit one version and ordinary saves cannot forge or delete metadata/history", async t => {
  const s = await setup(t, { shipmentStatus: "shipped", orderStatus: "shipped" }); const body = await s.draft();
  const results = await Promise.all([s.save(body), s.save(body)]);
  assert.equal(results.filter(result => result.response.status === 200).length, 1); assert.equal(results.filter(result => result.response.status === 409).length, 1);
  const before = await s.readPersistedState(); assert.equal(before.shipments[0].fulfillmentCorrectionHistory.length, 1);
  const write = shipment => s.request("/api/state/patch", { token: s.tokens.admin, body: { patch: { shipments: [shipment] }, basePatch: { shipments: before.shipments } } });
  const { fulfillmentCorrection, fulfillmentCorrectionHistory, ...without } = before.shipments[0];
  for (const forged of [without, { ...before.shipments[0], fulfillmentCorrection: { ...fulfillmentCorrection, receiptStatus: "received" } },
    { ...before.shipments[0], fulfillmentCorrectionHistory: [] }]) {
    const result = await write(forged); assert.equal(result.response.status, 409, JSON.stringify(result.body));
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test("unknown actual facts block ordinary confirmation, receipt and completion without changing existing workflow status", async t => {
  for (const shipmentStatus of ["outbound", "shipped", "delivered"]) {
    const s = await setup(t, { shipmentStatus, orderStatus: shipmentStatus === "delivered" ? "completed" : "shipped" }); ok(await s.save(await s.draft()));
    const before = await s.readPersistedState();
    for (const [route, body] of [["/api/shipments/confirm", { shipmentId: "correction-shipment", packingProof: ["one", "two"] }],
      ["/api/shipments/deliver", { shipmentId: "correction-shipment" }], ["/api/orders/complete", { orderId: "proof-order" }]]) {
      const result = await s.request(route, { token: s.tokens.admin, body }); assert.equal(result.response.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, "FULFILLMENT_CORRECTION_UNCERTAIN");
    }
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("a legitimate cancellation retains complete correction evidence in the existing immutable cancellation audit", async t => {
  const s = await setup(t, { shipmentStatus: "shipped", orderStatus: "shipped", customize: state => { delete state.commissionLedgerV1; } }); ok(await s.save(await s.draft()));
  const before = await s.readPersistedState();
  const preview = await s.request("/api/shipments/cancel-preview?shipmentId=correction-shipment", { token: s.tokens.editor }); ok(preview);
  const cancelled = await s.request("/api/shipments/cancel", { token: s.tokens.editor, body: { shipmentId: "correction-shipment", reviewToken: preview.body.reviewToken,
    confirmedPhysicalReturn: true, returnItems: [{ stockItemId: "proof-fish", subTankId: "tank-n" }] } }); ok(cancelled);
  const after = await s.readPersistedState(); assert.deepEqual(after.shipmentCancellationAudits.at(-1).shipmentBefore, before.shipments[0]);
  assert.ok(after.operationLogs.some(log => log.id === before.operationLogs[0].id));
});
