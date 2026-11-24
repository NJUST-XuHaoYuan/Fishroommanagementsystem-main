import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";

const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const denied = r => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
const time = "2026-11-20T12:00:00+08:00";
const receipt = (id, amount, status = "verified") => ({ id, type: "balance", amount, verificationStatus: status, time,
  channel: "wechat", account: "合成微信收款账户", paymentMethodId: "pm-wechat", verifiedAt: status === "verified" ? time : "" });
const refund = (id, amount, status = "pending") => ({ ...receipt(id, amount, status), type: "refund" });

async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture(); fixture.state.orders[0].payments = [receipt("received", 1000)]; customize(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(server.stop);
  const tokens = {};
  for (const role of ["editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const write = (data, role = "editor") => server.request("/api/orders/refund", { token: tokens[role], body: { orderId: "proof-order", time, ...data } });
  return { ...server, write };
}

for (const [shipMethod, status] of [["pickup", "delivered"], ["express", "shipped"], ["express", "damaged"]]) {
  test(`unfinished ${shipMethod}/${status} actual refund changes only money and preserves shipment, fish and receivable`, async t => {
    const s = await setup(t, state => {
      state.orders[0].status = "shipped";
      if (shipMethod === "pickup") state.orders[0].source = "线下";
      state.shipments = [{ id: "refund-shipment", orderId: "proof-order", siteId: "nanjing", shipMethod, status,
        itemStockIds: ["proof-fish"], shipDate: "2026-11-20", packingProof: ["one", "two"], actualShippingFee: 0 }];
    });
    const before = await s.readPersistedState(); const result = await s.write({ id: "actual-refund", amount: 200, refundStage: "before_shipment", notes: "实际退款" }); ok(result);
    const after = await s.readPersistedState(); const payment = after.orders[0].payments.at(-1);
    assert.equal(payment.refundStage, "after_shipment"); assert.equal(payment.verificationStatus, "pending"); assert.equal(payment.recordedBy, "pricing-editor");
    assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
    const { payments, salesAmountSnapshot, ...remaining } = after.orders[0];
    assert.deepEqual(remaining, Object.fromEntries(Object.entries(before.orders[0]).filter(([key]) => key !== "payments")));
    assert.equal(salesAmountSnapshot.amount, 1000); assert.equal(payments.length, before.orders[0].payments.length + 1);
    assert.equal(after.stockStatusHistory, before.stockStatusHistory);
  });
}

test("pending receipt permits business refund and its linked pending proof does not double the limit", async t => {
  const s = await setup(t, state => {
    state.orders[0].payments = [receipt("not-verified", 1000, "pending")];
    state.orders[0].paymentClaims = [{ id: "pending-claim", amount: 1000, status: "pending", matchingPaymentId: "not-verified" }];
  });
  const before = await s.readPersistedState(); const r = await s.write({ amount: 1000.01 }); denied(r);
  assert.equal(r.body.code, "ORDER_REFUND_EXCEEDS_RECEIPTS"); assert.match(r.body.error, /1000\.00/);
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.write({ id: "pending-income-refund", amount: 1000 }));
  const after = await s.readPersistedState(); assert.equal(after.orders[0].payments.at(-1).verificationStatus, "pending");
  denied(await s.write({ amount: 0.01 })); assert.deepEqual(await s.readPersistedState(), after);
});

test("registered income minus all registered refunds counts verified refund once and reserves pending refund", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt("confirmed", 100), receipt("pending-receipt", 500, "pending"),
    refund("verified-refund", 30, "verified"), refund("pending-refund", 20)]; });
  const before = await s.readPersistedState();
  const excess = await s.write({ id: "too-much", amount: 550.01 }); denied(excess); assert.match(excess.body.error, /550\.00/);
  assert.deepEqual(await s.readPersistedState(), before);
  const accepted = await s.write({ id: "remaining-550", amount: 550 }); ok(accepted); assert.equal(accepted.body.order.payments.at(-1).amount, 550);
  assert.equal(accepted.body.order.payments.at(-1).refundStage, "before_shipment");
  const after = await s.readPersistedState(); denied(await s.write({ id: "over-remaining", amount: 0.01 }));
  const duplicate = await s.write({ id: "remaining-550", amount: 550 }); denied(duplicate); assert.match(duplicate.body.error, /已存在/);
  assert.deepEqual(await s.readPersistedState(), after);
});

test("concurrent distinct refund requests cannot overspend the verified receipt balance", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [receipt("received", 100)]; });
  const results = await Promise.all(["refund-a", "refund-b"].map(id => s.write({ id, amount: 60 })));
  assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
  const order = (await s.readPersistedState()).orders[0]; assert.equal(order.payments.filter(p => p.type === "refund").length, 1);
});

test("cancelled order and unauthorized user cannot register actual refunds", async t => {
  const cancelled = await setup(t, state => { state.orders[0].status = "cancelled"; }); const before = await cancelled.readPersistedState();
  const r = await cancelled.write({ amount: 10 }); denied(r); assert.match(r.body.error, /已取消/); assert.deepEqual(await cancelled.readPersistedState(), before);
  const s = await setup(t); const initial = await s.readPersistedState();
  const forbidden = await s.write({ amount: 10 }, "viewer"); denied(forbidden); assert.match(forbidden.body.error, /权限/); assert.deepEqual(await s.readPersistedState(), initial);
});
