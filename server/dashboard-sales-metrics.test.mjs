import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardSalesMetrics,
  dashboardOrderAdjustmentTotals,
  dashboardOrderReceipts,
  dashboardOrderSaleAmount,
  dashboardRefundStage,
  isUnshippedOrderRefund,
  shipmentDamageAmount,
} from "./dashboard-sales-metrics.mjs";

const date = "2026-11-19";
const receipt = (id, amount, extra = {}) => ({ id, type: "balance", amount, time: `${date}T09:00:00`, ...extra });
const refund = (id, amount, extra = {}) => ({ id, type: "refund", amount, time: `${date}T10:00:00`, ...extra });
const order = extra => ({ id: "o1", orderNo: "SO-1", date, items: [{ price: 200 }], ...extra });
const metrics = (orders, shipments = [], dates = [date]) => buildDashboardSalesMetrics({ dates, orders, shipments });

test("registered receipts include pending payments and non-rejected claims without finance approval", () => {
  const result = metrics([order({ payments: [receipt("p1", 100, { verificationStatus: "pending" }), receipt("p2", 40)],
    paymentClaims: [{ id: "c1", amount: 30, status: "pending", time: date }, { id: "c2", amount: 50, status: "rejected", time: date }] })]);
  assert.equal(result.dailyFinanceData[0].received, 170);
});

test("explicit approved claim/payment linkage counts once, retaining claim date and effective payment amount", () => {
  const result = metrics([order({ paymentClaims: [{ id: "c1", paymentId: "p1", amount: 100, status: "approved", time: date }],
    payments: [receipt("p1", 98, { time: "2026-11-20T10:00:00", paymentProofClaimId: "c1", recordSource: "statement" })] })], [], [date, "2026-11-20"]);
  assert.deepEqual(result.dailyFinanceData.map(point => point.received), [98, 0]);
  assert.equal(result.salesMetricWarnings.possibleDuplicateReceiptCount, 0);
});

test("either explicit direction is sufficient for one-to-one linkage", () => {
  const records = dashboardOrderReceipts(order({ payments: [receipt("p1", 10, { paymentProofClaimId: "c1" }), receipt("p2", 20)],
    paymentClaims: [{ id: "c1", amount: 10, status: "approved", time: date }, { id: "c2", paymentId: "p2", amount: 20, status: "approved", time: date }] }));
  assert.equal(records.reduce((sum, item) => sum + item.amount, 0), 30);
  assert.equal(records.length, 2);
});

test("same amount and business day warns without guessing a claim/payment merge", () => {
  const result = metrics([order({ payments: [receipt("p1", 100)], paymentClaims: [{ id: "c1", amount: 100, status: "pending", time: date }] })]);
  assert.equal(result.dailyFinanceData[0].received, 200);
  assert.equal(result.salesMetricWarnings.possibleDuplicateReceiptCount, 1);
  assert.deepEqual(result.salesMetricWarnings.details.possibleDuplicateReceipt, [{ orderId: "o1", orderNo: "SO-1" }]);
});

test("same external transaction across dates warns in either affected date range without merging", () => {
  const orders = [order({ payments: [receipt("p1", 100, { externalTransactionNo: "tx" })],
    paymentClaims: [{ id: "c1", amount: 100, status: "pending", time: "2026-11-18", externalTransactionNo: "tx" }] })];
  assert.equal(metrics(orders).dailyFinanceData[0].received, 100);
  assert.equal(metrics(orders).salesMetricWarnings.possibleDuplicateReceiptCount, 1);
  assert.equal(metrics(orders, [], ["2026-11-18"]).salesMetricWarnings.possibleDuplicateReceiptCount, 1);
  assert.equal(metrics(orders, [], ["2026-11-17"]).salesMetricWarnings.possibleDuplicateReceiptCount, 0);
});

test("distinct external transactions and channels do not create false duplicate warnings", () => {
  const result = metrics([order({ payments: [receipt("p1", 100, { channel: "wechat", externalTransactionNo: "a" })],
    paymentClaims: [{ id: "c1", amount: 100, status: "pending", time: date, channel: "wechat", externalTransactionNo: "b" },
      { id: "c2", amount: 100, status: "pending", time: date, channel: "bank" }] })]);
  assert.equal(result.salesMetricWarnings.possibleDuplicateReceiptCount, 0);
  assert.equal(result.dailyFinanceData[0].received, 300);
});

