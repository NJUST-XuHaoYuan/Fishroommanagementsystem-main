import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyStockPricingState, normalizeStockPricing, reconcileReleasedStockPricing, resolveStockPriceMode, stockPricingProtectedIds, syncProductStockPrices } from "./stock-pricing.mjs";

const product = { id: "p", defaultPrice: 100 };
const fish = (id, extra = {}) => ({ id, productId: "p", basePrice: 100, sold: false, lost: false, ...extra });
const activeOrder = (stockItemId, extra = {}) => ({ id: `order-${stockItemId}`, status: "confirmed", items: [{ stockItemId, price: 83 }], ...extra });

test("two-state resolution preserves explicit manual intent and retires legacy classification", () => {
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "product", priceOverridden: true }), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "legacy" }), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "legacy", priceOverridden: true }), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { priceMode: "manual", priceOverridden: false }), product), "manual");
  assert.equal(resolveStockPriceMode(fish("f", { priceOverridden: true }), product), "manual");
  assert.equal(resolveStockPriceMode(fish("f"), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 99 }), product), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 0.1 + 0.2 }), { defaultPrice: 0.3 }), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: 0 }), { defaultPrice: 0 }), "product");
  assert.equal(resolveStockPriceMode(fish("f", { basePrice: "bad" }), product), "product");
  assert.throws(() => resolveStockPriceMode(fish("f", { priceMode: "unknown" }), product));
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

test("existing writes default old prices to products but retain intentional legacy-client manual changes", () => {
  const existing = fish("f", { basePrice: 120 });
  assert.equal(normalizeStockPricing({ ...existing, notes: "new" }, product, { existing }).priceMode, "product");
  assert.equal(normalizeStockPricing({ ...existing, notes: "new" }, product, { existing }).basePrice, 100);
  assert.equal(normalizeStockPricing({ ...existing, basePrice: 130 }, product, { existing }).priceMode, "manual");
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "product" }, product, { existing }).basePrice, 100);
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "manual" }, product, { existing }).priceOverridden, true);
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "legacy" }, product, { existing }).basePrice, 100);
  assert.equal(normalizeStockPricing({ ...existing, priceMode: "legacy" }, product, { existing }).priceMode, "product");
  assert.throws(() => normalizeStockPricing({ ...existing, priceMode: "legacy", basePrice: 130 }, product, { existing }));
  assert.equal(normalizeStockPricing(fish("f", { priceMode: "legacy" }), product, { existing: fish("f") }).priceMode, "product");
  assert.throws(() => normalizeStockPricing(fish("f", { priceMode: "legacy" }), product, { existing: fish("f", { priceMode: "manual" }) }), (error) => error.code === "STOCK_PRICING_STALE");
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

test("product updates retire historical classifications while preserving manual prices and financial records", () => {
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
  assert.deepEqual(synced.counts, { total: 7, product: 6, manual: 1, legacy: 0, protected: 4, priceUpdated: 1, modeFrozen: 7 });
  const second = syncProductStockPrices({ ...state, stock: synced.stock }, { ...product, defaultPrice: 150 }, { ...product, defaultPrice: 200 });
  assert.equal(second.stock.find((item) => item.id === "legacy").basePrice, 200);
  assert.equal(second.stock.find((item) => item.id === "legacy").priceMode, "product");
  assert.equal(second.stock.find((item) => item.id === "manual").basePrice, 100);
  assert.equal(second.counts.modeFrozen, 0);
  assert.equal(second.stock.find((item) => item.id === "other"), stock.at(-1));
});

test("same-price product edits still bring unclassified free stock onto the product price", () => {
  const result = syncProductStockPrices({ stock: [fish("a"), fish("b", { basePrice: 130 })] }, product, product);
  assert.equal(result.counts.priceUpdated, 1);
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
  assert.equal(reconciled.stock.find((item) => item.id === "legacy").basePrice, 200);
  assert.equal(reconciled.stock.find((item) => item.id === "legacy").priceMode, "product");
  for (const key of ["manual", "out", "still", "already-free"]) assert.equal(reconciled.stock.find((item) => item.id === key).basePrice, 100, key);
  assert.equal(reconciled.orders, next.orders);
  assert.equal(reconciled.shipments, next.shipments);
  assert.equal(next.stock[0].basePrice, 100, "caller state not mutated");
});

