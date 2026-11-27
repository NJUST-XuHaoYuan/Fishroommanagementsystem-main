import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";

const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const denied = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
const verifiedReceipt = () => ({ id: "snapshot-receipt", type: "balance", amount: 1000, time: "2026-11-17T10:00:00+08:00", verificationStatus: "verified", channel: "wechat", account: "合成微信收款账户" });
async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture();
  fixture.state.systemSettings.orderPackagingFee = 15;
  const base = fixture.state.stock[0];
  fixture.state.stock.push(...["second-original", "replacement-1", "replacement-2", "replacement-3", "new-order-fish"].map(id => ({ ...base, id, code: id, sold: false })));
  customize(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(server.stop);
  const token = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  return { ...server, write: (path, body) => server.request(path, { token, body }), read: path => server.request(path, { token }) };
}

test("real create captures agreement and later edit cannot rewrite it or use actual carrier fees", async t => {
  const s = await setup(t);
  const old = (await s.readPersistedState()).orders[0];
  const input = { ...old, id: "sales-new", items: [{ stockItemId: "new-order-fish", productId: "price-product", price: 1000 }],
    shippingFeeMode: "prepaid", shippingFee: 30, discount: 10 };
  denied(await s.write("/api/orders/create", { ...input, salesAmountSnapshot: { amount: 1, source: "created", capturedAt: "1900" } }));
  const created = await s.write("/api/orders/create", input); ok(created);
  const order = created.body.order; assert.equal(order.salesAmountSnapshot.amount, 1035); assert.equal(order.salesAmountSnapshot.source, "created");
  ok(await s.write("/api/orders/update", { ...order, orderId: order.id, items: [{ ...order.items[0], price: 900 }], shippingFee: 40 }));
  const after = (await s.readPersistedState()).orders.find(item => item.id === order.id);
  assert.deepEqual(after.salesAmountSnapshot, order.salesAmountSnapshot);
});

test("legacy edit and item return preserve the pre-edit agreement, including in route responses", async t => {
  const s = await setup(t);
  const old = (await s.readPersistedState()).orders[0];
  const edited = await s.write("/api/orders/update", { ...old, orderId: old.id, items: [{ ...old.items[0], price: 900 }] }); ok(edited);
  assert.equal(edited.body.order.salesAmountSnapshot.amount, 1000); assert.equal(edited.body.order.salesAmountSnapshot.source, "legacy");
  const returned = await s.write("/api/orders/return-item", { orderId: old.id, stockItemId: "proof-fish" }); ok(returned);
  assert.equal(returned.body.order.items.length, 0); assert.deepEqual(returned.body.order.salesAmountSnapshot, edited.body.order.salesAmountSnapshot);
});

test("refund stage and fish identity are server snapshots even for partial shipments and completed orders", async t => {
  const s = await setup(t, state => {
    state.orders[0].status = "shipped"; state.orders[0].items.push({ stockItemId: "second-original", productId: "price-product", fishCode: "second-original", price: 200 });
    state.stock.find(item => item.id === "second-original").sold = true;
    state.shipments = [{ id: "sales-shipment", orderId: "proof-order", status: "shipped", siteId: "nanjing", shipMethod: "express",
      shippedAt: "2026-11-18T10:00:00", itemStockIds: ["proof-fish"], packingProof: ["one", "two"], actualShippingFee: 0 }];
    state.orders.push({ ...structuredClone(state.orders[0]), id: "completed-sales", orderNo: "SALES-COMPLETED", status: "completed", items: [], payments: [verifiedReceipt()] });
  });
  const returned = await s.write("/api/orders/return-item", { orderId: "proof-order", stockItemId: "second-original",
    refund: { id: "partial-refund", type: "refund", amount: 200, time: "2026-11-19T11:00:00", refundStage: "after_shipment", refundShipmentId: "forged", refundItems: [] } }); ok(returned);
  const payment = returned.body.order.payments[0];
  assert.equal(payment.refundStage, "before_shipment"); assert.equal(payment.refundShipmentId, ""); assert.equal(payment.refundItems[0].stockItemId, "second-original");
  assert.equal(returned.body.order.salesAmountSnapshot.amount, 1200);
  const refund = await s.write("/api/orders/refund", { orderId: "completed-sales", amount: 30, time: "2026-11-19T11:00:00", refundStage: "before_shipment" }); ok(refund);
  assert.equal(refund.body.order.payments.at(-1).refundStage, "after_shipment");
});

