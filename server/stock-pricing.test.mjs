import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStockPricing, reconcileReleasedStockPricing, resolveStockPriceMode, stockPricingProtectedIds, syncProductStockPrices } from "./stock-pricing.mjs";

const product = { id: "p", defaultPrice: 100 };
const fish = (id, extra = {}) => ({ id, productId: "p", basePrice: 100, sold: false, lost: false, ...extra });
const activeOrder = (stockItemId, extra = {}) => ({ id: `order-${stockItemId}`, status: "confirmed", items: [{ stockItemId, price: 83 }], ...extra });

test("explicit three-state modes beat old flags; legacy evidence is classified against old cents", () => {
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "product", priceOverridden: true }), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "legacy" }), product), "legacy");
  assert.equal(resolveStockPriceMode(fish("f", { priceOverridden: true }), product), "manual");
  assert.equal(resolveStockPriceMode(fish("f"), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 99 }), product), "legacy");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 0.1 + 0.2 }), { defaultPrice: 0.3 }), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 0 }), { defaultPrice: 0 }), "legacy");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: "bad" }), product), "legacy");
});

test("new follow stock takes the server product price and legacy clients retain custom amounts as manual", () => {
  assert.deepEqual(normalizeStockPricing(fish("f", { basePrice: 1, priceMode: "product", priceOverridden: true }), product), fish("f", { priceMode: "product", priceOverridden: false }));
  assert.equal(normalizeStockPricing(fish("f"), product).priceMode, "product");
  assert.equal(normalizeStockPricing(fish("f", { basePrice: 120 }), product).priceMode, "manual");
  assert.equal(normalizeStockPricing(fish("f", { basePrice: 100, priceOverridden: true }), product).priceMode, "manual");
  assert.equal(normalizeStockPricing({ id: "f", productId: "p" }, product).basePrice, 100);
  for (const priceMode of ["legacy", "automatic", "invalid"]) assert.throws(() => normalizeStockPricing(fish("f", { priceMode }), product));
  assert.throws(() => normalizeStockPricing(fish("f", { priceMode: "manual", basePrice: Infinity }), product));
  assert.throws(() => normalizeStockPricing(fish("f", { priceMode: "product" }), { ...product, defaultPrice: 0 }));
});

test("existing price writes distinguish actual legacy-client changes from unrelated edits", () => {
  const existing = fish("f", { basePrice: 120 });
  assert.equal(normalizeStockPricing({ ...existing, notes: "new" }, product, { existing }).priceMode, "legacy");
  assert.equal(normalizeStockPricing({ ...existing, basePrice: 130 }, product, { existing }).priceMode, "manual");
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "product" }, product, { existing }).basePrice, 100);
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "manual" }, product, { existing }).priceOverridden, true);
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "legacy" }, product, { existing }).basePrice, 120);
  assert.throws(() => normalizeStockPricing({ ...existing, priceMode: "legacy", basePrice: 130 }, product, { existing }));
  assert.throws(() => normalizeStockPricing(fish("f", { priceMode: "legacy" }), product, { existing: fish("f") }));
  const explicitFollower = fish("f", { priceMode: "product" });
  const oldClientUpdate = { ...explicitFollower, basePrice: 110 }; delete oldClientUpdate.priceMode;
  assert.equal(normalizeStockPricing(oldClientUpdate, product, { existing: explicitFollower }).priceMode, "manual");
});

test("protected stock permits unrelated edits but never changes price or mode", () => {
  const existing = fish("f", { basePrice: 100, priceMode: "product" });
  const changedProduct = { ...product, defaultPrice: 150 };
  assert.equal(normalizeStockPricing({ ...existing, notes: "new" }, changedProduct, { existing, protected: true }).basePrice, 100);
  for (const change of [{ basePrice: 120 }, { priceMode: "manual" }, { productId: "other" }]) {
    assert.throws(() => normalizeStockPricing({ ...existing, ...change }, changedProduct, { existing, protected: true }), (error) => error.code === "STOCK_PRICING_PROTECTED");
  }
});

test("pricing protection covers all sales and shipment reservations but not cancelled or removed order lines", () => {
  const state = { stock: [fish("sold", { sold: true }), fish("lost", { lost: true }), fish("legacy-sold", { status: "sold" }), fish("free")],
    orders: [activeOrder("reserved"), activeOrder("completed", { status: "completed" }), activeOrder("cancelled", { status: "cancelled" }), activeOrder("removed", { items: [{ stockItemId: "removed", inventoryRemovedAt: "2026-09-14" }] })],
    shipments: [{ status: "outbound", itemStockIds: ["out"] }, { status: "damaged", itemStockIds: ["damaged"] }, { status: "preparing", itemStockIds: ["planned"] }] };
  assert.deepEqual([...stockPricingProtectedIds(state)].sort(), ["sold", "lost", "legacy-sold", "reserved", "completed", "out", "damaged"].sort());
});

