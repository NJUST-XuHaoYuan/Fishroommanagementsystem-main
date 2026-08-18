import test from "node:test";
import assert from "node:assert/strict";
import {
  activeShipmentInventoryAssignmentIsValid,
  assertActiveShipmentInventoryAssignment,
  assertShipmentInventoryIdentityUnchanged,
  inventoryProjectionForStock,
  projectedInventoryOutDateByStockId,
  projectedShippedOutStockIds,
  shipmentPatchRequiresAssignmentValidation,
} from "./shipment-inventory-integrity.mjs";

const currentShipment = {
  id: "shipment-1",
  orderId: "order-1",
  siteId: "nanjing",
  shipMethod: "pickup",
  status: "delivered",
  createdAt: "2026-08-18T10:00:00",
  itemStockIds: ["fish-1", "fish-2"],
};

const state = {
  orders: [{
    id: "order-1",
    siteId: "nanjing",
    items: [{ stockItemId: "fish-1" }, { stockItemId: "fish-2" }],
  }],
  stock: [{ id: "fish-1" }, { id: "fish-2" }],
};

test("ordinary shipment edits preserve inventory identity and assignment", () => {
  const edited = { ...currentShipment, notes: "客户已自取" };
  assert.doesNotThrow(() => assertShipmentInventoryIdentityUnchanged(currentShipment, edited));
  assert.doesNotThrow(() => assertActiveShipmentInventoryAssignment(edited, state));
});

for (const [label, patch] of [
  ["order", { orderId: "order-2" }],
  ["site", { siteId: "jiangyin" }],
  ["method", { shipMethod: "express" }],
  ["removed item list", { itemStockIds: undefined }],
  ["replaced item", { itemStockIds: ["fish-1", "fish-3"] }],
  ["appended item", { itemStockIds: ["fish-1", "fish-2", "fish-3"] }],
  ["creation time", { createdAt: "2026-08-18T11:00:00" }],
]) {
  test(`ordinary shipment edits reject changed ${label}`, () => {
    assert.throws(
      () => assertShipmentInventoryIdentityUnchanged(currentShipment, { ...currentShipment, ...patch }),
      /商品明细建立后不能通过普通编辑修改/,
    );
  });
}

test("legacy shipment site may only be backfilled from its order", () => {
  const legacy = { ...currentShipment, siteId: undefined };
  assert.doesNotThrow(() => assertShipmentInventoryIdentityUnchanged(
    legacy,
    { ...legacy, siteId: "nanjing" },
    { expectedSiteId: "nanjing" },
  ));
  assert.throws(
    () => assertShipmentInventoryIdentityUnchanged(
      legacy,
      { ...legacy, siteId: "jiangyin" },
      { expectedSiteId: "nanjing" },
    ),
    /商品明细建立后不能通过普通编辑修改/,
  );
});

test("active shipment assignment cannot be empty", () => {
  assert.throws(
    () => assertActiveShipmentInventoryAssignment({ ...currentShipment, itemStockIds: [] }, state),
    /必须保留商品明细/,
  );
});

test("active shipment assignment must be unique and belong to the order", () => {
  assert.throws(
    () => assertActiveShipmentInventoryAssignment({ ...currentShipment, itemStockIds: ["fish-1", "fish-1"] }, state),
    /不能在一张发货单中重复/,
  );
  assert.throws(
    () => assertActiveShipmentInventoryAssignment({ ...currentShipment, itemStockIds: ["fish-3"] }, {
      ...state,
      stock: [...state.stock, { id: "fish-3" }],
    }),
    /与关联订单不一致/,
  );
});

test("active shipment assignment must still resolve to inventory", () => {
  assert.throws(
    () => assertActiveShipmentInventoryAssignment(currentShipment, {
      ...state,
      stock: [{ id: "fish-1" }],
    }),
    /已不存在的库存记录/,
  );
});

test("active shipment site must match its order", () => {
  assert.throws(
    () => assertActiveShipmentInventoryAssignment({ ...currentShipment, siteId: "jiangyin" }, state),
    /场地与关联订单不一致/,
  );
});

test("preparing shipment may have no assigned inventory yet", () => {
  assert.doesNotThrow(() => assertActiveShipmentInventoryAssignment({
    id: "draft",
    orderId: "order-1",
    status: "preparing",
  }, state));
});

test("legacy invalid assignment can be detected without mutating it", () => {
  assert.equal(activeShipmentInventoryAssignmentIsValid({
    ...currentShipment,
    itemStockIds: [],
  }, state), false);
  assert.equal(activeShipmentInventoryAssignmentIsValid(currentShipment, state), true);
});

test("legacy invalid assignment allows same-status metadata edits but not status advancement", () => {
  const legacy = { ...currentShipment, status: "delivered", itemStockIds: [] };
  assert.equal(shipmentPatchRequiresAssignmentValidation(
    legacy,
    { ...legacy, notes: "metadata only" },
    state,
  ), false);
  assert.equal(shipmentPatchRequiresAssignmentValidation(
    { ...legacy, status: "outbound" },
    { ...legacy, status: "shipped" },
    state,
  ), true);
  assert.equal(shipmentPatchRequiresAssignmentValidation(
    currentShipment,
    { ...currentShipment, notes: "valid record remains strict" },
    state,
  ), true);
});

test("server inventory projection normalizes legacy ids across shipment and stock data", () => {
  const ids = projectedShippedOutStockIds({
    shipments: [{ status: "delivered", itemStockIds: [1001, " fish-2 "] }],
  });
  assert.deepEqual([...ids], ["1001", "fish-2"]);
});

