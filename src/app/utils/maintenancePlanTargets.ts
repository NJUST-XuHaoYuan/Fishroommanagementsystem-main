import type { Store, StockItem, TankGroup } from "../store";
import { getInventoryOutStockIds, isPhysicallyInTank } from "./inventory";
import { matchesSite } from "./sites";

export type PlanTarget = { targetType: "group" | "fish"; tankId: string; stockItemId?: string };
export const GROUP_PLAN_TYPES = ["inspection", "feeding", "water_change", "measurement", "treatment", "other"] as const;
export const FISH_PLAN_TYPES = ["inspection", "treatment", "media", "other"] as const;
export function maintenanceTypeAllowed(targetType: PlanTarget["targetType"], type: string): boolean {
  return (targetType === "fish" ? FISH_PLAN_TYPES : GROUP_PLAN_TYPES).includes(type as never);
}
export function maintenanceRecordAction(type: string, targetType: PlanTarget["targetType"]): string {
  return ({ inspection: "观察", feeding: "喂食", water_change: "换水", measurement: "水质", treatment: targetType === "fish" ? "治疗" : "下药", media: "拍照／视频", other: "其他" } as Record<string, string>)[type] || "其他";
}
export function maintenanceOperationLabel(type: string, targetType: PlanTarget["targetType"]): string {
  return type === "measurement" ? "测水质" : type === "treatment" && targetType === "group" ? "水体下药" : maintenanceRecordAction(type, targetType);
}
export function maintenanceTargetKey(target: PlanTarget): string { return `${target.targetType}:${target.targetType === "fish" ? target.stockItemId : target.tankId}`; }
export function maintenancePlanTargets(state: Store, siteId: string, batchId = ""): { groups: TankGroup[]; fish: StockItem[] } {
  const outIds = getInventoryOutStockIds(state);
  const groups = state.tankGroups.filter(group => matchesSite(group, siteId));
  const subIds = new Set(groups.flatMap(group => group.subTanks.map(sub => sub.id)));
  const fish = state.stock.filter(item => subIds.has(item.subTankId) && isPhysicallyInTank(item, outIds) && (!batchId || item.batchId === batchId));
  const occupied = new Set(fish.map(item => item.subTankId));
  return { groups: batchId ? groups.filter(group => group.subTanks.some(sub => occupied.has(sub.id))) : groups, fish };
}
export function planTargetSummary(target: PlanTarget, state: Store): string {
  const group = state.tankGroups.find(group => group.id === target.tankId);
  if (target.targetType === "group") return `${group?.name || "原缸组"} · 整个缸组`;
  const item = state.stock.find(item => item.id === target.stockItemId);
  return `${state.products.find(product => product.id === item?.productId)?.name || "鱼只"} · ${item?.code || target.stockItemId}`;
}

export function pendingMaintenanceCompletionState(tasks: import("./maintenanceWorkbench").MaintenanceTask[], pending: { taskId: string; completion: import("./maintenanceWorkbench").MaintenanceCompletion }): "resolved" | "retry" | "unavailable" {
  const task = tasks.find(task => task.id === pending.taskId);
  if (task?.status === "completed" && task.completion?.kind === pending.completion.kind && task.completion?.recordId === pending.completion.recordId) return "resolved";
  if (!task || !["pending", "in_progress"].includes(task.status) || task.targetUnavailable) return "unavailable";
  return "retry";
}
