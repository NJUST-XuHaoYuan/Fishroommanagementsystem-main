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

function stockChangeDetail(item, context = {}, fallbackId = "") {
  const {
    productById = new Map(),
    speciesById = new Map(),
    batchById = new Map(),
    tankById = new Map(),
    linkedOrdersByStockId = new Map(),
  } = context;
  const stockItemId = normalizedText(item?.id) || normalizedText(fallbackId);
  if (!item) {
    return {
      stockItemId,
      code: stockItemId,
      missing: true,
      linkedOrders: linkedOrdersByStockId.get(stockItemId) ?? [],
    };
  }
  const product = productById.get(normalizedText(item.productId));
  const itemSpecies = speciesById.get(normalizedText(product?.speciesId));
  const batch = batchById.get(normalizedText(item.batchId));
  const tank = tankById.get(normalizedText(item.subTankId));
  const imageUrl = normalizedText(product?.imageUrl) || normalizedText(itemSpecies?.imageUrl);
  const basePrice = Number(item?.basePrice ?? 0);
  return {
    stockItemId,
    code: normalizedText(item?.code) || stockItemId,
    productId: normalizedText(item?.productId),
    productName: normalizedText(product?.name) || normalizedText(item?.productId) || "未知品名",
    speciesName: normalizedText(itemSpecies?.name),
    size: normalizedText(product?.size),
    origin: normalizedText(product?.origin),
    imageUrl: imageUrl.startsWith("data:") ? "" : imageUrl,
    subTankId: normalizedText(item?.subTankId),
    tankName: normalizedText(tank?.label) || normalizedText(item?.subTankId) || "未知缸位",
    batchId: normalizedText(item?.batchId),
    batchNo: normalizedText(batch?.batchNo) || normalizedText(item?.batchId),
    batchDate: normalizedText(batch?.arrivalDate),
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
}

function stockChangeContext({ products = [], species = [], batches = [], tankGroups = [], orders = [] } = {}) {
  const tankById = new Map();
  for (const group of Array.isArray(tankGroups) ? tankGroups : []) {
    for (const tank of Array.isArray(group?.subTanks) ? group.subTanks : []) {
      const tankId = normalizedText(tank?.id);
      if (!tankId) continue;
      const labels = [normalizedText(group?.name), normalizedText(tank?.name)].filter(Boolean);
      tankById.set(tankId, {
        label: labels.filter((label, index) => labels.indexOf(label) === index).join(" / "),
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
  return {
    productById: recordsById(products),
    speciesById: recordsById(species),
    batchById: recordsById(batches),
    tankById,
    linkedOrdersByStockId,
  };
}

function addChangeCount(target, operation, count = 1) {
  if (operation === "add") target.addCount += count;
  else if (operation === "remove") target.removeCount += count;
  else target.updateCount += count;
}

/**
 * Creates an immutable approval snapshot for additions, removals and edits.
 * The grouped rows are intentionally redundant so the approval UI never has
 * to reconstruct historical batch or tank information from mutable state.
 */
export function buildStockChangeSnapshot({
  upsertItems = [],
  deleteIds = [],
  stock = [],
  products = [],
  species = [],
  batches = [],
  tankGroups = [],
  orders = [],
} = {}) {
  const currentStock = Array.isArray(stock) ? stock : [];
  const stockById = recordsById(currentStock);
  const context = stockChangeContext({ products, species, batches, tankGroups, orders });
  const uniqueDeleteIds = (Array.isArray(deleteIds) ? deleteIds : [])
    .map(normalizedText)
    .filter((id, index, all) => id && all.indexOf(id) === index);
  const normalizedUpserts = (Array.isArray(upsertItems) ? upsertItems : []).filter(Boolean);
  const changes = [];

  for (const stockItemId of uniqueDeleteIds) {
    const before = stockChangeDetail(stockById.get(stockItemId), context, stockItemId);
    changes.push({ operation: "remove", stockItemId, before, after: null });
  }
  for (const item of normalizedUpserts) {
    const stockItemId = normalizedText(item?.id);
    const current = stockById.get(stockItemId);
    const operation = current ? "update" : "add";
    changes.push({
      operation,
      stockItemId,
      before: current ? stockChangeDetail(current, context, stockItemId) : null,
      after: stockChangeDetail(item, context, stockItemId),
    });
  }

  const tankMap = new Map();
  const batchMap = new Map();
  for (const change of changes) {
    const detail = change.operation === "remove" ? change.before : change.after;
    if (!detail) continue;
    const tankKey = detail.subTankId || detail.tankName || "unknown-tank";
    if (!tankMap.has(tankKey)) {
      tankMap.set(tankKey, {
        subTankId: detail.subTankId || "",
        tankName: detail.tankName || "未知缸位",
        addCount: 0,
        removeCount: 0,
        updateCount: 0,
        rows: new Map(),
      });
    }
    const tank = tankMap.get(tankKey);
    addChangeCount(tank, change.operation);
    const rowKey = [detail.productId, detail.batchId].join("\0");
    if (!tank.rows.has(rowKey)) {
      tank.rows.set(rowKey, {
        productId: detail.productId || "",
        productName: detail.productName || "未知品名",
        speciesName: detail.speciesName || "",
        size: detail.size || "",
        origin: detail.origin || "",
        batchId: detail.batchId || "",
        batchNo: detail.batchNo || "未设置批次",
        batchDate: detail.batchDate || "",
        supplier: detail.supplier || "",
        addCount: 0,
        removeCount: 0,
        updateCount: 0,
      });
    }
    addChangeCount(tank.rows.get(rowKey), change.operation);

    const batchKey = detail.batchId || detail.batchNo || "unknown-batch";
    if (!batchMap.has(batchKey)) {
      batchMap.set(batchKey, {
        batchId: detail.batchId || "",
        batchNo: detail.batchNo || "未设置批次",
        batchDate: detail.batchDate || "",
        supplier: detail.supplier || "",
        origins: [],
        addCount: 0,
        removeCount: 0,
        updateCount: 0,
      });
    }
    const batch = batchMap.get(batchKey);
    addChangeCount(batch, change.operation);
    if (detail.origin && !batch.origins.includes(detail.origin)) batch.origins.push(detail.origin);
  }

  const tanks = [...tankMap.values()]
    .map((tank) => ({ ...tank, rows: [...tank.rows.values()] }))
    .sort((left, right) => left.tankName.localeCompare(right.tankName, "zh-CN"));
  const batchSummary = [...batchMap.values()]
    .map((batch) => ({ ...batch, origins: [...batch.origins].sort((a, b) => a.localeCompare(b, "zh-CN")) }))
    .sort((left, right) => String(right.batchDate).localeCompare(String(left.batchDate)) || left.batchNo.localeCompare(right.batchNo, "zh-CN"));
  const totals = changes.reduce((result, change) => {
    addChangeCount(result, change.operation);
    return result;
  }, { addCount: 0, removeCount: 0, updateCount: 0 });

  const groupedAdds = new Map();
  for (const change of changes.filter((item) => item.operation === "add")) {
    const detail = change.after;
    const key = stableSignature([
      detail?.subTankId,
      detail?.productId,
      detail?.batchId,
      detail?.status,
      detail?.inDate,
      detail?.basePrice,
    ]);
    groupedAdds.set(key, (groupedAdds.get(key) ?? 0) + 1);
  }
  const signature = {
    adds: [...groupedAdds.entries()].sort(([left], [right]) => left.localeCompare(right)),
    removes: changes.filter((item) => item.operation === "remove").map((item) => item.stockItemId).sort(),
    updates: changes.filter((item) => item.operation === "update").map((item) => [
      item.stockItemId,
      item.after?.subTankId,
      item.after?.productId,
      item.after?.batchId,
      item.after?.status,
      item.after?.inDate,
      item.after?.basePrice,
      item.after?.code,
      item.after?.notes,
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  };

  return {
    type: "stock_change",
    totals,
    requestedCount: changes.length,
    availableRemoveCount: changes.filter((change) => change.operation === "remove" && !change.before?.missing).length,
    tanks,
    batches: batchSummary,
    items: changes,
    signature,
  };
}

function stableSignature(value) {
  return JSON.stringify(value);
}

export function stockChangeAdjustmentSignature(stockDetails = {}) {
  const rows = (Array.isArray(stockDetails.tanks) ? stockDetails.tanks : [])
    .flatMap((tank) => (Array.isArray(tank?.rows) ? tank.rows : []).map((row) => ({
      subTankId: normalizedText(tank?.subTankId),
      productId: normalizedText(row?.productId),
      batchId: normalizedText(row?.batchId),
      addCount: Number(row?.addCount ?? 0),
      removeCount: Number(row?.removeCount ?? 0),
      updateCount: Number(row?.updateCount ?? 0),
    })))
    .sort((left, right) => stableSignature(left).localeCompare(stableSignature(right)));
  const removeStockIds = Array.isArray(stockDetails?.signature?.removes)
    ? stockDetails.signature.removes.map(normalizedText).filter(Boolean).sort()
    : [];
  return { rows, removeStockIds };
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
