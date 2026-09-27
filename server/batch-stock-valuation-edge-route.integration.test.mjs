import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

function fixtureForValuation() {
  const fixture = structuredClone(stockPricingFixture);
  const stock = (id, extra = {}) => ({ ...fixture.state.stock[0], id, code: id, ...extra });
  const order = (id, stockItemIds, extra = {}) => ({
    id, orderNo: id, siteId: "nanjing", date: "2026-09-01", status: "confirmed",
    source: "私域线上", discount: 0, packagingFee: 0, shippingFee: 0, payments: [],
    items: stockItemIds.map(stockItemId => ({ stockItemId, productId: "price-product", price: 123.45 })),
    ...extra,
  });
  fixture.state.products = [fixture.state.products[0]];
  fixture.state.stock = [
    stock("current-product", { basePrice: 90 }),
    stock("manual", { basePrice: 150, priceMode: "manual", priceOverridden: true }),
    stock("old-default", { basePrice: 140, priceMode: undefined }),
    stock("preparing"), stock("cancelled"), stock("removed-line"),
    stock("lost-retained", { basePrice: 88, lost: true }),
    stock("lost-manual", { basePrice: 77, priceMode: "manual", priceOverridden: true, lost: true }),
    stock("lost-no-price", { basePrice: undefined, lost: true }),
    stock("lost-and-sold", { basePrice: 66, lost: true, sold: true }),
    stock("sold-flag", { sold: true }), stock("sold-status", { status: "sold" }),
    stock("legacy-pickup"),
    ...["pending", "confirmed", "completed", "outbound", "shipped", "delivered", "damaged"].map(id => stock(id)),
    stock("release-product", { sold: true }),
    stock("release-manual", { sold: true, basePrice: 145, priceMode: "manual", priceOverridden: true }),
  ];
  fixture.state.orders = [
    ...["pending", "confirmed", "completed"].map(status => order(`order-${status}`, [status], { status })),
    order("order-cancelled", ["cancelled"], { status: "cancelled" }),
    order("order-removed", [], { items: [{ stockItemId: "removed-line", productId: "price-product", price: 987.65, inventoryRemovedAt: "2026-09-02T10:00:00+08:00" }] }),
    order("order-lost", ["lost-and-sold"]),
    order("order-release", ["release-product", "release-manual"]),
  ];
  fixture.state.shipments = ["preparing", "outbound", "shipped", "delivered", "damaged"].map(status => ({
    id: `shipment-${status}`, orderId: `shipment-order-${status}`, siteId: "nanjing",
    shipMethod: "express", status, itemStockIds: [status],
  }));
  fixture.state.shipments.push({ id: "legacy-pickup-shipment", orderId: "legacy-pickup-order", siteId: "nanjing",
    shipMethod: "pickup", status: "preparing", itemStockIds: ["legacy-pickup"] });
  fixture.state.logs = [];
  fixture.state.checks = [];
  return fixture;
}

async function setup(t, fixture = fixtureForValuation()) {
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const token = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const read = async () => {
    const result = await server.request("/api/batches/revenue-metrics?siteId=nanjing", { token });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const metric = result.body.metrics.find(row => row.batchId === "batch-n");
    assert.ok(metric?.valuation, "list metrics include the server-calculated valuation");
    return { ...result, metric, valuation: metric.valuation };
  };
  return { ...server, token, read, fixture };
}

test("batch stock valuation excludes every held lifecycle and does not mutate financial or inventory state", async t => {
  const server = await setup(t);
  const before = await server.readPersistedState();
  const { valuation } = await server.read();
  assert.deepEqual(valuation.unsold, { count: 6, estimatedSaleValue: 650, unpricedCount: 0 });
  assert.deepEqual(valuation.lost, { count: 4, estimatedSaleValue: 231, unpricedCount: 1 });
  assert.equal(valuation.bySpecies.length, 1);
  assert.deepEqual(valuation.bySpecies[0].unsold, valuation.unsold);
  assert.deepEqual(valuation.bySpecies[0].lost, valuation.lost);

  const detail = await server.request("/api/batches/detail?siteId=nanjing&batchId=batch-n&pageSize=100", { token: server.token });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.valuation, valuation, "detail and list use the same lifecycle and price rules");
  assert.equal(detail.body.items.find(item => item.stockItemId === "removed-line").status, "inStock", "a returned order line is not a current sale");
  assert.equal(detail.body.items.find(item => item.stockItemId === "sold-status").status, "sold");
  assert.equal(detail.body.items.find(item => item.stockItemId === "outbound").status, "sold", "physically dispatched fish cannot appear as free stock");
  assert.equal(detail.body.items.find(item => item.stockItemId === "legacy-pickup").status, "sold", "legacy pickup rows are already handed over even with stale preparing status");
  assert.equal(detail.body.items.find(item => item.stockItemId === "lost-and-sold").status, "lost");
  assert.deepEqual(await server.readPersistedState(), before, "GET metrics/detail cannot repair, reprice or rewrite history");
});

test("product edits and genuine order releases update only unsold estimates while loss estimates and financial records stay frozen", async t => {
  const server = await setup(t);
  const initial = await server.read();
  const before = await server.readPersistedState();
  const changed = await server.request("/api/products/upsert", { token: server.token,
    body: { product: { ...server.fixture.state.products[0], defaultPrice: 200 }, expectedDefaultPrice: 100 } });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  const updated = await server.read();
  assert.deepEqual(updated.valuation.unsold, { count: 6, estimatedSaleValue: 1150, unpricedCount: 0 });
  assert.deepEqual(updated.valuation.lost, initial.valuation.lost, "later product prices must not reconstruct a lost fish's historical value");
  const afterPrice = await server.readPersistedState();
  assert.deepEqual(afterPrice.orders, before.orders);
  assert.deepEqual(afterPrice.shipments, before.shipments);
  assert.equal(afterPrice.stock.find(item => item.id === "lost-no-price").basePrice, undefined, "missing retained loss price stays missing");

  const released = await server.request("/api/orders/delete", { token: server.token, body: { orderId: "order-release" } });
  assert.equal(released.response.status, 200, JSON.stringify(released.body));
  const afterRelease = await server.read();
  assert.deepEqual(afterRelease.valuation.unsold, { count: 8, estimatedSaleValue: 1495, unpricedCount: 0 });
  assert.deepEqual(afterRelease.valuation.lost, initial.valuation.lost);
  const committed = await server.readPersistedState();
  assert.equal(committed.stock.find(item => item.id === "release-product").basePrice, 200);
  assert.equal(committed.stock.find(item => item.id === "release-manual").basePrice, 145);
  assert.deepEqual(committed.orders, before.orders.filter(order => order.id !== "order-release"));
  assert.deepEqual(committed.shipments, before.shipments);
});
