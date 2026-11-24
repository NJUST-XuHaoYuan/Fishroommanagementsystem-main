import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, evidencePng, EVIDENCE_TEST_KEYRING, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";
import { reconcileCommissionLedger } from "./commission-ledger.mjs";

const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const denied = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
const NOW = "2026-11-20T12:00:00+08:00";
const receipt = (amount = 1050, shippingAmount = 50) => ({ id: "initial-receipt", type: "balance", amount, shippingAmount,
  time: NOW, verifiedAt: NOW, verifiedBy: "finance-reviewer", verificationStatus: "verified", channel: "wechat", account: "合成微信收款账户", paymentMethodId: "pm-wechat" });
const shipment = fee => ({ id: "freight-shipment", orderId: "proof-order", siteId: "nanjing", status: "delivered", shipMethod: "express",
  carrier: "顺丰", itemStockIds: ["proof-fish"], shipDate: "2026-11-20", actualShippingFee: fee });

async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture();
  Object.assign(fixture.state.orders[0], { shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 50 });
  customize(fixture.state);
  const s = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } });
  t.after(s.stop);
  const tokens = {};
  for (const name of ["pricing-admin", "pricing-editor", "pricing-viewer", "finance-reviewer", "other-owner"]) tokens[name] = await s.login(name, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = "pricing-editor") => s.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  const detail = async () => { const d = await request("/api/orders/shipping-settlement?orderId=proof-order"); ok(d); return d.body; };
  const upload = async () => {
    const response = await fetch(`${s.baseUrl}/api/orders/payment-proof/evidence?orderId=proof-order`, { method: "POST",
      headers: { Authorization: `Bearer ${tokens["pricing-editor"]}`, "Content-Type": "image/png", "x-file-name": encodeURIComponent("合成退运费凭证.png") }, body: evidencePng() });
    const result = { response, body: await response.json() }; ok(result); return result.body.attachment;
  };
  return { ...s, request, tokens, detail, upload };
}

test("new create distinguishes advance quote from deferred charge; legacy orders cannot silently migrate", async t => {
  const s = await setup(t, state => { state.orders = []; state.stock[0].sold = false; });
  const base = { id: "new-freight-order", siteId: "nanjing", source: "私域线上", customerId: "proof-customer", date: "2026-11-20", plannedShipDate: "2026-11-21",
    paymentMethodId: "pm-wechat", paymentChannel: "wechat", contactPersonnelId: "pricing-editor", items: [{ stockItemId: "proof-fish", price: 1000 }],
    shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 0, discount: 0 };
  denied(await s.request("/api/orders/create", base));
  const created = await s.request("/api/orders/create", { ...base, shippingSettlementTiming: "after_shipping", shippingFee: 123 }); ok(created);
  assert.equal(created.body.order.shippingFee, 0); assert.equal(created.body.order.shippingSettlementTiming, "after_shipping");
  assert.equal(created.body.order.salesAmountSnapshot.amount, 1000 + created.body.order.packagingFee);
  const before = await s.readPersistedState();
  const forged = { ...before.orders[0], shippingSettlementTiming: "before_shipping", shippingFee: 50 };
  denied(await s.request("/api/state/patch", { patch: { orders: [forged] }, basePatch: { orders: before.orders } }, "pricing-admin"));
  assert.deepEqual((await s.readPersistedState()).orders, before.orders);
});

