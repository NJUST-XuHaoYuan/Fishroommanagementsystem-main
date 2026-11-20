import test from "node:test";
import assert from "node:assert/strict";
import { applyShipmentFulfillmentCorrection, shipmentFulfillmentCorrectionDetail, fulfillmentCorrectionBlocksProgress,
  assertFulfillmentCorrectionUnchanged } from "./shipment-fulfillment-correction.mjs";

const actor = { username: "codex-maintenance", name: "系统维护（管理员本次授权）", accessRole: "admin" };
const now = "2026-11-20T12:00:00+08:00";
function fixture(status = "delivered") {
  return { sites: [{ id: "nanjing" }], personnel: [{ id: "untouched" }],
    orders: [{ id: "o", orderNo: "SO-TEST", siteId: "nanjing", date: "2026-10-01", status: "completed", items: [{ stockItemId: "fish", price: 200 }], payments: [{ amount: 200 }] }],
    shipments: [{ id: "s", orderId: "o", siteId: "nanjing", status, shipDate: "2026-10-10", shippedAt: "2026-10-10T10:00:00", deliveredAt: "2026-10-15T10:00:00", itemStockIds: ["fish"] }],
    operationLogs: [{ id: "old-log", detail: "历史原始操作" }], stock: [{ id: "fish", batchId: "old-batch" }], batches: [{ id: "old-batch" }],
    commissionLedgerV1: { immutable: "original commission" }, notifications: [{ id: "old-notice" }], lossRecords: [{ id: "old-loss" }],
  };
}
function draft(state, change = {}) {
  const { expectedVersion, baselineToken } = shipmentFulfillmentCorrectionDetail(state, "s", actor);
  return { shipmentId: "s", expectedVersion, baselineToken, shippingTimeStatus: "unknown", receiptStatus: "unknown", reason: "实际履约日期尚无凭证核实，保留原始记录", ...change };
}
function stripCorrection(state) {
  return { ...state, shipments: state.shipments.map(({ fulfillmentCorrection, fulfillmentCorrectionHistory, ...old }) => old),
    operationLogs: state.operationLogs.filter(log => log.action !== "履约记录更正") };
}

test("unknown correction adds auditable facts without changing any prior state branch or original workflow fields", () => {
  for (const status of ["outbound", "shipped", "delivered", "damaged"]) {
    const state = fixture(status); const before = structuredClone(state);
    const result = applyShipmentFulfillmentCorrection(state, draft(state, { status: "pending", itemStockIds: ["fake"], operator: "forged" }), actor, { now });
    assert.deepEqual(state, before); assert.deepEqual(stripCorrection(result.state), before);
    const correction = result.shipment.fulfillmentCorrection;
    assert.equal(correction.version, 1); assert.equal(correction.operator, actor.username); assert.equal(correction.operatorName, actor.name);
    assert.equal(correction.actualShippedAt, undefined); assert.equal(correction.actualDeliveredAt, undefined);
    assert.equal(fulfillmentCorrectionBlocksProgress(result.shipment), true);
    assert.equal(result.shipment.fulfillmentCorrectionHistory[0].from, null);
    assert.deepEqual(result.shipment.fulfillmentCorrectionHistory[0].to, correction);
  }
});

test("known dates normalize China time while received without a verified receipt date remains paused", () => {
  const state = fixture();
  const known = applyShipmentFulfillmentCorrection(state, draft(state, { shippingTimeStatus: "known", actualShippedAt: "2026-11-18T04:00:00Z",
    receiptStatus: "received", actualDeliveredAt: "2026-11-19T13:00" }), actor, { now });
  assert.equal(known.shipment.fulfillmentCorrection.actualShippedAt, "2026-11-18T12:00:00");
  assert.equal(fulfillmentCorrectionBlocksProgress(known.shipment), false);
  const uncertainReceiptDate = applyShipmentFulfillmentCorrection(known.state, draft(known.state, { shippingTimeStatus: "known", actualShippedAt: "2026-11-18T12:00", receiptStatus: "received" }), actor, { now });
  assert.equal(fulfillmentCorrectionBlocksProgress(uncertainReceiptDate.shipment), true);
  assert.equal(uncertainReceiptDate.shipment.fulfillmentCorrection.actualDeliveredAt, undefined);
  assert.equal(uncertainReceiptDate.shipment.deliveredAt, state.shipments[0].deliveredAt);
  assert.deepEqual(uncertainReceiptDate.shipment.fulfillmentCorrectionHistory[1].from, known.shipment.fulfillmentCorrection);
});

test("invalid, future, pre-order, reversed and fabricated unknown dates are rejected without modifying state", () => {
  const state = fixture(); const original = structuredClone(state);
  const changes = [{ reason: " " }, { reason: "a".repeat(2001) }, { shippingTimeStatus: "none" }, { receiptStatus: "yes" },
    { shippingTimeStatus: "known", actualShippedAt: "2026-11-21T00:00" }, { shippingTimeStatus: "known", actualShippedAt: "2026-09-30T23:59" },
    { shippingTimeStatus: "known", actualShippedAt: "2026-02-30T12:00" }, { shippingTimeStatus: "known", actualShippedAt: "2026-11-19T24:00" },
    { actualShippedAt: "2026-11-19T12:00" }, { actualDeliveredAt: "2026-11-19T12:00" },
    { shippingTimeStatus: "known", actualShippedAt: "2026-11-19T12:00", receiptStatus: "received", actualDeliveredAt: "2026-11-19T11:59" }];
  for (const change of changes) assert.throws(() => applyShipmentFulfillmentCorrection(state, draft(state, change), actor, { now }), error => error.statusCode === 400);
  assert.deepEqual(state, original);
});

test("unique targets, administrator identity, valid site and compare-and-swap baseline are mandatory", () => {
  const state = fixture(); const body = draft(state);
  assert.throws(() => applyShipmentFulfillmentCorrection(state, body, { ...actor, accessRole: "staff" }, { now }), error => error.statusCode === 403);
  assert.throws(() => applyShipmentFulfillmentCorrection({ ...state, shipments: [...state.shipments, { ...state.shipments[0] }] }, body, actor, { now }), error => error.code === "SHIPMENT_ID_NOT_UNIQUE");
  assert.throws(() => applyShipmentFulfillmentCorrection({ ...state, orders: [...state.orders, { ...state.orders[0] }] }, body, actor, { now }), error => error.code === "ORDER_ID_NOT_UNIQUE");
  assert.throws(() => applyShipmentFulfillmentCorrection({ ...state, shipments: [{ ...state.shipments[0], siteId: "jiangyin" }] }, body, actor, { now }), error => error.statusCode === 403);
  assert.throws(() => applyShipmentFulfillmentCorrection({ ...state, orders: [{ ...state.orders[0], notes: "changed" }] }, body, actor, { now }), error => error.code === "FULFILLMENT_CORRECTION_CONFLICT");
  const first = applyShipmentFulfillmentCorrection(state, body, actor, { now });
  assert.throws(() => applyShipmentFulfillmentCorrection(first.state, body, actor, { now }), error => error.code === "FULFILLMENT_CORRECTION_CONFLICT");
  assert.throws(() => assertFulfillmentCorrectionUnchanged(first.shipment, { ...first.shipment, fulfillmentCorrectionHistory: [] }), error => error.code === "FULFILLMENT_CORRECTION_IMMUTABLE");
});
