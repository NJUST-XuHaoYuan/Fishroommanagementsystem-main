import test from "node:test";
import assert from "node:assert/strict";
import {
  getInventoryOutStockIds,
  getInventoryHiddenStockIds,
  getShippedOutStockIds,
  isPhysicallyInTank,
  isVisibleInStockInventory,
} from "./inventory.ts";

test("safe server projection hides cross-site fulfilled stock without shipment details", () => {
  const hiddenIds = getInventoryOutStockIds({
    shipments: [],
    orders: [],
    inventoryProjection: { outStockIds: [" nanjing-fish "] },
  });

  assert.equal(hiddenIds.has("nanjing-fish"), true);
  assert.equal(isVisibleInStockInventory({ id: "nanjing-fish" }, hiddenIds), false);
  assert.equal(isPhysicallyInTank({ id: "nanjing-fish" }, hiddenIds), false);
});

test("delivered pickup stock is excluded from every inventory projection", () => {
  const shipments = [{
    id: "pickup-1",
    orderId: "order-1",
    shipMethod: "pickup",
    status: "delivered",
    itemStockIds: ["fish-1"],
  }];
  const shippedIds = getShippedOutStockIds(shipments);
  const hiddenIds = getInventoryHiddenStockIds(shipments, []);

  assert.deepEqual([...shippedIds], ["fish-1"]);
  assert.equal(isPhysicallyInTank({ id: "fish-1" }, shippedIds), false);
  assert.equal(isVisibleInStockInventory({ id: "fish-1" }, hiddenIds), false);
});

test("legacy numeric stock ids match the string ids stored by shipment APIs", () => {
  const shipments = [{
    id: "pickup-legacy",
    orderId: "order-legacy",
    shipMethod: "pickup",
    status: "delivered",
    itemStockIds: [1001],
  }];
  const shippedIds = getShippedOutStockIds(shipments);
  const hiddenIds = getInventoryHiddenStockIds(shipments, []);

  assert.equal(shippedIds.has("1001"), true);
  assert.equal(isPhysicallyInTank({ id: 1001 }, shippedIds), false);
  assert.equal(isVisibleInStockInventory({ id: 1001 }, hiddenIds), false);
});

test("shipped orders with shipment detail only hide explicitly fulfilled fish", () => {
  const shipments = [{
    id: "pickup-partial",
    orderId: 2001,
    shipMethod: "pickup",
    status: "delivered",
    itemStockIds: ["fish-picked-up"],
  }];
  const orders = [{
    id: "2001",
    status: "shipped",
    items: [
      { stockItemId: "fish-picked-up" },
      { stockItemId: "fish-added-later" },
    ],
  }];

  const hiddenIds = getInventoryHiddenStockIds(shipments, orders);
  assert.equal(hiddenIds.has("fish-picked-up"), true);
  assert.equal(hiddenIds.has("fish-added-later"), false);
});

test("partial damaged orders keep the unshipped fish in physical inventory", () => {
  const shipments = [{
    id: "damaged-partial",
    orderId: "order-damaged",
    shipMethod: "express",
    status: "damaged",
    damageResolution: "refund",
    itemStockIds: ["fish-damaged"],
  }];
  const orders = [{
    id: "order-damaged",
    status: "damaged",
    items: [
      { stockItemId: "fish-damaged" },
      { stockItemId: "fish-not-shipped" },
    ],
  }];

  const hiddenIds = getInventoryHiddenStockIds(shipments, orders);
  assert.equal(hiddenIds.has("fish-damaged"), true);
  assert.equal(hiddenIds.has("fish-not-shipped"), false);
});

test("shipped orders without item-level shipment evidence remain visible for audit", () => {
  const hiddenIds = getInventoryHiddenStockIds([], [{
    id: "ambiguous-legacy-order",
    status: "shipped",
    items: [{ stockItemId: "fish-without-shipment-evidence" }],
  }]);

  assert.equal(hiddenIds.has("fish-without-shipment-evidence"), false);
});

test("completed orders remain a safe fallback when legacy shipment detail is absent", () => {
  const hiddenIds = getInventoryHiddenStockIds([], [{
    id: "completed-order",
    status: "completed",
    items: [
      { stockItemId: 3001 },
      { stockItemId: "removed", inventoryRemovedAt: "2026-08-18T12:00:00" },
    ],
  }]);

  assert.equal(hiddenIds.has("3001"), true);
  assert.equal(hiddenIds.has("removed"), false);
});