test("new shipment zero cost is explicit and concurrency-safe; settled order can complete", async t => {
  const s = await setup(t, state => { state.orders[0].shippingSettlementTiming = "after_shipping"; state.orders[0].shippingFee = 0; state.shipments = [shipment(0)]; state.orders[0].payments = [receipt(1000, 0)]; });
  assert.equal((await s.detail()).shippingSettlement.status, "pending_fee");
  denied(await s.request("/api/orders/complete", { orderId: "proof-order" }));
  const saved = await s.request("/api/shipments/actual-shipping-fee", { shipmentId: "freight-shipment", actualShippingFee: 0,
    expectedActualShippingFee: 0, expectedActualShippingFeeRecordedAt: "" }); ok(saved);
  assert.ok(saved.body.shipment.actualShippingFeeRecordedAt);
  const stale = await s.request("/api/shipments/actual-shipping-fee", { shipmentId: "freight-shipment", actualShippingFee: 5,
    expectedActualShippingFee: 0, expectedActualShippingFeeRecordedAt: "" }); assert.equal(stale.response.status, 409);
  const complete = await s.request("/api/orders/complete", { orderId: "proof-order" }); ok(complete);
  assert.equal(complete.body.order.payments.length, 1);
  assert.equal((await s.detail()).shippingSettlement.status, "settled");
});

test("finance records receive server freight allocation and lock timing/estimate; forged allocations are blocked", async t => {
  const s = await setup(t);
  const added = await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: {
    id: "manual-finance-receipt", type: "balance", amount: 1050, time: NOW, paymentMethodId: "pm-wechat" } }, "finance-reviewer"); ok(added);
  const order = (await s.readPersistedState()).orders[0];
  assert.equal(order.payments[0].shippingAmount, 50);
  const edited = await s.request("/api/orders/update", { ...order, orderId: order.id, shippingSettlementTiming: "after_shipping", shippingFee: 0 });
  assert.equal(edited.response.status, 409); assert.equal(edited.body.code, "SHIPPING_SETTLEMENT_LOCKED");
  denied(await s.request("/api/orders/payment", { orderId: order.id, action: "add", payment: { id: "forged-ship", type: "balance", amount: 5, shippingAmount: 5, time: NOW } }, "finance-reviewer"));
  const forged = structuredClone(order); forged.payments[0].shippingAmount = 0;
  denied(await s.request("/api/state/patch", { patch: { orders: [forged] }, basePatch: { orders: [order] } }, "pricing-admin"));
  assert.deepEqual((await s.readPersistedState()).orders[0], order);
});

test("freight overpayment refunds require private proof, reserve amount once, preserve freight classification on finance verification", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt()]; state.shipments = [shipment(40)]; state.orders[0].status = "completed"; });
  const initial = await s.readPersistedState();
  const beforeCommission = reconcileCommissionLedger(initial, [], new Date()).byOrder.get("proof-order").commissionBase;
  const evidence = await s.upload(); const d = await s.detail();
  assert.equal(d.shippingSettlement.toRefund, 10);
  const body = { orderId: "proof-order", id: "freight-refund-test-001", expectedVersion: d.shippingSettlement.version,
    amount: 10, time: NOW, paymentMethodId: "pm-wechat", notes: "运费退差额", evidenceIds: [evidence.id] };
  denied(await s.request("/api/orders/shipping-refund", { ...body, amount: 11 }));
  denied(await s.request("/api/orders/shipping-refund", { ...body, evidenceIds: [] }));
  denied(await s.request("/api/orders/shipping-refund", body, "other-owner"));
  denied(await s.request("/api/orders/shipping-refund", { ...body, expectedVersion: "stale" }));
  const saved = await s.request("/api/orders/shipping-refund", body); ok(saved);
  assert.equal(saved.body.payment.refundCategory, "shipping_fee"); assert.equal(saved.body.payment.shippingAmount, 10);
  assert.equal(saved.body.payment.verificationStatus, "pending"); assert.equal(saved.body.shippingSettlement.toRefund, 0);
  assert.equal(saved.body.shippingSettlement.pendingRefundAmount, 10);
  const repeat = await s.request("/api/orders/shipping-refund", body); ok(repeat); assert.equal(repeat.body.idempotent, true);
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 2);
  const verified = await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: body.id }, "finance-reviewer"); ok(verified);
  const after = await s.readPersistedState(); const refund = after.orders[0].payments.at(-1);
  assert.equal(refund.refundCategory, "shipping_fee"); assert.equal(refund.shippingAmount, 10); assert.equal(refund.evidenceAttachments[0].id, evidence.id);
  assert.equal(reconcileCommissionLedger(after, [], new Date()).byOrder.get("proof-order").commissionBase, beforeCommission);
  assert.equal((await s.detail()).shippingSettlement.status, "settled");
  assert.deepEqual(after.stock, initial.stock); assert.deepEqual(after.orders[0].items, initial.orders[0].items);
  const privateImage = await fetch(`${s.baseUrl}/api/orders/payment-proof/evidence/${evidence.id}`, { headers: { Authorization: `Bearer ${s.tokens["finance-reviewer"]}` } });
  assert.equal(privateImage.status, 200);
  denied(await s.request("/api/orders/payment", { orderId: "proof-order", action: "delete", paymentId: body.id }, "finance-reviewer"));
});

