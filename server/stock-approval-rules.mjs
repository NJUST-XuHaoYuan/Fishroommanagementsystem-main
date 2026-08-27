import { createHash } from "node:crypto";
import { stockConcurrencySnapshot } from "./stock-mutation-relationships.mjs";

export const STOCK_BATCH_APPROVAL_DELAY_MS = 48 * 60 * 60 * 1000;
export const STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION = 2;

function normalizedText(value) {
  return String(value ?? "").trim();
}

function recordsById(records = []) {
  return new Map((Array.isArray(records) ? records : [])
    .map((record) => [normalizedText(record?.id), record])
    .filter(([id]) => id));
}

const STOCK_MUTATION_AUDIT_FIELDS = Object.freeze([
  "siteId",
  "productId",
  "batchId",
  "subTankId",
  "status",
  "sold",
  "lost",
  "lossDate",
  "lossReason",
  "lossProof",
  "inDate",
  "basePrice",
  "priceOverridden",
  "commissionRate",
  "code",
  "notes",
]);

function stockMutationChangedFields(before = {}, after = {}) {
  const beforeSnapshot = stockConcurrencySnapshot(before);
  const afterSnapshot = stockConcurrencySnapshot(after);
  return STOCK_MUTATION_AUDIT_FIELDS.filter((field) =>
    stableSignature(beforeSnapshot[field]) !== stableSignature(afterSnapshot[field])
  );
}

function stockLossProofAudit(item = {}) {
  const lossProof = stockConcurrencySnapshot(item).lossProof;
  return {
    lossProofCount: lossProof.length,
    lossProofFingerprint: lossProof.length > 0
      ? createHash("sha256").update(stableSignature(lossProof)).digest("hex")
      : "",
  };
}

