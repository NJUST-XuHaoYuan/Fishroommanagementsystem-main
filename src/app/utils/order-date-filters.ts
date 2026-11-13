type PlannedShipmentOrder = {
  status?: string;
  plannedShipDate?: string;
  items?: readonly { plannedShipDate?: string; inventoryRemovedAt?: string }[];
};

/** Business dates use Beijing time, regardless of the operator's device timezone. */
export function beijingOrderCalendar(now = new Date()): { today: string; tomorrow: string } {
  const beijingTime = now.getTime() + 8 * 60 * 60 * 1000;
  return {
    today: new Date(beijingTime).toISOString().slice(0, 10),
    tomorrow: new Date(beijingTime + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

/** Both bounds are inclusive; an absent bound leaves that end open. */
export function matchesPlannedShipmentRange(
  order: PlannedShipmentOrder,
  { from = "", to = "" }: { from?: string; to?: string },
): boolean {
  if (!from && !to) return true;
  if (order.status === "cancelled" || (from && to && from > to)) return false;
  // Current orders have one plan. Only fall back to legacy item plans when it is absent.
  const dates = order.plannedShipDate
    ? [order.plannedShipDate]
    : (order.items ?? []).filter((item) => !item.inventoryRemovedAt).map((item) => item.plannedShipDate);
  return dates.some((date) => Boolean(date) && (!from || date! >= from) && (!to || date! <= to));
}