test("refund waits for verified overpayment and all shipment fees, never an estimated prepayment", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [{ ...receipt(), verificationStatus: "pending" }]; state.shipments = [shipment(40)]; });
  const d = await s.detail(); assert.equal(d.shippingSettlement.toRefund, 0);
  const evidence = await s.upload();
  denied(await s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "refund-without-receipt", expectedVersion: (await s.detail()).shippingSettlement.version,
    amount: 10, time: NOW, paymentMethodId: "pm-wechat", evidenceIds: [evidence.id] }));
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
});

test("prepaid proof remains reviewable after actual freight drops; only verified excess becomes refundable", async t => {
  const s = await setup(t, state => { state.shipments = [shipment(0)]; });
  const evidence = await s.upload();
  const submitted = await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 1050, time: NOW,
    paymentMethodId: "pm-wechat", evidenceIds: [evidence.id], purpose: "order" }); ok(submitted);
  const claim = (await s.readPersistedState()).orders[0].paymentClaims[0]; assert.equal(claim.shippingAmount, 50);
  ok(await s.request("/api/shipments/actual-shipping-fee", { shipmentId: "freight-shipment", expectedActualShippingFee: 0,
    expectedActualShippingFeeRecordedAt: "", actualShippingFee: 40 }));
  assert.equal((await s.detail()).shippingSettlement.toRefund, 0);
  const d = await s.request("/api/orders/payment-proof/detail?orderId=proof-order", undefined, "finance-reviewer"); ok(d);
  ok(await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version,
    reviewToken: d.body.reviewToken, decision: "approve" }, "finance-reviewer"));
  assert.equal((await s.detail()).shippingSettlement.toRefund, 10);
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments[0].amount, 1050); assert.equal(order.payments[0].shippingAmount, 50);
});

test("ordinary pre-shipment full refund includes freight allocation once and preserves it on finance verification", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt()]; });
  const refunded = await s.request("/api/orders/refund", { orderId: "proof-order", id: "ordinary-full-refund", amount: 1050, time: NOW,
    proof: [], notes: "发货前取消，货款和预收运费一并退还" }); ok(refunded);
  const payment = refunded.body.order.payments.at(-1); assert.equal(payment.shippingAmount, 50); assert.equal(payment.type, "refund");
  denied(await s.request("/api/orders/refund", { orderId: "proof-order", amount: 1, time: NOW }));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: payment.id }, "finance-reviewer"));
  assert.equal((await s.readPersistedState()).orders[0].payments.at(-1).shippingAmount, 50);
  assert.equal((await s.detail()).shippingSettlement.shippingRefunded, 50);
});

