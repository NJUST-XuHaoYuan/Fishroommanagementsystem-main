import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_FORM_SCHEMA_VERSION,
  normalizeLegacyDouyinOrderRequest,
} from "./order-source-compat.mjs";

test("uses notes as the Douyin order number for the legacy order form", () => {
  const result = normalizeLegacyDouyinOrderRequest({
    source: "平台下单",
    notes: "DY-LEGACY-001",
  });

  assert.equal(result.douyinOrderNo, "DY-LEGACY-001");
});

test("keeps the explicit Douyin order number", () => {
  const result = normalizeLegacyDouyinOrderRequest({
    source: "平台下单",
    douyinOrderNo: "DY-EXPLICIT-001",
    notes: "ordinary note",
  });

  assert.equal(result.douyinOrderNo, "DY-EXPLICIT-001");
});

test("does not reinterpret notes from the current order form", () => {
  const result = normalizeLegacyDouyinOrderRequest({
    source: "平台下单",
    orderFormSchemaVersion: ORDER_FORM_SCHEMA_VERSION,
    notes: "ordinary note",
  });

  assert.equal(result.douyinOrderNo, undefined);
});

test("does not reinterpret notes for other order sources", () => {
  const result = normalizeLegacyDouyinOrderRequest({
    source: "私域线上",
    notes: "ordinary note",
  });

  assert.equal(result.douyinOrderNo, undefined);
});
