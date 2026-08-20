import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderShipmentMutationTargetError,
  resolveUniqueOrderMutationTarget,
  resolveUniqueShipmentMutationTarget,
} from "./order-shipment-mutation-targets.mjs";

function stateFixture() {
  return {
    orders: [
      { id: "order-nj", siteId: "nanjing", orderNo: "SO-NJ" },
      { id: "order-jy", siteId: "jiangyin", orderNo: "SO-JY" },
    ],
    shipments: [
      { id: "shipment-nj", orderId: "order-nj", siteId: "forged-site" },
      { id: "shipment-jy", orderId: "order-jy", siteId: "jiangyin" },
    ],
  };
}

function assertTargetError(fn, { statusCode, code }) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof OrderShipmentMutationTargetError, true);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test("resolves exactly one order and exposes its authoritative stored site", () => {
  const state = stateFixture();
  const target = resolveUniqueOrderMutationTarget(state, " order-nj ");
  assert.equal(target.order, state.orders[0]);
  assert.equal(target.siteId, "nanjing");
  assert.equal(target.orders, state.orders);
});

test("fails closed for a duplicate order id even when copies belong to different sites", () => {
  const state = stateFixture();
  state.orders.push({ ...state.orders[0], siteId: "jiangyin" });
  assertTargetError(() => resolveUniqueOrderMutationTarget(state, "order-nj"), {
    statusCode: 409,
    code: "ORDER_ID_NOT_UNIQUE",
  });
});

test("reports missing order ids without selecting a fallback record", () => {
  assertTargetError(() => resolveUniqueOrderMutationTarget(stateFixture(), ""), {
    statusCode: 400,
    code: "ORDER_ID_REQUIRED",
  });
  assertTargetError(() => resolveUniqueOrderMutationTarget(stateFixture(), "missing"), {
    statusCode: 404,
    code: "ORDER_NOT_FOUND",
  });
});

test("resolves a shipment and authorizes from its unique related order, not shipment.siteId", () => {
  const state = stateFixture();
  const target = resolveUniqueShipmentMutationTarget(state, "shipment-nj");
  assert.equal(target.shipment, state.shipments[0]);
  assert.equal(target.order, state.orders[0]);
  assert.equal(target.siteId, "nanjing");
});

test("fails closed for duplicate shipment ids across sites", () => {
  const state = stateFixture();
  state.shipments.push({ ...state.shipments[0], orderId: "order-jy", siteId: "jiangyin" });
  assertTargetError(() => resolveUniqueShipmentMutationTarget(state, "shipment-nj"), {
    statusCode: 409,
    code: "SHIPMENT_ID_NOT_UNIQUE",
  });
});

test("fails closed when a shipment related order id is duplicated across sites", () => {
  const state = stateFixture();
  state.orders.push({ ...state.orders[0], siteId: "jiangyin" });
  assertTargetError(() => resolveUniqueShipmentMutationTarget(state, "shipment-nj"), {
    statusCode: 409,
    code: "ORDER_ID_NOT_UNIQUE",
  });
});

test("fails closed when the shipment has no unique related order", () => {
  const state = stateFixture();
  state.shipments[0] = { ...state.shipments[0], orderId: "missing" };
  assertTargetError(() => resolveUniqueShipmentMutationTarget(state, "shipment-nj"), {
    statusCode: 404,
    code: "ORDER_NOT_FOUND",
  });
});