test("product updates freeze every old classification before default-price collisions and preserve financial records", () => {
  const stock = [fish("follow"), fish("manual", { priceOverridden: true }), fish("legacy", { basePrice: 150 }), fish("reserved"), fish("out"), fish("lost", { lost: true }), fish("sold", { sold: true }), fish("other", { productId: "other" })];
  const state = { stock, orders: [activeOrder("reserved")], shipments: [{ status: "delivered", itemStockIds: ["out"] }] };
  const before = structuredClone(state);
  const synced = syncProductStockPrices(state, product, { ...product, defaultPrice: 150 });
  assert.deepEqual(state, before);
  assert.equal(synced.stock.find((item) => item.id === "follow").basePrice, 150);
  for (const stockId of ["reserved", "out", "lost", "sold"]) {
    assert.equal(synced.stock.find((item) => item.id === stockId).basePrice, 100);
    assert.equal(synced.stock.find((item) => item.id === stockId).priceMode, "product");
  }
  assert.deepEqual(synced.counts, { total: 7, product: 5, manual: 1, legacy: 1, protected: 4, priceUpdated: 1, modeFrozen: 7 });
  const second = syncProductStockPrices({ ...state, stock: synced.stock }, { ...product, defaultPrice: 150 }, { ...product, defaultPrice: 200 });
  assert.equal(second.stock.find((item) => item.id === "legacy").basePrice, 150);
  assert.equal(second.stock.find((item) => item.id === "legacy").priceMode, "legacy");
  assert.equal(second.stock.find((item) => item.id === "manual").basePrice, 100);
  assert.equal(second.counts.modeFrozen, 0);
  assert.equal(second.stock.find((item) => item.id === "other"), stock.at(-1));
});

test("same-price product edits may freeze modes but do not report price changes", () => {
  const result = syncProductStockPrices({ stock: [fish("a"), fish("b", { basePrice: 130 })] }, product, product);
  assert.equal(result.counts.priceUpdated, 0);
  assert.equal(result.counts.modeFrozen, 2);
  const repeated = syncProductStockPrices({ stock: result.stock }, product, product);
  assert.equal(repeated.updatedStock.length, 0);
});

test("only newly released product followers catch up; retained order and shipment amounts stay untouched", () => {
  const products = [{ ...product, defaultPrice: 200 }];
  const stock = [fish("follow", { sold: true, priceMode: "product" }), fish("manual", { sold: true, priceMode: "manual" }), fish("legacy", { sold: true, priceMode: "legacy" }), fish("out", { sold: true, priceMode: "product" }), fish("still", { sold: true, priceMode: "product" }), fish("already-free", { priceMode: "product" })];
  const orders = stock.slice(0, 5).map((item) => activeOrder(item.id));
  const previous = { products, stock, orders, shipments: [{ status: "shipped", itemStockIds: ["out"], actualShippingFee: 21 }] };
  const next = { ...previous, stock: stock.map((item) => ({ ...item, sold: item.id === "still" })), orders: orders.map((order) => ({ ...order, status: order.id === "order-still" ? "confirmed" : "cancelled" })) };
  const reconciled = reconcileReleasedStockPricing(previous, next);
  assert.equal(reconciled.stock.find((item) => item.id === "follow").basePrice, 200);
  for (const key of ["manual", "legacy", "out", "still", "already-free"]) assert.equal(reconciled.stock.find((item) => item.id === key).basePrice, 100, key);
  assert.equal(reconciled.orders, next.orders);
  assert.equal(reconciled.shipments, next.shipments);
  assert.equal(next.stock[0].basePrice, 100, "caller state not mutated");
});

test("released unclassified legacy stock is classified against previous product, never the new matching default", () => {
  const previous = { stock: [fish("legacy", { sold: true, basePrice: 150 })], products: [product], orders: [activeOrder("legacy")] };
  const next = { stock: [fish("legacy", { basePrice: 150 })], products: [{ ...product, defaultPrice: 150 }], orders: [] };
  assert.equal(reconcileReleasedStockPricing(previous, next).stock[0].priceMode, "legacy");
});

test("loss recovery needs the original lost snapshot and resumes only product followers", () => {
  const previous = { products: [{ ...product, defaultPrice: 180 }], stock: [fish("f", { lost: true, priceMode: "product" })], orders: [], shipments: [] };
  const next = { ...previous, stock: [fish("f", { lost: false, priceMode: "product" })] };
  assert.equal(reconcileReleasedStockPricing(previous, next).stock[0].basePrice, 180);
  assert.equal(reconcileReleasedStockPricing({ ...previous, stock: next.stock }, next).stock[0].basePrice, 100,
    "overwriting previous stock before reconciliation loses the historical protection signal");
});

test("cancelling the last shipment resumes price only when the order no longer reserves that fish", () => {
  const previous = { products: [{ ...product, defaultPrice: 180 }], stock: [fish("f", { priceMode: "product" })],
    orders: [activeOrder("f", { status: "cancelled" })], shipments: [{ status: "shipped", itemStockIds: ["f"] }] };
  const next = { ...previous, shipments: [] };
  assert.equal(reconcileReleasedStockPricing(previous, next).stock[0].basePrice, 180);
  assert.equal(reconcileReleasedStockPricing({ ...previous, shipments: [] }, next).stock[0].basePrice, 100,
    "overwriting previous shipments loses protection for cancelled orders with sold=false");
  const stillReserved = { ...next, orders: [activeOrder("f")] };
  assert.equal(reconcileReleasedStockPricing(previous, stillReserved).stock[0].basePrice, 100);
});
