import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchStockValuations, batchStockUnavailableIds } from "./batch-stock-valuations.mjs";

const fish = (id, extra = {}) => ({ id, batchId: "b1", productId: "p1", siteId: "nanjing", subTankId: "t1", basePrice: 90, priceMode: "product", ...extra });
const fixture = (extra = {}) => ({
  batches: [{ id: "b1", siteId: "nanjing" }, { id: "b2", siteId: "jiangyin" }],
  products: [{ id: "p1", speciesId: "s1", name: "黄金吊 小", defaultPrice: 100.1 }, { id: "p2", speciesId: "s1", name: "黄金吊 大", defaultPrice: 200.2 }],
  species: [{ id: "s1", name: "黄金吊" }],
  tankGroups: [{ siteId: "nanjing", subTanks: [{ id: "t1" }] }, { siteId: "jiangyin", subTanks: [{ id: "t2" }] }],
  visibleSiteIds: ["nanjing", "jiangyin"], stock: [], orders: [], shipments: [], ...extra,
});
const metric = (state) => buildBatchStockValuations(state).metrics.find((item) => item.batchId === "b1");

test("uses current follower price, explicit manual price and retained loss price; merges variants by species", () => {
  const state = fixture({ stock: [fish("a"), fish("b", { productId: "p2" }), fish("c", { priceMode: "manual", basePrice: 10.3 }), fish("d", { lost: true, sold: true, basePrice: 44.4 }), fish("e", { priceMode: "legacy" }), fish("f", { priceMode: undefined, priceOverridden: true, basePrice: 25.5 })] });
  const before = structuredClone(state);
  const result = metric(state);
  assert.deepEqual(result.unsold, { count: 5, estimatedSaleValue: 436.2, unpricedCount: 0 });
  assert.deepEqual(result.lost, { count: 1, estimatedSaleValue: 44.4, unpricedCount: 0 });
  assert.equal(result.bySpecies.length, 1);
  assert.deepEqual(result.bySpecies[0].unsold, result.unsold);
  assert.deepEqual(result.bySpecies[0].lost, result.lost);
  assert.deepEqual(state, before);
});

test("occupancy excludes active orders and outbound shipments, but not cancelled orders or removed lines", () => {
  const state = fixture({ stock: ["reserved", "cancelled", "released", "preparing", "outbound", "pickup", "sold", "old-sold", "damaged", "restored"].map((key) => fish(key, key === "sold" ? { sold: true } : key === "old-sold" ? { status: "sold" } : {})),
    orders: [{ status: "confirmed", items: [{ stockItemId: "reserved" }, { stockItemId: "released", inventoryRemovedAt: "2026-01-01" }] }, { status: "cancelled", items: [{ stockItemId: "cancelled" }] }],
    shipments: [{ status: "preparing", itemStockIds: ["preparing"] }, { status: "shipped", itemStockIds: ["outbound"] }, { status: "preparing", shipMethod: "pickup", itemStockIds: ["pickup"] }, { status: "damaged", itemStockIds: ["damaged"] }],
    lossRecords: [{ stockItemId: "restored", date: "2026-01-01" }],
  });
  assert.deepEqual(metric(state).unsold, { count: 4, estimatedSaleValue: 400.4, unpricedCount: 0 });
  assert.equal(metric(state).lost.count, 0);
  assert.equal(metric(state).excludedCount, 6);
  assert.equal(batchStockUnavailableIds(state).has("pickup"), true);
});

test("a visible transfer remains in original batch; current tank site controls confidentiality", () => {
  const state = fixture({ stock: [fish("local"), fish("transferred", { subTankId: "t2", siteId: "nanjing", basePrice: 999999 }), fish("hidden-batch", { batchId: "b2" }), fish("no-batch", { batchId: "" })] });
  assert.equal(metric(state).unsold.count, 2);
  const scoped = buildBatchStockValuations({ ...state, visibleSiteIds: ["nanjing"] });
  assert.equal(scoped.metrics.length, 1);
  assert.equal(scoped.metrics[0].unsold.estimatedSaleValue, 100.1);
  assert.equal(scoped.metrics[0].restrictedCount, 1);
  assert.equal(JSON.stringify(scoped).includes("999999"), false);
  assert.deepEqual(buildBatchStockValuations({ ...state, visibleSiteIds: [] }), { metrics: [] });
});

test("missing, zero, invalid or ambiguous prices remain visibly unpriced, never fallback to current loss price", () => {
  const state = fixture({ stock: [fish("missing", { productId: "missing" }), fish("zero", { priceMode: "manual", basePrice: 0 }), fish("invalid", { priceMode: "unknown" }), fish("loss", { lost: true, basePrice: undefined }), fish("manual", { productId: "missing", priceMode: "manual", basePrice: 0.3 })] });
  assert.deepEqual(metric(state).unsold, { count: 4, estimatedSaleValue: 0.3, unpricedCount: 3 });
  assert.deepEqual(metric(state).lost, { count: 1, estimatedSaleValue: 0, unpricedCount: 1 });
  const duplicated = fixture({ products: [{ id: "p1", defaultPrice: 100 }, { id: "p1", defaultPrice: 200 }], stock: [fish("a")] });
  assert.equal(metric(duplicated).unsold.unpricedCount, 1);
});

test("never reconstructs missing fish or merges unrelated missing catalog identities", () => {
  const state = fixture({ stock: [fish("x", { productId: "missing-a" }), fish("y", { productId: "missing-b" }), fish("z", { productId: "" }), fish("zz", { productId: "" }), fish("removed", { _removed: true })],
    lossRecords: [{ stockItemId: "not-retained" }], orders: [{ items: [{ stockItemId: "not-retained", batchId: "b1", price: 1000 }] }],
  });
  assert.equal(metric(state).unsold.count, 4);
  assert.equal(metric(state).bySpecies.length, 4);
  assert.equal(metric(state).lost.count, 0);
  assert.equal(metric(state).excludedCount, 1);
});

test("duplicate stock IDs are excluded once, ambiguous tanks are restricted, and cent totals are exact", () => {
  const state = fixture({ stock: [fish("dup"), fish("dup"), fish("missing-id", { id: "" }), fish("ambiguous", { subTankId: "conflict" }), ...Array.from({ length: 10 }, (_, i) => fish(`cent-${i}`, { priceMode: "manual", basePrice: 0.1 }))],
    tankGroups: [{ siteId: "nanjing", subTanks: [{ id: "conflict" }] }, { siteId: "jiangyin", subTanks: [{ id: "conflict" }] }],
  });
  const result = metric(state);
  assert.deepEqual(result.unsold, { count: 10, estimatedSaleValue: 1, unpricedCount: 0 });
  assert.equal(result.invalidStockCount, 2);
  assert.equal(result.restrictedCount, 1);
});