test("version marker keeps new free/collect orders editable without upgrading historical orders", async t => {
  const s = await setup(t, state => { Object.assign(state.orders[0], { shippingFeeMode: "free", shippingSettlementVersion: 1, shippingFee: 0 }); delete state.orders[0].shippingSettlementTiming; });
  const before = (await s.readPersistedState()).orders[0];
  const changed = await s.request("/api/orders/update", { ...before, orderId: before.id, shippingFeeMode: "prepaid", shippingSettlementTiming: "after_shipping" }); ok(changed);
  assert.equal(changed.body.order.shippingSettlementVersion, 1); assert.equal(changed.body.order.shippingSettlementTiming, "after_shipping");
  const getDenied = await s.request("/api/orders/shipping-settlement?orderId=proof-order", undefined, "pricing-viewer"); assert.equal(getDenied.response.status, 403);
});

test("statement-first receipt stores the same goods/freight allocation", async t => {
  const s = await setup(t);
  const csvText = ["交易时间,交易单号,收支类型,交易金额,付款方,备注", "2026-11-20 12:00:00,BANK-FREIGHT-001,收入,1050.00,付款凭证合成客户,SO-PROOF-TEST 鱼款"].join("\n");
  const imported = await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "合成含运费流水.csv", csvText }, "finance-reviewer"); ok(imported);
  const overview = await s.request("/api/finance/overview?siteId=nanjing", undefined, "finance-reviewer"); ok(overview);
  const row = overview.body.statements[0];
  if (row.matchStatus === "unmatched") ok(await s.request("/api/finance/statements/link", { action: "link", statementId: row.id, orderId: "proof-order" }, "finance-reviewer"));
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments.length, 1); assert.equal(order.payments[0].shippingAmount, 50);
  assert.equal((await s.detail()).shippingSettlement.recordedShippingReceived, 50);
});

test("pending proof reserves freight collection and later bank import waits for verification without a duplicate", async t => {
  const s = await setup(t); const evidence = await s.upload();
  ok(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 1050, time: NOW,
    paymentMethodId: "pm-wechat", evidenceIds: [evidence.id], purpose: "order" }));
  const csvText = ["交易时间,交易单号,收支类型,交易金额,付款方,备注", "2026-11-20 12:00:00,BANK-PENDING-FREIGHT-001,收入,1050.00,付款凭证合成客户,SO-PROOF-TEST 鱼款"].join("\n");
  const imported = await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "合成待核验对应流水.csv", csvText }, "finance-reviewer"); ok(imported);
  assert.equal(imported.body.matchedCount, 0);
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 0);
  assert.equal((await s.detail()).shippingSettlement.recordedShippingReceived, 50);
});

for (const status of ["pending", "verified"]) {
  test(`${status} ordinary actual refund exhausts the whole-order overpayment and blocks a second freight refund`, async t => {
    const s = await setup(t, state => { state.orders[0].payments = [receipt()]; state.shipments = [shipment(40)]; });
    const initial = await s.readPersistedState();
    const ordinary = await s.request("/api/orders/refund", { orderId: "proof-order", id: "ordinary-difference", amount: 10, time: NOW }); ok(ordinary);
    assert.equal(ordinary.body.order.payments.at(-1).shippingAmount, 0, "do not silently change ordinary refund classification");
    if (status === "verified") ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "ordinary-difference" }, "finance-reviewer"));
    const evidence = await s.upload(); const detail = (await s.detail()).shippingSettlement;
    assert.equal(detail.finalAmountDue, 1040); assert.equal(detail.registeredOrderRefunded, 10);
    assert.equal(detail.orderRefundableAmount, 0); assert.equal(detail.toRefund, 0);
    const beforeDenied = await s.readPersistedState();
    const result = await s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "duplicate-difference", expectedVersion: detail.version,
      amount: 10, time: NOW, paymentMethodId: "pm-wechat", evidenceIds: [evidence.id] });
    assert.equal(result.response.status, 409); assert.equal(result.body.code, "SHIPPING_REFUND_EXCEEDS_AVAILABLE");
    const after = await s.readPersistedState(); assert.deepEqual(after, beforeDenied);
    assert.deepEqual(after.stock, initial.stock); assert.deepEqual(after.shipments, initial.shipments);
    assert.equal(after.orders[0].payments.length, 2);
  });
}

