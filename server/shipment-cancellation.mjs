import { createHash } from "node:crypto";
import { projectedShippedOutStockIds } from "./shipment-inventory-integrity.mjs";
import { isStockInTransfer } from "./stock-transfer-rules.mjs";
import { restoreCancelledTransferDispatch } from "./stock-transfer-dispatch.mjs";

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();
const fail = (message, code = "SHIPMENT_CANCEL_REVIEW_INVALID", statusCode = 409) => {
  throw Object.assign(new Error(message), { statusCode, code });
};
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const signature = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

function unique(records, wanted, label) {
  const matches = list(records).filter((record) => text(record?.id) === text(wanted));
  if (matches.length !== 1) fail(`${label}不存在或编号不唯一，请刷新后核对`);
  return matches[0];
}

function tanksForReview(state, visibleSiteIds) {
  const visible = new Set(visibleSiteIds.map(text));
  const counts = new Map();
  for (const group of list(state.tankGroups)) for (const tank of list(group.subTanks)) {
    counts.set(text(tank.id), (counts.get(text(tank.id)) ?? 0) + 1);
  }
  const sites = new Map(list(state.sites).map((site) => [text(site.id), text(site.name)]));
  const uniqueSiteIds = new Set(list(state.sites).filter((site) =>
    list(state.sites).filter((other) => text(other.id) === text(site.id)).length === 1).map((site) => text(site.id)));
  return list(state.tankGroups).flatMap((group) => visible.has(text(group.siteId)) && uniqueSiteIds.has(text(group.siteId))
    ? list(group.subTanks).filter((tank) => text(tank.id) && counts.get(text(tank.id)) === 1)
      .map((tank) => ({ id: text(tank.id), siteId: text(group.siteId),
        name: `${sites.get(text(group.siteId)) || group.siteId} · ${group.name} / ${tank.name}` })) : []);
}

function containsReference(value, stockId) {
  if (typeof value === "string") return value === stockId;
  if (Array.isArray(value)) return value.some((entry) => containsReference(entry, stockId));
  if (value && typeof value === "object") return Object.values(value).some((entry) => containsReference(entry, stockId));
  return false;
}

function pendingStockReference(state, stockId) {
  return list(state.approvalRequests).some((request) => request.status === "pending" &&
    containsReference(request.payload ?? request.stockDetails, stockId)) ||
    list(state.inventoryAdjustmentDrafts).some((draft) => containsReference(draft, stockId));
}

function reservedCandidateIds(state) {
  const ids = new Set();
  for (const order of list(state.orders)) for (const item of list(order.items)) ids.add(text(item.stockItemId));
  for (const shipment of list(state.shipments)) {
    for (const id of list(shipment.itemStockIds)) ids.add(text(id));
    for (const id of list(shipment.damageItemStockIds)) ids.add(text(id));
    for (const replacement of list(shipment.damageReplacements)) {
      ids.add(text(replacement.originalStockItemId));
      ids.add(text(replacement.replacementStockItemId));
    }
  }
  for (const record of list(state.lossRecords)) ids.add(text(record.stockItemId));
  return ids;
}

