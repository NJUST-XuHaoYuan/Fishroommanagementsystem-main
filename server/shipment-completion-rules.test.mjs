import test from "node:test";
import assert from "node:assert/strict";

import {
  countsAsCompletionShipment,
  shipmentIsResolvedForCompletion,
} from "./shipment-completion-rules.mjs";

test("a handled reship shipment keeps undamaged fish in the fulfillment history", () => {
  const shipment = { status: "damaged", damageResolution: "reship" };
  assert.equal(countsAsCompletionShipment(shipment), true);
  assert.equal(shipmentIsResolvedForCompletion(shipment), true);
});

test("preparing and in-transit shipments are not complete", () => {
  assert.equal(countsAsCompletionShipment({ status: "preparing" }), false);
  assert.equal(shipmentIsResolvedForCompletion({ status: "shipped" }), false);
});
