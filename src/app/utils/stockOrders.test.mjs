import test from "node:test";
import assert from "node:assert/strict";
import { linkedOrdersForStock, orderItemKeepsInventory } from "./stockOrders.ts";

test("finds active orders linked to a sold stock item", () => {
  const orders = [
    {
      id: "pending",
      orderNo: "SO-2026-1001",
      date: "2026-07-01",
      status: "pending",
      items: [{ stockItemId: "fish-1" }],
    },
    {
      id: "confirmed",
      orderNo: "SO-2026-1002",
      date: "2026-07-02",
      status: "confirmed",
      items: [{ stockItemId: "fish-1" }],
    },
  ];

  assert.deepEqual(
    linkedOrdersForStock(orders, "fish-1").map((order) => order.id),
    ["confirmed", "pending"],
  );
});

test("ignores cancelled orders and order items already detached from inventory", () => {
  const orders = [
    {
      id: "cancelled",
      date: "2026-07-03",
      status: "cancelled",
      items: [{ stockItemId: "fish-1" }],
    },
    {
      id: "removed",
      date: "2026-07-04",
      status: "pending",
      items: [{ stockItemId: "fish-1", inventoryRemovedAt: "2026-07-05T10:00:00Z" }],
    },
  ];

  assert.deepEqual(linkedOrdersForStock(orders, "fish-1"), []);
  assert.equal(orderItemKeepsInventory(orders[1].items[0]), false);
});

test("does not match another stock item", () => {
  const orders = [{
    id: "other",
    date: "2026-07-01",
    status: "pending",
    items: [{ stockItemId: "fish-2" }],
  }];

  assert.deepEqual(linkedOrdersForStock(orders, "fish-1"), []);
});
