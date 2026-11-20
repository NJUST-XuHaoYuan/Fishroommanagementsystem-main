import assert from "node:assert/strict";
import test from "node:test";
import {
  fulfillmentCorrectionCanApply, fulfillmentCorrectionDraft, fulfillmentCorrectionPayload,
  fulfillmentCorrectionPreviewFromPayload, shipmentFulfillmentState,
} from "./shipmentFulfillmentCorrection.ts";

const correction = extra => ({ version: 1, shippingTimeStatus: "known", actualShippedAt: "2026-11-19T10:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-20T10:00:00", reason: "已核对", updatedAt: "2026-11-20T12:00:00", operator: "admin", ...extra });
const preview = extra => ({ shipmentId: "sh1", expectedVersion: 0, baselineToken: "token", current: null, history: [], original: { shipDate: "2026-11-18", status: "delivered", deliveredAt: "2026-11-18T10:00:00" }, order: { id: "o1", orderNo: "SO-2026-2748", date: "2026-11-18", status: "completed" }, ...extra });
const draft = extra => ({ ...fulfillmentCorrectionDraft(null), reason: "原鱼延迟发，实际时间无法核实", ...extra });
const now = "2026-11-20T13:00:00";

test("initial correction defaults to unknown rather than copying the original registered dates", () => {
  assert.deepEqual(fulfillmentCorrectionDraft(null), { shippingTimeStatus: "unknown", actualShippedAt: "", receiptStatus: "unknown", actualDeliveredAt: "", receiptDateUnknown: false, reason: "" });
});

test("unknown statuses omit stale dates instead of guessing or submitting hidden values", () => {
  const result = fulfillmentCorrectionPayload(preview(), draft({ actualShippedAt: "2026-11-18T10:00:00", actualDeliveredAt: "2026-11-18T12:00:00" }), now);
  assert.equal(result.shippingTimeStatus, "unknown");
  assert.equal(result.receiptStatus, "unknown");
  assert.equal("actualShippedAt" in result, false);
  assert.equal("actualDeliveredAt" in result, false);
  assert.equal(result.expectedVersion, 0);
  assert.equal(result.baselineToken, "token");
});

test("known shipping date is mandatory and bounded by order date and current time", () => {
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ shippingTimeStatus: "known" }), now), /实际发货时间/);
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ shippingTimeStatus: "known", actualShippedAt: "2026-11-17T09:00:00" }), now), /早于下单日期/);
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ shippingTimeStatus: "known", actualShippedAt: "2026-11-20T14:00:00" }), now), /晚于当前时间/);
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ shippingTimeStatus: "known", actualShippedAt: "2026-02-30T10:00:00" }), now), /有效/);
});

test("received without date requires an explicit unknown-date choice", () => {
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ receiptStatus: "received" }), now), /实际签收时间/);
  const result = fulfillmentCorrectionPayload(preview(), draft({ receiptStatus: "received", receiptDateUnknown: true, actualDeliveredAt: "2026-11-18T10:00:00" }), now);
  assert.equal(result.receiptStatus, "received");
  assert.equal("actualDeliveredAt" in result, false);
});

test("known receipt time cannot precede known shipment time and correction reason is required", () => {
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ shippingTimeStatus: "known", actualShippedAt: "2026-11-19T11:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-19T10:00:00" }), now), /早于实际发货时间/);
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ reason: "  " }), now), /更正原因/);
  assert.throws(() => fulfillmentCorrectionPayload(preview(), draft({ reason: "x".repeat(1001) }), now), /1000/);
});

test("not received always omits previous delivery time", () => {
  const result = fulfillmentCorrectionPayload(preview(), draft({ receiptStatus: "not_received", actualDeliveredAt: "2026-11-19T12:00:00" }), now);
  assert.equal("actualDeliveredAt" in result, false);
});

test("current received-date-unknown state reopens with the explicit checkbox selected", () => {
  const result = fulfillmentCorrectionDraft(correction({ actualDeliveredAt: undefined }));
  assert.equal(result.receiptDateUnknown, true);
  assert.equal(result.reason, "");
  assert.equal(result.actualDeliveredAt, "");
});

test("unknown correction overrides an old delivery flag with a pending verification label", () => {
  const status = shipmentFulfillmentState({ status: "delivered", fulfillmentCorrection: correction({ shippingTimeStatus: "unknown", actualShippedAt: undefined, receiptStatus: "unknown", actualDeliveredAt: undefined }) });
  assert.equal(status.label, "履约待核实");
  assert.equal(status.pending, true);
  assert.equal(status.needsVerification, true);
  assert.equal(shipmentFulfillmentState({ status: "delivered" }), null);
});

test("received with unknown date remains pending verification; confirmed not-received remains pending fulfillment", () => {
  assert.equal(shipmentFulfillmentState({ fulfillmentCorrection: correction({ actualDeliveredAt: undefined }) }).receiptLabel, "已收到，签收日期待核实");
  assert.equal(shipmentFulfillmentState({ fulfillmentCorrection: correction({ actualDeliveredAt: undefined }) }).needsVerification, true);
  const pending = shipmentFulfillmentState({ fulfillmentCorrection: correction({ receiptStatus: "not_received", actualDeliveredAt: undefined }) });
  assert.equal(pending.label, "实际尚未收到");
  assert.equal(pending.pending, true);
  assert.equal(pending.needsVerification, false);
  assert.equal(shipmentFulfillmentState({ fulfillmentCorrection: correction({}) }).label, "履约已核实");
});

test("preview rejects wrong shipment and stale or missing concurrency metadata", () => {
  assert.equal(fulfillmentCorrectionPreviewFromPayload(preview(), "sh1")?.order.orderNo, "SO-2026-2748");
  assert.equal(fulfillmentCorrectionPreviewFromPayload(preview(), "sh2"), null);
  assert.equal(fulfillmentCorrectionPreviewFromPayload(preview({ baselineToken: "" }), "sh1"), null);
  assert.equal(fulfillmentCorrectionPreviewFromPayload(preview({ current: correction({}), expectedVersion: 0 }), "sh1"), null);
});

test("local updates reject removed or superseded shipment corrections", () => {
  const result = { id: "sh1", fulfillmentCorrection: correction({ version: 2 }) };
  assert.equal(fulfillmentCorrectionCanApply(undefined, result), false);
  assert.equal(fulfillmentCorrectionCanApply({ id: "sh2" }, result), false);
  assert.equal(fulfillmentCorrectionCanApply({ id: "sh1", fulfillmentCorrection: correction({ version: 3 }) }, result), false);
  assert.equal(fulfillmentCorrectionCanApply({ id: "sh1", fulfillmentCorrection: correction({ version: 1 }) }, result), true);
});
