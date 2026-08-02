import assert from "node:assert/strict";
import test from "node:test";
import {
  isPaymentVerified,
  normalizePaymentChannel,
  refundMethodForChannel,
  verifiedPaymentTotals,
} from "./payment-utils.mjs";

test("legacy payments remain verified", () => {
  assert.equal(isPaymentVerified({ type: "balance", amount: 100 }), true);
  assert.equal(isPaymentVerified({ verificationStatus: "pending" }), false);
});

test("verified totals exclude pending declarations", () => {
  assert.deepEqual(verifiedPaymentTotals([
    { type: "balance", amount: 500 },
    { type: "refund", amount: 100, verificationStatus: "verified" },
    { type: "refund", amount: 80, verificationStatus: "pending" },
    { type: "balance", amount: 120, verificationStatus: "pending" },
  ]), {
    received: 500,
    refunded: 100,
    pendingReceived: 120,
    pendingRefunded: 80,
    pendingCount: 2,
  });
});

test("refund path follows the actual funds location", () => {
  assert.equal(refundMethodForChannel("douyin"), "platform");
  assert.equal(refundMethodForChannel("wechat"), "account");
  assert.equal(refundMethodForChannel("alipay"), "account");
  assert.equal(refundMethodForChannel("bank"), "account");
  assert.equal(refundMethodForChannel("cash"), "account");
  assert.equal(normalizePaymentChannel("unknown"), "");
});
