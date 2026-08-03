import assert from "node:assert/strict";
import test from "node:test";
import { requiredShipMethodForOrderSource } from "./shipment-rules.mjs";

test("offline pickup orders require pickup", () => {
  assert.equal(requiredShipMethodForOrderSource("线下"), "pickup");
  assert.equal(requiredShipMethodForOrderSource("线下自提"), "pickup");
});

test("marketplace and private-domain orders require express shipping", () => {
  for (const source of ["平台下单", "闲鱼平台", "微拍堂平台"]) {
    assert.equal(requiredShipMethodForOrderSource(source), "express");
  }
  assert.equal(requiredShipMethodForOrderSource("私域线上"), "express");
});

test("legacy non-pickup sources default to express shipping", () => {
  assert.equal(requiredShipMethodForOrderSource("微信"), "express");
  assert.equal(requiredShipMethodForOrderSource(""), "express");
});
