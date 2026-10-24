const text = (value) => String(value ?? "").trim();
const MOVE_SOURCE_TYPES = new Set([
  "stockMove",
  "stockTransferIssued",
  "stockTransferReceived",
  "stockTransferDispatched",
  "stockTransferDispatchCancelled",
]);
const TRANSFER_ROUTE_FIELDS = [
  "fromSiteId",
  "fromSubTankId",
  "fromTankName",
  "toSiteId",
  "toSubTankId",
  "toTankName",
  "issuedAt",
  "issuedBy",
  "receivedAt",
  "receivedBy",
  "notes",
  "dispatchedAt", "dispatchedBy", "dispatchSiteId", "dispatchSiteName", "orderId", "shipmentId",
  "cancelledAt", "cancelledBy",
];

function siteSet(visibleSiteIds = []) {
  return new Set((Array.isArray(visibleSiteIds) ? visibleSiteIds : []).map(text).filter(Boolean));
}

function canViewTransferRoute({ sourceType = "", fromSiteId = "", toSiteId = "", dispatchSiteId = "" } = {}, visible) {
  const from = text(fromSiteId);
  const to = text(dispatchSiteId || toSiteId);
  if (sourceType === "stockTransferIssued") return Boolean(from && visible.has(from) && (!to || visible.has(to)));
  return Boolean(from && to && visible.has(from) && visible.has(to));
}

export function sanitizeStockTransferForVisibleSites(item, visibleSiteIds = [], { isAdmin = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item) || isAdmin) return item;
  const transfer = item.tankTransfer;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) return item;
  const visible = siteSet(visibleSiteIds);
  const canView = transfer.status === "in_transit"
    ? Boolean(text(transfer.fromSiteId) && visible.has(text(transfer.fromSiteId)))
    : transfer.status === "dispatched"
    ? Boolean(text(transfer.dispatchSiteId) && visible.has(text(transfer.dispatchSiteId)))
    : transfer.status === "received" && Boolean(text(transfer.toSiteId) && visible.has(text(transfer.toSiteId)));
  if (canView) {
    if (transfer.status !== "dispatched") return item;
    const { orderId: _orderId, shipmentId: _shipmentId, ...safeTransfer } = transfer;
    return { ...item, tankTransfer: safeTransfer };
  }
  const { tankTransfer: _hiddenTransfer, ...sanitized } = item;
  return sanitized;
}

export function sanitizeBioRecordTransferForVisibleSites(record, visibleSiteIds = [], { isAdmin = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record) || isAdmin) return record;
  const sourceType = text(record.sourceType);
  const isMove = MOVE_SOURCE_TYPES.has(sourceType) || /^移缸(?:签发|签收)?[：:]/.test(text(record.text));
  if (!isMove) return record;
  const visible = siteSet(visibleSiteIds);
  const { orderId: _orderId, shipmentId: _shipmentId, ...safeRecord } = record;
  if (canViewTransferRoute({
    sourceType,
    fromSiteId: record.fromSiteId,
    toSiteId: record.toSiteId,
    dispatchSiteId: record.dispatchSiteId,
  }, visible)) return Object.hasOwn(record, "orderId") || Object.hasOwn(record, "shipmentId") ? safeRecord : record;
  const sanitized = {
    ...safeRecord,
    text: "移缸记录；未授权或未结构化保存的历史位置已隐藏",
    photos: [],
    videos: [],
  };
  for (const field of TRANSFER_ROUTE_FIELDS) delete sanitized[field];
  return sanitized;
}
