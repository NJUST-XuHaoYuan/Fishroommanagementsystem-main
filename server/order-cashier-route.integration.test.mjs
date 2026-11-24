import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD, EVIDENCE_TEST_KEYRING, evidencePng } from "./test-support/payment-proof-fixture.mjs";

const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const denied = r => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
const TIME = "2026-11-20T12:00:00+08:00";
const body = source => ({ id: "cashier-order", orderFormSchemaVersion: 4, siteId: "nanjing", source, customerId: "proof-customer",
  platformOrderNo: "SYNTHETIC-CASHIER-001", date: "2026-11-20", plannedShipDate: "2026-11-21", plannedCarrier: "顺丰",
  contactPersonnelId: "pricing-editor", items: [{ stockItemId: "proof-fish", price: 1000 }],
  shippingSettlementVersion: 1, shippingFeeMode: "prepaid", shippingSettlementTiming: "after_shipping", shippingFee: 0, discount: 0 });

async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture(); fixture.state.orders = []; fixture.state.stock[0].sold = false; customize(fixture.state);
  const server = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } }); t.after(server.stop);
  const tokens = {};
  for (const name of ["pricing-editor", "pricing-admin", "finance-reviewer", "pricing-viewer"]) tokens[name] = await server.login(name, PRICING_TEST_PASSWORD);
  const request = (path, data, name = "pricing-editor") => server.request(path, { token: tokens[name], ...(data === undefined ? {} : { body: data }) });
  const create = async source => { const r = await request("/api/orders/create", body(source)); ok(r); return r.body.order; };
  const upload = async width => {
    const response = await fetch(`${server.baseUrl}/api/orders/payment-proof/evidence?orderId=cashier-order`, {
      method: "POST", headers: { Authorization: `Bearer ${tokens["pricing-editor"]}`, "Content-Type": "image/png", "x-file-name": "synthetic-cashier.png" }, body: evidencePng({ width }) });
    const r = { response, body: await response.json() }; ok(r); return r.body.attachment.id;
  };
  return { ...server, request, create, upload };
}

for (const source of ["私域线上", "批发", "线下", "平台下单", "闲鱼平台", "微拍堂平台"]) {
  test(`v4 ${source}: create stores source and shipping plan, no payment method or receipt`, async t => {
    const s = await setup(t); const order = await s.create(source);
    assert.equal(order.orderFormSchemaVersion, 4); assert.equal(order.source, source);
    assert.equal(order.paymentChannel, undefined); assert.equal(order.paymentMethodId, undefined); assert.equal(order.paymentAccount, "");
    assert.deepEqual(order.payments, []); assert.equal(order.paymentClaims, undefined);
    assert.equal(order.plannedCarrier, source === "线下" ? undefined : "顺丰");
    assert.equal(order.plannedShipDate, source === "线下" ? undefined : "2026-11-21");
    const persisted = (await s.readPersistedState()).orders[0]; assert.deepEqual(persisted, order);
    const detail = await s.request("/api/orders/payment-proof/detail?orderId=cashier-order"); ok(detail);
    const channels = detail.body.paymentMethods.map(m => m.channel);
    if (source === "平台下单") assert.deepEqual(channels, ["douyin"]);
    else if (source === "闲鱼平台") assert.deepEqual(channels, ["xianyu"]);
    else if (source === "微拍堂平台") assert.deepEqual(channels, ["weipaitang"]);
    else assert.deepEqual(channels, ["wechat", "cash"]);
  });
}

test("legacy payment requirement remains; marker and planned carrier cannot be forged", async t => {
  const s = await setup(t);
  denied(await s.request("/api/orders/create", { ...body("私域线上"), orderFormSchemaVersion: 3 }));
  denied(await s.request("/api/orders/create", { ...body("私域线上"), plannedCarrier: "not configured" }));
  denied(await s.request("/api/orders/create", { ...body("私域线上"), paymentMethodId: "pm-wechat" }));
  const created = await s.request("/api/orders/create", { ...body("私域线上"), orderFormSchemaVersion: 3, paymentMethodId: "pm-wechat", paymentChannel: "wechat" }); ok(created);
  const order = created.body.order; assert.equal(order.orderFormSchemaVersion, undefined);
  denied(await s.request("/api/orders/update", { ...order, orderId: order.id, orderFormSchemaVersion: 4 }));
  denied(await s.request("/api/state/patch", { patch: { orders: [{ ...order, orderFormSchemaVersion: 4 }] }, basePatch: { orders: [order] } }, "pricing-admin"));
  assert.deepEqual((await s.readPersistedState()).orders[0], order);
});

