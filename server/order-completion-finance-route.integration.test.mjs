import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD, EVIDENCE_TEST_KEYRING, evidencePng } from "./test-support/payment-proof-fixture.mjs";

const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const time = "2026-11-20T12:00:00+08:00";
const receipt = (amount, status = "verified", id = "received") => ({ id, amount, type: "balance", verificationStatus: status,
  time, channel: "wechat", account: "合成微信收款账户", paymentMethodId: "pm-wechat", verifiedAt: status === "verified" ? time : "" });
const blocked = (r, code) => {
  assert.equal(r.response.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, "ORDER_COMPLETION_FINANCE_REQUIRED");
  assert.ok(r.body.completionFinancial.reasons.some(reason => reason.code === code), JSON.stringify(r.body));
};

async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture(); const order = fixture.state.orders[0]; order.status = "shipped";
  fixture.state.shipments = [{ id: "complete-shipment", orderId: order.id, siteId: "nanjing", status: "delivered",
    shipMethod: "express", itemStockIds: ["proof-fish"], shipDate: "2026-11-20", deliveredAt: time,
    actualShippingFee: 0, packingProof: ["one", "two"] }];
  customize(fixture.state);
  const server = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } }); t.after(server.stop);
  const tokens = {};
  for (const name of ["pricing-editor", "pricing-admin", "finance-reviewer", "pricing-viewer"]) tokens[name] = await server.login(name, PRICING_TEST_PASSWORD);
  const request = (path, body, name = "pricing-editor") => server.request(path, { token: tokens[name], ...(body === undefined ? {} : { body }) });
  return { ...server, request, tokens, complete: () => request("/api/orders/complete", { orderId: "proof-order" }) };
}

for (const source of ["私域线上", "批发", "线下", "平台下单", "闲鱼平台", "微拍堂平台"]) {
  test(`${source}: completion requires verified payment for legacy and cashier orders without preventing credit dispatch`, async t => {
    const s = await setup(t, state => {
      const order = state.orders[0]; order.source = source;
      if (source !== "私域线上") order.orderFormSchemaVersion = 4;
      if (source === "线下") state.shipments[0].shipMethod = "pickup";
    });
    const before = await s.readPersistedState(); blocked(await s.complete(), "PAYMENT_SHORTFALL");
    assert.deepEqual(await s.readPersistedState(), before);
    const method = { "平台下单": "pm-douyin", "闲鱼平台": "pm-xianyu", "微拍堂平台": "pm-weipaitang" }[source] || "pm-wechat";
    ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: { id: "actual-receipt", type: "balance", amount: 1000, time, paymentMethodId: method } }, "finance-reviewer"));
    blocked(await s.complete(), "RECEIPT_PENDING");
    ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "actual-receipt" }, "finance-reviewer"));
    const completed = await s.complete(); ok(completed); assert.equal(completed.body.order.status, "completed");
    const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock);
    assert.equal(after.shipments[0].status, "delivered");
    const logs = after.operationLogs.filter(log => log.detail.includes("标记完成")); assert.equal(logs.length, 1);
    ok(await s.complete()); assert.equal((await s.readPersistedState()).operationLogs.filter(log => log.detail.includes("标记完成")).length, 1);
  });
}

test("pending proof cannot complete until finance approves it; no duplicate money is created", async t => {
  const s = await setup(t);
  const uploaded = await fetch(`${s.baseUrl}/api/orders/payment-proof/evidence?orderId=proof-order`, {
    method: "POST", headers: { Authorization: `Bearer ${s.tokens["pricing-editor"]}`, "Content-Type": "image/png", "x-file-name": "completion-synthetic.png" }, body: evidencePng({ width: 8 }) });
  const evidence = await uploaded.json(); assert.equal(uploaded.status, 200, JSON.stringify(evidence));
  ok(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 1000, time, purpose: "order", paymentMethodId: "pm-wechat", evidenceIds: [evidence.attachment.id] }));
  blocked(await s.complete(), "PAYMENT_PROOF_PENDING");
  const detail = await s.request("/api/orders/payment-proof/detail?orderId=proof-order", undefined, "finance-reviewer"); ok(detail);
  const claim = detail.body.claims[0];
  ok(await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version, reviewToken: detail.body.reviewToken, decision: "approve" }, "finance-reviewer"));
  ok(await s.complete()); const order = (await s.readPersistedState()).orders[0];
  assert.equal(order.payments.length, 1); assert.equal(order.payments[0].amount, 1000);
});

