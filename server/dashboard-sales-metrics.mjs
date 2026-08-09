const FINANCE_ONLY_REFUND_SOURCES = new Set(["finance", "platform", "statement"]);
const ACTUALLY_SHIPPED_STATUSES = new Set(["shipped", "delivered", "damaged"]);

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

export function dashboardDatePart(value) {
  const date = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function comparableMoment(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.replace(" ", "T");
  return normalized.length === 10 ? `${normalized}T00:00:00` : normalized;
}

function refundBusinessRecord(payment = {}) {
  const currentSource = String(payment?.recordSource ?? "").trim();
  const original = currentSource === "statement" && payment?.statementOriginal && typeof payment.statementOriginal === "object"
    ? payment.statementOriginal
    : null;
  return {
    source: String(original?.recordSource ?? currentSource).trim(),
    time: original?.time || payment?.time,
  };
}

export function unshippedRefundRecordedAt(payment = {}) {
  return comparableMoment(refundBusinessRecord(payment).time);
}

function shipmentWasActuallyFulfilled(shipment = {}) {
  const status = String(shipment?.status ?? "").trim();
  if (shipment?.shipMethod === "pickup" && status !== "preparing") return true;
  return ACTUALLY_SHIPPED_STATUSES.has(status) || Boolean(String(shipment?.shippedAt ?? "").trim());
}

export function shipmentFulfilledAt(shipment = {}) {
  if (!shipmentWasActuallyFulfilled(shipment)) return "";
  const candidates = shipment?.shipMethod === "pickup"
    ? [shipment.deliveredAt, shipment.shippedAt, shipment.outboundDate, shipment.createdAt, shipment.shipDate]
    : [shipment.shippedAt, shipment.deliveredAt, shipment.shipDate, shipment.outboundDate, shipment.createdAt];
  return candidates.map(comparableMoment).find(Boolean) ?? "";
}

export function isUnshippedOrderRefund(payment = {}, orderShipments = []) {
  if (String(payment?.type ?? "") !== "refund") return false;
  const businessRecord = refundBusinessRecord(payment);
  if (FINANCE_ONLY_REFUND_SOURCES.has(businessRecord.source)) return false;

  const fulfilledAt = (Array.isArray(orderShipments) ? orderShipments : [])
    .map(shipmentFulfilledAt)
    .filter(Boolean)
    .sort()[0] ?? "";
  if (!fulfilledAt) return true;

  const refundAt = comparableMoment(businessRecord.time);
  return Boolean(refundAt) && refundAt < fulfilledAt;
}

function legacyDamagePaymentTime(shipment = {}, order = {}) {
  const fulfilledAt = shipmentFulfilledAt(shipment);
  const expectedAmount = money(shipment?.damageRefundAmount);
  const candidates = (Array.isArray(order?.payments) ? order.payments : [])
    .filter((payment) => String(payment?.type ?? "") === "refund")
    .filter((payment) => !FINANCE_ONLY_REFUND_SOURCES.has(refundBusinessRecord(payment).source))
    .filter((payment) => {
      const time = unshippedRefundRecordedAt(payment);
      if (!time || (fulfilledAt && time < fulfilledAt)) return false;
      return expectedAmount <= 0.005 || Math.abs(money(payment?.amount) - expectedAmount) <= 0.005;
    })
    .map(unshippedRefundRecordedAt)
    .filter(Boolean)
    .sort();
  return candidates[0] ?? "";
}

export function shipmentDamagedAt(shipment = {}, order = {}) {
  if (String(shipment?.status ?? "") !== "damaged") return "";
  return comparableMoment(shipment?.damagedAt) ||
    legacyDamagePaymentTime(shipment, order) ||
    comparableMoment(shipment?.deliveredAt) ||
    comparableMoment(shipment?.shippedAt) ||
    comparableMoment(shipment?.shipDate) ||
    comparableMoment(shipment?.createdAt);
}

export function shipmentDamageAmount(shipment = {}, order = {}) {
  if (String(shipment?.status ?? "") !== "damaged") return 0;
  if (shipment?.damageAmount != null) return money(shipment.damageAmount);
  if (shipment?.damageRefundAmount != null) return money(shipment.damageRefundAmount);

  const damagedIds = new Set(
    (Array.isArray(shipment?.damageItemStockIds) ? shipment.damageItemStockIds : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean)
  );
  if (damagedIds.size === 0) return 0;
  return money((Array.isArray(order?.items) ? order.items : [])
    .filter((item) => damagedIds.has(String(item?.stockItemId ?? "")))
    .reduce((sum, item) => sum + Number(item?.price ?? 0), 0));
}

export function dashboardOrderAdjustmentTotals(orders = [], shipments = [], date = "") {
  const targetDate = dashboardDatePart(date);
  if (!targetDate) return { unshippedRefund: 0, shippedDamage: 0 };

  const orderById = new Map((Array.isArray(orders) ? orders : [])
    .map((order) => [String(order?.id ?? ""), order]));
  const shipmentsByOrderId = new Map();
  for (const shipment of Array.isArray(shipments) ? shipments : []) {
    const orderId = String(shipment?.orderId ?? "");
    shipmentsByOrderId.set(orderId, [...(shipmentsByOrderId.get(orderId) ?? []), shipment]);
  }

  let unshippedRefund = 0;
  for (const order of Array.isArray(orders) ? orders : []) {
    const orderShipments = shipmentsByOrderId.get(String(order?.id ?? "")) ?? [];
    for (const payment of Array.isArray(order?.payments) ? order.payments : []) {
      if (dashboardDatePart(unshippedRefundRecordedAt(payment)) !== targetDate) continue;
      if (isUnshippedOrderRefund(payment, orderShipments)) {
        unshippedRefund += Number(payment?.amount ?? 0);
      }
    }
  }

  let shippedDamage = 0;
  for (const shipment of Array.isArray(shipments) ? shipments : []) {
    const order = orderById.get(String(shipment?.orderId ?? "")) ?? {};
    if (dashboardDatePart(shipmentDamagedAt(shipment, order)) !== targetDate) continue;
    shippedDamage += shipmentDamageAmount(shipment, order);
  }

  return {
    unshippedRefund: money(unshippedRefund),
    shippedDamage: money(shippedDamage),
  };
}
