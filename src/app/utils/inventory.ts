import type { Shipment, StockItem } from "../store";

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
