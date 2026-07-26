export type OrderSearchableRow = {
  searchText?: unknown;
  fishSearchCodes?: readonly unknown[];
  orderNo?: unknown;
};

export const ORDER_SEARCH_NO_MATCH = Number.POSITIVE_INFINITY;

export function normalizeOrderSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[－–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeOrderFishCode(value: unknown): string {
  return normalizeOrderSearchText(value).replace(/[\s\-_]/g, "");
}

export function orderSearchRank(row: OrderSearchableRow, query: string): number {
  const term = normalizeOrderSearchText(query);
  if (!term) return 0;

  const fishTerm = normalizeOrderFishCode(query);
  const fishCodes = (row.fishSearchCodes ?? [])
    .map(normalizeOrderFishCode)
    .filter(Boolean);

  if (fishTerm) {
    if (fishCodes.some((code) => code === fishTerm)) return 0;
    if (fishCodes.some((code) => code.startsWith(fishTerm))) return 1;
    if (fishCodes.some((code) => code.includes(fishTerm))) return 2;
  }

  const orderNo = normalizeOrderSearchText(row.orderNo);
  if (orderNo === term) return 3;
  if (orderNo.includes(term)) return 4;

  return normalizeOrderSearchText(row.searchText).includes(term)
    ? 5
    : ORDER_SEARCH_NO_MATCH;
}

export function rankOrderSearchRows<T extends OrderSearchableRow>(
  rows: readonly T[],
  query: string
): T[] {
  if (!normalizeOrderSearchText(query)) return [...rows];

  return rows
    .map((row, index) => ({ row, index, rank: orderSearchRank(row, query) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => row);
}
