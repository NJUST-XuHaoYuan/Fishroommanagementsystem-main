export const STOCK_BATCH_APPROVAL_DELAY_MS = 48 * 60 * 60 * 1000;

function normalizedText(value) {
  return String(value ?? "").trim();
}

function recordsById(records = []) {
  return new Map((Array.isArray(records) ? records : [])
    .map((record) => [normalizedText(record?.id), record])
    .filter(([id]) => id));
}

export function buildStockDeletionSnapshot({
  deleteIds = [],
  stock = [],
  products = [],
  species = [],
  batches = [],
  tankGroups = [],
  orders = [],
} = {}) {
  const requestedIds = (Array.isArray(deleteIds) ? deleteIds : [])
    .map(normalizedText)
    .filter((id, index, all) => id && all.indexOf(id) === index);
  const stockById = recordsById(stock);
  const productById = recordsById(products);
  const speciesById = recordsById(species);
  const batchById = recordsById(batches);
  const tankById = new Map();
  for (const group of Array.isArray(tankGroups) ? tankGroups : []) {
    for (const tank of Array.isArray(group?.subTanks) ? group.subTanks : []) {
      const tankId = normalizedText(tank?.id);
      if (!tankId) continue;
      tankById.set(tankId, {
        groupName: normalizedText(group?.name),
        tankName: normalizedText(tank?.name),
      });
    }
  }

  const linkedOrdersByStockId = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      const stockItemId = normalizedText(item?.stockItemId);
      if (!stockItemId) continue;
      if (!linkedOrdersByStockId.has(stockItemId)) linkedOrdersByStockId.set(stockItemId, []);
      const linkedOrders = linkedOrdersByStockId.get(stockItemId);
      const orderId = normalizedText(order?.id);
      if (linkedOrders.some((linkedOrder) => linkedOrder.id === orderId)) continue;
      linkedOrders.push({
        id: orderId,
        orderNo: normalizedText(order?.orderNo),
        status: normalizedText(order?.status),
        source: normalizedText(order?.source),
      });
    }
  }

  const items = requestedIds.map((stockItemId) => {
    const item = stockById.get(stockItemId);
    if (!item) {
      return {
        stockItemId,
        code: stockItemId,
        missing: true,
        linkedOrders: linkedOrdersByStockId.get(stockItemId) ?? [],
      };
    }
    const product = productById.get(normalizedText(item?.productId));
    const itemSpecies = speciesById.get(normalizedText(product?.speciesId));
    const batch = batchById.get(normalizedText(item?.batchId));
    const tank = tankById.get(normalizedText(item?.subTankId));
    const tankLabel = [tank?.groupName, tank?.tankName]
      .map(normalizedText)
      .filter((label, index, all) => label && all.indexOf(label) === index)
      .join(" / ");
    const imageUrl = normalizedText(product?.imageUrl) || normalizedText(itemSpecies?.imageUrl);
    const basePrice = Number(item?.basePrice ?? 0);
    return {
      stockItemId,
      code: normalizedText(item?.code) || stockItemId,
      productName: normalizedText(product?.name) || normalizedText(item?.productId) || "未知品名",
      speciesName: normalizedText(itemSpecies?.name),
      size: normalizedText(product?.size),
      origin: normalizedText(product?.origin),
      imageUrl: imageUrl.startsWith("data:") ? "" : imageUrl,
      tankName: tankLabel || normalizedText(item?.subTankId) || "未知缸位",
      batchNo: normalizedText(batch?.batchNo) || normalizedText(item?.batchId),
      supplier: normalizedText(batch?.supplier),
      inDate: normalizedText(item?.inDate),
      status: normalizedText(item?.status) || "healthy",
      sold: item?.sold === true,
      lost: item?.lost === true,
      basePrice: Number.isFinite(basePrice) ? basePrice : 0,
      notes: normalizedText(item?.notes),
      siteId: normalizedText(item?.siteId),
      missing: false,
      linkedOrders: linkedOrdersByStockId.get(stockItemId) ?? [],
    };
  });

  return {
    type: "stock_delete",
    requestedCount: requestedIds.length,
    availableCount: items.filter((item) => !item.missing).length,
    items,
  };
}

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
