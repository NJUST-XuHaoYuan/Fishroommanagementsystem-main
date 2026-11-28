import test from "node:test";
import assert from "node:assert/strict";
import { batchStockCounts, isArrivalDeadStock, refreshBatchStockCounts } from "./batch-stock-counts.mjs";

const batch = { id: "b", receiving: { schemaVersion: 1, receipts: [
  { id: "r1", entries: [{ stockItemIds: ["live", "sold", "later-lost", "deleted"], lossStockItemIds: ["arrival-dead", "arrival-dead-removed"] }] },
] } };

test("received identities persist across sales, later loss, and deletion without counting arrival deaths as stock-in", () => {
  const stock = [
    { id: "live", batchId: "b" },
    { id: "sold", batchId: "b", sold: true },
    { id: "later-lost", batchId: "b", lost: true },
    { id: "arrival-dead", batchId: "b", lost: true, entryDisposition: "arrival_dead", neverEnteredTank: true },
  ];
  assert.deepEqual(batchStockCounts(batch, stock), { stockedCount: 4, lossCount: 3, arrivalLossCount: 2 });
  assert.deepEqual(batchStockCounts(batch, []), { stockedCount: 4, lossCount: 2, arrivalLossCount: 2 });
});

test("legacy retained rows and duplicate loss identities are counted once per batch", () => {
  const stock = [{ id: "old", batchId: "legacy", lost: true }, { id: "old", batchId: "legacy", lost: true }, { id: "other", batchId: "other" }];
  const result = refreshBatchStockCounts([{ id: "legacy", stockedCount: 99 }, { id: "other" }], stock);
  assert.deepEqual(result, [
    { id: "legacy", stockedCount: 1, lossCount: 1, arrivalLossCount: 0 },
    { id: "other", stockedCount: 1, lossCount: 0, arrivalLossCount: 0 },
  ]);
  assert.equal(isArrivalDeadStock({ neverEnteredTank: true }), true);
  assert.equal(isArrivalDeadStock({ entryDisposition: "stocked" }), false);
});

test("replayed receipt identities and malformed overlap do not double-count fish", () => {
  const repeated = structuredClone(batch);
  repeated.receiving.receipts.push(structuredClone(batch.receiving.receipts[0]));
  repeated.receiving.receipts[0].entries[0].stockItemIds.push("arrival-dead");
  assert.deepEqual(batchStockCounts(repeated, []), { stockedCount: 4, lossCount: 2, arrivalLossCount: 2 });
});
