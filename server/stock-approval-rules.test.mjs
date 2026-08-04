import assert from "node:assert/strict";
import test from "node:test";
import {
  batchRequiresLateStockApproval,
  buildStockChangeSnapshot,
  buildStockDeletionSnapshot,
  classifyStockMutationForApproval,
  preserveBatchCreationTimes,
  stockChangeAdjustmentSignature,
  STOCK_BATCH_APPROVAL_DELAY_MS,
} from "./stock-approval-rules.mjs";

test("stock change approvals group exact deltas by tank, product and batch", () => {
  const snapshot = buildStockChangeSnapshot({
    stock: [{
      id: "stock-remove",
      productId: "product-1",
      batchId: "batch-1",
      subTankId: "tank-1",
      status: "healthy",
      inDate: "2026-07-30",
      basePrice: 260,
    }],
    upsertItems: [
      { id: "stock-add-1", productId: "product-1", batchId: "batch-1", subTankId: "tank-2", status: "healthy", inDate: "2026-07-30", basePrice: 260 },
      { id: "stock-add-2", productId: "product-1", batchId: "batch-1", subTankId: "tank-2", status: "healthy", inDate: "2026-07-30", basePrice: 260 },
    ],
    deleteIds: ["stock-remove"],
    products: [{ id: "product-1", speciesId: "species-1", name: "蓝吊", origin: "印尼", size: "7-8" }],
    species: [{ id: "species-1", name: "蓝点吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-2026-030", arrivalDate: "2026-07-30", supplier: "供应商A" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }, { id: "tank-2", name: "D1-2" }] }],
  });

  assert.deepEqual(snapshot.totals, { addCount: 2, removeCount: 1, updateCount: 0 });
  assert.equal(snapshot.tanks.length, 2);
  assert.equal(snapshot.tanks.find((tank) => tank.subTankId === "tank-1")?.removeCount, 1);
  assert.equal(snapshot.tanks.find((tank) => tank.subTankId === "tank-2")?.addCount, 2);
  assert.deepEqual(snapshot.batches[0], {
    batchId: "batch-1",
    batchNo: "PO-2026-030",
    batchDate: "2026-07-30",
    supplier: "供应商A",
    origins: ["印尼"],
    addCount: 2,
    removeCount: 1,
    updateCount: 0,
  });
  assert.equal(snapshot.tanks[1].rows[0].origin, "印尼");
});

test("inventory adjustment signatures ignore generated stock ids", () => {
  const input = {
    stock: [{ id: "remove-a", productId: "product-1", batchId: "batch-1", subTankId: "tank-1" }],
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }, { id: "tank-2", name: "D1-2" }] }],
  };
  const first = buildStockChangeSnapshot({
    ...input,
    deleteIds: ["remove-a"],
    upsertItems: [{ id: "generated-a", productId: "product-1", batchId: "batch-1", subTankId: "tank-2" }],
  });
  const second = buildStockChangeSnapshot({
    ...input,
    deleteIds: ["remove-a"],
    upsertItems: [{ id: "generated-b", productId: "product-1", batchId: "batch-1", subTankId: "tank-2" }],
  });

  assert.deepEqual(stockChangeAdjustmentSignature(first), stockChangeAdjustmentSignature(second));
});

