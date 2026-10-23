import assert from "node:assert/strict";
import test from "node:test";
import {
  actualShippingFeeRequiredAtOutbound,
  requiredShipMethodForOrderSource,
  shipmentHasPendingActualShippingFee,
  shipmentsHavePendingActualShippingFee,
} from "./shipment-rules.mjs";

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

test("prepaid and free shipping can both leave the actual fee pending at outbound", () => {
  assert.equal(actualShippingFeeRequiredAtOutbound("prepaid"), false);
  assert.equal(actualShippingFeeRequiredAtOutbound("free"), false);
  assert.equal(actualShippingFeeRequiredAtOutbound("collect"), false);
});

test("active prepaid and free express shipments remain pending until a positive actual fee is recorded", () => {
  for (const mode of ["prepaid", "free"]) {
    assert.equal(shipmentHasPendingActualShippingFee(mode, {
      status: "outbound",
      shipMethod: "express",
      actualShippingFee: 0,
    }), true);
  }
  assert.equal(shipmentHasPendingActualShippingFee("prepaid", {
    status: "shipped",
    shipMethod: "express",
    actualShippingFee: 18.5,
  }), false);
  assert.equal(shipmentHasPendingActualShippingFee("prepaid", {
    status: "preparing",
    shipMethod: "express",
    actualShippingFee: 0,
  }), false);
  assert.equal(shipmentHasPendingActualShippingFee("prepaid", {
    status: "delivered",
    shipMethod: "pickup",
    actualShippingFee: 0,
  }), false);
  assert.equal(shipmentHasPendingActualShippingFee("collect", {
    status: "delivered",
    shipMethod: "express",
    actualShippingFee: 0,
  }), false);
});

test("pending fee detection covers every active shipment in an order", () => {
  assert.equal(shipmentsHavePendingActualShippingFee("prepaid", [
    { status: "shipped", shipMethod: "express", actualShippingFee: 20 },
    { status: "outbound", shipMethod: "express", actualShippingFee: 0 },
  ]), true);
  assert.equal(shipmentsHavePendingActualShippingFee("prepaid", [
    { status: "shipped", shipMethod: "express", actualShippingFee: 20 },
    { status: "delivered", shipMethod: "express", actualShippingFee: 12 },
  ]), false);
});