test("refund metadata cannot be forged by order, generic state, or finance edits and survives verification", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [verifiedReceipt()]; });
  const result = await s.write("/api/orders/refund", { orderId: "proof-order", amount: 50, time: "2026-11-19T11:00:00" }); ok(result);
  const order = result.body.order; const before = await s.readPersistedState();
  const forged = { ...order, salesAmountSnapshot: { ...order.salesAmountSnapshot, amount: 1 } };
  denied(await s.write("/api/orders/update", { ...forged, orderId: order.id }));
  denied(await s.write("/api/state/patch", { patch: { orders: [forged] }, basePatch: { orders: before.orders } }));
  const payment = order.payments.at(-1);
  denied(await s.write("/api/orders/payment", { orderId: order.id, action: "update", payment: { ...payment, refundStage: "after_shipment" } }));
  denied(await s.write("/api/orders/payment", { orderId: order.id, action: "add", payment: { id: "forged", type: "refund", amount: 10, refundStage: "before_shipment" } }));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.write("/api/orders/payment", { orderId: order.id, action: "verify", paymentId: payment.id }));
  const overview = await s.read("/api/finance/overview?siteId=nanjing"); ok(overview);
  const token = overview.body.orders.find(item => item.id === order.id).payments.find(item => item.id === payment.id).correctionToken;
  const edited = await s.write("/api/orders/payment-correction", { orderId: order.id, paymentId: payment.id, action: "correct", mode: "replace",
    clientMutationId: "refund-date-correction", expectedToken: token, reason: "更正流水登记时间，保留业务发生日",
    payment: { ...payment, time: "2026-11-19T15:00:00", notes: "财务补充说明", refundStage: "forged", refundOccurredAt: "1900-01-01" } }); ok(edited);
  const corrected = edited.body.order.payments.at(-1);
  assert.equal(corrected.refundOccurredAt, "2026-11-19T11:00:00"); assert.equal(corrected.refundStage, payment.refundStage);
  assert.equal(corrected.time, "2026-11-19T15:00:00"); assert.notEqual(corrected.id, payment.id); assert.equal(corrected.verificationStatus, "pending");
  assert.deepEqual(corrected.refundItems, payment.refundItems);
  assert.deepEqual(edited.body.order.salesAmountSnapshot, before.orders[0].salesAmountSnapshot);
  assert.equal(edited.body.order.paymentCorrections[0].originalPayment.refundOccurredAt, "2026-11-19T11:00:00");
  const verified = await s.write("/api/orders/payment", { orderId: order.id, action: "verify", paymentId: corrected.id }); ok(verified);
  assert.equal(verified.body.order.payments.at(-1).refundOccurredAt, "2026-11-19T11:00:00");
});

