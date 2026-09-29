import type { OrderItem, Shipment, StockItem, TankGroup } from "../store";

export type StockLocationSnapshot = { siteId: string; subTankId: string };
export type ExpectedStockLocations = Record<string, StockLocationSnapshot>;

/** Sold fish remain eligible for their own order after an authorized cross-site move. */
export function orderOutboundItems(items: OrderItem[], shipments: Shipment[], accessibleStock: StockItem[]) {
  const shippedItemIds = new Set(shipments.filter((shipment) => shipment.status !== "preparing")
    .flatMap((shipment) => shipment.itemStockIds ?? []));
  const inventoryActiveItems = items.filter((item) => !item.inventoryRemovedAt);
  const unshippedItems = inventoryActiveItems.filter((item) => !shippedItemIds.has(item.stockItemId));
  const findStock = (id: string) => accessibleStock.find((stock) => stock.id === id);
  return {
    shippedItemIds,
    inventoryActiveItems,
    unshippedItems,
    lostUnshippedItems: unshippedItems.filter((item) => findStock(item.stockItemId)?.lost),
    unavailableUnshippedItems: unshippedItems.filter((item) => !findStock(item.stockItemId)),
    shippableUnshippedItems: unshippedItems.filter((item) => {
      const stock = findStock(item.stockItemId);
      return Boolean(stock) && !stock?.lost;
    }),
  };
}

/** The current physical tank takes precedence over the stock's older site snapshot. */
export function stockLocationSnapshot(
  stock: Pick<StockItem, "subTankId" | "siteId"> | undefined,
  tankGroups: readonly Pick<TankGroup, "siteId" | "subTanks">[],
): StockLocationSnapshot | undefined {
  if (!stock) return undefined;
  const group = tankGroups.find((entry) => entry.subTanks.some((tank) => tank.id === stock.subTankId));
  return {
    siteId: String(group?.siteId ?? stock.siteId ?? "nanjing").trim() || "nanjing",
    subTankId: String(stock.subTankId ?? "").trim(),
  };
}

export function currentTankLocationLabel(
  subTankId: string,
  tankGroups: readonly Pick<TankGroup, "siteId" | "name" | "subTanks">[],
  sites: readonly { id: string; name: string }[],
): string {
  for (const group of tankGroups) {
    const tank = group.subTanks.find((entry) => entry.id === subTankId);
    if (!tank) continue;
    const siteId = String(group.siteId ?? "nanjing").trim() || "nanjing";
    return `${sites.find((site) => site.id === siteId)?.name ?? siteId} · ${group.name} / ${tank.name}`;
  }
  return "缸位暂不可见";
}

/** Preserve the location shown when the dialog opened, not a later background refresh. */
export function selectExpectedStockLocations(selectedItemIds: string[], snapshots: ExpectedStockLocations): ExpectedStockLocations | null {
  const selected: ExpectedStockLocations = {};
  for (const id of selectedItemIds) {
    const location = snapshots[id];
    if (!location?.siteId || !location.subTankId) return null;
    selected[id] = { ...location };
  }
  return selected;
}