export function filterEffectiveStockMutation({
  stock = [],
  upsertItems = [],
  deleteIds = [],
} = {}) {
  const stockById = recordsById(stock);
  const effectiveUpsertItems = (Array.isArray(upsertItems) ? upsertItems : [])
    .filter(Boolean)
    .filter((item) => {
      const current = stockById.get(normalizedText(item?.id));
      if (!current) return true;
      return stableSignature(stockConcurrencySnapshot(current)) !==
        stableSignature(stockConcurrencySnapshot(item));
    });
  return {
    upsertItems: effectiveUpsertItems,
    deleteIds: Array.isArray(deleteIds) ? [...deleteIds] : [],
  };
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
  const canonical = stockConcurrencySnapshot(item);
  const basePrice = Number(canonical.basePrice);
  const commissionRate = Number(canonical.commissionRate);
  return {
    stockItemId,
    code: canonical.code,
    rawCode: canonical.code,
    productId: canonical.productId,
    productName: normalizedText(product?.name) || normalizedText(item?.productId) || "未知品名",
    speciesName: normalizedText(itemSpecies?.name),
    size: normalizedText(product?.size),
    origin: normalizedText(product?.origin),
    imageUrl: imageUrl.startsWith("data:") ? "" : imageUrl,
    subTankId: canonical.subTankId,
    tankName: normalizedText(tank?.label) || normalizedText(item?.subTankId) || "未知缸位",
    batchId: canonical.batchId,
    batchNo: normalizedText(batch?.batchNo) || normalizedText(item?.batchId),
    batchDate: normalizedText(batch?.arrivalDate),
    supplier: normalizedText(batch?.supplier),
    inDate: canonical.inDate,
    status: canonical.status,
    sold: canonical.sold,
    lost: canonical.lost,
    lossDate: canonical.lossDate,
    lossReason: canonical.lossReason,
    ...stockLossProofAudit(item),
    basePrice: Number.isFinite(basePrice) ? basePrice : 0,
    priceOverridden: canonical.priceOverridden,
    commissionRate: Number.isFinite(commissionRate) ? commissionRate : 0,
    notes: canonical.notes,
    siteId: canonical.siteId,
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
  const { upsertItems: normalizedUpserts } = filterEffectiveStockMutation({
    stock: currentStock,
    upsertItems,
  });
  const changes = [];

  for (const stockItemId of uniqueDeleteIds) {
    const before = stockChangeDetail(stockById.get(stockItemId), context, stockItemId);
    changes.push({ operation: "remove", stockItemId, before, after: null });
  }
  for (const item of normalizedUpserts) {
    const stockItemId = normalizedText(item?.id);
    const current = stockById.get(stockItemId);
    const operation = current ? "update" : "add";
    const changedFields = current ? stockMutationChangedFields(current, item) : [];
    changes.push({
      operation,
      stockItemId,
      before: current ? stockChangeDetail(current, context, stockItemId) : null,
      after: stockChangeDetail(item, context, stockItemId),
      ...(current ? {
        changedFields,
        lossProofChanged: changedFields.includes("lossProof"),
      } : {}),
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
      detail?.siteId,
      detail?.subTankId,
      detail?.productId,
      detail?.batchId,
      detail?.status,
      detail?.sold,
      detail?.lost,
      detail?.lossDate,
      detail?.lossReason,
      detail?.lossProofCount,
      detail?.lossProofFingerprint,
      detail?.inDate,
      detail?.basePrice,
      detail?.priceOverridden,
      detail?.commissionRate,
      detail?.code,
      detail?.notes,
    ]);
    groupedAdds.set(key, (groupedAdds.get(key) ?? 0) + 1);
  }
  const signature = {
    adds: [...groupedAdds.entries()].sort(([left], [right]) => left.localeCompare(right)),
    removes: changes.filter((item) => item.operation === "remove").map((item) => item.stockItemId).sort(),
    updates: changes.filter((item) => item.operation === "update").map((item) => [
      item.stockItemId,
      item.after?.siteId,
      item.after?.subTankId,
      item.after?.productId,
      item.after?.batchId,
      item.after?.status,
      item.after?.sold,
      item.after?.lost,
      item.after?.lossDate,
      item.after?.lossReason,
      item.after?.lossProofCount,
      item.after?.lossProofFingerprint,
      item.after?.inDate,
      item.after?.basePrice,
      item.after?.priceOverridden,
      item.after?.commissionRate,
      item.after?.code,
      item.after?.notes,
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  };

  return {
    type: "stock_change",
    schemaVersion: STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    reviewComplete: true,
    totals,
    requestedCount: changes.length,
    availableRemoveCount: changes.filter((change) => change.operation === "remove" && !change.before?.missing).length,
    tanks,
    batches: batchSummary,
    items: changes,
    signature,
  };
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasCanonicalStockAuditDetail(detail) {
  if (!isPlainRecord(detail)) return false;
  return [
    "stockItemId",
    "siteId",
    "productId",
    "batchId",
    "subTankId",
    "status",
    "sold",
    "lost",
    "inDate",
    "basePrice",
    "code",
    "rawCode",
    "notes",
    "priceOverridden",
    "commissionRate",
    "lossDate",
    "lossReason",
    "lossProofCount",
    "lossProofFingerprint",
    "missing",
  ].every((field) => Object.prototype.hasOwnProperty.call(detail, field));
}

export function stockChangeSnapshotNeedsCanonicalRebuild(stockDetails = {}) {
  if (stockDetails?.type !== "stock_change" || !Array.isArray(stockDetails?.items)) return false;
  if (Number(stockDetails.schemaVersion) !== STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION ||
      stockDetails.reviewComplete !== true ||
      stockDetails.items.length === 0) {
    return true;
  }
  return stockDetails.items.some((item) => {
    if (item?.operation === "add") return !hasCanonicalStockAuditDetail(item.after);
    if (item?.operation === "remove") return !hasCanonicalStockAuditDetail(item.before);
    if (item?.operation === "update") {
      return !hasCanonicalStockAuditDetail(item.before) ||
        !hasCanonicalStockAuditDetail(item.after) ||
        !Array.isArray(item.changedFields) ||
        item.changedFields.length === 0;
    }
    return true;
  });
}

export function rebuildStockChangeSnapshotFromApprovalRequest(approvalRequest = {}, context = {}) {
  const payload = isPlainRecord(approvalRequest?.payload) ? approvalRequest.payload : {};
  const rawUpsertItems = Array.isArray(payload.upsert) ? payload.upsert : [];
  if (rawUpsertItems.some((item) => !isPlainRecord(item))) return null;
  const upsertItems = rawUpsertItems;
  const deleteIds = Array.isArray(payload.deleteIds)
    ? payload.deleteIds.map(normalizedText)
    : [];
  if (upsertItems.length === 0 && deleteIds.length === 0) return null;
  const expectedOperations = isPlainRecord(payload.expectedOperations) ? payload.expectedOperations : null;
  const expectedBefore = isPlainRecord(payload.expectedBefore) ? payload.expectedBefore : null;
  if (!expectedOperations || !expectedBefore) return null;

  const upsertIds = upsertItems.map((item) => normalizedText(item?.id));
  if (upsertIds.some((id) => !id) ||
      deleteIds.some((id) => !id) ||
      new Set(upsertIds).size !== upsertIds.length ||
      new Set(deleteIds).size !== deleteIds.length ||
      upsertIds.some((id) => deleteIds.includes(id))) {
    return null;
  }

  const requestedIds = [...upsertIds, ...deleteIds];
  const operationKeys = Object.keys(expectedOperations);
  const normalizedOperationKeys = operationKeys.map(normalizedText);
  if (operationKeys.some((key, index) => !normalizedOperationKeys[index] || key !== normalizedOperationKeys[index]) ||
      new Set(normalizedOperationKeys).size !== requestedIds.length ||
      requestedIds.some((id) => !normalizedOperationKeys.includes(id))) {
    return null;
  }

  const beforeStock = [];
  const expectedBeforeIds = [];
  for (const item of upsertItems) {
    const stockItemId = normalizedText(item?.id);
    const operation = expectedOperations[stockItemId];
    if (operation === "create") continue;
    if (operation !== "update") return null;
    const before = expectedBefore[stockItemId];
    if (!isPlainRecord(before) || normalizedText(before?.id) !== stockItemId) return null;
    beforeStock.push(before);
    expectedBeforeIds.push(stockItemId);
  }
  for (const stockItemId of deleteIds) {
    if (expectedOperations[stockItemId] !== "delete") return null;
    const before = expectedBefore[stockItemId];
    if (!isPlainRecord(before) || normalizedText(before?.id) !== stockItemId) return null;
    beforeStock.push(before);
    expectedBeforeIds.push(stockItemId);
  }

  const beforeKeys = Object.keys(expectedBefore);
  const normalizedBeforeKeys = beforeKeys.map(normalizedText);
  if (beforeKeys.some((key, index) => !normalizedBeforeKeys[index] || key !== normalizedBeforeKeys[index]) ||
      new Set(normalizedBeforeKeys).size !== expectedBeforeIds.length ||
      expectedBeforeIds.some((id) => !normalizedBeforeKeys.includes(id))) {
    return null;
  }

  const rebuilt = buildStockChangeSnapshot({
    upsertItems,
    deleteIds,
    stock: beforeStock,
    products: context.products,
    species: context.species,
    batches: context.batches,
    tankGroups: context.tankGroups,
    orders: context.orders,
  });
  const expectedItems = requestedIds.map((stockItemId) => ({
    stockItemId,
    operation: expectedOperations[stockItemId] === "create"
      ? "add"
      : expectedOperations[stockItemId] === "delete"
        ? "remove"
        : expectedOperations[stockItemId] === "update"
          ? "update"
          : "invalid",
  })).sort((left, right) => stableSignature(left).localeCompare(stableSignature(right)));
  const rebuiltItems = rebuilt.items.map((item) => ({
    stockItemId: normalizedText(item?.stockItemId),
    operation: normalizedText(item?.operation),
  })).sort((left, right) => stableSignature(left).localeCompare(stableSignature(right)));
  return stableSignature(expectedItems) === stableSignature(rebuiltItems) ? rebuilt : null;
}

function stableSignature(value) {
  return JSON.stringify(value);
}

function finiteCanonicalNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function canonicalAdjustmentProposal(detail = {}) {
  const rawCode = Object.prototype.hasOwnProperty.call(detail, "rawCode")
    ? detail.rawCode
    : detail.code;
  const lossProofCount = Number(detail?.lossProofCount ?? 0);
  return {
    siteId: normalizedText(detail?.siteId),
    productId: normalizedText(detail?.productId),
    batchId: normalizedText(detail?.batchId),
    subTankId: normalizedText(detail?.subTankId),
    status: normalizedText(detail?.status) || "healthy",
    sold: Boolean(detail?.sold),
    lost: Boolean(detail?.lost),
    lossDate: normalizedText(detail?.lossDate),
    lossReason: normalizedText(detail?.lossReason),
    lossProofCount: Number.isSafeInteger(lossProofCount) && lossProofCount > 0 ? lossProofCount : 0,
    lossProofFingerprint: normalizedText(detail?.lossProofFingerprint),
    inDate: normalizedText(detail?.inDate),
    basePrice: finiteCanonicalNumber(detail?.basePrice),
    priceOverridden: Boolean(detail?.priceOverridden),
    commissionRate: finiteCanonicalNumber(detail?.commissionRate),
    code: normalizedText(rawCode),
    notes: normalizedText(detail?.notes),
  };
}

function countedAdjustmentProposals(items = [], operation) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.operation !== operation || !item?.after) continue;
    const proposal = canonicalAdjustmentProposal(item.after);
    const key = stableSignature(proposal);
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { proposal, count: 1 });
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => ({ proposal: entry.proposal, count: entry.count }));
}