test("released unclassified old stock follows the current product price", () => {
  const previous = { stock: [fish("legacy", { sold: true, basePrice: 150 })], products: [product], orders: [activeOrder("legacy")] };
  const next = { stock: [fish("legacy", { basePrice: 150 })], products: [{ ...product, defaultPrice: 150 }], orders: [] };
  assert.equal(reconcileReleasedStockPricing(previous, next).stock[0].priceMode, "product");
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

test("legacy migration changes only candidate pricing fields, freezes held amounts and is idempotent", () => {
  const legacy = (stockId, extra = {}) => fish(stockId, { priceMode: "legacy", ...extra });
  const stock = [
    legacy("legacy", { basePrice: 110 }), fish("unclassified", { basePrice: 130 }), fish("same", { basePrice: 200 }),
    legacy("legacy-override", { basePrice: 140, priceOverridden: true }),
    fish("manual", { basePrice: 300, priceMode: "manual", priceOverridden: false }),
    fish("old-manual", { basePrice: 320, priceOverridden: true }),
    fish("product", { basePrice: 20, priceMode: "product" }),
    legacy("sold", { sold: true }), legacy("lost", { lost: true }), legacy("status-sold", { status: "sold" }),
    legacy("reserved"), legacy("out"), legacy("removed"), legacy("cancelled"), legacy("planned"),
  ].map((item) => ({ ...item, notes: "preserve", entrySnapshot: { tank: "original" }, arbitrary: [1, { nested: true }] }));
  const state = {
    products: [{ ...product, defaultPrice: 200 }], stock,
    orders: [activeOrder("reserved"), activeOrder("removed", { items: [{ stockItemId: "removed", price: 91, inventoryRemovedAt: "2026-09-18" }] }), activeOrder("cancelled", { status: "cancelled" })],
    shipments: [{ status: "delivered", itemStockIds: ["out"], actualShippingFee: 12 }, { status: "preparing", itemStockIds: ["planned"] }],
    batches: [{ id: "batch", purchaseCost: 1299 }], payments: [{ amount: 777 }], refunds: [{ amount: 31 }],
    approvalRequests: [{ payload: { upsert: [legacy("legacy", { basePrice: 110 })] } }],
    operationLogs: [{ id: "old-log" }], arbitraryNonStock: { untouched: true },
  };
  const before = structuredClone(state);
  const result = migrateLegacyStockPricingState(state);
  assert.equal(result.changed, true);
  assert.deepEqual(state, before, "source state is not mutated");
  assert.deepEqual(result.counts, { total: 15, candidates: 12, legacyConverted: 10, unclassifiedConverted: 2,
    manualPreserved: 2, productPreserved: 1, protected: 5, priceUpdated: 6, modeUpdated: 12, exceptionCount: 0 });
  assert.deepEqual(result.exceptions, []);
  const afterById = new Map(result.state.stock.map((item) => [item.id, item]));
  for (const stockId of ["legacy", "unclassified", "same", "legacy-override", "removed", "cancelled", "planned"]) {
    assert.equal(afterById.get(stockId).basePrice, 200, stockId);
    assert.equal(afterById.get(stockId).priceMode, "product", stockId);
    assert.equal(afterById.get(stockId).priceOverridden, false, stockId);
  }
  for (const stockId of ["sold", "lost", "status-sold", "reserved", "out"]) {
    assert.equal(afterById.get(stockId).basePrice, 100, stockId);
    assert.equal(afterById.get(stockId).priceMode, "product", stockId);
  }
  for (const stockId of ["manual", "old-manual", "product"]) {
    assert.equal(afterById.get(stockId), state.stock.find((item) => item.id === stockId), "established modes remain wholly untouched");
  }
  const withoutPricing = ({ basePrice, priceMode, priceOverridden, ...other }) => other;
  assert.deepEqual(result.state.stock.map(withoutPricing), state.stock.map(withoutPricing));
  for (const key of Object.keys(state).filter((key) => key !== "stock")) {
    assert.equal(result.state[key], state[key], `${key} keeps original reference`);
    assert.deepEqual(result.state[key], before[key], `${key} keeps original content`);
  }
  const repeated = migrateLegacyStockPricingState(result.state);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state, result.state);
  for (const key of ["candidates", "legacyConverted", "unclassifiedConverted", "priceUpdated", "modeUpdated"]) assert.equal(repeated.counts[key], 0, key);
});

test("migration preserves exceptional amounts without fabricating product matches or silently converting unknown modes", () => {
  const state = {
    products: [{ id: "duplicate", defaultPrice: 200 }, { id: "duplicate", defaultPrice: 300 }, { id: "invalid", defaultPrice: 0 }],
    stock: [
      fish("missing", { productId: "missing", priceMode: "legacy", basePrice: 170 }),
      fish("duplicate", { productId: "duplicate", basePrice: 180 }),
      fish("invalid", { productId: "invalid", priceMode: "legacy", basePrice: 190 }),
      fish("missing-held", { productId: "missing", priceMode: "legacy", basePrice: 210, sold: true }),
      fish("unknown", { priceMode: "unknown", basePrice: 220 }), null,
    ],
  };
  const before = structuredClone(state);
  const result = migrateLegacyStockPricingState(state);
  assert.equal(result.changed, true);
  assert.equal(result.counts.priceUpdated, 0);
  assert.equal(result.counts.candidates, 4);
  assert.equal(result.counts.protected, 1);
  assert.deepEqual(result.exceptions, [
    { stockId: "missing", reason: "PRODUCT_MISSING", protected: false },
    { stockId: "duplicate", reason: "PRODUCT_DUPLICATE", protected: false },
    { stockId: "invalid", reason: "PRODUCT_PRICE_INVALID", protected: false },
    { stockId: "missing-held", reason: "PRODUCT_MISSING", protected: true },
    { stockId: "unknown", reason: "UNKNOWN_PRICE_MODE", protected: false },
    { stockId: "", reason: "INVALID_STOCK", protected: false },
  ]);
  assert.equal(result.counts.exceptionCount, 6);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(result.state.stock[index].basePrice, state.stock[index].basePrice);
    assert.equal(result.state.stock[index].priceMode, "product");
  }
  assert.equal(result.state.stock[4], state.stock[4]);
  assert.equal(result.state.stock[5], null);
  assert.deepEqual(state, before);
  const repeated = migrateLegacyStockPricingState(result.state);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state, result.state);
  assert.equal(repeated.counts.candidates, 0);
});

