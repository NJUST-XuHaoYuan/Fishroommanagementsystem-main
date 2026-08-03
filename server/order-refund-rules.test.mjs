import assert from "node:assert/strict";
import test from "node:test";
import {
  orderHasActuallyShipped,
  shipmentHasActuallyShipped,
} from "./order-refund-rules.mjs";

test("preparing and outbound shipments remain eligible for ordinary refunds", () => {
  assert.equal(shipmentHasActuallyShipped({ status: "preparing" }), false);
  assert.equal(shipmentHasActuallyShipped({ status: "outbound" }), false);
});

test("shipped, delivered, and damaged shipments require damage refunds", () => {
  assert.equal(shipmentHasActuallyShipped({ status: "shipped" }), true);
  assert.equal(shipmentHasActuallyShipped({ status: "delivered" }), true);
  assert.equal(shipmentHasActuallyShipped({ status: "damaged" }), true);
});

test("legacy shipped timestamps also block ordinary refunds", () => {
  assert.equal(shipmentHasActuallyShipped({ status: "outbound", shippedAt: "2026-08-03 12:30" }), true);
});

test("completed pickups count as actually shipped", () => {
  assert.equal(shipmentHasActuallyShipped({ status: "outbound", shipMethod: "pickup" }), true);
});

test("order shipment checks only consider the requested order", () => {
  const shipments = [
    { orderId: "order-a", status: "outbound" },
    { orderId: "order-b", status: "shipped" },
  ];
  assert.equal(orderHasActuallyShipped(shipments, "order-a"), false);
  assert.equal(orderHasActuallyShipped(shipments, "order-b"), true);
  assert.equal(orderHasActuallyShipped(shipments, ""), false);
});
