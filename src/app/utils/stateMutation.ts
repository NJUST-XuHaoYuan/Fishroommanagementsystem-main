export function mapArrayCopyOnWrite<T>(
  items: readonly T[],
  mapItem: (item: T, index: number) => T,
): T[] {
  let changed = false;
  const mapped = items.map((item, index) => {
    const nextItem = mapItem(item, index);
    if (!Object.is(nextItem, item)) changed = true;
    return nextItem;
  });
  return changed ? mapped : items as T[];
}

export function changedObjectKeys<T extends object, K extends keyof T>(
  before: T,
  after: T,
  keys: readonly K[],
): K[] {
  return keys.filter((key) => {
    const beforeValue = before[key] ?? null;
    const afterValue = after[key] ?? null;
    if (Object.is(beforeValue, afterValue)) return false;
    return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
  });
}

export function isCurrentStateRequest(
  requestedUserKey: string,
  currentUserKey: string,
  requestEpoch: number,
  currentEpoch: number,
): boolean {
  return Boolean(requestedUserKey) &&
    requestedUserKey === currentUserKey &&
    requestEpoch === currentEpoch;
}

export function latestStateVersion(currentVersion: string, candidateVersion: unknown): string {
  const current = String(currentVersion ?? "");
  const candidate = String(candidateVersion ?? "").trim();
  // A successfully accepted slice is authoritative even when production was
  // restored from a backup whose monotonic sequence is numerically smaller.
  return candidate || current;
}

export function hasStateVersionChanged(currentVersion: unknown, candidateVersion: unknown): boolean {
  const current = String(currentVersion ?? "").trim();
  const candidate = String(candidateVersion ?? "").trim();
  return Boolean(candidate) && candidate !== current;
}

export function isNewerStateVersion(currentVersion: unknown, candidateVersion: unknown): boolean {
  const current = String(currentVersion ?? "").trim();
  const candidate = String(candidateVersion ?? "").trim();
  if (!candidate) return false;
  if (!current) return true;
  if (/^\d+$/.test(current) && /^\d+$/.test(candidate)) {
    return BigInt(candidate) > BigInt(current);
  }
  // Rolling upgrades may briefly expose the legacy timestamp version. Treat
  // any different opaque value as changed instead of relying on lexicographic
  // ordering, which is unsafe for concurrent transaction timestamps.
  return candidate !== current;
}