test("ambiguous references never silently discard multiple registered payments", () => {
  const result = metrics([order({ payments: [receipt("p1", 100, { paymentProofClaimId: "c1" }), receipt("p2", 100, { paymentProofClaimId: "c1" })],
    paymentClaims: [{ id: "c1", paymentId: "p1", amount: 100, status: "approved", time: date }] })]);
  assert.equal(result.dailyFinanceData[0].received, 300);
  assert.equal(result.salesMetricWarnings.possibleDuplicateReceiptCount, 1);
});

test("statement matching preserves original receipt business date", () => {
  const result = metrics([order({ payments: [receipt("p1", 100, { time: "2026-11-20", recordSource: "statement", statementOriginal: { time: date } })] })]);
  assert.equal(result.dailyFinanceData[0].received, 100);
});

test("created original-sale snapshot survives deleted fish, cancellation and later refunds", () => {
  const result = metrics([order({ status: "cancelled", items: [], salesAmountSnapshot: { amount: 290, capturedAt: date, source: "created" },
    payments: [refund("r1", 50, { refundStage: "before_shipment" })] })]);
  assert.equal(result.dailyFinanceData[0].orderAmount, 290);
  assert.equal(result.dailyFinanceData[0].unshippedRefund, 50);
  assert.equal(result.salesMetricWarnings.legacyOrderAmountCount, 0);
  assert.deepEqual(dashboardOrderSaleAmount(order({ salesAmountSnapshot: { amount: 0, source: "created" } })), { amount: 0, legacy: false });
});

test("legacy order estimate uses original prepaid freight, packaging and discount, never damage adjustment", () => {
  const result = metrics([order({ status: "damaged", shippingFee: 30, packagingFee: 15, discount: 5 })],
    [{ orderId: "o1", status: "damaged", damageResolution: "refund", damageRefundAmount: 80, actualShippingFee: 70, damagedAt: date }]);
  assert.equal(result.dailyFinanceData[0].orderAmount, 240);
  assert.equal(result.dailyFinanceData[0].shippedDamage, 0);
  assert.equal(result.salesMetricWarnings.legacyOrderAmountCount, 1);
  assert.equal(dashboardOrderSaleAmount(order({ shippingFee: 30, shippingFeeMode: "free" })).amount, 200);
  assert.equal(dashboardOrderSaleAmount(order({ shippingFee: 30, source: "线下自提" })).amount, 200);
  assert.equal(dashboardOrderSaleAmount(order({ salesAmountSnapshot: { amount: 150, source: "legacy" } })).legacy, true);
});

test("refund snapshots override current fulfillment and preserve initial business date", () => {
  const result = metrics([order({ payments: [receipt("p1", 200), refund("r1", 40, { refundStage: "before_shipment", refundOccurredAt: `${date}T10:00:00`, time: "2026-11-22" }),
    refund("r2", 30, { refundStage: "after_shipment" })] })], [{ orderId: "o1", status: "delivered", shippedAt: "2026-11-18" }]);
  assert.equal(result.dailyFinanceData[0].unshippedRefund, 40);
  assert.equal(result.dailyFinanceData[0].shippedDamage, 30);
  assert.equal(result.salesMetricWarnings.estimatedRefundStageCount, 0);
  assert.equal(result.salesMetricWarnings.unmatchedRefundCount, 0);
});

test("legacy refund stages use actual fulfillment, including completed-order refunds and all record sources", () => {
  const result = metrics([order({ status: "completed", payments: [receipt("p1", 200), refund("r1", 20, { recordSource: "finance", verificationStatus: "pending" })] })],
    [{ orderId: "o1", status: "delivered", shippedAt: "2026-11-18T15:00:00" }]);
  assert.equal(result.dailyFinanceData[0].shippedDamage, 20);
  assert.equal(result.dailyFinanceData[0].unshippedRefund, 0);
  assert.equal(result.salesMetricWarnings.estimatedRefundStageCount, 1);
  assert.equal(isUnshippedOrderRefund(refund("r", 10, { recordSource: "finance" }), []), true);
  assert.deepEqual(dashboardRefundStage(refund("r", 10), [{ status: "shipped", shippedAt: "2026-11-20" }]), { stage: "before_shipment", estimated: true });
});

