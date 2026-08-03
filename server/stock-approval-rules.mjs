export const STOCK_BATCH_APPROVAL_DELAY_MS = 48 * 60 * 60 * 1000;

export function batchRequiresLateStockApproval(batch = {}, now = Date.now()) {
  const createdAt = Date.parse(String(batch?.createdAt ?? ""));
  if (!Number.isFinite(createdAt)) return true;
  return Number(now) - createdAt >= STOCK_BATCH_APPROVAL_DELAY_MS;
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
