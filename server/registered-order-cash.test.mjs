import test from "node:test";
import assert from "node:assert/strict";
import { registeredOrderCashSummary, shippingSettlementSummary, validateOrderRefundAllocation } from "./shipping-settlement.mjs";

test("registered cash counts pending income and reserves pending refunds, with persistent-ID deduplication", () => {
  const payment = { id: "payment", type: "balance", amount: 100, verificationStatus: "pending", paymentProofClaimId: "linked" };
  const claim = { id: "new-claim", status: "pending", amount: 30 };
  const order = { payments: [payment, { ...payment }, { id: "refund", type: "refund", amount: 20, verificationStatus: "pending" }], paymentClaims: [
    { id: "linked", status: "pending", amount: 100 },
    { id: "matched", matchingPaymentId: "payment", status: "pending", amount: 100 },
    { id: "payment-linked", paymentId: "payment", status: "pending", amount: 100 },
    claim, { ...claim }, { id: "rejected", status: "rejected", amount: 999 }, { id: "orphan-approved", status: "approved", amount: 999 },
  ] };
  assert.deepEqual(registeredOrderCashSummary(order), {
    recordedReceived: 130, recordedRefunded: 20, netRecorded: 110, availableRefund: 110,
    verifiedReceived: 0, verifiedRefunded: 0, pendingReceiptAmount: 100, pendingProofAmount: 30, pendingRefundAmount: 20,
    pendingReceiptCount: 1, pendingProofCount: 1, pendingRefundCount: 1, invalidRecordCount: 0,
  });
});

test("same amounts with distinct IDs stay distinct; rejected supplemental proof does not erase an existing payment", () => {
  const order = { payments: [{ id: "one", type: "balance", amount: 100 }, { id: "two", type: "balance", amount: 100, verificationStatus: "pending" }],
    paymentClaims: [{ id: "rejected", status: "rejected", paymentId: "one", amount: 100 }] };
  const cash = registeredOrderCashSummary(order); assert.equal(cash.recordedReceived, 200); assert.equal(cash.verifiedReceived, 100);
});

test("invalid amounts and conflicting IDs fail closed, while rejected declarations never authorize refunds", () => {
  for (const payments of [
    [{ id: "bad", amount: -1 }], [{ id: "bad", amount: Infinity }], [{ id: "bad", amount: 1.001 }],
    [{ id: "bad", amount: 100, shippingAmount: 101 }], [{ id: "bad", amount: 100 }, { id: "bad", amount: 200 }],
  ]) {
    const cash = registeredOrderCashSummary({ payments }); assert.ok(cash.invalidRecordCount > 0); assert.equal(cash.availableRefund, 0);
  }
  assert.equal(registeredOrderCashSummary({ paymentClaims: [{ id: "bad", status: "rejected", amount: 104 }] }).availableRefund, 0);
});

test("pending 104 declaration permits 16 freight difference and its registration immediately consumes both balances", () => {
  const order = { id: "o", source: "私域线上", shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 50,
    items: [{ stockItemId: "fish", price: 65 }], discount: 11, packagingFee: 0, payments: [],
    paymentClaims: [{ id: "claim", status: "pending", amount: 104, purpose: "order", shippingAmount: 50 }] };
  const shipments = [{ orderId: "o", status: "delivered", shipMethod: "express", itemStockIds: ["fish"], actualShippingFee: 34 }];
  assert.equal(registeredOrderCashSummary(order).availableRefund, 104);
  assert.equal(shippingSettlementSummary(order, shipments).toRefund, 16);
  assert.deepEqual(validateOrderRefundAllocation(order, 104), { goodsAmount: 54, shippingAmount: 50 });
  order.payments.push({ id: "refund", type: "refund", refundCategory: "shipping_fee", shippingAmount: 16, amount: 16, verificationStatus: "pending" });
  assert.equal(registeredOrderCashSummary(order).availableRefund, 88); assert.equal(shippingSettlementSummary(order, shipments).toRefund, 0);
  order.paymentClaims[0].status = "rejected";
  const cash = registeredOrderCashSummary(order); assert.equal(cash.recordedRefunded, 16); assert.equal(cash.netRecorded, -16); assert.equal(cash.availableRefund, 0);
});
