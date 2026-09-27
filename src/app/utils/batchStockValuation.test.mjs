import test from "node:test";
import assert from "node:assert/strict";
import { batchValuationDisplay } from "./batchStockValuation.ts";

test("batch valuation does not render unavailable data or wholly unpriced fish as zero", () => {
  assert.equal(batchValuationDisplay(undefined).amount, "—");
  assert.deepEqual(batchValuationDisplay({ count: 3, estimatedSaleValue: 0, unpricedCount: 3 }), {
    amount: "暂无可估价", quantity: "3 条", note: "3 条缺少售价", partial: true,
  });
});

test("batch valuation distinguishes an empty group and a known zero price from missing prices", () => {
  assert.equal(batchValuationDisplay({ count: 0, estimatedSaleValue: 0, unpricedCount: 0 }).amount, "¥0.00");
  assert.deepEqual(batchValuationDisplay({ count: 1, estimatedSaleValue: 0, unpricedCount: 0 }), {
    amount: "¥0.00", quantity: "1 条", note: "", partial: false,
  });
});

test("batch valuation marks a partially priced subtotal and keeps its full quantity", () => {
  assert.deepEqual(batchValuationDisplay({ count: 10, estimatedSaleValue: 1234.5, unpricedCount: 2 }), {
    amount: "¥1,234.50", quantity: "10 条", note: "部分合计 · 2 条缺少售价", partial: true,
  });
});

test("batch valuation does not conceal an invalid backend amount as zero", () => {
  for (const amount of [NaN, Infinity, -1]) {
    assert.equal(batchValuationDisplay({ count: 2, estimatedSaleValue: amount, unpricedCount: 0 }).amount, "—");
  }
});
