import type {
  MaintenanceSaveChange,
  MaintenanceSaveResult,
  MaintenanceStockExpectedSnapshot,
  StockItem,
} from "../store";

export type MaintenanceMutationTicket = {
  clientMutationId: string;
  fingerprint: string;
};

type MaintenanceRequestLock = { current: boolean };

export function isMaintenanceRequestInFlight(lock: MaintenanceRequestLock): boolean {
  return lock.current;
}

export function beginMaintenanceRequest(lock: MaintenanceRequestLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function finishMaintenanceRequest(lock: MaintenanceRequestLock): void {
  lock.current = false;
}

export function maintenanceSaveFailure(
  message: unknown,
  status = 0,
  code?: unknown,
): MaintenanceSaveResult {
  const error = String(message ?? "")
    .replace(/^Failed to save maintenance action:\s*/i, "")
    .trim() || "维护保存失败，请重试";
  const normalizedCode = String(code ?? "").trim();
  return {
    ok: false,
    error,
    ...(normalizedCode ? { code: normalizedCode } : {}),
    conflict: status === 409,
  };
}

export function createMaintenanceClientMutationId(): string {
  const randomPart = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `maintenance-${randomPart}`;
}

type WithoutMutationId<T> = T extends unknown ? Omit<T, "clientMutationId"> : never;
export type MaintenanceChangeWithoutId = WithoutMutationId<MaintenanceSaveChange>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)])
  );
}

export function maintenanceStockExpectedSnapshot(
  item: Pick<StockItem, "id" | "subTankId" | "status" | "lost">
): MaintenanceStockExpectedSnapshot {
  return {
    id: String(item.id),
    subTankId: String(item.subTankId ?? ""),
    status: item.status,
    lost: item.lost === true,
  };
}

/**
 * Reuse the same mutation id while the semantic request is unchanged. If a
 * user edits the form after a failed request, the changed fingerprint creates
 * a new logical mutation instead of conflicting with the prior id.
 */
export function maintenanceMutationTicket(
  previous: MaintenanceMutationTicket | null,
  change: MaintenanceChangeWithoutId,
  createId: () => string,
): MaintenanceMutationTicket {
  const fingerprint = JSON.stringify(canonicalValue(change));
  if (previous?.fingerprint === fingerprint) return previous;
  return {
    clientMutationId: createId(),
    fingerprint,
  };
}
