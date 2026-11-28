import test from "node:test";
import assert from "node:assert/strict";
import { calculatePurchaseBatchCosting } from "./purchase-batch-costing.mjs";
import { assertReceivedProcurementUnchanged, planBatchReceiving, receivingBlockedReason, receivingSources, preserveReceivingStockIdentity, assertGenericReceivingStockPatch } from "./purchase-batch-receiving-rules.mjs";

function fixture() {
  const procurement = {
    schemaVersion: 1, currency: "CNY", status: "confirmed",
    lines: [{ id: "line", productId: "product", productName: "测试鱼", size: "M", origin: "测试", quantity: 7, unitPrice: 12.34, taxWeightPercent: 10 }],
    boxes: [
      { id: "box-a", boxNo: "1", items: [{ id: "item-a", lineId: "line", quantity: 3, weightPercent: 100 }] },
      { id: "box-b", boxNo: "2", items: [{ id: "item-b", lineId: "line", quantity: 4, weightPercent: 100 }] },
    ],
    fees: { internationalFreight: 1.01, documentFee: 0.07, domesticFreight: 0.09, miscFee: 0.03, importTax: 0.05 },
  };
  procurement.allocation = calculatePurchaseBatchCosting(procurement);
  const batch = { id: "batch", siteId: "nanjing", batchNo: "QA", arrivalDate: "2026-11-28", costingRevision: 1,
    stockedCount: 0, lossCount: 0, procurement, receiving: { schemaVersion: 1, revision: 0, receipts: [] } };
  return { batches: [batch], stock: [], products: [{ id: "product", name: "测试鱼", defaultPrice: 100 }],
    sites: [{ id: "nanjing", name: "南京" }], tankGroups: [{ id: "group", name: "缸组", siteId: "nanjing", subTanks: [{ id: "tank", name: "子缸" }] }] };
}

function receive(state, entries, mutation = "receipt-one") {
  const batch = state.batches[0];
  const input = { siteId: "nanjing", batchId: batch.id, expectedRevision: batch.receiving.revision, expectedCostingRevision: batch.costingRevision,
    clientMutationId: mutation, date: "2026-11-28", entries, proofPhotos: ["/uploads/loss.jpg"], reason: "到货死亡", notes: "" };
  const result = planBatchReceiving({ state, batch, input, operator: "receiver", operatorId: "receiver", now: "2026-11-28T02:00:00Z" });
  return { result, state: { ...state, batches: [result.batch], stock: [...state.stock, ...result.stockItems] } };
}

test("each fee and purchase component is conserved in cents across partial live and arrival-dead receipts", () => {
  let state = fixture();
  state = receive(state, [{ boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 1, subTankId: "tank" }]).state;
  state = receive(state, [{ boxId: "box-b", itemId: "item-b", stockedQuantity: 3, lostQuantity: 1, subTankId: "tank" }], "receipt-two").state;
  state = receive(state, [{ boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 0, subTankId: "tank" }], "receipt-three").state;
  const totals = state.batches[0].procurement.allocation.totals;
  for (const field of Object.keys(totals).filter(key => key.endsWith("Cents"))) {
    assert.equal(state.stock.reduce((sum, fish) => sum + fish.procurementCostSnapshot[field], 0), totals[field], field);
  }
  assert.equal(state.stock.length, 7);
  assert.equal(state.stock.filter(fish => fish.entryDisposition === "arrival_dead").length, 2);
  assert.equal(receivingSources(state.batches[0]).reduce((sum, source) => sum + source.pendingQuantity, 0), 0);
});

test("multiple entries from one box use unique per-fish ordinals and deleting retained rows never reopens quantity", () => {
  const next = receive(fixture(), [
    { boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 1, subTankId: "tank" },
    { boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 0, subTankId: "tank" },
  ]).state;
  assert.deepEqual(next.stock.map(fish => fish.procurementSource.ordinal), [1, 2, 3]);
  next.stock = [];
  assert.equal(receivingBlockedReason(next, next.batches[0]), "");
  assert.equal(receivingSources(next.batches[0]).find(row => row.boxId === "box-a").pendingQuantity, 0);
});

test("a source cannot be repriced after first receipt and its frozen cost cannot be replaced by ordinary stock edits", () => {
  const state = receive(fixture(), [{ boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 0, subTankId: "tank" }]).state;
  const current = state.batches[0], changed = structuredClone(current);
  changed.procurement.fees.documentFee = 100;
  changed.procurement.allocation = calculatePurchaseBatchCosting(changed.procurement);
  assert.throws(() => assertReceivedProcurementUnchanged(current, changed), error => error.code === "BATCH_RECEIVING_COST_LOCKED");
  const fish = state.stock[0];
  const saved = preserveReceivingStockIdentity({ ...fish, notes: "只改备注", procurementCostSnapshot: { totalCents: 1 } }, fish);
  assert.deepEqual(saved.procurementCostSnapshot, fish.procurementCostSnapshot);
  assert.throws(() => assertGenericReceivingStockPatch(state, { ...state, stock: [{ ...fish, procurementCostSnapshot: { totalCents: 1 } }] }, ["stock"]), error => error.code === "BATCH_RECEIVING_SOURCE_LOCKED");
});

test("old empty-looking batches remain blocked and known receipt identities in later approval snapshots do not", () => {
  const state = fixture();
  delete state.batches[0].receiving;
  assert.match(receivingBlockedReason(state, state.batches[0]), /历史批次/);
  const next = receive(fixture(), [{ boxId: "box-a", itemId: "item-a", stockedQuantity: 1, lostQuantity: 0, subTankId: "tank" }]).state;
  next.approvalRequests = [{ status: "approved", stockDetails: { items: [{ stockItemId: next.stock[0].id, operation: "update", before: { stockItemId: next.stock[0].id, batchId: "batch" } }] } }];
  assert.equal(receivingBlockedReason(next, next.batches[0]), "");
});
