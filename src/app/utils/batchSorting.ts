import type { PurchaseBatch } from "../store";

type BatchDates = Pick<PurchaseBatch, "arrivalDate" | "createdAt">;

function arrivalTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return -Infinity;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : -Infinity;
}

/** Sort before filtering/pagination, without changing persisted batch order. */
export function sortBatchesNewestFirst<T extends BatchDates>(batches: readonly T[]): T[] {
  return batches.map((batch, index) => ({ batch, index,
    arrival: arrivalTime(batch.arrivalDate),
    created: Number.isFinite(Date.parse(batch.createdAt || "")) ? Date.parse(batch.createdAt!) : -Infinity,
  })).sort((a, b) => {
    if (a.arrival !== b.arrival) return a.arrival > b.arrival ? -1 : 1;
    if (a.created !== b.created) return a.created > b.created ? -1 : 1;
    return a.index - b.index;
  }).map(({ batch }) => batch);
}
