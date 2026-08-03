export const STOCK_BATCH_APPROVAL_DELAY_MS = 48 * 60 * 60 * 1000;

export function batchRequiresLateStockApproval(batch = {}, now = Date.now()) {
  const createdAt = Date.parse(String(batch?.createdAt ?? ""));
  if (!Number.isFinite(createdAt)) return true;
  return Number(now) - createdAt >= STOCK_BATCH_APPROVAL_DELAY_MS;
}

export function classifyStockMutationForApproval({
  isAdmin = false,
  existingIds = [],
  upsertItems = [],
  deleteIds = [],
  batches = [],
  now = Date.now(),
} = {}) {
  if (isAdmin) {
    return { requiresApproval: false, updatedItems: [], lateItems: [], hasDeletes: false };
  }
  const existingIdSet = existingIds instanceof Set
    ? existingIds
    : new Set((Array.isArray(existingIds) ? existingIds : []).map(String));
  const batchById = new Map((Array.isArray(batches) ? batches : [])
    .map((batch) => [String(batch?.id ?? ""), batch]));
  const upserts = Array.isArray(upsertItems) ? upsertItems : [];
  const updatedItems = upserts.filter((item) => existingIdSet.has(String(item?.id ?? "")));
  const newItems = upserts.filter((item) => !existingIdSet.has(String(item?.id ?? "")));
  const lateItems = newItems.filter((item) =>
    batchRequiresLateStockApproval(batchById.get(String(item?.batchId ?? "")), now)
  );
  const hasDeletes = Array.isArray(deleteIds) && deleteIds.length > 0;
  return {
    requiresApproval: updatedItems.length > 0 || lateItems.length > 0 || hasDeletes,
    updatedItems,
    lateItems,
    hasDeletes,
  };
}

export function preserveBatchCreationTimes(currentBatches = [], incomingBatches = [], createdAt = new Date().toISOString()) {
  const currentById = new Map((Array.isArray(currentBatches) ? currentBatches : [])
    .map((batch) => [String(batch?.id ?? ""), batch])
    .filter(([id]) => id));
  return (Array.isArray(incomingBatches) ? incomingBatches : []).map((batch) => {
    const current = currentById.get(String(batch?.id ?? ""));
    if (current) {
      if (current.createdAt) return { ...batch, createdAt: current.createdAt };
      const { createdAt: _ignoredCreatedAt, ...withoutClientCreatedAt } = batch;
      return withoutClientCreatedAt;
    }
    return { ...batch, createdAt };
  });
}
