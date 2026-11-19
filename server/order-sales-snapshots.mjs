import { orderHasActuallyShipped } from "./order-refund-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const money = value => Number((Number.isFinite(Number(value)) ? Number(value) : 0).toFixed(2));

/** The order agreement, before later returns, damage adjustments or carrier fees. */
export function originalOrderSalesAmount(order = {}) {
  const goods = list(order.items).reduce((sum, item) => sum + Number(item?.price || 0), 0);
  const shippingMode = ["线下", "线下自提"].includes(text(order.source)) ? "collect" : text(order.shippingFeeMode) || "prepaid";
  return money(Math.max(0, goods + (shippingMode === "prepaid" ? Number(order.shippingFee || 0) : 0) +
    Number(order.packagingFee || 0) - Number(order.discount || 0)));
}

export function captureOrderSalesAmount(order = {}, capturedAt, source = "legacy") {
  if (order.salesAmountSnapshot) return order;
  return { ...order, salesAmountSnapshot: { amount: originalOrderSalesAmount(order), capturedAt: text(capturedAt), source } };
}

/** Use the pre-mutation order when capturing old data; never infer a lost old price. */
export function preserveOrderSalesSnapshots(before = {}, after = {}, capturedAt) {
  const previous = new Map(list(before.orders).map(order => [text(order.id), order]));
  return { ...after, orders: list(after.orders).map(order => {
    const old = previous.get(text(order.id));
    if (!old) return captureOrderSalesAmount(order, capturedAt, "created");
    if (old.salesAmountSnapshot) return { ...order, salesAmountSnapshot: old.salesAmountSnapshot };
    // Unrelated orders need not acquire a misleading migration timestamp.
    if (JSON.stringify(old) === JSON.stringify(order)) return order;
    return { ...order, salesAmountSnapshot: captureOrderSalesAmount(old, capturedAt).salesAmountSnapshot };
  }) };
}

function fail() {
  const error = new Error("订单成交金额及退款业务快照由系统保存，不能手工修改");
  error.statusCode = 409;
  error.code = "ORDER_SALES_SNAPSHOT_IMMUTABLE";
  throw error;
}

export const REFUND_METADATA_FIELDS = ["refundStage", "refundOccurredAt", "refundItems", "refundShipmentId"];

export function refundMetadataSnapshot(record = {}) {
  return Object.fromEntries(REFUND_METADATA_FIELDS.filter(key => own(record, key)).map(key => [key, record[key]]));
}

export function assertRefundMetadataUnchanged(before = {}, after = {}, { partial = false } = {}) {
  for (const key of REFUND_METADATA_FIELDS) {
    if (partial && !own(after, key)) continue;
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) fail();
  }
}

export function assertOrderSalesMetadataUnchanged(before, after = {}, { partial = true } = {}) {
  if ((!partial || own(after, "salesAmountSnapshot")) && JSON.stringify(before?.salesAmountSnapshot) !== JSON.stringify(after.salesAmountSnapshot)) fail();
  if (own(after, "payments")) {
    const previous = new Map(list(before?.payments).map(payment => [text(payment.id), payment]));
    for (const payment of list(after.payments)) assertRefundMetadataUnchanged(previous.get(text(payment.id)), payment, { partial });
  }
}

export function refundMetadataForOrder(order = {}, shipments = [], { time, stage, stockItemIds } = {}) {
  const refundStage = stage || (order.status === "completed" || orderHasActuallyShipped(shipments, order.id) ? "after_shipment" : "before_shipment");
  const selected = stockItemIds ? new Set(list(stockItemIds).map(text)) : null;
  const items = list(order.items).filter(item => !selected || selected.has(text(item.stockItemId)));
  return { refundStage, refundOccurredAt: text(time), refundShipmentId: "", refundItems: items.map(item => ({
    stockItemId: text(item.stockItemId), productId: text(item.productId), fishCode: text(item.fishCode), salePrice: money(item.price),
  })) };
}
