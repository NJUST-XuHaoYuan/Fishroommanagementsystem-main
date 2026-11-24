import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
let vite, ui;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ui = await vite.ssrLoadModule("/src/app/utils/shippingSettlement.ts");
});
after(async () => { await vite?.close(); });
const order = (extra = {}) => ({ id: "o", status: "confirmed", source: "私域线上", shippingFeeMode: "prepaid", shippingSettlementTiming: "after_shipping", shippingFee: 0, packagingFee: 0, discount: 0, items: [{ stockItemId: "fish", price: 1000 }], payments: [], paymentClaims: [], ...extra });
const shipment = (fee, extra = {}) => ({ id: "s", orderId: "o", status: "shipped", shipMethod: "express", itemStockIds: ["fish"], actualShippingFee: fee, ...extra });

test("after shipping shows unknown fee as pending rather than zero settled", () => {
  const o = order();
  assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(0)]), "pending_fee");
  assert.equal(ui.shippingSettlementStatusLabel("pending_fee"), "运费待确定");
  assert.equal(ui.getShippingSettlementSummary(o, [shipment(0)]).finalized, false);
  assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(0, { actualShippingFeeRecordedAt: "2026-11-25T14:00" })]), "settled");
});

test("pending shipping proof covers collection once but cannot pretend cash is verified", () => {
  const o = order({ paymentClaims: [{ id: "proof", status: "pending", amount: 60, purpose: "shipping_fee", shippingAmount: 60 }] });
  const summary = ui.getShippingSettlementSummary(o, [shipment(60)]);
  assert.equal(summary.toCollect, 0);
  assert.equal(summary.recordedShippingReceived, 60);
  assert.equal(summary.verifiedShippingReceived, 0);
  assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(60)]), "proof_pending");
  o.paymentClaims[0].status = "rejected";
  assert.equal(ui.getShippingSettlementSummary(o, [shipment(60)]).toCollect, 60);
});

test("prepaid mixed receipt yields only genuine freight refund and reserves pending refund", () => {
  const o = order({ shippingSettlementTiming: "before_shipping", shippingFee: 50, payments: [{ id: "paid", type: "balance", amount: 1050, shippingAmount: 50, verificationStatus: "verified" }] });
  assert.equal(ui.getShippingSettlementSummary(o, [shipment(40)]).toRefund, 10);
  assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(40)]), "to_refund");
  o.payments.push({ id: "refund", type: "refund", refundCategory: "shipping_fee", amount: 10, verificationStatus: "pending" });
  assert.equal(ui.getShippingSettlementSummary(o, [shipment(40)]).toRefund, 0);
  assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(40)]), "proof_pending");
});

test("order receipt splits goods first while dedicated freight receipt preserves purpose", () => {
  const o = order({ shippingSettlementTiming: "before_shipping", shippingFee: 50 });
  assert.deepEqual(ui.allocatePaymentProofShipping(o, [], 1050, "order"), { purpose: "order", goodsAmount: 1000, shippingAmount: 50 });
  assert.deepEqual(ui.allocatePaymentProofShipping(o, [], 50, "shipping_fee"), { purpose: "shipping_fee", goodsAmount: 0, shippingAmount: 50 });
});

test("legacy, cancelled and customer-free orders stay out of new freight work queue", () => {
  for (const o of [order({ shippingSettlementTiming: undefined }), order({ status: "cancelled" }), order({ shippingFeeMode: "free" }), order({ source: "线下" })]) {
    assert.equal(ui.shippingSettlementFilterStatus(o, [shipment(60)]), null);
  }
});


test("proof for a bank-first mixed receipt preserves its original freight allocation after a lower actual fee", () => {
  const receipt = { id: "bank-first", type: "balance", amount: 1050, shippingAmount: 50, verificationStatus: "pending" };
  const o = order({ shippingSettlementTiming: "before_shipping", shippingFee: 50, payments: [receipt] });
  assert.deepEqual(ui.paymentProofDraftAllocation(o, [shipment(40)], 1050, "order", "", receipt), { purpose: "order", shippingAmount: 50, goodsAmount: 1000 });
  assert.deepEqual(ui.paymentProofDraftAllocation(o, [shipment(40)], 50, "order", "", { ...receipt, type: "shipping_fee", amount: 50 }), { purpose: "shipping_fee", shippingAmount: 50, goodsAmount: 0 });
});

test("legacy receipt missing explicit allocation is excluded before reconstructing a bank-first split", () => {
  const receipt = { id: "bank-first", type: "balance", amount: 1050, verificationStatus: "pending" };
  const o = order({ shippingSettlementTiming: "before_shipping", shippingFee: 50, payments: [receipt] });
  assert.deepEqual(ui.paymentProofDraftAllocation(o, [shipment(40)], 1050, "order", "", receipt), { purpose: "order", shippingAmount: 50, goodsAmount: 1000 });
});
