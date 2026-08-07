import test from "node:test";
import assert from "node:assert/strict";
import {
  orderItemMinimumReturnFloor,
  orderMinimumReturnFloorTotal,
  sickMinimumReturnExemption,
} from "./order-pricing-rules.mjs";

test("healthy fish keep their configured minimum-return floor", () => {
  assert.equal(sickMinimumReturnExemption({ status: "healthy" }), false);
  assert.equal(orderItemMinimumReturnFloor({ minReturnPrice: 180 }), 180);
});

test("sick fish are exempt from the minimum-return floor", () => {
  assert.equal(sickMinimumReturnExemption({ status: "sick" }), true);
  assert.equal(orderItemMinimumReturnFloor({ minReturnPrice: 180, minReturnPriceExempt: true }), 0);
  assert.equal(orderMinimumReturnFloorTotal([
    { minReturnPrice: 180, minReturnPriceExempt: true },
    { minReturnPrice: 100 },
  ]), 100);
});

test("a saved sick-fish exemption remains valid after the stock status changes", () => {
  assert.equal(sickMinimumReturnExemption(
    { status: "healthy" },
    { minReturnPriceExempt: true, minReturnPriceExemptReason: "sick" }
  ), true);
});
