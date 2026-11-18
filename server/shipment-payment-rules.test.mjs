import assert from "node:assert/strict";
import test from "node:test";
import { shipmentPaymentGate, verifiedNetPaymentAmount } from "./shipment-payment-rules.mjs";

const proof = (amount, status = "pending", extra = {}) => ({ id: `claim-${amount}`, status, amount, evidenceAttachments: [{ id: "private-evidence" }], ...extra });

test("all sources may ship while only verified net receipts confirm money", () => {
  const payments = [
    { type: "balance", amount: 800, verificationStatus: "verified" },
    { type: "balance", amount: 300, verificationStatus: "pending" },
    { type: "refund", amount: 100, verificationStatus: "verified" },
  ];
  assert.equal(verifiedNetPaymentAmount(payments), 700);
  for (const source of ["私域线上", "平台下单", "闲鱼平台", "微拍堂平台", "线下"]) {
    const gate = shipmentPaymentGate({ source, payments }, 1000);
    assert.equal(gate.canShip, true, source); assert.equal(gate.status, "credit_sale");
    assert.equal(gate.verifiedAmount, 700); assert.equal(gate.creditAmount, 300); assert.equal(gate.pendingProofAmount, 0);
  }
});

test("fully reconciled legacy receipts remain paid without uploading historical pictures", () => {
  const gate = shipmentPaymentGate({ source: "平台下单", payments: [{ type: "balance", amount: 1000 }] }, 1000);
  assert.equal(gate.status, "verified"); assert.equal(gate.verifiedAmount, 1000); assert.equal(gate.creditAmount, 0);
  assert.equal(gate.canShip, true);
});

test("pending proof covers a declared amount without fabricating confirmed receipts", () => {
  const gate = shipmentPaymentGate({ source: "私域线上", paymentClaims: [proof(1000)], payments: [] }, 1000);
  assert.equal(gate.status, "proof_pending"); assert.equal(gate.pendingProofAmount, 1000); assert.equal(gate.verifiedAmount, 0);
  assert.equal(gate.creditAmount, 0); assert.equal(gate.canShip, true);
});

test("partial declarations and verified receipts leave only the uncovered difference as credit", () => {
  const gate = shipmentPaymentGate({ payments: [{ type: "balance", amount: 200, verificationStatus: "verified" }],
    paymentClaims: [proof(300), proof(400, "rejected"), proof(500, "approved"), proof(900, "pending", { evidenceAttachments: [] })] }, 1000);
  assert.equal(gate.verifiedAmount, 200); assert.equal(gate.pendingProofAmount, 300); assert.equal(gate.creditAmount, 500);
  assert.equal(gate.status, "credit_sale");
});

test("old credit approval cannot mark unpaid value as confirmed or erase credit", () => {
  const gate = shipmentPaymentGate({ source: "私域线上", payments: [], creditSaleApproval: { amount: 1000, confirmedAt: "2026-11-01T12:00", confirmedBy: "admin" } }, 1000);
  assert.equal(gate.status, "credit_sale"); assert.equal(gate.creditAmount, 1000); assert.equal(gate.verifiedAmount, 0);
  assert.equal(gate.approvedAmount, 0); assert.equal(gate.canShip, true);
});

test("pending coverage is capped to the receivable after verified receipts", () => {
  const gate = shipmentPaymentGate({ payments: [{ type: "balance", amount: 800, verificationStatus: "verified" }], paymentClaims: [proof(700)] }, 1000);
  assert.equal(gate.pendingProofAmount, 200); assert.equal(gate.creditAmount, 0);
});
