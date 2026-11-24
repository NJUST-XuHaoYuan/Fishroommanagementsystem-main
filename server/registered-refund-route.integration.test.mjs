import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD, EVIDENCE_TEST_KEYRING, evidencePng } from "./test-support/payment-proof-fixture.mjs";

const TIME = "2026-11-20T12:00:00+08:00";
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture(); customize(fixture.state);
  const server = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } }); t.after(server.stop);
  const tokens = {};
  for (const name of ["pricing-editor", "finance-reviewer"]) tokens[name] = await server.login(name, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = "pricing-editor") => server.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  const upload = async width => {
    const response = await fetch(`${server.baseUrl}/api/orders/payment-proof/evidence?orderId=proof-order`, { method: "POST",
      headers: { Authorization: `Bearer ${tokens["pricing-editor"]}`, "Content-Type": "image/png", "x-file-name": "synthetic-registered-refund.png" }, body: evidencePng({ width }) });
    const r = { response, body: await response.json() }; ok(r); return r.body.attachment.id;
  };
  const detail = async () => { const r = await request("/api/orders/shipping-settlement?orderId=proof-order"); ok(r); return r.body; };
  const review = async decision => {
    const d = await request("/api/orders/payment-proof/detail?orderId=proof-order", undefined, "finance-reviewer"); ok(d);
    const claim = d.body.claims.find(c => c.status === "pending"); assert.ok(claim);
    return request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version, reviewToken: d.body.reviewToken,
      decision, ...(decision === "reject" ? { reason: "合成测试：原收款凭证不正确，保留已发生退款" } : {}) }, "finance-reviewer");
  };
  return { ...server, request, upload, detail, review };
}

async function pendingFreight(t) {
  const s = await setup(t, state => {
    Object.assign(state.orders[0], { status: "shipped", shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 50,
      discount: 11, packagingFee: 0 }); state.orders[0].items[0].price = 65;
    state.shipments = [{ id: "shipment", orderId: "proof-order", siteId: "nanjing", status: "delivered", shipMethod: "express", itemStockIds: ["proof-fish"], actualShippingFee: 0, packingProof: ["one", "two"] }];
  });
  ok(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 104, time: TIME, paymentMethodId: "pm-wechat", purpose: "order", evidenceIds: [await s.upload(8)] }));
  ok(await s.request("/api/shipments/actual-shipping-fee", { shipmentId: "shipment", expectedActualShippingFee: 0, expectedActualShippingFeeRecordedAt: "", actualShippingFee: 34 }));
  return s;
}

for (const verifyFirst of ["income", "refund"]) {
  test(`${verifyFirst} may be financially verified first; pending receipt supports business refund and completion waits for both`, async t => {
    const s = await pendingFreight(t); const evidence = await s.upload(9); const d = await s.detail();
    assert.equal(d.registeredCash.recordedReceived, 104); assert.equal(d.registeredCash.verifiedReceived, 0);
    assert.equal(d.shippingSettlement.finalAmountDue, 88); assert.equal(d.shippingSettlement.toRefund, 16);
    const body = { orderId: "proof-order", id: "actual-freight-refund", expectedVersion: d.shippingSettlement.version, amount: 16, time: TIME, paymentMethodId: "pm-wechat", evidenceIds: [evidence] };
    const excessive = await s.request("/api/orders/shipping-refund", { ...body, amount: 34 }); assert.equal(excessive.response.status, 409);
    ok(await s.request("/api/orders/shipping-refund", body)); ok(await s.request("/api/orders/shipping-refund", body));
    let state = await s.readPersistedState(); assert.equal(state.orders[0].payments.length, 1); assert.equal(state.orders[0].payments[0].verificationStatus, "pending");
    assert.equal((await s.detail()).shippingSettlement.toRefund, 0);
    const verifyRefund = () => s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: body.id }, "finance-reviewer");
    ok(await (verifyFirst === "income" ? s.review("approve") : verifyRefund()));
    const blocked = await s.request("/api/orders/complete", { orderId: "proof-order" }); assert.equal(blocked.response.status, 409); assert.equal(blocked.body.code, "ORDER_COMPLETION_FINANCE_REQUIRED");
    ok(await (verifyFirst === "income" ? verifyRefund() : s.review("approve")));
    ok(await s.request("/api/orders/complete", { orderId: "proof-order" }));
    state = await s.readPersistedState(); assert.equal(state.orders[0].status, "completed");
    assert.equal(state.orders[0].payments.reduce((sum,p) => sum + (p.type === "refund" ? -p.amount : p.amount), 0), 88);
  });
}

