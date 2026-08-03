import assert from "node:assert/strict";
import test from "node:test";
import {
  batchRequiresLateStockApproval,
  classifyStockMutationForApproval,
  preserveBatchCreationTimes,
  STOCK_BATCH_APPROVAL_DELAY_MS,
} from "./stock-approval-rules.mjs";

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