test("v4 edits preserve payment deferral and validate carrier without requiring old payment fields", async t => {
  const s = await setup(t); const order = await s.create("私域线上");
  const changed = await s.request("/api/orders/update", { ...body("私域线上"), orderId: order.id, plannedCarrier: "京东", notes: "修改计划" }); ok(changed);
  assert.equal(changed.body.order.plannedCarrier, "京东"); assert.equal(changed.body.order.paymentChannel, undefined);
  denied(await s.request("/api/orders/update", { ...changed.body.order, orderId: order.id, orderFormSchemaVersion: 3 }));
  denied(await s.request("/api/orders/update", { ...changed.body.order, orderId: order.id, paymentChannel: "wechat", paymentMethodId: "pm-wechat" }));
  const before = (await s.readPersistedState()).orders[0];
  denied(await s.request("/api/state/patch", { patch: { orders: [{ ...before, plannedCarrier: "invalid" }] }, basePatch: { orders: [before] } }, "pricing-admin"));
  assert.deepEqual((await s.readPersistedState()).orders[0], before);
});

test("v4 proof chooses each actual receipt account; mixed methods verify without writing order account", async t => {
  const s = await setup(t); await s.create("私域线上");
  const firstEvidence = await s.upload(8);
  const proof = { orderId: "cashier-order", amount: 400, time: TIME, evidenceIds: [firstEvidence], purpose: "order" };
  denied(await s.request("/api/orders/payment-proof/submit", proof));
  denied(await s.request("/api/orders/payment-proof/submit", { ...proof, paymentMethodId: "pm-douyin" }));
  ok(await s.request("/api/orders/payment-proof/submit", { ...proof, paymentMethodId: "pm-wechat" }));
  const order = (await s.readPersistedState()).orders[0];
  denied(await s.request("/api/orders/update", { ...order, orderId: order.id, source: "批发" }));
  ok(await s.request("/api/orders/payment-proof/submit", { ...proof, amount: 600, paymentMethodId: "pm-cash", evidenceIds: [await s.upload(9)] }));
  for (let i = 0; i < 2; i++) {
    const detail = await s.request("/api/orders/payment-proof/detail?orderId=cashier-order", undefined, "finance-reviewer"); ok(detail);
    const claim = detail.body.claims.find(c => c.status === "pending");
    ok(await s.request("/api/orders/payment-proof/review", { orderId: "cashier-order", claimId: claim.id, expectedVersion: claim.version, reviewToken: detail.body.reviewToken, decision: "approve" }, "finance-reviewer"));
  }
  const final = (await s.readPersistedState()).orders[0]; assert.equal(final.paymentChannel, undefined); assert.equal(final.paymentAccount, "");
  assert.deepEqual(final.payments.map(p => [p.amount, p.channel, p.verificationStatus]), [[400, "wechat", "verified"], [600, "cash", "verified"]]);
  denied(await s.request("/api/orders/refund", { orderId: final.id, amount: 20, time: TIME }));
  const refund = await s.request("/api/orders/refund", { orderId: final.id, amount: 20, time: TIME, paymentMethodId: "pm-wechat" }); ok(refund);
  assert.equal(refund.body.order.payments.at(-1).channel, "wechat"); assert.equal(refund.body.order.payments.at(-1).account, "合成微信收款账户");
});