test("rejecting income after an actual refund preserves the refund and blocks completion rather than undoing reality", async t => {
  const s = await pendingFreight(t); const evidence = await s.upload(9); const d = await s.detail();
  ok(await s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "refund-before-rejection", expectedVersion: d.shippingSettlement.version,
    amount: 16, time: TIME, paymentMethodId: "pm-wechat", evidenceIds: [evidence] }));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "refund-before-rejection" }, "finance-reviewer"));
  const before = await s.readPersistedState(); ok(await s.review("reject"));
  const after = await s.readPersistedState(); assert.deepEqual(after.orders[0].payments, before.orders[0].payments);
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
  const current = await s.detail(); assert.equal(current.registeredCash.recordedReceived, 0); assert.equal(current.registeredCash.recordedRefunded, 16);
  assert.equal(current.registeredCash.availableRefund, 0); assert.equal(current.shippingSettlement.toRefund, 0);
  const complete = await s.request("/api/orders/complete", { orderId: "proof-order" }); assert.equal(complete.response.status, 409);
  assert.equal(complete.body.completionFinancial.verifiedNetReceived, -16); assert.equal(complete.body.completionFinancial.outstandingAmount, 104);
});

test("ordinary refund can use pending proof, reserves it once, and rejection never removes the recorded refund", async t => {
  const s = await setup(t); const image = await s.upload(8);
  ok(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 100, time: TIME, paymentMethodId: "pm-wechat", evidenceIds: [image] }));
  const d = await s.detail(); assert.equal(d.registeredCash.availableRefund, 100);
  const results = await Promise.all(["ordinary-a", "ordinary-b"].map(id => s.request("/api/orders/refund", { orderId: "proof-order", id, expectedVersion: d.shippingSettlement.version, amount: 60, time: TIME })));
  assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
  assert.equal((await s.detail()).registeredCash.availableRefund, 40);
  const before = await s.readPersistedState(); ok(await s.review("reject"));
  const after = await s.readPersistedState(); assert.deepEqual(after.orders[0].payments, before.orders[0].payments); assert.equal((await s.detail()).registeredCash.availableRefund, 0);
});

test("ordinary and freight refunds against the same pending declaration cannot both consume one reviewed difference", async t => {
  const s = await pendingFreight(t); const evidence = await s.upload(9); const d = await s.detail();
  const results = await Promise.all([
    s.request("/api/orders/refund", { orderId: "proof-order", id: "ordinary-racing", expectedVersion: d.shippingSettlement.version, amount: 16, time: TIME }),
    s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "freight-racing", expectedVersion: d.shippingSettlement.version, amount: 16, time: TIME, paymentMethodId: "pm-wechat", evidenceIds: [evidence] }),
  ]);
  assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
  assert.equal(results.find(r => r.response.status === 409).body.code, "SHIPPING_SETTLEMENT_CONFLICT");
  const state = await s.readPersistedState(); assert.equal(state.orders[0].payments.length, 1); assert.equal(state.orders[0].payments[0].amount, 16);
  const current = await s.detail(); assert.equal(current.registeredCash.recordedReceived, 104); assert.equal(current.registeredCash.recordedRefunded, 16);
  assert.equal(current.shippingSettlement.toRefund, 0);
});

for (const entry of ["manual", "statement"]) {
  test(`pending refund does not block later ${entry} receipt registration or claim on an order with approved proof`, async t => {
    const s = await setup(t, state => {
      state.orders[0].payments = [{ id: "original", type: "balance", amount: 1000, time: TIME, channel: "wechat", account: "合成微信收款账户", paymentMethodId: "pm-wechat", verificationStatus: "verified", paymentProofClaimId: "approved" }];
      state.orders[0].paymentClaims = [{ id: "approved", status: "approved", amount: 1000, paymentId: "original" }];
    });
    ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "actual-refund", amount: 100, time: TIME }));
    if (entry === "manual") {
      ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: { id: "new-receipt", type: "balance", amount: 100, time: TIME, paymentMethodId: "pm-wechat" } }, "finance-reviewer"));
    } else {
      const csvText = ["交易时间,交易单号,收支类型,交易金额,付款方,备注", "2026-11-20 12:00:00,REFUND-RECOLLECT-TEST,收入,100.00,合成客户,测试补收"].join("\n");
      ok(await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "synthetic-recollect.csv", csvText }, "finance-reviewer"));
      const overview = await s.request("/api/finance/overview?siteId=nanjing", undefined, "finance-reviewer"); ok(overview);
      const row = overview.body.statements[0];
      if (row.matchStatus === "unmatched") ok(await s.request("/api/finance/statements/link", { action: "link", statementId: row.id, orderId: "proof-order" }, "finance-reviewer"));
    }
    const state = await s.readPersistedState(); assert.equal(state.orders[0].payments.length, 3);
    assert.equal(state.orders[0].payments.find(p => p.id === "actual-refund").verificationStatus, "pending");
    assert.equal((await s.detail()).registeredCash.netRecorded, 1000);
  });
}
