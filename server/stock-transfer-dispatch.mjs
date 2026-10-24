import { isStockInTransfer, stockTransferId } from "./stock-transfer-rules.mjs";

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const fail = (message, code = "STOCK_TRANSFER_DISPATCH_INVALID", statusCode = 409) => {
  throw Object.assign(new Error(message), { statusCode, code });
};

// Run only against locked state. Request IDs acknowledge the exact in-transit
// cycle; they never supply its source, order ownership or authorization scope.
export function planStockTransferDispatch(state, selectedIds, request, { visibleSiteIds = [] } = {}) {
  const selected = list(selectedIds).map(text);
  const selectedStock = selected.map((id) => {
    const matches = list(state.stock).filter((item) => text(item.id) === id);
    if (matches.length !== 1) fail("库存鱼不存在或 ID 不唯一，请刷新后重试", "STOCK_ID_NOT_UNIQUE");
    return matches[0];
  });
  const active = selectedStock.filter(isStockInTransfer);
  if (!active.length && request === undefined) return null;
  if (!request || typeof request !== "object" || Array.isArray(request) || !active.length) {
    fail("在途状态已变化，请刷新后确认实际发货场地和在途鱼", "STOCK_TRANSFER_STALE");
  }
  const items = list(request.items);
  const expected = new Map(items.map((item) => [text(item?.stockItemId), text(item?.transferId)]));
  if (expected.size !== items.length || items.length !== active.length ||
      active.some((item) => !expected.get(text(item.id)) || expected.get(text(item.id)) !== stockTransferId(item))) {
    fail("所选在途鱼已被签收、重新签发或选择已变化，请刷新后重试", "STOCK_TRANSFER_STALE");
  }
  const siteId = text(request.siteId);
  const sites = list(state.sites).filter((site) => text(site.id) === siteId && siteId);
  if (sites.length !== 1) fail("请选择有效的实际发货场地", "STOCK_TRANSFER_DISPATCH_SITE_INVALID");
  if (!list(visibleSiteIds).map(text).includes(siteId)) {
    fail("无权从该场地直接出库在途鱼", "STOCK_SITE_FORBIDDEN", 403);
  }
  for (const item of active) {
    const transfer = item.tankTransfer;
    if (list(state.stock).filter((other) => isStockInTransfer(other) && stockTransferId(other) === transfer.id).length !== 1) {
      fail("移缸签发 ID 不唯一，不能安全出库", "STOCK_TRANSFER_ID_NOT_UNIQUE");
    }
    if (!text(transfer.issuedAt) || !Number.isFinite(Date.parse(transfer.issuedAt)) || !text(transfer.issuedBy) ||
        !text(transfer.fromSiteId) || !text(transfer.fromSubTankId) || !text(transfer.fromTankName) ||
        text(item.siteId) !== text(transfer.fromSiteId) || text(item.subTankId) !== text(transfer.fromSubTankId) ||
        list(state.sites).filter((source) => text(source.id) === text(transfer.fromSiteId)).length !== 1) {
      fail("移缸在途来源快照不完整或位置不一致，请联系管理员核对", "STOCK_TRANSFER_STATE_INVALID");
    }
    if (item.lost) fail("已损耗商品不能直接出库");
  }
  return { siteId, siteName: text(sites[0].name), items: active };
}

export function applyStockTransferDispatch(state, plan, { shipmentId, orderId, operator, now, date, createId }) {
  if (!plan) return { stock: state.stock, bioRecords: state.bioRecords };
  const dispatched = new Map(plan.items.map((item) => [text(item.id), {
    ...item.tankTransfer, status: "dispatched", dispatchedAt: now, dispatchedBy: operator,
    dispatchSiteId: plan.siteId, dispatchSiteName: plan.siteName, orderId, shipmentId,
  }]));
  const records = plan.items.map((item) => {
    const transfer = dispatched.get(text(item.id));
    return {
      ...transfer, id: createId(), transferId: transfer.id, sourceType: "stockTransferDispatched",
      stockItemId: item.id, siteId: plan.siteId, date, operator,
      text: `移缸在途直接出库：${transfer.fromTankName} → ${plan.siteName}发货（未入缸）`, photos: [], videos: [],
    };
  });
  return {
    stock: list(state.stock).map((item) => dispatched.has(text(item.id))
      ? { ...item, siteId: plan.siteId, subTankId: "", tankTransfer: dispatched.get(text(item.id)) } : item),
    bioRecords: [...list(state.bioRecords), ...records],
  };
}

export function restoreCancelledTransferDispatch(state, shipment, { visibleSiteIds = [], operator, now, date, createId }) {
  const shipmentId = text(shipment.id);
  const transfers = list(state.stock).filter((item) => item?.tankTransfer?.status === "dispatched" &&
    text(item.tankTransfer.shipmentId) === shipmentId);
  const declared = list(shipment.transferDispatch?.items);
  if (!declared.length && !transfers.length) return { stock: state.stock, bioRecords: state.bioRecords };
  if (declared.length !== transfers.length || transfers.some((item) =>
    !declared.some((ref) => text(ref.stockItemId) === text(item.id) && text(ref.transferId) === stockTransferId(item)) ||
    text(item.tankTransfer.orderId) !== text(shipment.orderId) || !list(shipment.itemStockIds).map(text).includes(text(item.id)))) {
    fail("直接出库的移缸记录已变化，不能安全撤销", "STOCK_TRANSFER_STALE");
  }
  const restored = new Map();
  const records = [];
  for (const item of transfers) {
    const transfer = item.tankTransfer;
    if (!list(visibleSiteIds).map(text).includes(text(transfer.dispatchSiteId))) {
      fail("无权撤销该实际发货场地的在途出库", "STOCK_SITE_FORBIDDEN", 403);
    }
    if (item.lost || !text(transfer.fromSiteId) || !text(transfer.fromSubTankId) || !text(transfer.fromTankName)) {
      fail("直接出库记录不能安全恢复为在途，请联系管理员核对", "STOCK_TRANSFER_STATE_INVALID");
    }
    const { dispatchedAt, dispatchedBy, dispatchSiteId, dispatchSiteName, orderId, shipmentId: _shipmentId, ...original } = transfer;
    restored.set(text(item.id), { ...item, siteId: transfer.fromSiteId, subTankId: transfer.fromSubTankId,
      tankTransfer: { ...original, status: "in_transit" } });
    records.push({ ...transfer, id: createId(), transferId: transfer.id, stockItemId: item.id,
      sourceType: "stockTransferDispatchCancelled", siteId: dispatchSiteId, date, operator,
      cancelledAt: now, cancelledBy: operator,
      text: "撤销在途直接出库，恢复移缸在途（未入缸）", photos: [], videos: [],
    });
  }
  return { stock: list(state.stock).map((item) => restored.get(text(item.id)) ?? item),
    bioRecords: [...list(state.bioRecords), ...records] };
}
