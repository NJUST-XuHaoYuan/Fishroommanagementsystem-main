import type { Order, Shipment, ShippingFeeMode } from "../store";

export const SHIPPING_FEE_MODE_OPTIONS: Array<{ value: ShippingFeeMode; label: string; hint: string }> = [
  { value: "collect", label: "到付", hint: "客户向承运方支付，不计订单应收" },
  { value: "prepaid", label: "寄付", hint: "运费计入订单应收" },
  { value: "free", label: "包邮", hint: "实际运费计入包邮折扣" },
];

export function orderShippingFeeMode(order?: Pick<Order, "shippingFeeMode" | "source"> | null): ShippingFeeMode {
  if (["线下", "线下自提"].includes(String(order?.source ?? "").trim())) return "collect";
  return order?.shippingFeeMode === "collect" || order?.shippingFeeMode === "free"
    ? order.shippingFeeMode
    : "prepaid";
}

export function shippingFeeModeLabel(mode?: ShippingFeeMode | string): string {
  return SHIPPING_FEE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "寄付";
}

export function shipmentCountsForFees(shipment: Shipment): boolean {
  return shipment.status !== "preparing";
}

export function getBillableShippingFee(order: Order, shipments: Shipment[]): number {
  if (orderShippingFeeMode(order) === "collect") return 0;
  const active = shipments.filter((shipment) => shipment.orderId === order.id && shipmentCountsForFees(shipment));
  if (active.length === 0) return Number(order.shippingFee ?? 0);
  return active.reduce((sum, shipment) => sum + Number(shipment.actualShippingFee ?? 0), 0);
}

export function shippingDiscountForOrder(order: Order, shipments: Shipment[]): number {
  return orderShippingFeeMode(order) === "free" ? getBillableShippingFee(order, shipments) : 0;
}

export function customerShippingCharge(order: Order, shipments: Shipment[]): number {
  return orderShippingFeeMode(order) === "prepaid" ? getBillableShippingFee(order, shipments) : 0;
}
