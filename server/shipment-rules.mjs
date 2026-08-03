const PICKUP_ORDER_SOURCES = new Set(["线下", "线下自提"]);

export function requiredShipMethodForOrderSource(source = "") {
  return PICKUP_ORDER_SOURCES.has(String(source ?? "").trim()) ? "pickup" : "express";
}
