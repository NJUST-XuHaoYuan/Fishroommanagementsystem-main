const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const eventKey = (item) => `${text(item.stockItemId)}:${text(item.transferId)}:${text(item.shipmentId)}:${text(item.dispatchedAt)}`;

// Explicit projection: global transfer viewing never grants order/customer/cost
// access. Events outlive the stock's latest transfer and repeated transfer cycles.
export function recentStockTransferItems(state = {}, { visibleSiteIds = [], now = Date.now() } = {}) {
  const visible = new Set(list(visibleSiteIds).map(text));
  const sites = new Map(list(state.sites).map((site) => [text(site.id), text(site.name)]));
  const stocks = new Map(list(state.stock).map((item) => [text(item.id), item]));
  const products = new Map(list(state.products).map((item) => [text(item.id), item]));
  const records = list(state.transferRecords ?? state.bioRecords);
  const cancelled = new Set(records.filter((item) => item.sourceType === "stockTransferDispatchCancelled").map(eventKey));
  const completions = records.filter((item) => ["stockTransferReceived", "stockTransferDispatched"].includes(item.sourceType));
  // Compatibility for old snapshots that predate independent completion events.
  const seen = new Set(completions.map((item) => `${text(item.stockItemId)}:${text(item.transferId)}:${item.sourceType}`));
  for (const item of stocks.values()) {
    const transfer = item.tankTransfer;
    if (!["received", "dispatched"].includes(transfer?.status)) continue;
    const sourceType = transfer.status === "received" ? "stockTransferReceived" : "stockTransferDispatched";
    if (!seen.has(`${text(item.id)}:${text(transfer.id)}:${sourceType}`)) {
      completions.push({ ...transfer, stockItemId: item.id, transferId: transfer.id, sourceType });
    }
  }
  const cutoff = Number(now) - 30 * 24 * 60 * 60 * 1000;
  return completions.flatMap((record) => {
    const dispatched = record.sourceType === "stockTransferDispatched";
    if (dispatched && cancelled.has(eventKey(record))) return [];
    const completedAt = text(dispatched ? record.dispatchedAt : record.receivedAt);
    const timestamp = Date.parse(completedAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > Number(now)) return [];
    const fromSiteId = text(record.fromSiteId);
    const destination = text(dispatched ? record.dispatchSiteId : record.toSiteId);
    if (!visible.has(fromSiteId) && !visible.has(destination)) return [];
    const item = stocks.get(text(record.stockItemId));
    const product = products.get(text(item?.productId)) ?? {};
    return [{
      stockItemId: text(record.stockItemId), transferId: text(record.transferId),
      productId: text(item?.productId), productName: text(product.name) || "商品已删除",
      size: text(product.size), origin: text(product.origin), imageUrl: text(product.imageUrl),
      code: text(item?.code), status: text(item?.status), sold: Boolean(item?.sold),
      fromSiteId, fromSiteName: sites.get(fromSiteId) ?? "", fromSubTankId: text(record.fromSubTankId),
      fromTankName: text(record.fromTankName), issuedAt: text(record.issuedAt), issuedBy: text(record.issuedBy),
      notes: text(record.notes), transferStatus: dispatched ? "dispatched" : "received", completedAt,
      completedBy: text(dispatched ? record.dispatchedBy : record.receivedBy),
      ...(dispatched ? { dispatchSiteId: destination, dispatchSiteName: text(record.dispatchSiteName) || sites.get(destination) || "" }
        : { toSiteId: destination, toSiteName: sites.get(destination) ?? "", toSubTankId: text(record.toSubTankId), toTankName: text(record.toTankName) }),
    }];
  }).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.stockItemId.localeCompare(b.stockItemId)).slice(0, 200);
}