function stockChangeReviewIntegritySignature(stockDetails = {}) {
  const items = (Array.isArray(stockDetails?.items) ? stockDetails.items : [])
    .map((item) => {
      const operation = normalizedText(item?.operation);
      const stockItemId = normalizedText(item?.stockItemId);
      if (operation === "add") {
        return { operation, stockItemId, after: canonicalAdjustmentProposal(item?.after) };
      }
      if (operation === "remove") {
        return { operation, stockItemId, before: canonicalAdjustmentProposal(item?.before) };
      }
      if (operation === "update") {
        return {
          operation,
          stockItemId,
          before: canonicalAdjustmentProposal(item?.before),
          after: canonicalAdjustmentProposal(item?.after),
          changedFields: (Array.isArray(item?.changedFields) ? item.changedFields : [])
            .map(normalizedText)
            .filter(Boolean)
            .sort(),
          lossProofChanged: item?.lossProofChanged === true,
        };
      }
      return { operation, stockItemId, invalid: true };
    })
    .sort((left, right) => stableSignature(left).localeCompare(stableSignature(right)));
  return {
    items,
    totals: {
      addCount: finiteCanonicalNumber(stockDetails?.totals?.addCount),
      removeCount: finiteCanonicalNumber(stockDetails?.totals?.removeCount),
      updateCount: finiteCanonicalNumber(stockDetails?.totals?.updateCount),
    },
    requestedCount: finiteCanonicalNumber(stockDetails?.requestedCount),
    signature: stockDetails?.signature ?? null,
  };
}

