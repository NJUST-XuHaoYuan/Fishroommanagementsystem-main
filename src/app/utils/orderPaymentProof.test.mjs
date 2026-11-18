import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { paymentProofSummary } from "../../../server/payment-proof-rules.mjs";

let vite, frontend;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  frontend = await vite.ssrLoadModule("/src/app/utils/orderPaymentProof.ts");
});
after(async () => { await vite?.close(); });

const claim = (amount, status = "pending") => ({ amount, status, evidenceAttachments: [{ id: "synthetic-proof" }] });
const payment = (amount, extra = {}) => ({ amount, type: "balance", verificationStatus: "verified", ...extra });
const scenarios = [
  ["no evidence covers no unpaid amount", {}, 100, [0, 0, 100]],
  ["a full pending proof allows delivery without pretending cash arrived", { paymentClaims: [claim(100)] }, 100, [0, 100, 0]],
  ["partial proof leaves a credit balance", { paymentClaims: [claim(40)] }, 100, [0, 40, 60]],
  ["verified cash and pending proofs cover different parts", { payments: [payment(30)], paymentClaims: [claim(40)] }, 100, [30, 40, 30]],
  ["rejected and approved proof metadata cannot itself count as cash", { paymentClaims: [claim(100, "rejected"), claim(100, "approved")] }, 100, [0, 0, 100]],
  ["old verified money remains valid without photographs", { payments: [payment(100, { verificationStatus: undefined })] }, 100, [100, 0, 0]],
  ["pending legacy payment does not become confirmed receipt", { payments: [payment(100, { verificationStatus: "pending" })] }, 100, [0, 0, 100]],
  ["verified refunds reopen the uncovered balance", { payments: [payment(100), payment(20, { type: "refund" })], paymentClaims: [] }, 100, [80, 0, 20]],
  ["claimed evidence cannot cover more than the current unpaid balance", { payments: [payment(75)], paymentClaims: [claim(40)] }, 100, [75, 25, 0]],
];

for (const [label, order, due, expected] of scenarios) test(label, () => {
  for (const summary of [frontend.orderPaymentProofSummary(order, due), paymentProofSummary(order, due)]) {
    assert.deepEqual([summary.verifiedAmount, summary.pendingProofAmount, summary.creditAmount], expected);
    assert.equal(summary.amountDue, due);
  }
});