/** A review is a server-derived, actor-bound snapshot; a client never supplies evidence. */
export function shipmentCancellationReview(state, shipment, order, { visibleSiteIds = [], reviewer = "" } = {}) {
  if (!["outbound", "shipped"].includes(shipment.status)) fail("只有已出库或运输中的发货单可以取消");
  if (["completed", "cancelled"].includes(order.status)) fail("已完成或已取消订单不能取消发货");
  // The dedicated transfer path validates its issuing snapshot and actual dispatch-site access.
  // This pure dry run prevents an inaccessible transfer from reaching even the preview.
  restoreCancelledTransferDispatch(state, shipment, {
    visibleSiteIds, operator: reviewer, now: "preview", date: "preview", createId: () => "preview-only",
  });
  const ids = list(shipment.itemStockIds).map(text);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id)) fail("出库鱼只明细不完整，请先核对");
  const orderIds = new Set(list(order.items).filter((item) => !item.inventoryRemovedAt).map((item) => text(item.stockItemId)));
  if (ids.some((id) => !orderIds.has(id))) fail("出库鱼只与订单明细不一致，请先核对");
  const tanks = tanksForReview(state, visibleSiteIds);
  const tankById = new Map(tanks.map((tank) => [tank.id, tank]));
  const outIds = projectedShippedOutStockIds(state);
  const reservedIds = reservedCandidateIds(state);
  const stockCounts = new Map();
  for (const stock of list(state.stock)) stockCounts.set(text(stock.id), (stockCounts.get(text(stock.id)) ?? 0) + 1);
  const declaredTransfers = new Set(list(shipment.transferDispatch?.items).map((entry) => text(entry.stockItemId)));
  const before = [];
  const allCandidateIds = new Set();
  const items = ids.map((id) => {
    const stock = unique(state.stock, id, "原鱼记录");
    if (stock.lost || list(state.lossRecords).some((record) => text(record.stockItemId) === id)) {
      fail("出库鱼只已登记损耗，请先核对损耗记录，不能直接回缸");
    }
    if (list(state.shipments).some((other) => text(other.id) !== text(shipment.id) &&
      other.status !== "preparing" && list(other.itemStockIds).map(text).includes(id))) {
      fail("原鱼还关联其他出库记录，请先核对，不能直接回缸");
    }
    const product = unique(state.products, stock.productId, "关联商品");
    const batch = unique(state.batches, stock.batchId, "关联批次");
    const restoreTransfer = declaredTransfers.has(id);
    const tank = tankById.get(text(stock.subTankId));
    if (!restoreTransfer && (!tank || tank.siteId !== text(stock.siteId))) {
      fail("原鱼当前场地或缸位不可访问，请联系有该场地权限的人员核对", "STOCK_SITE_FORBIDDEN", 403);
    }
    if (!restoreTransfer && (isStockInTransfer(stock) || stock.tankTransfer?.status === "dispatched")) {
      fail("原鱼移缸状态与出库单不一致，请先核对");
    }
    before.push(stock);
    const candidates = restoreTransfer ? [] : list(state.stock).filter((candidate) => {
      const candidateId = text(candidate.id);
      const candidateTank = tankById.get(text(candidate.subTankId));
      return candidateId && !ids.includes(candidateId) && stockCounts.get(candidateId) === 1 &&
        text(candidate.productId) === text(stock.productId) && text(candidate.batchId) === text(stock.batchId) &&
        candidateTank && candidateTank.siteId === text(candidate.siteId) &&
        !candidate.sold && ["healthy", "feeding", "sick"].includes(candidate.status) && !candidate.lost && !isStockInTransfer(candidate) &&
        !candidate.tankTransfer && !outIds.has(candidateId) && !reservedIds.has(candidateId) &&
        !pendingStockReference(state, candidateId) &&
        !list(state.bioRecords).some((record) => text(record.stockItemId) === candidateId &&
          String(record.sourceType ?? "").startsWith("stockTransfer"));
    }).sort((a, b) => text(b.entrySnapshot?.recordedAt).localeCompare(text(a.entrySnapshot?.recordedAt)) ||
      text(a.id).localeCompare(text(b.id)));
    for (const candidate of candidates) allCandidateIds.add(text(candidate.id));
    return {
      stockItemId: id, fishCode: text(stock.code) || id, productName: text(product.name),
      batchNo: text(batch.batchNo) || text(batch.id), siteId: text(stock.siteId),
      subTankId: text(stock.subTankId), tankName: tank?.name || "移缸在途（未入缸）", restoreTransfer,
      candidates: candidates.map((candidate) => ({ stockItemId: text(candidate.id),
        fishCode: text(candidate.code) || text(candidate.id), subTankId: text(candidate.subTankId),
        tankName: tankById.get(text(candidate.subTankId)).name, notes: text(candidate.notes),
        status: text(candidate.status), inDate: text(candidate.inDate),
        recordedAt: text(candidate.entrySnapshot?.recordedAt),
        stocktakeHint: /盘库|盘点/.test(text(candidate.notes)),
      })),
    };
  });
  const relevantIds = new Set([...ids, ...allCandidateIds]);
  const hasStocktakeHints = items.some((item) => item.candidates.some((candidate) => candidate.stocktakeHint));
  const snapshot = {
    reviewer, visibleSiteIds: [...visibleSiteIds].sort(), shipment, order, tanks,
    stock: list(state.stock).filter((stock) => relevantIds.has(text(stock.id))),
    bioRecords: list(state.bioRecords).filter((record) => relevantIds.has(text(record.stockItemId))),
    statusHistory: list(state.stockStatusHistory).filter((record) => relevantIds.has(text(record.stockItemId))),
    // Include exact dependencies so an occupied/newly approved candidate cannot reuse an old review.
    pending: list(state.approvalRequests).filter((request) => request.status === "pending" &&
      [...relevantIds].some((id) => containsReference(request.payload ?? request.stockDetails, id))),
    drafts: list(state.inventoryAdjustmentDrafts).filter((draft) => [...relevantIds].some((id) => containsReference(draft, id))),
    hiddenIds: list(state.publicCatalogPolicy?.hiddenStockIds).filter((id) => relevantIds.has(text(id))),
    items,
  };
  return { shipmentId: text(shipment.id), orderNo: text(order.orderNo), reviewToken: signature(snapshot),
    items, tanks, hasStocktakeHints,
    warnings: ["请核实实物已经回缸。若盘库已把同一条鱼补录，请逐条选择对应记录合并，避免重复计数。", 
      "候选记录仅按商品、批次和可合并状态筛选，不代表已经确认是同一条实物。"] };
}

