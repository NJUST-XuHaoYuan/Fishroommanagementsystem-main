import assert from "node:assert/strict";
import test from "node:test";
import { lossPricingSnapshot, normalizeLossPrice, planLossPriceUpdate } from "./stock-loss-price.mjs";

const fish = { id: "dead-fish", lost: true, basePrice: 100, priceMode: "product", priceOverridden: false, siteId: "nanjing" };
const input = (overrides = {}) => ({ stockItemId: fish.id, basePrice: "125.50", expectedPricing: lossPricingSnapshot(fish), ...overrides });

test("loss prices accept exact positive decimal amounts without rounding", () => {
  for (const [value, expected] of [[1, 1], [0.01, 0.01], [123.45, 123.45], ["123.40", 123.4], [" 9.99 ", 9.99]]) {
    assert.equal(normalizeLossPrice(value), expected);
  }
  for (const value of [null, undefined, true, false, [], {}, "", " ", 0, -1, -0.01, "-0.01", NaN, Infinity,
    "NaN", "Infinity", "0.001", 1.001, "100.000", "1e2", "0x10", "+1", "1,000", 1e100, "90071992547409.92", "90071992547409.91"]) {
    assert.throws(() => normalizeLossPrice(value), { code: "LOSS_PRICE_INVALID" }, String(value));
  }
});

test("only the three existing pricing fields change and caller-supplied business fields are ignored", () => {
  const state = [structuredClone(fish), { id: "other", lost: false }];
  const before = structuredClone(state);
  const result = planLossPriceUpdate(state, input({ lost: false, siteId: "jiangyin", sold: true, orders: [] }));
  assert.deepEqual(state, before);
  assert.deepEqual(result.updated, { ...fish, basePrice: 125.5, priceMode: "manual", priceOverridden: true });
  assert.equal(result.unchanged, false);
  assert.equal(planLossPriceUpdate([result.updated], input({ basePrice: 125.5, expectedPricing: lossPricingSnapshot(result.updated) })).unchanged, true);
});

test("CAS preserves raw types and requires all three snapshot fields, with legacy omissions represented by null", () => {
  assert.deepEqual(lossPricingSnapshot({}), { basePrice: null, priceMode: null, priceOverridden: null });
  const legacy = { id: fish.id, lost: true };
  assert.equal(planLossPriceUpdate([legacy], input({ expectedPricing: lossPricingSnapshot(legacy) })).updated.basePrice, 125.5);
  for (const expectedPricing of [undefined, null, [], {}, { basePrice: 100, priceMode: "product" },
    { ...lossPricingSnapshot(fish), basePrice: "100" }, { ...lossPricingSnapshot(fish), priceMode: "manual" },
    { ...lossPricingSnapshot(fish), priceOverridden: null }]) {
    assert.throws(() => planLossPriceUpdate([fish], input({ expectedPricing })), { code: "LOSS_PRICE_STALE" });
  }
});

test("absent, duplicate and non-lost fish are rejected, including truthy malformed loss flags", () => {
  assert.throws(() => planLossPriceUpdate([], input()), { statusCode: 404 });
  assert.throws(() => planLossPriceUpdate([fish, fish], input()), { code: "LOSS_STOCK_AMBIGUOUS" });
  assert.throws(() => planLossPriceUpdate([fish], input({ stockItemId: 1 })), { code: "LOSS_STOCK_ID_REQUIRED" });
  for (const lost of [false, undefined, 1, "true"]) {
    assert.throws(() => planLossPriceUpdate([{ ...fish, lost }], input()), { code: "LOSS_STOCK_NOT_LOST" });
  }
});
