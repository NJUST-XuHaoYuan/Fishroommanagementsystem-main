import type { Order, Shipment, StockItem } from "../store";

export function getShippedOutStockIds(shipments: Shipment[] = []): Set<string> {
  return new Set(
    shipments
      .filter((shipment) => shipment.status !== "preparing")
      .flatMap((shipment) => shipment.itemStockIds ?? [])
  );
}

export function isPhysicallyInTank(item: StockItem, shippedOutStockIds: Set<string>): boolean {
  return !item.lost && !shippedOutStockIds.has(item.id);
}

export function getInventoryHiddenStockIds(
  shipments: Shipment[] = [],
  orders: Order[] = [],
): Set<string> {
  const hiddenIds = getShippedOutStockIds(shipments);
  const ordersWithShipmentDetail = new Set(
    shipments
      .filter((shipment) => shipment.status !== "preparing")
      .map((shipment) => shipment.orderId)
      .filter(Boolean),
  );

  orders.forEach((order) => {
    if (order.status === "cancelled" || order.status === "pending" || order.status === "confirmed") return;
    if (order.status === "shipped" && ordersWithShipmentDetail.has(order.id)) return;
    order.items.forEach((item) => {
      if (item.stockItemId) hiddenIds.add(item.stockItemId);
    });
  });

  return hiddenIds;
}

export function isVisibleInStockInventory(item: StockItem, hiddenStockIds: Set<string>): boolean {
  return !item.lost && !hiddenStockIds.has(item.id);
}