test("statement-linked legacy refunds retain their original date", () => {
  const result = metrics([order({ payments: [refund("r1", 40, { time: "2026-11-20", recordSource: "statement", statementOriginal: { time: date, recordSource: "order" } })] })]);
  assert.equal(result.dailyFinanceData[0].unshippedRefund, 40);
});

test("receivable-only damage adjustment is never a refund, and a payment plus damage adjustment counts once", () => {
  const shipment = { orderId: "o1", status: "damaged", shippedAt: "2026-11-18", damagedAt: date, damageResolution: "refund", damageAmount: 70, damageRefundAmount: 70,
    damageEvents: [{ id: "d1", time: date, resolution: "refund" }] };
  assert.equal(metrics([order({})], [shipment]).dailyFinanceData[0].shippedDamage, 0);
  assert.equal(metrics([order({ payments: [refund("r", 70)] })], [shipment]).dailyFinanceData[0].shippedDamage, 70);
  assert.equal(shipmentDamageAmount(shipment, order({})), 0);
});

test("replacement value uses replacement fish sale snapshot and retains repeated events without current-field duplication", () => {
  const shipment = { orderId: "o1", status: "damaged", damagedAt: date, damageResolution: "reship", damageAmount: 999,
    damageReplacements: [{ replacementSalePrice: 500 }], damageEvents: [
      { id: "d1", time: date, resolution: "reship", replacementSaleAmount: 80 },
      { id: "d1", time: date, resolution: "reship", replacementSaleAmount: 80 },
      { id: "d2", time: date, resolution: "reship", replacements: [{ replacementSalePrice: 60 }, { replacementSalePrice: 0 }] },
    ] };
  assert.equal(metrics([order({})], [shipment]).dailyFinanceData[0].shippedDamage, 140);
  assert.equal(shipmentDamageAmount(shipment, order({})), 140);
});

test("missing historical replacement prices warn and never use original fish or today's product prices", () => {
  const shipment = { orderId: "o1", status: "damaged", damagedAt: date, damageResolution: "reship", damageAmount: 200,
    damageReplacements: [{ originalStockItemId: "a", replacementStockItemId: "b" }] };
  const result = metrics([order({ items: [{ stockItemId: "a", price: 200 }] })], [shipment]);
  assert.equal(result.dailyFinanceData[0].shippedDamage, 0);
  assert.equal(result.salesMetricWarnings.missingReplacementPriceCount, 1);
  assert.deepEqual(result.salesMetricWarnings.details.missingReplacementPrice, [{ orderId: "o1", orderNo: "SO-1" }]);
});

test("refunds without known receipts remain counted with a reconciliation warning", () => {
  const result = metrics([order({ payments: [refund("r1", 20, { refundStage: "before_shipment" })] })]);
  assert.equal(result.dailyFinanceData[0].unshippedRefund, 20);
  assert.equal(result.salesMetricWarnings.unmatchedRefundCount, 1);
  const funded = metrics([order({ payments: [receipt("p1", 20, { time: "2026-11-18" }), refund("r1", 20, { refundStage: "before_shipment" })] })]);
  assert.equal(funded.salesMetricWarnings.unmatchedRefundCount, 0);
});

test("warnings are date-scoped and order detail samples are unique and capped at 20", () => {
  const orders = Array.from({ length: 25 }, (_, index) => order({ id: `o${index}`, orderNo: `SO-${index}`, payments: [refund("r", 1)] }));
  const result = metrics(orders);
  assert.equal(result.salesMetricWarnings.legacyOrderAmountCount, 25);
  assert.equal(result.salesMetricWarnings.details.legacyOrderAmount.length, 20);
  assert.equal(result.salesMetricWarnings.estimatedRefundStageCount, 25);
  assert.equal(result.salesMetricWarnings.details.unmatchedRefund.length, 20);
  const outside = metrics(orders, [], ["2026-11-20"]).salesMetricWarnings;
  assert.equal(outside.legacyOrderAmountCount, 0);
  assert.equal(outside.estimatedRefundStageCount, 0);
  assert.equal(outside.unmatchedRefundCount, 0);
});

