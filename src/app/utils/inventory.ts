import type { Order, Shipment, StockItem } from "../store";

export function normalizeInventoryId(value: unknown): string {
  return String(value ?? "").trim();
}

const inventoryId = normalizeInventoryId;

export function getShippedOutStockIds(
  shipments: Shipment[] = [],
  orders: Order[] = [],
  projectedOutStockIds: readonly unknown[] = [],
): Set<string> {
  const shippedIds = new Set(
    shipments
      .filter((shipment) => shipment.status !== "preparing")
      .flatMap((shipment) => shipment.itemStockIds ?? [])
      .map(inventoryId)
      .filter(Boolean)
  );
  orders.forEach((order) => {
    // Completion is the only order-level state that proves every remaining item
    // was fulfilled; shipped/damaged can still be partial.
    if (order.status !== "completed") return;
    order.items.forEach((item) => {
      const stockItemId = inventoryId(item.stockItemId);
      if (stockItemId && !item.inventoryRemovedAt) shippedIds.add(stockItemId);
    });
  });
  projectedOutStockIds.forEach((id) => {
    const stockItemId = inventoryId(id);
    if (stockItemId) shippedIds.add(stockItemId);
  });
  return shippedIds;
}

export function getInventoryOutStockIds(state: {
  shipments?: Shipment[];
  orders?: Order[];
  inventoryProjection?: { outStockIds?: readonly unknown[] };
} = {}): Set<string> {
  return getShippedOutStockIds(
    state.shipments ?? [],
    state.orders ?? [],
    state.inventoryProjection?.outStockIds ?? [],
  );
}

export function isPhysicallyInTank(item: StockItem, shippedOutStockIds: Set<string>): boolean {
  return !item.lost && !shippedOutStockIds.has(inventoryId(item.id));
}

export function getInventoryHiddenStockIds(
  shipments: Shipment[] = [],
  orders: Order[] = [],
  projectedOutStockIds: readonly unknown[] = [],
): Set<string> {
  return getShippedOutStockIds(shipments, orders, projectedOutStockIds);
}

export function isVisibleInStockInventory(item: StockItem, hiddenStockIds: Set<string>): boolean {
  return !item.lost && !hiddenStockIds.has(inventoryId(item.id));
}