/** Apply only after the caller has locked state and refreshed its authorization. */
export function applyShipmentCancellationReturns(state, shipment, order, body, options) {
  const review = shipmentCancellationReview(state, shipment, order, options);
  if (!text(body.reviewToken) || body.reviewToken !== review.reviewToken) {
    fail("出库或库存记录已变化，请重新核对后提交", "SHIPMENT_CANCEL_REVIEW_STALE");
  }
  const normalItems = review.items.filter((item) => !item.restoreTransfer);
  if (body.confirmedPhysicalReturn !== true) fail("请先确认实物去向并核对是否已通过盘库补录");
  const returns = list(body.returnItems);
  const returnIds = returns.map((item) => text(item?.stockItemId));
  if (returns.length !== normalItems.length || new Set(returnIds).size !== returnIds.length ||
    normalItems.some((item) => !returnIds.includes(item.stockItemId))) fail("请逐条确认全部回缸鱼只");
  const tankById = new Map(review.tanks.map((tank) => [tank.id, tank]));
  const deleted = new Set();
  const updates = new Map();
  const auditItems = [];
  for (const item of normalItems) {
    const selected = returns.find((entry) => text(entry.stockItemId) === item.stockItemId);
    const tank = tankById.get(text(selected.subTankId));
    if (!tank) fail("请选择有权限的有效回缸位置", "STOCK_SITE_FORBIDDEN", 403);
    const original = unique(state.stock, item.stockItemId, "原鱼记录");
    const duplicateId = text(selected.duplicateStockItemId);
    let duplicate = null;
    if (duplicateId) {
      if (deleted.has(duplicateId) || !item.candidates.some((candidate) => candidate.stockItemId === duplicateId)) {
        fail("补录鱼只已变化或不符合安全合并条件，请重新核对");
      }
      duplicate = unique(state.stock, duplicateId, "补录鱼只");
      if (text(duplicate.subTankId) !== tank.id) fail("合并时请选择补录记录当前所在缸位，其他移缸请另行签发签收");
      deleted.add(duplicateId);
    }
    const after = { ...original, siteId: tank.siteId, subTankId: tank.id,
      ...(duplicate ? { status: duplicate.status,
        notes: [...new Set([text(original.notes), text(duplicate.notes)].filter(Boolean))].join("\n"),
        ...(list(original.photos).length || list(duplicate.photos).length
          ? { photos: [...new Set([...list(original.photos), ...list(duplicate.photos)])] } : {}),
        ...(list(original.videos).length || list(duplicate.videos).length
          ? { videos: [...new Set([...list(original.videos), ...list(duplicate.videos)])] } : {}),
      } : {}),
    };
    updates.set(item.stockItemId, after);
    auditItems.push({ stockItemId: item.stockItemId, duplicateStockItemId: duplicateId || null,
      originalBefore: original, duplicateBefore: duplicate, after,
      siteId: tank.siteId, subTankId: tank.id,
      bioRecordsBefore: list(state.bioRecords).filter((record) =>
        [item.stockItemId, duplicateId].includes(text(record.stockItemId))),
      statusHistoryBefore: list(state.stockStatusHistory).filter((record) =>
        [item.stockItemId, duplicateId].includes(text(record.stockItemId))),
    });
  }
  const mergedInto = new Map(auditItems.filter((item) => item.duplicateStockItemId)
    .map((item) => [item.duplicateStockItemId, item.stockItemId]));
  const redirect = (record) => mergedInto.has(text(record.stockItemId))
    ? { ...record, stockItemId: mergedInto.get(text(record.stockItemId)),
      mergedFromStockItemId: text(record.stockItemId), mergedAt: options.now } : record;
  const stock = list(state.stock).filter((item) => !deleted.has(text(item.id)))
    .map((item) => updates.get(text(item.id)) ?? item);
  const hidden = new Set(list(state.publicCatalogPolicy?.hiddenStockIds).map(text));
  for (const [duplicateId, originalId] of mergedInto) if (hidden.has(duplicateId)) hidden.add(originalId);
  for (const duplicateId of deleted) hidden.delete(duplicateId);
  const bioRecords = list(state.bioRecords).map(redirect);
  for (const item of auditItems) bioRecords.push({ id: options.createId(), stockItemId: item.stockItemId,
    siteId: item.siteId, subTankId: item.subTankId, sourceType: "shipmentCancellation", date: options.date,
    operator: options.operator, shipmentId: text(shipment.id), orderId: text(order.id),
    text: `取消出库：${order.orderNo || order.id}；回缸：${tankById.get(item.subTankId).name}` +
      (item.duplicateStockItemId ? `；核对合并重复补录：${item.duplicateBefore.code || item.duplicateStockItemId}（保留原鱼记录）` : "；已核实未重复补录"),
    photos: [], videos: [],
  });
  return { stock, bioRecords, stockStatusHistory: list(state.stockStatusHistory).map(redirect), auditItems,
    ...(state.publicCatalogPolicy ? { publicCatalogPolicy: { ...state.publicCatalogPolicy, hiddenStockIds: [...hidden] } } : {}),
    mergedCount: deleted.size,
  };
}