test("adjustment compatibility API shares the new refund and replacement rules", () => {
  const orders = [order({ payments: [refund("r1", 12, { refundStage: "before_shipment" }), refund("r2", 18, { refundStage: "after_shipment" })] })];
  const shipments = [{ orderId: "o1", damageEvents: [{ id: "d1", time: date, resolution: "reship", replacementSaleAmount: 30 }] }];
  assert.deepEqual(dashboardOrderAdjustmentTotals(orders, shipments, date), { unshippedRefund: 12, shippedDamage: 48 });
});


test("later fulfillment corrections warn without changing registered refund dates, amounts or stages", () => {
  const orders = [order({ payments: [receipt("p", 200),
    refund("before", 30, { refundStage: "before_shipment", refundOccurredAt: `${date}T10:00:00`, time: "2026-11-22" }),
    refund("after", 40, { refundStage: "after_shipment" }),
  ] })];
  const shipment = { orderId: "o1", status: "delivered", shippedAt: "2026-11-18T10:00:00", deliveredAt: date };
  const original = metrics(orders, [shipment]);
  assert.equal(original.salesMetricWarnings.correctedFulfillmentRefundCount, 0);
  assert.deepEqual(original.salesMetricWarnings.details.correctedFulfillmentRefund, []);
  for (const fulfillmentCorrection of [
    { shippingTimeStatus: "unknown", receiptStatus: "unknown" },
    { shippingTimeStatus: "known", actualShippedAt: "2026-11-20T10:00:00", receiptStatus: "received", actualDeliveredAt: "2026-11-21T10:00:00" },
  ]) {
    const corrected = metrics(orders, [{ ...shipment, fulfillmentCorrection }]);
    assert.deepEqual(corrected.dailyFinanceData, original.dailyFinanceData);
    assert.equal(corrected.dailyFinanceData[0].unshippedRefund, 30);
    assert.equal(corrected.dailyFinanceData[0].shippedDamage, 40);
    assert.equal(corrected.salesMetricWarnings.estimatedRefundStageCount, original.salesMetricWarnings.estimatedRefundStageCount);
    assert.equal(corrected.salesMetricWarnings.correctedFulfillmentRefundCount, 2);
    assert.deepEqual(corrected.salesMetricWarnings.details.correctedFulfillmentRefund, [{ orderId: "o1", orderNo: "SO-1" }]);
  }
});

test("corrected-fulfillment refund warning is scoped to refund business date and owning order", () => {
  const orders = [order({ payments: [refund("r1", 30, { refundStage: "before_shipment", refundOccurredAt: "2026-11-18T10:00:00" }),
    refund("r2", 40, { refundStage: "after_shipment" })] }),
    order({ id: "uncorrected", orderNo: "SO-OTHER", payments: [refund("r3", 50, { refundStage: "before_shipment" })] })];
  const shipments = [{ orderId: "o1", status: "delivered", shippedAt: "2026-11-17", fulfillmentCorrection: { shippingTimeStatus: "unknown", receiptStatus: "unknown" } }];
  const selected = metrics(orders, shipments);
  assert.equal(selected.salesMetricWarnings.correctedFulfillmentRefundCount, 1);
  assert.deepEqual(selected.salesMetricWarnings.details.correctedFulfillmentRefund, [{ orderId: "o1", orderNo: "SO-1" }]);
  assert.equal(metrics(orders, shipments, ["2026-11-18"]).salesMetricWarnings.correctedFulfillmentRefundCount, 1);
  assert.equal(metrics(orders, shipments, ["2026-11-20"]).salesMetricWarnings.correctedFulfillmentRefundCount, 0);
  assert.deepEqual(metrics(orders, shipments, ["2026-11-20"]).salesMetricWarnings.details.correctedFulfillmentRefund, []);
  const noRefund = metrics([order({ payments: [receipt("p", 200)] })], shipments);
  assert.equal(noRefund.salesMetricWarnings.correctedFulfillmentRefundCount, 0);
});
