import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
function fixture() {
  const fixture = structuredClone(stockPricingFixture), state = fixture.state;
  state.customers = [{ id: "metric-customer", name: "合成统计客户" }];
  state.personnel.find(p => p.id === "pricing-admin").permissions.finance = { create: true, update: true, delete: true };
  state.systemSettings = { orderPackagingFee: 10, paymentMethods: [{ id: "metric-cash", name: "现金", channel: "cash", account: "合成账户", enabled: true }] };
  const order = (id, itemIds, status = "confirmed") => ({
    id, orderNo: id, siteId: "nanjing", date: today, createdAt: `${today}T08:00:00+08:00`, source: "私域线上",
    customerId: "metric-customer", contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor",
    plannedShipDate: today, paymentChannel: "cash", paymentMethodId: "metric-cash", paymentMethodName: "现金", paymentAccount: "合成账户",
    status, shippingFeeMode: "collect", shippingFee: 0, packagingFee: 0, discount: 0,
    items: itemIds.map(id => ({ stockItemId: id, productId: "price-product", price: 100 })), payments: [],
  });
  state.orders = [order("PARTIAL", ["release-follower", "release-manual"], "shipped"), order("COMPLETED-METRIC", ["ordered-completed"], "completed"),
    order("RESHIP-METRIC", ["shipment-shipped"], "shipped"), order("ADJUST-METRIC", ["shipment-delivered"], "shipped")];
  state.stock.forEach(stock => { stock.sold = state.orders.some(order => order.items.some(item => item.stockItemId === stock.id)); });
  state.stock.find(stock => stock.id === "follower-stale").basePrice = 1;
  state.products.find(product => product.id === "price-product").defaultPrice = 333;
  const shipment = (id, orderId, itemStockIds, status = "shipped") => ({
    id, orderId, siteId: "nanjing", itemStockIds, status, shipMethod: "express", shipDate: today,
    createdAt: `${today}T08:00:00+08:00`, shippedAt: `${today}T09:00:00+08:00`, trackingNo: id, carrier: "合成物流", packingProof: ["synthetic-one", "synthetic-two"],
  });
  state.shipments = [shipment("partial-shipped", "PARTIAL", ["release-follower"]), shipment("completed-shipped", "COMPLETED-METRIC", ["ordered-completed"], "delivered"),
    shipment("reship-shipped", "RESHIP-METRIC", ["shipment-shipped"]), shipment("adjust-shipped", "ADJUST-METRIC", ["shipment-delivered"])];
  state.orders[0].payments = [{ id: "receipt-partial", type: "balance", amount: 200, time: `${today}T08:30:00`, recordSource: "order", verificationStatus: "pending" }];
  state.orders[1].payments = [{ id: "receipt-completed", type: "balance", amount: 100, time: `${today}T08:30:00`, recordSource: "order", verificationStatus: "pending" }];
  return fixture;
}
async function setup(t) {
  const server = await startMutableRouteServer(fixture()); t.after(() => server.stop());
  const token = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const write = (path, body) => server.request(path, { token, body });
  const summary = async () => {
    const result = await server.request(`/api/dashboard-summary?siteId=nanjing&startDate=${today}&endDate=${today}`, { token }); ok(result);
    return result.body.summary;
  };
  return { ...server, token, write, summary };
}

