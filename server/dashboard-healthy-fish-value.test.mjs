import assert from "node:assert/strict";
import test from "node:test";
import {
  HealthyFishInventoryValueError,
  healthyFishInventoryMetrics,
  isFishInventoryItem,
  stockEstimatedSalePriceCents,
} from "./dashboard-healthy-fish-value.mjs";

const fishSpecies = { id: "species-fish", category: "海水鱼", name: "法仙" };
const products = [
  { id: "product-fish", speciesId: fishSpecies.id, defaultPrice: 120 },
  { id: "product-coral", speciesId: "species-coral", defaultPrice: 500 },
];
const species = [fishSpecies, { id: "species-coral", category: "珊瑚", name: "纽扣珊瑚" }];

function metrics(stock, outStockIds = []) {
  return healthyFishInventoryMetrics({ stock, products, species, outStockIds });
}

test("healthy and feeding unsold fish use their per-fish selling prices", () => {
  assert.deepEqual(metrics([
    { id: "healthy", productId: "product-fish", status: "healthy", basePrice: 100.1 },
    { id: "feeding", productId: "product-fish", status: "feeding", basePrice: 80.2 },
  ]), { value: 180.3, count: 2, unpricedCount: 0 });
});

test("sick, sold-in-tank, lost and invalid-status rows are excluded", () => {
  assert.deepEqual(metrics([
    { id: "healthy", productId: "product-fish", status: "healthy", basePrice: 100 },
    { id: "sick", productId: "product-fish", status: "sick", basePrice: 200 },
    { id: "sold", productId: "product-fish", status: "healthy", sold: true, basePrice: 300 },
    { id: "lost", productId: "product-fish", status: "feeding", lost: true, basePrice: 400 },
    { id: "unknown", productId: "product-fish", status: "", basePrice: 500 },
  ]), { value: 100, count: 1, unpricedCount: 0 });
});

test("trusted cross-site inventory projection excludes fulfilled fish", () => {
  assert.deepEqual(metrics([
    { id: " nj-fish-fulfilled ", siteId: "nanjing", productId: "product-fish", status: "healthy", basePrice: 880 },
    { id: "nj-fish-live", siteId: "nanjing", productId: "product-fish", status: "healthy", basePrice: 220 },
  ], new Set(["nj-fish-fulfilled"])), { value: 220, count: 1, unpricedCount: 0 });
});

test("non-fish inventory is excluded while gobies remain fish", () => {
  assert.equal(isFishInventoryItem(
    { name: "黄守瓜虾虎" },
    { category: "虾虎鱼", name: "黄守瓜虾虎" }
  ), true);
  assert.deepEqual(metrics([
    { id: "fish", productId: "product-fish", status: "healthy", basePrice: 100 },
    { id: "coral", productId: "product-coral", status: "healthy", basePrice: 900 },
    { id: "orphan", productId: "missing-product", status: "healthy", basePrice: 999 },
  ]), { value: 100, count: 1, unpricedCount: 0 });
});

test("invalid per-fish price falls back to a positive product default", () => {
  for (const invalidPrice of [undefined, null, "", 0, -1, "invalid", true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, 1e308]) {
    assert.equal(stockEstimatedSalePriceCents({ basePrice: invalidPrice }, { defaultPrice: 123.45 }), 12345);
  }
  assert.equal(stockEstimatedSalePriceCents({ basePrice: 1e308 }, { defaultPrice: 1e308 }), 0);
});

test("missing or invalid per-fish and product prices contribute zero and are reported", () => {
  assert.deepEqual(healthyFishInventoryMetrics({
    stock: [
      { id: "unpriced-a", productId: "invalid-default-a", status: "healthy", basePrice: 0 },
      { id: "unpriced-b", productId: "invalid-default-b", status: "feeding", basePrice: "nope" },
    ],
    products: [
      { id: "invalid-default-a", speciesId: fishSpecies.id, defaultPrice: -50 },
      { id: "invalid-default-b", speciesId: fishSpecies.id, defaultPrice: Number.POSITIVE_INFINITY },
    ],
    species,
  }), { value: 0, count: 2, unpricedCount: 2 });
});

test("money is summed in integer cents and duplicate stock ids cannot inflate value", () => {
  assert.deepEqual(metrics([
    { id: "one", productId: "product-fish", status: "healthy", basePrice: 0.1 },
    { id: "two", productId: "product-fish", status: "healthy", basePrice: 0.2 },
    { id: "two", productId: "product-fish", status: "healthy", basePrice: 999 },
    { id: "rounded", productId: "product-fish", status: "feeding", basePrice: 1.005 },
  ]), { value: 1.31, count: 3, unpricedCount: 0 });
});

test("aggregate values fail closed before integer-cent precision is lost", () => {
  assert.throws(() => metrics([
    { id: "huge-a", productId: "product-fish", status: "healthy", basePrice: 40_000_000_000_000 },
    { id: "huge-b", productId: "product-fish", status: "healthy", basePrice: 40_000_000_000_000 },
    { id: "huge-c", productId: "product-fish", status: "healthy", basePrice: 40_000_000_000_000 },
  ]), (error) => {
    assert.equal(error instanceof HealthyFishInventoryValueError, true);
    assert.equal(error.code, "HEALTHY_FISH_VALUE_OVERFLOW");
    return true;
  });
});

test("account and site scoped stock input cannot count rows outside the authorized slice", () => {
  const alreadyScopedStock = [
    { id: "nanjing", siteId: "nanjing", productId: "product-fish", status: "healthy", basePrice: 188 },
  ];
  assert.deepEqual(metrics(alreadyScopedStock), { value: 188, count: 1, unpricedCount: 0 });
});