test("final due includes discount, packaging, actual freight and damage adjustment; refund is deducted only once", async t => {
  const s = await setup(t, state => {
    Object.assign(state.orders[0], { shippingSettlementVersion: 1, shippingSettlementTiming: "after_shipping", shippingFeeMode: "prepaid", shippingFee: 0,
      packagingFee: 15, discount: 50, payments: [receipt(995)] });
    Object.assign(state.shipments[0], { status: "damaged", damageResolution: "refund", damageRefundAmount: 100,
      actualShippingFee: 30, actualShippingFeeRecordedAt: time });
  });
  const before = await s.readPersistedState(); const overpaid = await s.complete(); blocked(overpaid, "PAYMENT_OVERPAID");
  assert.equal(overpaid.body.completionFinancial.amountDue, 895); assert.equal(overpaid.body.completionFinancial.refundDueAmount, 100);
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "actual-refund", amount: 100, time, paymentMethodId: "pm-wechat" }));
  const pending = await s.complete(); blocked(pending, "REFUND_PENDING"); assert.equal(pending.body.completionFinancial.verifiedNetReceived, 995);
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "actual-refund" }, "finance-reviewer"));
  ok(await s.complete()); const after = await s.readPersistedState();
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
});

test("ordinary refund does not silently reduce receivable; verified net shortage still blocks", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt(1000), { ...receipt(100, "verified", "refund"), type: "refund" }]; });
  const result = await s.complete(); blocked(result, "PAYMENT_SHORTFALL"); assert.equal(result.body.completionFinancial.outstandingAmount, 100);
});

test("pending proof or refund blocks despite net matching; overpayment and cancelled orders cannot finish", async t => {
  for (const [name, patch, code] of [
    ["proof", { paymentClaims: [{ id: "pending-proof", status: "pending", amount: 1000 }] }, "PAYMENT_PROOF_PENDING"],
    ["refund", { payments: [receipt(1000), { ...receipt(10, "pending", "pending-refund"), type: "refund" }] }, "REFUND_PENDING"],
    ["overpayment", { payments: [receipt(1001)] }, "PAYMENT_OVERPAID"],
  ]) await t.test(name, async child => {
    const s = await setup(child, state => Object.assign(state.orders[0], { payments: [receipt(1000)], ...patch })); blocked(await s.complete(), code);
  });
  const s = await setup(t, state => Object.assign(state.orders[0], { status: "cancelled", payments: [receipt(1000)] }));
  const result = await s.complete(); assert.equal(result.response.status, 400); assert.match(result.body.error, /已取消/);
});

test("historically completed unpaid orders remain unchanged without applying the new financial gate retroactively", async t => {
  const s = await setup(t, state => { state.orders[0].status = "completed"; });
  const before = await s.readPersistedState(); ok(await s.complete()); assert.deepEqual(await s.readPersistedState(), before);
});

test("generic state patch and ordinary order update cannot bypass completion with forged verified money", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const order = before.orders[0];
  const updated = await s.request("/api/orders/update", { ...order, orderId: order.id, orderFormSchemaVersion: 3, status: "completed" });
  assert.equal(updated.response.status, 409); assert.equal(updated.body.code, "ORDER_STATUS_DEDICATED_REQUIRED");
  for (const payments of [order.payments, [receipt(1000)]]) {
    const result = await s.request("/api/state/patch", { patch: { orders: [{ ...order, status: "completed", payments }] }, basePatch: { orders: [order] } }, "pricing-admin");
    assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test("completion retains permission, live role/site revocation and session validation", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt(1000)]; });
  const before = await s.readPersistedState();
  const viewer = await s.request("/api/orders/complete", { orderId: "proof-order" }, "pricing-viewer");
  assert.equal(viewer.response.status, 400); assert.match(viewer.body.error, /没有订单模块的操作权限/);
  assert.deepEqual(await s.readPersistedState(), before);
  await s.patchTestPersonnel("pricing-editor", { permissions: {} });
  const revoked = await s.complete(); assert.equal(revoked.response.status, 400); assert.match(revoked.body.error, /没有订单模块的操作权限/);
  await s.patchTestPersonnel("pricing-editor", { permissions: { orders: { update: true } }, visibleSiteIds: ["jiangyin"] });
  assert.equal((await s.complete()).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["nanjing"], sessionVersion: 1 });
  const session = await s.complete(); assert.ok([401, 403].includes(session.response.status), JSON.stringify(session.body));
  assert.equal((await s.readPersistedState()).orders[0].status, "shipped");
});

test("concurrent refund and completion cannot pass with either an owed refund or a pending refund", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt(1100)]; });
  const [refund, completion] = await Promise.all([
    s.request("/api/orders/refund", { orderId: "proof-order", id: "concurrent-refund", amount: 100, time, paymentMethodId: "pm-wechat" }), s.complete(),
  ]);
  ok(refund); assert.equal(completion.response.status, 409); assert.equal(completion.body.code, "ORDER_COMPLETION_FINANCE_REQUIRED");
  const results = await Promise.all([
    s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "concurrent-refund" }, "finance-reviewer"), s.complete(),
  ]); ok(results[0]); assert.ok([200, 409].includes(results[1].response.status));
  ok(await s.complete()); const final = await s.readPersistedState();
  assert.equal(final.orders[0].status, "completed"); assert.equal(final.operationLogs.filter(log => log.detail.includes("标记完成")).length, 1);
});
