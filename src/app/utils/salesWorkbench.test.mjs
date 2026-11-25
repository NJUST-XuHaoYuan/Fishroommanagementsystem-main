import assert from "node:assert/strict";
import test from "node:test";
import { readOrderFollowupSummary, salesCollectionRemaining, salesPendingShipment } from "./salesWorkbench.ts";

const order = (extra = {}) => ({ id: "order-1", status: "confirmed", source: "私域线上", items: [{ stockItemId: "fish-1", price: 100 }], payments: [], paymentClaims: [], ...extra });
const shipment = (extra = {}) => ({ id: "shipment-1", orderId: "order-1", status: "shipped", itemStockIds: ["fish-1"], shipMethod: "express", ...extra });

test("registered pending proof satisfies collection before finance verification", () => {
  assert.equal(salesCollectionRemaining(order({ paymentClaims: [{ id: "proof", amount: 100, status: "pending", purpose: "order" }] }), 100), 0);
  assert.equal(salesCollectionRemaining(order({ paymentClaims: [{ id: "proof", amount: 60, status: "pending", purpose: "order" }] }), 100), 40);
});

test("linked proof and payment are deduplicated, rejected proofs do not count", () => {
  const context = order({ payments: [{ id: "payment", type: "balance", amount: 60, verificationStatus: "pending" }], paymentClaims: [{ id: "proof", paymentId: "payment", amount: 60, status: "pending" }] });
  assert.equal(salesCollectionRemaining(context, 100), 40);
  assert.equal(salesCollectionRemaining(order({ paymentClaims: [{ id: "rejected", amount: 100, status: "rejected" }] }), 100), 100);
});

test("registered refunds, freight adjustment and overpayment use the current order due", () => {
  const context = order({ payments: [{ id: "in", type: "balance", amount: 126, verificationStatus: "pending" }, { id: "out", type: "refund", amount: 16, verificationStatus: "pending" }] });
  assert.equal(salesCollectionRemaining(context, 110), 0);
  assert.equal(salesCollectionRemaining(context, 130), 20);
  assert.equal(salesCollectionRemaining(context, 100), 0);
  assert.equal(salesCollectionRemaining({ ...context, status: "cancelled" }, 130), 0);
});

test("invalid financial records stay unknown rather than being silently treated as paid", () => {
  assert.equal(salesCollectionRemaining(order(), NaN), null);
  assert.equal(salesCollectionRemaining(order({ payments: [{ id: "invalid", type: "balance", amount: -10 }] }), 100), null);
});

test("dispatch work includes new, partial, outbound and pickup orders regardless of order.status", () => {
  assert.equal(salesPendingShipment(order({ status: "shipped" }), []).pending, true);
  assert.equal(salesPendingShipment(order(), [shipment({ status: "outbound" })]).label, "已出库，待发货");
  assert.equal(salesPendingShipment(order({ items: [{ stockItemId: "fish-1" }, { stockItemId: "fish-2" }] }), [shipment()]).label, "部分待发货");
  assert.equal(salesPendingShipment(order({ source: "线下" }), []).label, "待自提");
  assert.equal(salesPendingShipment(order({ source: "线下自提" }), [shipment({ status: "preparing", shipMethod: "pickup" })]).pending, true);
});

test("actually dispatched, delivered pickup and removed fish do not become shipping tasks", () => {
  assert.equal(salesPendingShipment(order(), [shipment()]).pending, false);
  assert.equal(salesPendingShipment(order({ source: "线下" }), [shipment({ status: "delivered", shipMethod: "pickup" })]).pending, false);
  assert.equal(salesPendingShipment(order({ items: [{ stockItemId: "fish-1", inventoryRemovedAt: "2026-11-20" }] }), []).pending, false);
  for (const status of ["completed", "cancelled"]) assert.equal(salesPendingShipment(order({ status }), [shipment({ status: "outbound" })]).pending, false);
});

test("unverified actual shipping time remains visible for checking, without changing the shipment", () => {
  const source = shipment({ fulfillmentCorrection: { shippingTimeStatus: "unknown", receiptStatus: "unknown" } });
  const before = structuredClone(source);
  assert.equal(salesPendingShipment(order(), [source]).label, "发货时间待核实");
  assert.deepEqual(source, before);
});

test("followup summary distinguishes zero records from completed followup and validates the site", () => {
  const payload = { ok: true, siteId: "nanjing", orders: [{ orderId: "first", followupCount: 0, lastFollowupAt: "" }, { orderId: "done", followupCount: 2, lastFollowupAt: "2026-11-26T10:00:00" }] };
  const rows = readOrderFollowupSummary(payload, "nanjing");
  assert.deepEqual(rows.filter(row => row.followupCount === 0).map(row => row.orderId), ["first"]);
  assert.throws(() => readOrderFollowupSummary(payload, "jiangyin"));
});

test("failed or malformed followup data is never interpreted as a zero count", () => {
  for (const payload of [null, {}, { ok: false }, { ok: true, siteId: "nanjing", orders: null }, { ok: true, siteId: "nanjing", orders: [{ orderId: "a" }] }, { ok: true, siteId: "nanjing", orders: [{ orderId: "a", followupCount: -1 }] }]) {
    assert.throws(() => readOrderFollowupSummary(payload, "nanjing"));
  }
  assert.throws(() => readOrderFollowupSummary({ ok: true, siteId: "nanjing", orders: [{ orderId: "a", followupCount: 0 }, { orderId: "a", followupCount: 1 }] }, "nanjing"));
});