test("stock deletion approvals preserve complete inventory details", () => {
  const snapshot = buildStockDeletionSnapshot({
    deleteIds: ["stock-1", "stock-missing", "stock-1"],
    stock: [{
      id: "stock-1",
      code: "D1-2-035",
      productId: "product-1",
      batchId: "batch-1",
      subTankId: "tank-1",
      siteId: "nanjing",
      inDate: "2026-07-30",
      status: "sick",
      sold: true,
      basePrice: 260,
      notes: "观察中",
    }],
    products: [{
      id: "product-1",
      speciesId: "species-1",
      name: "蓝吊",
      size: "7-8",
      origin: "印尼",
      imageUrl: "https://example.com/blue-tang.jpg",
    }],
    species: [{ id: "species-1", name: "蓝点吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-2026-030", supplier: "供应商A" }],
    tankGroups: [{ id: "group-1", name: "鱼D 1800", subTanks: [{ id: "tank-1", name: "D1-2" }] }],
    orders: [{
      id: "order-1",
      orderNo: "SO-2026-1888",
      status: "pending",
      source: "私域线上",
      items: [{ stockItemId: "stock-1" }],
    }],
  });

  assert.equal(snapshot.requestedCount, 2);
  assert.equal(snapshot.availableCount, 1);
  assert.deepEqual(snapshot.items[0], {
    stockItemId: "stock-1",
    code: "D1-2-035",
    productName: "蓝吊",
    speciesName: "蓝点吊",
    size: "7-8",
    origin: "印尼",
    imageUrl: "https://example.com/blue-tang.jpg",
    tankName: "鱼D 1800 / D1-2",
    batchNo: "PO-2026-030",
    supplier: "供应商A",
    inDate: "2026-07-30",
    status: "sick",
    sold: true,
    lost: false,
    basePrice: 260,
    notes: "观察中",
    siteId: "nanjing",
    missing: false,
    linkedOrders: [{
      id: "order-1",
      orderNo: "SO-2026-1888",
      status: "pending",
      source: "私域线上",
    }],
  });
  assert.deepEqual(snapshot.items[1], {
    stockItemId: "stock-missing",
    code: "stock-missing",
    missing: true,
    linkedOrders: [],
  });
});

test("stock deletion snapshots keep tank labels compact and skip inline images", () => {
  const snapshot = buildStockDeletionSnapshot({
    deleteIds: ["stock-1"],
    stock: [{ id: "stock-1", productId: "product-1", subTankId: "tank-1" }],
    products: [{ id: "product-1", imageUrl: "data:image/jpeg;base64,very-large-image" }],
    tankGroups: [{ name: "D1-2", subTanks: [{ id: "tank-1", name: "D1-2" }] }],
  });

  assert.equal(snapshot.items[0].tankName, "D1-2");
  assert.equal(snapshot.items[0].imageUrl, "");
});

test("stock added before a batch is 48 hours old does not require approval", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(batchRequiresLateStockApproval({
    createdAt: new Date(now - STOCK_BATCH_APPROVAL_DELAY_MS + 1).toISOString(),
  }, now), false);
});

test("stock added at or after 48 hours requires approval", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(batchRequiresLateStockApproval({
    createdAt: new Date(now - STOCK_BATCH_APPROVAL_DELAY_MS).toISOString(),
  }, now), true);
  assert.equal(batchRequiresLateStockApproval({}, now), true);
});

test("batch creation timestamps are server-assigned and cannot be changed later", () => {
  const current = [
    { id: "old", batchNo: "PO-1", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "legacy", batchNo: "PO-LEGACY" },
  ];
  const next = preserveBatchCreationTimes(current, [
    { id: "old", batchNo: "PO-1", createdAt: "2099-01-01T00:00:00.000Z" },
    { id: "legacy", batchNo: "PO-LEGACY", createdAt: "2099-01-01T00:00:00.000Z" },
    { id: "new", batchNo: "PO-2", createdAt: "2000-01-01T00:00:00.000Z" },
  ], "2026-08-03T12:00:00.000Z");
  assert.equal(next[0].createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(next[1].createdAt, undefined);
  assert.equal(next[2].createdAt, "2026-08-03T12:00:00.000Z");
});

test("staff updates and deletes require approval before changing stock", () => {
  const updated = classifyStockMutationForApproval({
    existingIds: new Set(["stock-1"]),
    upsertItems: [{ id: "stock-1", batchId: "batch-new" }],
    batches: [{ id: "batch-new", createdAt: new Date().toISOString() }],
  });
  assert.equal(updated.requiresApproval, true);
  assert.equal(updated.updatedItems.length, 1);

  const deleted = classifyStockMutationForApproval({
    existingIds: ["stock-1"],
    deleteIds: ["stock-1"],
  });
  assert.equal(deleted.requiresApproval, true);
  assert.equal(deleted.hasDeletes, true);
});

test("administrators remain the approving authority and may maintain stock directly", () => {
  const result = classifyStockMutationForApproval({
    isAdmin: true,
    existingIds: ["stock-1"],
    upsertItems: [{ id: "stock-1" }],
    deleteIds: ["stock-2"],
  });
  assert.equal(result.requiresApproval, false);
});