test("refund statement linking and unlinking retain the original business date and stage", async t => {
  const s = await setup(t, state => { state.orders[0].payments = [verifiedReceipt()]; });
  const refund = await s.write("/api/orders/refund", { orderId: "proof-order", amount: 50, time: "2026-11-18T11:00:00" }); ok(refund);
  const original = refund.body.order.payments.at(-1);
  const imported = await s.write("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "合成退款流水.csv",
    csvText: ["交易时间,交易单号,收支类型,交易金额,付款方,备注", "2026-11-19 15:00:00,REFUND-SNAPSHOT-001,支出,50.00,付款凭证合成客户,SO-PROOF-TEST 退款"].join("\n") }); ok(imported);
  const overview = await s.read("/api/finance/overview?siteId=nanjing"); ok(overview); const statement = overview.body.statements[0];
  assert.ok(statement);
  if (statement.matchStatus === "unmatched") ok(await s.write("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: "proof-order" }));
  const linked = (await s.readPersistedState()).orders[0].payments.at(-1);
  assert.equal(linked.refundOccurredAt, original.refundOccurredAt); assert.equal(linked.refundStage, original.refundStage);
  assert.deepEqual(linked.refundItems, original.refundItems); assert.equal(linked.statementOriginal.time, original.time);
  assert.equal(linked.statementId, statement.id); assert.notEqual(linked.time, original.time);
  ok(await s.write("/api/finance/statements/link", { action: "unlink", statementId: statement.id }));
  const unlinked = (await s.readPersistedState()).orders[0].payments.at(-1);
  assert.equal(unlinked.time, original.time); assert.equal(unlinked.refundOccurredAt, original.refundOccurredAt);
  assert.equal(unlinked.refundStage, original.refundStage); assert.deepEqual(unlinked.refundItems, original.refundItems);
});

test("a receipt cannot be rewritten as a refund; separate actual refund captures server stage and generic creation cannot bypass it", async t => {
  const s = await setup(t);
  const receipt = await s.write("/api/orders/payment", { orderId: "proof-order", action: "add", payment: { id: "convert", type: "balance", amount: 10, time: "2026-11-18T11:00:00", paymentMethodId: "pm-wechat", channel: "wechat", account: "合成微信收款账户" } }); ok(receipt);
  const order = receipt.body.order;
  const forged = { ...order, payments: [...order.payments, { id: "generic-refund", type: "refund", amount: 10, time: "2026-11-19T12:00:00" }] };
  denied(await s.write("/api/state/patch", { patch: { orders: [forged] }, basePatch: { orders: [order] } }));
  denied(await s.write("/api/orders/payment", { orderId: order.id, action: "update", payment: { ...order.payments[0], type: "refund", time: "2026-11-19T12:00:00" } }));
  const refund = await s.write("/api/orders/refund", { orderId: order.id, amount: 10, time: "2026-11-19T12:00:00", paymentMethodId: "pm-wechat" }); ok(refund);
  assert.equal(refund.body.order.payments[0].type, "balance");
  assert.equal(refund.body.order.payments.at(-1).refundStage, "before_shipment");
  assert.equal(refund.body.order.payments.at(-1).refundOccurredAt, "2026-11-19T12:00:00");
});

test("each real reship appends effective replacement prices, keeps old events and rejects a duplicate original fish", async t => {
  const s = await setup(t, state => {
    state.orders[0].status = "shipped"; state.orders[0].items.push({ stockItemId: "second-original", productId: "price-product", price: 200 });
    state.stock.find(item => item.id === "second-original").sold = true;
    state.stock.find(item => item.id === "replacement-1").basePrice = 90;
    Object.assign(state.stock.find(item => item.id === "replacement-2"), { priceMode: "manual", priceOverridden: true, basePrice: 155 });
    state.shipments = [{ id: "sales-shipment", orderId: "proof-order", status: "shipped", siteId: "nanjing", shipMethod: "express",
      shippedAt: "2026-11-18T10:00:00", itemStockIds: ["proof-fish", "second-original"], packingProof: ["one", "two"], actualShippingFee: 0 }];
  });
  const reship = (originalStockItemId, replacementStockItemId) => s.write("/api/shipments/damage", { shipmentId: "sales-shipment", resolution: "reship", replacements: [{ originalStockItemId, replacementStockItemId }] });
  ok(await reship("proof-fish", "replacement-1"));
  ok(await reship("second-original", "replacement-2"));
  const state = await s.readPersistedState(); const shipment = state.shipments[0];
  assert.deepEqual(shipment.damageEvents.map(event => event.replacementSaleAmount), [100, 155]);
  assert.equal(shipment.damageEvents[0].replacements[0].replacementSalePrice, 100);
  assert.equal(shipment.damageAmount, 200, "existing financial damage semantics stay separate from replacement sale value");
  assert.equal(state.orders[0].salesAmountSnapshot.amount, 1200);
  assert.deepEqual(state.orders[0].items.map(item => item.price), [1000, 200]);
  denied(await reship("proof-fish", "replacement-3")); assert.deepEqual(await s.readPersistedState(), state);
  const forged = { ...shipment, damageEvents: [{ ...shipment.damageEvents[0], replacementSaleAmount: 9999 }] };
  denied(await s.write("/api/state/patch", { patch: { shipments: [forged] }, basePatch: { shipments: state.shipments } }));
});

test("a pre-existing damaged shipment retains an unknown-price legacy event before a new damage registration", async t => {
  const s = await setup(t, state => {
    state.orders[0].status = "shipped";
    state.shipments = [{ id: "old-damage", orderId: "proof-order", status: "damaged", damageResolution: "reship", siteId: "nanjing", shipMethod: "express",
      shippedAt: "2026-10-18T10:00:00", itemStockIds: ["proof-fish"], damageAmount: 600,
      damageReplacements: [{ originalStockItemId: "unknown-old", replacementStockItemId: "unknown-replacement" }] }];
  });
  ok(await s.write("/api/shipments/damage", { shipmentId: "old-damage", resolution: "refund", damagedItemStockIds: ["proof-fish"], refundAmount: 100 }));
  const state = await s.readPersistedState(); const events = state.shipments[0].damageEvents;
  assert.equal(events.length, 2); assert.equal(events[0].legacy, true); assert.equal(events[0].replacementSaleAmount, undefined);
  assert.equal(events[0].replacements[0].replacementSalePrice, undefined); assert.equal(events[1].resolution, "refund");
  assert.equal(state.orders[0].payments.length, 0, "an adjustment does not create an actual cash refund");
});