function incompleteStockChangeReviewDetails(stockDetails = {}) {
  if (isPlainRecord(stockDetails) && Array.isArray(stockDetails.items)) {
    return { ...stockDetails, reviewComplete: false };
  }
  return {
    type: "stock_change",
    schemaVersion: STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    reviewComplete: false,
    totals: { addCount: 0, removeCount: 0, updateCount: 0 },
    requestedCount: 0,
    availableRemoveCount: 0,
    tanks: [],
    batches: [],
    items: [],
    signature: { adds: [], removes: [], updates: [] },
  };
}

export function stockApprovalReviewDetails(approvalRequest = {}, context = {}) {
  const storedDetails = isPlainRecord(approvalRequest?.stockDetails)
    ? approvalRequest.stockDetails
    : null;
  const rebuiltDetails = rebuildStockChangeSnapshotFromApprovalRequest(approvalRequest, context);
  if (!rebuiltDetails) {
    return {
      reviewComplete: false,
      usedStoredSnapshot: false,
      rebuiltFromPayload: false,
      stockDetails: incompleteStockChangeReviewDetails(storedDetails),
    };
  }

  const storedSnapshotMatches = storedDetails?.type === "stock_change" &&
    Array.isArray(storedDetails?.items) &&
    !stockChangeSnapshotNeedsCanonicalRebuild(storedDetails) &&
    stableSignature(stockChangeReviewIntegritySignature(storedDetails)) ===
      stableSignature(stockChangeReviewIntegritySignature(rebuiltDetails));
  return {
    reviewComplete: true,
    usedStoredSnapshot: storedSnapshotMatches,
    rebuiltFromPayload: !storedSnapshotMatches,
    stockDetails: storedSnapshotMatches ? storedDetails : rebuiltDetails,
  };
}

function redactStockLossProofAuditValue(value) {
  if (Array.isArray(value)) return value.map(redactStockLossProofAuditValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (key === "lossProof" || key === "lossProofFingerprint") return [];
    return [[key, redactStockLossProofAuditValue(entry)]];
  }));
}

export function stockApprovalDetailsForResponse(stockDetails = {}) {
  const { signature: _internalSignature, ...withoutInternalSignature } = isPlainRecord(stockDetails)
    ? stockDetails
    : {};
  return redactStockLossProofAuditValue(withoutInternalSignature);
}

export function stockChangeAdjustmentSignature(stockDetails = {}) {
  const items = Array.isArray(stockDetails?.items) ? stockDetails.items : [];
  const adds = countedAdjustmentProposals(items, "add");
  const updates = items
    .filter((item) => item?.operation === "update" && item?.after)
    .map((item) => ({
      stockItemId: normalizedText(item?.stockItemId),
      proposal: canonicalAdjustmentProposal(item.after),
    }))
    .sort((left, right) => stableSignature(left).localeCompare(stableSignature(right)));
  const removeStockIds = [...new Set([
    ...items
      .filter((item) => item?.operation === "remove")
      .map((item) => normalizedText(item?.stockItemId)),
    ...(Array.isArray(stockDetails?.signature?.removes)
      ? stockDetails.signature.removes.map(normalizedText)
      : []),
  ].filter(Boolean))].sort();
  return { adds, updates, removeStockIds };
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
  stock,
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
  const upserts = Array.isArray(stock)
    ? filterEffectiveStockMutation({ stock, upsertItems }).upsertItems
    : (Array.isArray(upsertItems) ? upsertItems : []);
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