test("ordinary pending refund partially reserves the excess and freight can only return the remaining balance", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt()]; state.shipments = [shipment(40)]; });
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "ordinary-partial", amount: 4, time: NOW }));
  const evidence = await s.upload(); const detail = (await s.detail()).shippingSettlement; assert.equal(detail.toRefund, 6);
  const body = { orderId: "proof-order", id: "remaining-freight", expectedVersion: detail.version, amount: 6, time: NOW, paymentMethodId: "pm-wechat", evidenceIds: [evidence.id] };
  const over = await s.request("/api/orders/shipping-refund", { ...body, amount: 6.01 }); assert.equal(over.response.status, 409);
  const saved = await s.request("/api/orders/shipping-refund", body); ok(saved); assert.equal(saved.body.shippingSettlement.toRefund, 0);
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments.filter(p => p.type === "refund").reduce((sum,p) => sum + p.amount, 0), 10);
});

test("authoritative final receivable includes discount packaging and damage while ordinary goods refunds remain ordinary", async t => {
  const s = await setup(t, state => {
    Object.assign(state.orders[0], { discount: 50, packagingFee: 15, payments: [receipt(1015, 50)] });
    state.shipments = [{ ...shipment(40), status: "damaged", damageResolution: "refund", damageRefundAmount: 100 }];
  });
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "damaged-goods-refund", amount: 100, time: NOW }));
  const evidence = await s.upload(); const detail = (await s.detail()).shippingSettlement;
  assert.equal(detail.finalAmountDue, 905); assert.equal(detail.orderRefundableAmount, 10); assert.equal(detail.toRefund, 10);
  const saved = await s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "freight-after-goods", expectedVersion: detail.version,
    amount: 10, time: NOW, paymentMethodId: "pm-wechat", evidenceIds: [evidence.id] }); ok(saved);
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments[1].shippingAmount, 0);
  assert.equal(order.payments[1].refundCategory, undefined); assert.equal(order.payments[2].refundCategory, "shipping_fee");
});

test("ordinary goods refund beyond overpayment remains allowed and a later unified receipt can settle the resulting shortage", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt()]; state.shipments = [shipment(40)]; });
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "normal-goods-refund", amount: 100, time: NOW }));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "normal-goods-refund" }, "finance-reviewer"));
  assert.equal((await s.detail()).shippingSettlement.toRefund, 0);
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: { id: "unified-remainder", type: "balance", amount: 90, time: NOW, paymentMethodId: "pm-wechat" } }, "finance-reviewer"));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "unified-remainder" }, "finance-reviewer"));
  ok(await s.request("/api/orders/complete", { orderId: "proof-order" }));
  assert.equal((await s.detail()).shippingSettlement.toRefund, 0);
});

for (const first of ["ordinary", "freight"]) {
  test(`concurrent ${first}-first refunds using one reviewed version can commit only one route`, async t => {
    const s = await setup(t, state => { state.orders[0].payments = [receipt()]; state.shipments = [shipment(40)]; });
    const evidence = await s.upload(); const detail = (await s.detail()).shippingSettlement;
    const ordinary = () => s.request("/api/orders/refund", { orderId: "proof-order", id: "concurrent-ordinary", expectedVersion: detail.version, amount: 10, time: NOW });
    const freight = () => s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "concurrent-freight", expectedVersion: detail.version,
      amount: 10, time: NOW, paymentMethodId: "pm-wechat", evidenceIds: [evidence.id] });
    const results = await Promise.all(first === "ordinary" ? [ordinary(), freight()] : [freight(), ordinary()]);
    assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
    assert.equal(results.find(r => r.response.status === 409).body.code, "SHIPPING_SETTLEMENT_CONFLICT");
    const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments.filter(p => p.type === "refund").length, 1);
    assert.equal((await s.detail()).shippingSettlement.toRefund, 0);
  });
}
