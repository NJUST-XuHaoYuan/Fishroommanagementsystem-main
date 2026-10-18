const id = (value) => String(value ?? "").trim();

export const STOCK_TRANSFER_IN_TRANSIT = "in_transit";
export const STOCK_TRANSFER_RECEIVED = "received";

export function isStockInTransfer(item = {}) {
  return String(item?.tankTransfer?.status ?? "").trim() === STOCK_TRANSFER_IN_TRANSIT;
}

export function stockTransferId(item = {}) {
  return id(item?.tankTransfer?.id);
}

export function stockTransferConcurrencySnapshot(item = {}) {
  const transfer = item?.tankTransfer;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) return null;
  return {
    id: id(transfer.id),
    status: String(transfer.status ?? "").trim(),
    issuedAt: String(transfer.issuedAt ?? "").trim(),
    issuedBy: String(transfer.issuedBy ?? "").trim(),
    fromSiteId: id(transfer.fromSiteId),
    fromSubTankId: id(transfer.fromSubTankId),
    fromTankName: String(transfer.fromTankName ?? "").trim(),
    notes: String(transfer.notes ?? "").trim(),
    receivedAt: String(transfer.receivedAt ?? "").trim(),
    receivedBy: String(transfer.receivedBy ?? "").trim(),
    toSiteId: id(transfer.toSiteId),
    toSubTankId: id(transfer.toSubTankId),
    toTankName: String(transfer.toTankName ?? "").trim(),
  };
}

export function activeTransferStockIds(state = {}) {
  return new Set((Array.isArray(state?.stock) ? state.stock : [])
    .filter(isStockInTransfer)
    .map((item) => id(item?.id))
    .filter(Boolean));
}

export function assertStockIdsNotInTransfer(state = {}, stockIds = [], message = "移缸在途的鱼不能执行该操作") {
  const activeIds = activeTransferStockIds(state);
  const blocked = (Array.isArray(stockIds) ? stockIds : [])
    .map(id)
    .find((stockId) => stockId && activeIds.has(stockId));
  if (!blocked) return true;
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "STOCK_IN_TRANSFER";
  throw error;
}
