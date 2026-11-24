import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, api;
before(async () => { vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } }); api = await vite.ssrLoadModule("/src/app/utils/orderCashier.ts"); });
after(async () => { await vite?.close(); });
const payment = (id, amount, extra = {}) => ({ id, amount, type: "balance", time: "2026-11-25T10:00:00+08:00", proof: [], ...extra });
const claim = (id, amount, extra = {}) => ({ id, amount, status: "pending", time: "2026-11-25T11:00:00+08:00", evidenceAttachments: [{ id: "proof" }], ...extra });

test("bank receipt first plus pending evidence forms one receipt", () => {
  const entries = api.orderCashierEntries({ payments: [payment("p1", 100)], paymentClaims: [claim("c1", 100, { matchingPaymentId: "p1" })] });
  assert.equal(entries.length, 1); assert.equal(entries[0].statusLabel, "已确认到账 · 凭证待核验");
  assert.equal(api.orderCashierTotals(entries).received, 100);
});
test("approved evidence and generated receipt are deduplicated by either persisted link", () => {
  for (const [p, c] of [[payment("p1", 100), claim("c1", 100, { status: "approved", paymentId: "p1" })], [payment("p1", 100, { paymentProofClaimId: "c1" }), claim("c1", 100, { status: "approved" })]]) {
    const entries = api.orderCashierEntries({ payments: [p], paymentClaims: [c] }); assert.equal(entries.length, 1); assert.equal(api.orderCashierTotals(entries).confirmedReceived, 100);
  }
});
test("all claims linked to one receipt stay one cash entry even when historical review states overlap", () => {
  const entries = api.orderCashierEntries({
    payments: [payment("p1", 100, { paymentProofClaimId: "approved" })],
    paymentClaims: [claim("rejected", 100, { status: "rejected", matchingPaymentId: "p1" }), claim("pending", 100, { matchingPaymentId: "p1" }), claim("approved", 100, { status: "approved", paymentId: "p1" })],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].claim.id, "pending");
  assert.equal(api.orderCashierTotals(entries).received, 100);
  assert.equal(api.orderCashierTotals(entries).confirmedReceived, 100);
});
test("same amount without an ID link remains separate; rejected evidence does not count", () => {
  const entries = api.orderCashierEntries({ payments: [payment("p1", 100)], paymentClaims: [claim("c1", 100), claim("c2", 100, { status: "rejected" })] });
  assert.equal(entries.length, 3); assert.equal(api.orderCashierTotals(entries).received, 200); assert.equal(api.orderCashierTotals(entries).confirmedReceived, 100);
});
test("pending receipt, ordinary refund and freight refund keep cash direction and verification distinct", () => {
  const entries = api.orderCashierEntries({ payments: [payment("p1", 100, { verificationStatus: "pending" }), payment("r1", 20, { type: "refund", verificationStatus: "pending" }), payment("r2", 10, { type: "refund", refundCategory: "shipping_fee" })] });
  assert.deepEqual(api.orderCashierTotals(entries), { received: 100, refunded: 30, netRecorded: 70, confirmedReceived: 0, confirmedRefunded: 10 });
  assert.equal(entries.find(e => e.id === "payment:r2").label, "运费退差额");
});
test("approved orphan evidence is visible for reconciliation but never invents money", () => {
  const entries = api.orderCashierEntries({ payments: [], paymentClaims: [claim("orphan", 999, { status: "approved", paymentId: "missing" })] });
  assert.equal(entries[0].status, "unmatched"); assert.equal(api.orderCashierTotals(entries).received, 0);
});

test("pending receipts and proofs count toward registered money with persisted-link deduplication", () => {
  const entries = api.orderCashierEntries({ payments: [payment("cash", 80, { verificationStatus: "pending" })],
    paymentClaims: [claim("cash-proof", 80, { matchingPaymentId: "cash" }), claim("additional", 46)] });
  assert.deepEqual(api.orderCashierTotals(entries), { received: 126, refunded: 0, netRecorded: 126, confirmedReceived: 0, confirmedRefunded: 0 });
});

test("registered refund reserves the balance before finance checks either side", () => {
  const entries = api.orderCashierEntries({ paymentClaims: [claim("pending-proof", 126)],
    payments: [payment("refund", 16, { type: "refund", verificationStatus: "pending", refundCategory: "shipping_fee" })] });
  assert.deepEqual(api.orderCashierTotals(entries), { received: 126, refunded: 16, netRecorded: 110, confirmedReceived: 0, confirmedRefunded: 0 });
});

test("duplicate record identifiers do not inflate cashier totals", () => {
  const receipt = payment("cash", 100, { verificationStatus: "pending" });
  const proof = claim("proof", 26);
  const entries = api.orderCashierEntries({ payments: [receipt, { ...receipt }], paymentClaims: [proof, { ...proof }] });
  assert.equal(api.orderCashierTotals(entries).received, 126);
});
