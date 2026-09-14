import assert from "node:assert/strict";
import test from "node:test";
import { buildStockPriceDetailsPatch, isStockSpecialPrice, newStockPriceMode, stockPriceMode, stockPriceModeLabel, stockSalePrice } from "./stockPricing.ts";

const product = { defaultPrice: 100 };

test("explicit source survives equal prices and future product price changes", () => {
  for (const priceMode of ["product", "manual", "legacy"]) {
    assert.equal(stockPriceMode({ basePrice: 100, priceMode }, product), priceMode);
    assert.equal(stockPriceMode({ basePrice: 100, priceMode }, { defaultPrice: 200 }), priceMode);
  }
});

test("unmarked legacy stock follows only an equal positive price without manual override", () => {
  assert.equal(stockPriceMode({ basePrice: 100 }, product), "product");
  assert.equal(stockPriceMode({ basePrice: 100, priceOverridden: false }, product), "product");
  assert.equal(stockPriceMode({ basePrice: 100, priceOverridden: true }, product), "manual");
  assert.equal(stockPriceMode({ basePrice: 80 }, product), "legacy");
  assert.equal(stockPriceMode({ basePrice: 0 }, product), "legacy");
  assert.equal(stockPriceMode({ basePrice: 100 }), "legacy");
  assert.equal(stockPriceMode({ basePrice: 1.005 }, { defaultPrice: 1.01 }), "product");
  assert.equal(stockPriceMode({ basePrice: Number.MAX_VALUE }, { defaultPrice: Number.MAX_VALUE }), "legacy");
});

test("untouched maintenance omits pricing fields even with stale draft price or historical null mode", () => {
  for (const original of [{ basePrice: 100 }, { basePrice: 100, priceMode: "product" }, { basePrice: 70, priceMode: "legacy" }]) {
    assert.deepEqual(buildStockPriceDetailsPatch(original, { changed: false, mode: "legacy", price: 999 }), { details: {}, expectedDetails: {} });
  }
});

test("explicit source choice includes original persisted CAS price and never manufactures undefined mode", () => {
  assert.deepEqual(buildStockPriceDetailsPatch({ basePrice: 80 }, { changed: true, mode: "product", price: 100 }), {
    details: { basePrice: 100, priceMode: "product" }, expectedDetails: { basePrice: 80 },
  });
  assert.deepEqual(buildStockPriceDetailsPatch({ basePrice: 100, priceMode: "product" }, { changed: true, mode: "manual", price: 100 }), {
    details: { basePrice: 100, priceMode: "manual" }, expectedDetails: { basePrice: 100, priceMode: "product" },
  });
  assert.deepEqual(buildStockPriceDetailsPatch({ basePrice: 80, priceMode: "legacy" }, { changed: true, mode: "manual", price: 80 }), {
    details: { basePrice: 80, priceMode: "manual" }, expectedDetails: { basePrice: 80, priceMode: "legacy" },
  });
});

test("invalid edited prices and attempts to write legacy are rejected", () => {
  for (const price of [0, 0.001, -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => buildStockPriceDetailsPatch({ basePrice: 80 }, { changed: true, mode: "manual", price }));
  }
  assert.throws(() => buildStockPriceDetailsPatch({ basePrice: 80 }, { changed: true, mode: "legacy", price: 80 }));
});

test("new stock and restored additions retain manual prices, including a manually entered equal price", () => {
  assert.equal(newStockPriceMode({ basePrice: 100, priceMode: "product" }, product), "product");
  assert.equal(newStockPriceMode({ basePrice: 100, priceMode: "manual" }, product), "manual");
  assert.equal(newStockPriceMode({ basePrice: 80 }, product), "manual");
  assert.equal(newStockPriceMode({ basePrice: 80, priceMode: "legacy" }, product), "manual");
});

test("effective sale price remains the persisted price and explicit manual source owns the special-price badge", () => {
  assert.equal(stockSalePrice({ basePrice: 80, priceMode: "product" }, product), 80);
  assert.equal(isStockSpecialPrice({ basePrice: 100, priceMode: "manual", priceOverridden: false }, product), true);
  assert.equal(isStockSpecialPrice({ basePrice: 100, priceMode: "product", priceOverridden: true }, product), false);
  assert.equal(isStockSpecialPrice({ basePrice: 80, priceOverridden: true }, product), true);
  assert.deepEqual(["product", "manual", "legacy"].map(stockPriceModeLabel), ["跟随商品价", "单独定价", "历史价格待确认"]);
});
