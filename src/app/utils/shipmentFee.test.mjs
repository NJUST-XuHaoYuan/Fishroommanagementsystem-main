import assert from "node:assert/strict";
import test from "node:test";

import {
  actualShippingFeePayload,
  canApplyActualShippingFeeResponse,
  canUseActualShippingFeeApi,
  MAX_ACTUAL_SHIPPING_FEE,
  normalizedPositiveShippingFee,
  roundShippingFee,
} from "./shipmentFee.ts";

test("accepts cents but rejects an entered fee with more than two decimals", () => {
  assert.equal(normalizedPositiveShippingFee(58), 58);
  assert.equal(normalizedPositiveShippingFee(58.01), 58.01);
  assert.equal(normalizedPositiveShippingFee(58.005), null);
});

test("rejects values that round below one cent", () => {
  assert.equal(normalizedPositiveShippingFee(0.001), null);
  assert.equal(normalizedPositiveShippingFee(0), null);
  assert.equal(normalizedPositiveShippingFee(-1), null);
});

test("accepts the maximum fee and rejects any raw value above it", () => {
  assert.equal(normalizedPositiveShippingFee(MAX_ACTUAL_SHIPPING_FEE), MAX_ACTUAL_SHIPPING_FEE);
  assert.equal(normalizedPositiveShippingFee(MAX_ACTUAL_SHIPPING_FEE + 0.001), null);
  assert.equal(
    actualShippingFeePayload({ id: "shipment-limit" }, MAX_ACTUAL_SHIPPING_FEE + 0.001),
    null
  );
});

test("keeps a zero concurrency baseline and rejects non-numeric values", () => {
  assert.equal(roundShippingFee(0), 0);
  assert.equal(roundShippingFee("not-a-number"), null);
});

test("only enables the dedicated fee API for prepaid or free express shipments", () => {
  assert.equal(canUseActualShippingFeeApi({ shipMethod: "express" }, "prepaid"), true);
  assert.equal(canUseActualShippingFeeApi({ shipMethod: "express" }, "free"), true);
  assert.equal(canUseActualShippingFeeApi({ shipMethod: "express" }, "collect"), false);
  assert.equal(canUseActualShippingFeeApi({ shipMethod: "pickup" }, "prepaid"), false);
});

test("discards stale fee responses and responses for a removed shipment", () => {
  const shipments = [{ id: "shipment-1" }];
  assert.equal(canApplyActualShippingFeeResponse(shipments, "shipment-1", 2, 2), true);
  assert.equal(canApplyActualShippingFeeResponse(shipments, "shipment-1", 1, 2), false);
  assert.equal(canApplyActualShippingFeeResponse([], "shipment-1", 2, 2), false);
});

test("builds the dedicated API payload with the current fee as concurrency baseline", () => {
  assert.deepEqual(
    actualShippingFeePayload({ id: "shipment-1", actualShippingFee: 12.345 }, 58.01),
    {
      shipmentId: "shipment-1",
      actualShippingFee: 58.01,
      expectedActualShippingFee: 12.35,
    }
  );
  assert.equal(
    actualShippingFeePayload({ id: "shipment-too-precise", actualShippingFee: 12.34 }, 58.005),
    null
  );
  assert.deepEqual(
    actualShippingFeePayload({ id: "shipment-2" }, 58),
    {
      shipmentId: "shipment-2",
      actualShippingFee: 58,
      expectedActualShippingFee: 0,
    }
  );
});