test("server inventory projection only applies order fallback to completed orders", () => {
  const ids = projectedShippedOutStockIds({
    shipments: [{
      orderId: "damaged-order",
      status: "damaged",
      itemStockIds: ["fish-damaged"],
    }],
    orders: [
      {
        id: "damaged-order",
        status: "damaged",
        items: [{ stockItemId: "fish-damaged" }, { stockItemId: "fish-still-in-tank" }],
      },
      {
        id: "completed-order",
        status: "completed",
        items: [{ stockItemId: "fish-completed" }],
      },
    ],
  });
  assert.equal(ids.has("fish-damaged"), true);
  assert.equal(ids.has("fish-still-in-tank"), false);
  assert.equal(ids.has("fish-completed"), true);
});

test("global fulfillment projection is intersected with visible stock without leaking shipment data", () => {
  const fullState = {
    stock: [{ id: "nanjing-fish" }, { id: "other-fish" }],
    shipments: [{
      id: "cross-site-shipment",
      orderId: "other-site-order",
      status: "delivered",
      itemStockIds: ["nanjing-fish"],
      notes: "private cross-site detail",
    }],
  };
  const firstScope = inventoryProjectionForStock(fullState, [{ id: "nanjing-fish" }]);
  assert.deepEqual(firstScope, { outStockIds: ["nanjing-fish"], outDateByStockId: {} });

  const nestedScope = inventoryProjectionForStock({
    stock: [{ id: "nanjing-fish" }],
    shipments: [],
    orders: [],
    inventoryProjection: firstScope,
  }, undefined, { inheritProjection: true });
  assert.deepEqual(nestedScope, firstScope);
  assert.equal("shipments" in nestedScope, false);
});

test("raw persisted state cannot forge the transient fulfillment projection", () => {
  const raw = {
    stock: [{ id: "fish-in-tank" }],
    shipments: [],
    orders: [],
    inventoryProjection: {
      outStockIds: ["fish-in-tank"],
      outDateByStockId: { "fish-in-tank": "2026-08-01" },
    },
  };
  assert.deepEqual(inventoryProjectionForStock(raw), {
    outStockIds: [],
    outDateByStockId: {},
  });
  assert.deepEqual(
    inventoryProjectionForStock(raw, raw.stock, { inheritProjection: true }),
    raw.inventoryProjection,
  );
});

test("global projection carries the earliest outbound date for visible stock only", () => {
  const projection = inventoryProjectionForStock({
    stock: [{ id: "nanjing-fish" }, { id: "hidden-stock" }],
    shipments: [
      { status: "delivered", outboundDate: "2026-08-10", itemStockIds: ["nanjing-fish", "hidden-stock"] },
      { status: "delivered", shipDate: "2026-08-12", itemStockIds: ["nanjing-fish"] },
    ],
  }, [{ id: "nanjing-fish" }]);
  assert.deepEqual(projection, {
    outStockIds: ["nanjing-fish"],
    outDateByStockId: { "nanjing-fish": "2026-08-10" },
  });

  assert.deepEqual(
    [...projectedInventoryOutDateByStockId({
      shipments: [],
      inventoryProjection: projection,
    })],
    [["nanjing-fish", "2026-08-10"]],
  );
});

test("fresh projection moves a fish out immediately after outbound", () => {
  const state = {
    stock: [{ id: "fish-1" }],
    orders: [{
      id: "order-1",
      status: "shipped",
      items: [{ stockItemId: "fish-1" }],
    }],
    shipments: [],
  };
  assert.deepEqual(inventoryProjectionForStock(state), {
    outStockIds: [],
    outDateByStockId: {},
  });

  assert.deepEqual(inventoryProjectionForStock({
    ...state,
    shipments: [{
      id: "shipment-1",
      orderId: "order-1",
      status: "outbound",
      outboundDate: "2026-08-18",
      itemStockIds: ["fish-1"],
    }],
  }), {
    outStockIds: ["fish-1"],
    outDateByStockId: { "fish-1": "2026-08-18" },
  });
});

test("fresh projection returns a fish after its only shipment is cancelled", () => {
  const state = {
    stock: [{ id: "fish-1" }],
    orders: [{
      id: "order-1",
      status: "pending",
      items: [{ stockItemId: "fish-1" }],
    }],
    shipments: [{
      id: "shipment-1",
      orderId: "order-1",
      status: "shipped",
      shipDate: "2026-08-18",
      itemStockIds: ["fish-1"],
    }],
  };
  assert.deepEqual(inventoryProjectionForStock(state), {
    outStockIds: ["fish-1"],
    outDateByStockId: { "fish-1": "2026-08-18" },
  });

  assert.deepEqual(inventoryProjectionForStock({
    ...state,
    shipments: [],
  }), {
    outStockIds: [],
    outDateByStockId: {},
  });
});

test("cancelling one shipment keeps the fish out when another active shipment remains", () => {
  const state = {
    stock: [{ id: "fish-1" }],
    orders: [{
      id: "order-1",
      status: "shipped",
      items: [{ stockItemId: "fish-1" }],
    }],
    shipments: [
      {
        id: "cancelled-shipment",
        orderId: "order-1",
        status: "shipped",
        shipDate: "2026-08-17",
        itemStockIds: ["fish-1"],
      },
      {
        id: "remaining-shipment",
        orderId: "order-1",
        status: "delivered",
        shipDate: "2026-08-18",
        itemStockIds: ["fish-1"],
      },
    ],
  };

  assert.deepEqual(inventoryProjectionForStock({
    ...state,
    shipments: state.shipments.filter((shipment) => shipment.id !== "cancelled-shipment"),
  }), {
    outStockIds: ["fish-1"],
    outDateByStockId: { "fish-1": "2026-08-18" },
  });
});
