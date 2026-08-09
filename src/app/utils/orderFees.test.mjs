import assert from "node:assert/strict";
import test from "node:test";

import {
  getBillableShippingFee,
  hasActualShippingFee,
  orderHasPendingActualShippingFee,
  shippingFeeAdjustmentForOrder,
} from "./orderFees.ts";

const prepaidOrder = {
  id: "order-1",
  source: "私域线上",
  shippingFeeMode: "prepaid",
  shippingFee: 25,
};

test("prepaid shipping keeps the estimated charge until every actual fee is recorded", () => {
  const shipments = [
    { orderId: "order-1", status: "shipped", shipMethod: "express", actualShippingFee: 18 },
    { orderId: "order-1", status: "outbound", shipMethod: "express", actualShippingFee: 0 },
  ];

  assert.equal(orderHasPendingActualShippingFee(prepaidOrder, shipments), true);
  assert.equal(hasActualShippingFee(prepaidOrder, shipments), false);
  assert.equal(getBillableShippingFee(prepaidOrder, shipments), 25);
  assert.equal(shippingFeeAdjustmentForOrder(prepaidOrder, shipments), 0);
});

test("prepaid shipping switches to the actual total after all fees are recorded", () => {
  const shipments = [
    { orderId: "order-1", status: "shipped", shipMethod: "express", actualShippingFee: 18 },
    { orderId: "order-1", status: "delivered", shipMethod: "express", actualShippingFee: 12 },
  ];

  assert.equal(orderHasPendingActualShippingFee(prepaidOrder, shipments), false);
  assert.equal(hasActualShippingFee(prepaidOrder, shipments), true);
  assert.equal(getBillableShippingFee(prepaidOrder, shipments), 30);
  assert.equal(shippingFeeAdjustmentForOrder(prepaidOrder, shipments), 5);
});

test("collect shipping never requires or bills an actual fee", () => {
  const order = { ...prepaidOrder, shippingFeeMode: "collect", shippingFee: 0 };
  const shipments = [
    { orderId: "order-1", status: "shipped", shipMethod: "express", actualShippingFee: 0 },
  ];

  assert.equal(orderHasPendingActualShippingFee(order, shipments), false);
  assert.equal(getBillableShippingFee(order, shipments), 0);
});