test("migration does not create stock in an empty state and preserves every invalid default price", () => {
  const empty = { orders: [] };
  assert.equal(migrateLegacyStockPricingState(empty).state, empty);
  const prices = [0, -1, null, "", "bad", Number.POSITIVE_INFINITY, 0.001, 1e100];
  for (const defaultPrice of prices) {
    const state = { products: [{ ...product, defaultPrice }], stock: [fish("f", { priceMode: "legacy", basePrice: 123 })] };
    const result = migrateLegacyStockPricingState(state);
    assert.equal(result.state.stock[0].basePrice, 123, String(defaultPrice));
    assert.equal(result.state.stock[0].priceMode, "product");
    assert.equal(result.exceptions[0].reason, "PRODUCT_PRICE_INVALID");
  }
});

test("compatible old legacy writes retire their mode but cannot change protected or stale prices", () => {
  const existing = fish("f", { basePrice: 120, priceMode: "legacy", priceOverridden: true });
  const changedProduct = { ...product, defaultPrice: 200 };
  const held = normalizeStockPricing({ ...existing, notes: "updated" }, changedProduct, { existing, protected: true });
  assert.equal(held.priceMode, "product");
  assert.equal(held.priceOverridden, false);
  assert.equal(held.basePrice, 120);
  assert.equal(normalizeStockPricing(existing, changedProduct, { existing }).basePrice, 200);
  for (const change of [{ basePrice: 130 }, { productId: "other" }]) {
    assert.throws(() => normalizeStockPricing({ ...existing, ...change }, changedProduct, { existing }), (error) => error.code === "STOCK_PRICING_STALE");
  }
  const migrated = { ...held, basePrice: 200 };
  assert.throws(() => normalizeStockPricing(existing, changedProduct, { existing: migrated }), (error) => error.code === "STOCK_PRICING_STALE");
});

test("synchronization reports retired explicit legacy modes and only re-prices free stock", () => {
  const state = { stock: [fish("free", { priceMode: "legacy", priceOverridden: true, basePrice: 123 }), fish("held", { priceMode: "legacy", sold: true, basePrice: 124 })] };
  const synced = syncProductStockPrices(state, product, { ...product, defaultPrice: 180 });
  assert.equal(synced.counts.legacy, 0);
  assert.equal(synced.counts.product, 2);
  assert.equal(synced.counts.modeFrozen, 2);
  assert.equal(synced.counts.priceUpdated, 1);
  assert.equal(synced.stock[0].basePrice, 180);
  assert.equal(synced.stock[1].basePrice, 124);
  assert.ok(synced.stock.every((item) => item.priceMode === "product" && item.priceOverridden === false));
});

test("released legacy stock catches up but never chooses arbitrarily between duplicate products", () => {
  const previous = { stock: [fish("f", { sold: true, priceMode: "legacy", basePrice: 123 })], products: [product], orders: [activeOrder("f")] };
  const next = { stock: [fish("f", { priceMode: "legacy", basePrice: 123 })], products: [{ ...product, defaultPrice: 200 }], orders: [] };
  const released = reconcileReleasedStockPricing(previous, next).stock[0];
  assert.equal(released.priceMode, "product");
  assert.equal(released.basePrice, 200);
  const duplicate = { ...next, products: [...next.products, { ...product, defaultPrice: 300 }] };
  const ambiguous = reconcileReleasedStockPricing(previous, duplicate).stock[0];
  assert.equal(ambiguous.priceMode, "product");
  assert.equal(ambiguous.basePrice, 123);
});
