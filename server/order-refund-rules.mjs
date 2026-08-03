const ACTUALLY_SHIPPED_STATUSES = new Set(["shipped", "delivered", "damaged"]);

export function shipmentHasActuallyShipped(shipment = {}) {
  if (!shipment || typeof shipment !== "object") return false;
  const status = String(shipment.status ?? "").trim();
  if (shipment.shipMethod === "pickup" && status !== "preparing") return true;
  return ACTUALLY_SHIPPED_STATUSES.has(status) || Boolean(String(shipment.shippedAt ?? "").trim());
}

export function orderHasActuallyShipped(shipments = [], orderId = "") {
  const normalizedOrderId = String(orderId ?? "").trim();
  if (!normalizedOrderId) return false;
  return (Array.isArray(shipments) ? shipments : []).some((shipment) =>
    String(shipment?.orderId ?? "") === normalizedOrderId && shipmentHasActuallyShipped(shipment)
  );
}