test("real dashboard route separates registered receipts, unshipped returns, fulfilled refunds and replacement sale snapshots", async t => {
  const server = await setup(t);
  let summary = await server.summary();
  assert.equal(summary.dailyFinanceData[0].received, 300, "pending order receipts count before finance verification");
  const initialOrderTotal = summary.dailyFinanceData[0].orderAmount;
  const returned = await server.write("/api/orders/return-item", { orderId: "PARTIAL", stockItemId: "release-manual",
    refund: { id: "partial-refund", type: "refund", amount: 40, time: `${today}T10:00:00`, proof: [], notes: "合成未发货鱼退款" } }); ok(returned);
  assert.equal(returned.body.order.payments.at(-1).refundStage, "before_shipment");
  assert.equal(returned.body.order.salesAmountSnapshot.amount, 200, "capture before removing the returned line");
  ok(await server.write("/api/orders/refund", { orderId: "COMPLETED-METRIC", id: "completed-refund", amount: 30, time: `${today}T10:15:00` }));
  ok(await server.write("/api/shipments/damage", { shipmentId: "adjust-shipped", resolution: "refund", damagedItemStockIds: ["shipment-delivered"], refundAmount: 50 }));
  summary = await server.summary();
  assert.equal(summary.dailyFinanceData[0].orderAmount, initialOrderTotal, "returns and receivable reductions leave original sale total unchanged");
  assert.equal(summary.dailyFinanceData[0].unshippedRefund, 40, "a return of an unshipped line stays pre-shipment even after another line shipped");
  assert.equal(summary.dailyFinanceData[0].shippedDamage, 30, "receivable reduction is not an actual cash refund");
  const replacementBody = { shipmentId: "reship-shipped", resolution: "reship", replacements: [{ originalStockItemId: "shipment-shipped", replacementStockItemId: "follower-stale" }] };
  const replacement = await server.write("/api/shipments/damage", replacementBody); ok(replacement);
  assert.equal(replacement.body.shipment.damageEvents.at(-1).replacementSaleAmount, 333, "product follower uses current effective default, not stale basePrice or original item price");
  summary = await server.summary();
  assert.equal(summary.dailyFinanceData[0].shippedDamage, 363);
  const duplicate = await server.write("/api/shipments/damage", replacementBody);
  assert.ok(duplicate.response.status >= 400, JSON.stringify(duplicate.body));
  assert.equal((await server.summary()).dailyFinanceData[0].shippedDamage, 363, "repeating one replacement cannot double count");
  const staleOriginal = await server.write("/api/shipments/damage", { ...replacementBody,
    replacements: [{ originalStockItemId: "shipment-shipped", replacementStockItemId: "manual-different" }] });
  assert.ok(staleOriginal.response.status >= 400, "an already replaced original fish cannot reserve another replacement");
  assert.equal((await server.summary()).dailyFinanceData[0].shippedDamage, 363);

  const payment = await server.write("/api/orders/payment", { orderId: "COMPLETED-METRIC", action: "add", payment: {
    id: "finance-refund", type: "refund", amount: 10, time: `${today}T10:45:00`, channel: "cash", account: "合成账户", proof: [],
  } }); ok(payment);
  assert.equal(payment.body.order.payments.at(-1).refundStage, "after_shipment", "finance entry also captures business stage");
  assert.equal((await server.summary()).dailyFinanceData[0].shippedDamage, 373);
});

test("generic patches cannot rewrite stored sale, refund-stage or replacement-value business facts", async t => {
  const server = await setup(t);
  ok(await server.write("/api/orders/refund", { orderId: "COMPLETED-METRIC", id: "immutable-refund", amount: 20 }));
  let state = await server.readPersistedState();
  for (const modify of [
    order => ({ ...order, salesAmountSnapshot: { ...order.salesAmountSnapshot, amount: 999999 } }),
    order => ({ ...order, payments: order.payments.map(payment => payment.id === "immutable-refund" ? { ...payment, refundStage: "before_shipment" } : payment) }),
  ]) {
    const orders = state.orders.map(order => order.id === "COMPLETED-METRIC" ? modify(order) : order);
    const response = await server.write("/api/state/patch", { patch: { orders }, basePatch: { orders: state.orders } });
    assert.equal(response.response.status, 409, JSON.stringify(response.body));
    assert.deepEqual((await server.readPersistedState()).orders, state.orders);
  }
  ok(await server.write("/api/shipments/damage", { shipmentId: "reship-shipped", resolution: "reship", replacements: [{ originalStockItemId: "shipment-shipped", replacementStockItemId: "follower-stale" }] }));
  state = await server.readPersistedState();
  const shipments = state.shipments.map(shipment => shipment.id === "reship-shipped" ? { ...shipment, damageEvents: shipment.damageEvents.map(event => ({ ...event, replacementSaleAmount: 1 })) } : shipment);
  const response = await server.write("/api/state/patch", { patch: { shipments }, basePatch: { shipments: state.shipments } });
  assert.equal(response.response.status, 409, JSON.stringify(response.body));
});

test("new order stores the agreed gross sale at creation and later repricing cannot silently rewrite it", async t => {
  const server = await setup(t);
  const created = await server.write("/api/orders/create", {
    date: today, plannedShipDate: today, siteId: "nanjing", source: "私域线上", customerId: "metric-customer",
    contactPersonnelId: "pricing-admin", paymentMethodId: "metric-cash", paymentChannel: "cash", shippingFeeMode: "prepaid",
    items: [{ stockItemId: "follower", price: 150 }], shippingFee: 30, discount: 15, notes: "合成下单价快照测试",
  }); ok(created);
  const order = created.body.order;
  assert.deepEqual(order.salesAmountSnapshot, { amount: 175, capturedAt: order.salesAmountSnapshot.capturedAt, source: "created" });
  const updated = await server.write("/api/orders/update", { ...order, orderId: order.id, items: order.items.map(item => ({ ...item, price: 250 })), shippingFee: 90 }); ok(updated);
  assert.equal(updated.body.order.salesAmountSnapshot.amount, 175);
  const stored = (await server.readPersistedState()).orders.find(item => item.id === order.id);
  assert.deepEqual(updated.body.order.salesAmountSnapshot, stored.salesAmountSnapshot);
  assert.equal((await server.summary()).salesMetricWarnings.details.legacyOrderAmount.some(item => item.orderId === order.id), false);
});
