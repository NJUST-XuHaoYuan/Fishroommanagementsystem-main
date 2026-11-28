import type { TankGroup } from "../store";

type GroupHistoryRecord = { tankGroupId?: string; subTankId?: string; inheritedTankGroupIds?: string[] };
export function isInheritedMaintenanceHistory(record: GroupHistoryRecord): boolean {
  return Array.isArray(record.inheritedTankGroupIds) && record.inheritedTankGroupIds.length > 0;
}

/** One historical record can appear under several groups without being copied. */
export function maintenanceHistoryGroupIds(record: GroupHistoryRecord, groups: TankGroup[], fallbackId = ""): string[] {
  const visible = new Set(groups.map(group => group.id));
  if (isInheritedMaintenanceHistory(record)) return [...new Set(record.inheritedTankGroupIds)].filter(id => visible.has(id));
  const id = record.tankGroupId || fallbackId || groups.find(group => group.subTanks.some(tank => tank.id === record.subTankId))?.id;
  return id && visible.has(id) ? [id] : [];
}

export function maintenanceHistoryScopeLabel(record: GroupHistoryRecord, groups: TankGroup[], selectedGroupId = "all"): string {
  const ids = maintenanceHistoryGroupIds(record, groups);
  const names = ids.map(id => groups.find(group => group.id === id)?.name || "缸组");
  const name = selectedGroupId !== "all" && ids.includes(selectedGroupId)
    ? groups.find(group => group.id === selectedGroupId)?.name || "缸组"
    : names.length > 2 ? `${names.slice(0, 2).join("、")}等 ${names.length} 个缸组` : names.join("、") || "已删除缸组";
  return `${name}${isInheritedMaintenanceHistory(record) ? " · 历史继承" : ""}`;
}
