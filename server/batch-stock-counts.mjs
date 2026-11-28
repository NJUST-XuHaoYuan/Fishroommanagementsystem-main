const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();

/** Arrival deaths retain a fish identity for history, but have never entered inventory. */
export function isArrivalDeadStock(item = {}) {
  return item?.entryDisposition === "arrival_dead" || item?.neverEnteredTank === true;
}

/**
 * Counts are identities, not current availability. A sale, transfer, subsequent
 * loss or inventory correction must never make an already received fish pending
 * again. The immutable receiving ledger preserves those identities after removal.
 * Legacy batches keep their retained-stock counting convention.
 */
export function batchStockCounts(batch = {}, stock = []) {
  const stockedIds = new Set();
  const arrivalLostIds = new Set();
  const lostIds = new Set();
  if (batch?.receiving?.schemaVersion === 1) {
    for (const receipt of array(batch.receiving.receipts)) {
      for (const entry of array(receipt?.entries)) {
        for (const value of array(entry?.stockItemIds)) if (text(value)) stockedIds.add(text(value));
        for (const value of array(entry?.lossStockItemIds)) if (text(value)) arrivalLostIds.add(text(value));
      }
    }
  }
  for (const item of array(stock)) {
    const stockId = text(item?.id);
    if (!stockId || text(item?.batchId) !== text(batch?.id)) continue;
    if (isArrivalDeadStock(item)) arrivalLostIds.add(stockId);
    else stockedIds.add(stockId);
    if (item?.lost === true) lostIds.add(stockId);
  }
  // Corrupt overlapping identities must never become two fish in a report.
  for (const stockId of arrivalLostIds) {
    stockedIds.delete(stockId);
    lostIds.add(stockId);
  }
  return { stockedCount: stockedIds.size, lossCount: lostIds.size, arrivalLossCount: arrivalLostIds.size };
}

export function refreshBatchStockCounts(batches = [], stock = []) {
  const byBatch = new Map();
  for (const item of array(stock)) {
    const batchId = text(item?.batchId);
    const items = byBatch.get(batchId) ?? [];
    items.push(item);
    byBatch.set(batchId, items);
  }
  return array(batches).map((batch) => ({ ...batch, ...batchStockCounts(batch, byBatch.get(text(batch?.id)) ?? []) }));
}
