const PICKUP_ORDER_SOURCES = new Set(["线下", "线下自提"]);
const ACTUAL_SHIPPING_FEE_MODES = new Set(["prepaid", "free"]);

export function requiredShipMethodForOrderSource(source = "") {
  return PICKUP_ORDER_SOURCES.has(String(source ?? "").trim()) ? "pickup" : "express";
}

export function actualShippingFeeRequiredAtOutbound(mode = "") {
  // The carrier normally confirms the real amount after pickup. Both prepaid
  // and free-shipping orders may therefore leave outbound with a pending fee.
  // Keep this helper for callers and older tests, but no fee mode is finalized
  // at the physical outbound step.
  void mode;
  return false;
}

export function shipmentHasPendingActualShippingFee(mode = "", shipment = {}) {
  if (!ACTUAL_SHIPPING_FEE_MODES.has(String(mode ?? "").trim())) return false;
  if (String(shipment?.shipMethod ?? "express") === "pickup") return false;
  if (String(shipment?.status ?? "") === "preparing") return false;
  return Number(shipment?.actualShippingFee ?? 0) <= 0;
}

export function shipmentsHavePendingActualShippingFee(mode = "", shipments = []) {
  return (Array.isArray(shipments) ? shipments : [])
    .some((shipment) => shipmentHasPendingActualShippingFee(mode, shipment));
}
