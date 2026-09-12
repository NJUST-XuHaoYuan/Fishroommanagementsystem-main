import test from "node:test";
import assert from "node:assert/strict";
import { batchPrice, batchRecordDate, batchSaleLabel } from "./batchDetailDisplay.ts";

test("historical prices distinguish unknown from a zero price", () => {
  assert.equal(batchPrice(null), "价格未记录");
  assert.equal(batchPrice(undefined), "价格未记录");
  assert.equal(batchPrice(NaN), "价格未记录");
  assert.equal(batchPrice(0), "¥0.00");
  assert.equal(batchPrice(1234.5), "¥1,234.50");
});
test("dates retain date-only precision and display timestamp in China timezone", () => {
  assert.equal(batchRecordDate(null), "未记录");
  assert.equal(batchRecordDate("2026-09-12"), "2026-09-12");
  assert.equal(batchRecordDate("2026-09-12T15:00:00Z"), "2026/09/12 23:00:00");
  assert.equal(batchRecordDate("2026-09-12 15:00:00"), "2026/09/12 15:00:00");
});
test("replacement and cancelled orders are not labelled new completed sales", () => {
  assert.equal(batchSaleLabel({ kind: "replacement", status: "completed" }), "补发关联");
  assert.equal(batchSaleLabel({ kind: "originalReplaced", status: "completed" }), "原鱼订单（已补发）");
  assert.equal(batchSaleLabel({ kind: "sale", status: "cancelled" }), "已取消订单");
});
