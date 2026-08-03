import assert from "node:assert/strict";
import test from "node:test";
import { shipmentPaymentGate, verifiedNetPaymentAmount } from "./shipment-payment-rules.mjs";

test("verified payment gate uses verified net receipts only", () => {
  const payments = [
    { type: "balance", amount: 800, verificationStatus: "verified" },
    { type: "balance", amount: 300, verificationStatus: "pending" },
    { type: "refund", amount: 100, verificationStatus: "verified" },
  ];
  assert.equal(verifiedNetPaymentAmount(payments), 700);
  assert.deepEqual(shipmentPaymentGate({ source: "私域线上", payments }, 1000), {
    status: "confirmation_required",
    amountDue: 1000,
    verifiedAmount: 700,
    outstandingAmount: 300,
    approvedAmount: 0,
    canShip: false,
  });
});

test("fully reconciled non-platform orders may ship", () => {
  const result = shipmentPaymentGate({
    source: "线下",
    payments: [{ type: "balance", amount: 1000, verificationStatus: "verified" }],
  }, 999.99);
  assert.equal(result.status, "verified");
  assert.equal(result.canShip, true);
});

test("platform orders bypass pre-shipment reconciliation", () => {
  const result = shipmentPaymentGate({ source: "平台下单", payments: [] }, 1800);
  assert.equal(result.status, "platform_exempt");
  assert.equal(result.canShip, true);
});

test("offline pickup orders default to credit before reconciliation", () => {
  const result = shipmentPaymentGate({ source: "线下", payments: [] }, 360);
  assert.deepEqual(result, {
    status: "offline_credit",
    amountDue: 360,
    verifiedAmount: 0,
    outstandingAmount: 360,
    approvedAmount: 360,
    canShip: true,
  });
});

test("the responsible person may approve only the unreconciled amount", () => {
  const order = {
    source: "私域线上",
    payments: [{ type: "deposit", amount: 200, verificationStatus: "verified" }],
    creditSaleApproval: {
      amount: 800,
      confirmedAt: "2026-08-03T12:00",
      confirmedBy: "sales-a",
    },
  };
  assert.equal(shipmentPaymentGate(order, 1000).status, "credit_approved");
  assert.equal(shipmentPaymentGate(order, 1100).status, "confirmation_required");
});
