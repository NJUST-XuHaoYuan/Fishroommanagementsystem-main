export type StockOrderItemLink = {
  stockItemId?: unknown;
  inventoryRemovedAt?: unknown;
};

export type StockLinkedOrder = {
  id?: unknown;
  orderNo?: unknown;
  date?: unknown;
  status?: unknown;
  items?: readonly StockOrderItemLink[];
};

export function orderItemKeepsInventory(item: StockOrderItemLink): boolean {
  return !String(item?.inventoryRemovedAt ?? "").trim();
}

export function linkedOrdersForStock<T extends StockLinkedOrder>(
  orders: readonly T[],
  stockItemId: string,
): T[] {
  const targetId = String(stockItemId ?? "").trim();
  if (!targetId) return [];

  return orders
    .filter((order) =>
      String(order?.status ?? "") !== "cancelled" &&
      (Array.isArray(order?.items) ? order.items : []).some((item) =>
        String(item?.stockItemId ?? "") === targetId && orderItemKeepsInventory(item)
      )
    )
    .sort((left, right) => {
      const byDate = String(right?.date ?? "").localeCompare(String(left?.date ?? ""));
      if (byDate) return byDate;
      return String(right?.orderNo ?? "").localeCompare(String(left?.orderNo ?? ""));
    });
}
