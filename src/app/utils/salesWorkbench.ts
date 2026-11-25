import type { Order, Shipment } from "../store";
import { getRegisteredOrderCashSummary } from "./shippingSettlement.ts";
import { shipmentFulfillmentState } from "./shipmentFulfillmentCorrection.ts";

export type SalesTodoKind = "collection" | "shipment" | "followup";
export type FollowupSummaryRow = { orderId: string; followupCount: number; lastFollowupAt: string };

export function salesCollectionRemaining(order: Order, amountDue: number): number | null {
  if (order.status === "cancelled") return 0;
  const cash = getRegisteredOrderCashSummary(order);
  if (cash.invalidRecordCount > 0 || !Number.isFinite(amountDue) || !Number.isFinite(cash.netRecorded)) return null;
  return Math.max(0, Math.round((amountDue - cash.netRecorded) * 100) / 100);
}

/** Outbound fish still need dispatch; an order status alone does not establish fulfillment. */
export function salesPendingShipment(order: Order, shipments: Shipment[]): { pending: boolean; label: string } {
  if (order.status === "cancelled" || order.status === "completed") return { pending: false, label: "" };
  const ownShipments = shipments.filter(shipment => shipment.orderId === order.id);
  const activeItems = order.items.filter(item => !item.inventoryRemovedAt);
  const actualIds = new Set(ownShipments.filter(shipment => shipment.status !== "preparing" && shipment.status !== "outbound"
    && (shipment.shipMethod === "pickup" || ["shipped", "delivered", "damaged"].includes(shipment.status) || Boolean(shipment.shippedAt)))
    .flatMap(shipment => shipment.itemStockIds || []));
  const pickup = ["线下", "线下自提"].includes(String(order.source || "").trim());
  if (ownShipments.some(shipment => shipmentFulfillmentState(shipment)?.shippingTimePending)) return { pending: true, label: "发货时间待核实" };
  if (ownShipments.some(shipment => shipment.status === "outbound")) return { pending: true, label: pickup ? "待确认自提" : "已出库，待发货" };
  if (activeItems.some(item => !actualIds.has(item.stockItemId))) {
    return { pending: true, label: pickup ? "待自提" : actualIds.size ? "部分待发货" : "待出库发货" };
  }
  if (ownShipments.some(shipment => shipment.status === "preparing" && shipment.itemStockIds?.length)) return { pending: true, label: pickup ? "待自提" : "待出库发货" };
  return { pending: false, label: "" };
}

export function readOrderFollowupSummary(payload: unknown, siteId: string): FollowupSummaryRow[] {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (body?.ok !== true || body.siteId !== siteId || !Array.isArray(body.orders)) throw new Error("回访待办返回异常，请刷新后重试。");
  const seen = new Set<string>();
  return body.orders.map(value => {
    const row = value as Record<string, unknown> | null;
    if (!row || typeof row.orderId !== "string" || !row.orderId || seen.has(row.orderId)
      || !Number.isSafeInteger(row.followupCount) || Number(row.followupCount) < 0
      || (row.lastFollowupAt != null && typeof row.lastFollowupAt !== "string")) throw new Error("回访待办返回异常，请刷新后重试。");
    seen.add(row.orderId);
    return { orderId: row.orderId, followupCount: Number(row.followupCount), lastFollowupAt: String(row.lastFollowupAt || "") };
  });
}