test("v4 finance receipt requires explicit source-compatible configured method", async t => {
  const s = await setup(t); await s.create("平台下单");
  const payment = { type: "balance", amount: 200, time: TIME };
  denied(await s.request("/api/orders/payment", { orderId: "cashier-order", action: "add", payment }, "finance-reviewer"));
  denied(await s.request("/api/orders/payment", { orderId: "cashier-order", action: "add", payment: { ...payment, paymentMethodId: "pm-wechat" } }, "finance-reviewer"));
  ok(await s.request("/api/orders/payment", { orderId: "cashier-order", action: "add", payment: { ...payment, paymentMethodId: "pm-douyin" } }, "finance-reviewer"));
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments[0].channel, "douyin"); assert.equal(order.paymentChannel, undefined);
});

test("v4 bank statement reconciliation works with blank order account and remains deduplicated", async t => {
  const s = await setup(t); const order = await s.create("私域线上");
  const csvText = ["交易时间,交易单号,收支类型,交易金额,付款方,备注", `2026-11-20 12:00:00,CASHIER-STATEMENT-001,收入,1000.00,付款凭证合成客户,${order.orderNo} 鱼款`].join("\n");
  const imported = await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "synthetic-cashier.csv", csvText }, "finance-reviewer"); ok(imported);
  const overview = await s.request("/api/finance/overview?siteId=nanjing", undefined, "finance-reviewer"); ok(overview);
  const statement = overview.body.statements[0];
  if (statement.matchStatus === "unmatched") ok(await s.request("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: order.id }, "finance-reviewer"));
  const final = (await s.readPersistedState()).orders[0]; assert.equal(final.payments.length, 1); assert.equal(final.payments[0].channel, "wechat"); assert.equal(final.payments[0].amount, 1000); assert.equal(final.paymentChannel, undefined);
  denied(await s.request("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: order.id }, "finance-reviewer"));
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
});

test("v4 unpaid order can ship on credit; recording logistics never fabricates money", async t => {
  const s = await setup(t); const order = await s.create("私域线上");
  assert.equal(order.salesAmountSnapshot.amount, 1000 + order.packagingFee);
  const out = await s.request("/api/shipments/outbound", { orderId: order.id, selectedItemIds: ["proof-fish"], carrier: "顺丰", shipMethod: "express", shipDate: "2026-11-20" }, "pricing-admin"); ok(out);
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.status, "credit_sale");
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.verifiedAmount, 0);
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.creditAmount, 1000 + order.packagingFee);
  const shipmentId = out.body.shipment.id;
  ok(await s.request("/api/shipments/confirm", { shipmentId, packingProof: ["/uploads/synthetic-1.jpg", "/uploads/synthetic-2.jpg"] }, "pricing-admin"));
  const final = (await s.readPersistedState()).orders[0];
  assert.deepEqual(final.payments, []); assert.equal(final.paymentClaims, undefined); assert.equal(final.paymentChannel, undefined);
  assert.deepEqual(final.salesAmountSnapshot, order.salesAmountSnapshot);
});

test("v4 preserves an unchanged disabled carrier snapshot but rejects newly selecting it", async t => {
  const s = await setup(t, state => {
    state.systemSettings.shippingCarriers = [{ id: "sf", name: "顺丰", enabled: false }, { id: "jd", name: "京东", enabled: true }];
    const existing = paymentProofFixture().state.orders[0];
    state.orders = [{ ...existing, id: "cashier-order", orderFormSchemaVersion: 4, plannedCarrier: "顺丰", paymentMethodId: undefined,
      paymentMethodName: "", paymentChannel: undefined, paymentAccount: "", shippingSettlementVersion: 1, shippingFeeMode: "prepaid", shippingSettlementTiming: "after_shipping" }];
    state.stock[0].sold = true;
  });
  const before = (await s.readPersistedState()).orders[0];
  const preserved = await s.request("/api/orders/update", { ...before, orderId: before.id, notes: "保留旧计划" }); ok(preserved);
  assert.equal(preserved.body.order.plannedCarrier, "顺丰");
  const changed = await s.request("/api/orders/update", { ...preserved.body.order, orderId: before.id, plannedCarrier: "京东" }); ok(changed);
  denied(await s.request("/api/orders/update", { ...changed.body.order, orderId: before.id, plannedCarrier: "顺丰" }));
});
