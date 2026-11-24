import test from "node:test";
import assert from "node:assert/strict";
import { orderCompletionFinancialCheck as check } from "./order-completion-finance.mjs";

const receipt = (amount, verificationStatus = "verified") => ({ type: "balance", amount, verificationStatus });
const refund = (amount, verificationStatus = "verified") => ({ type: "refund", amount, verificationStatus });

test("verified net receipts must equal the final receivable, to the cent", () => {
  assert.equal(check({ payments: [receipt(0.1), receipt(0.2)] }, 0.3).canComplete, true);
  assert.equal(check({ payments: [receipt(999.99)] }, 1000).outstandingAmount, 0.01);
  assert.equal(check({ payments: [receipt(1000.01)] }, 1000).refundDueAmount, 0.01);
  assert.equal(check({ payments: [] }, 0).canComplete, true);
  const value = check({ payments: [receipt(1000), refund(100)] }, 900);
  assert.equal(value.canComplete, true); assert.equal(value.verifiedReceived, 1000);
  assert.equal(value.verifiedRefunded, 100); assert.equal(value.verifiedNetReceived, 900);
  assert.equal(check({ payments: [receipt(1000), refund(100)] }, 1000).outstandingAmount, 100);
});

test("each pending financial record blocks even if verified money already equals due", () => {
  for (const [extra, code] of [
    [{ payments: [receipt(1000), receipt(5, "pending")] }, "RECEIPT_PENDING"],
    [{ payments: [receipt(1000), refund(5, "pending")] }, "REFUND_PENDING"],
    [{ payments: [receipt(1000)], paymentClaims: [{ status: "pending", matchingPaymentId: "receipt" }] }, "PAYMENT_PROOF_PENDING"],
  ]) {
    const result = check(extra, 1000); assert.equal(result.canComplete, false);
    assert.equal(result.reasons[0].code, code); assert.equal(result.verifiedNetReceived, 1000);
  }
  assert.equal(check({ payments: [receipt(1000)], paymentClaims: [{ status: "rejected" }, { status: "approved" }] }, 1000).canComplete, true);
});

test("legacy verified records preserve existing semantics while invalid amounts fail closed", () => {
  assert.equal(check({ payments: [{ type: "balance", amount: 1000 }] }, 1000).canComplete, true);
  for (const amount of [NaN, Infinity, -1, 1.001, null, "", true, Number.MAX_SAFE_INTEGER]) {
    assert.equal(check({ payments: [] }, amount).reasons[0].code, "INVALID_FINANCIAL_AMOUNT");
    assert.equal(check({ payments: [{ type: "balance", amount }] }, 0).reasons[0].code, "INVALID_FINANCIAL_AMOUNT");
  }
});
