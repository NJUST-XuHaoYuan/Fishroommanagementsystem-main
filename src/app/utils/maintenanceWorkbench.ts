export const MAINTENANCE_TYPES = {
  inspection: "观察巡检", feeding: "喂食", water_change: "换水清洁",
  measurement: "测水质", treatment: "下药 / 治疗", other: "其他", media: "鱼只照片视频",
} as const;
export type MaintenanceType = keyof typeof MAINTENANCE_TYPES;
export type MaintenanceStatus = "pending" | "in_progress" | "completed" | "cancelled";
export const MAINTENANCE_STATUS: Record<MaintenanceStatus, string> = {
  pending: "待执行", in_progress: "进行中", completed: "已完成", cancelled: "已取消",
};
export type MaintenanceTask = {
  id: string; siteId: string; title: string; type: MaintenanceType;
  targetType?: "group" | "fish"; stockItemId?: string; fishCode?: string; productName?: string;
  tankId?: string; subTankId?: string; tankName?: string; subTankName?: string; assignedTo?: string; dueDate: string; dueTime: string;
  status: MaintenanceStatus; notes?: string; planId?: string;
  createdAt: string; createdBy: string; createdByName?: string;
  startedAt?: string; startedBy?: string; startedByName?: string;
  completedAt?: string; completedBy?: string; completedByName?: string;
  cancelledAt?: string; cancelledBy?: string; cancelledByName?: string;
  result?: string; measurements?: Record<string, number>; medicineDescription?: string; reason?: string;
  updatedAt?: string; updatedBy?: string;
  completion?: { kind: "dailyLog" | "waterQualityRecord" | "bioRecord"; recordId: string; record: Record<string, unknown> };
  targetUnavailable?: boolean; targetUnavailableReason?: string;
  currentTankId?: string; currentTankName?: string; currentSubTankId?: string; currentSubTankName?: string;
};
export type MaintenancePlan = Pick<MaintenanceTask, "id" | "siteId" | "title" | "type" | "targetType" | "stockItemId" | "fishCode" | "productName" | "tankId" | "tankName" | "subTankId" | "assignedTo" | "notes" | "dueTime" | "targetUnavailable" | "targetUnavailableReason" | "currentTankId" | "currentTankName" | "currentSubTankId" | "currentSubTankName"> & {
  enabled: boolean; frequency: "daily" | "weekly"; weekdays: number[]; startDate: string;
  createdAt: string; createdBy: string; createdByName?: string; updatedAt?: string; updatedBy?: string;
};
export type MaintenanceHandoff = {
  id: string; content: string; assignedTo?: string; followUpAt?: string; taskId?: string;
  createdAt: string; createdBy: string; createdByName?: string;
};
export type MaintenanceHistory = {
  id: string; action: string; taskId?: string; planId?: string; title: string;
  operator: string; operatorName?: string; at: string; detail?: string;
  before?: Record<string, unknown>; after?: Record<string, unknown>;
};
export type MaintenanceSnapshot = {
  ok: true; siteId: string; revision: number; tasks: MaintenanceTask[];
  plans: MaintenancePlan[]; handoffs: MaintenanceHandoff[]; history: MaintenanceHistory[];
  permissions: { canCreate: boolean; canUpdate: boolean; canDelete: boolean };
  assignees?: { id: string; username: string; name: string }[];
  materializationPending?: boolean; replayed?: boolean;
};
export type MaintenanceTarget = { targetType: "group"; tankId: string } | { targetType: "fish"; stockItemId: string; tankId?: string };
export type MaintenanceCompletion = { kind: "dailyLog" | "waterQualityRecord" | "bioRecord"; recordId: string };
export function maintenanceTypesForTarget(target: "group" | "fish"): MaintenanceType[] {
  return target === "fish" ? ["inspection", "treatment", "media", "other"] : ["inspection", "feeding", "water_change", "measurement", "treatment", "other"];
}
export type MeasurementDraft = { name: string; value: string };

export function maintenanceToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Keep empty measurement inputs empty; never infer a healthy result or a zero. */
export function parseMaintenanceMeasurements(rows: MeasurementDraft[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const name = row.name.trim(), raw = row.value.trim();
    if (!name && !raw) continue;
    if (!name || !raw) throw new Error("每项水质记录都需要填写项目名称和实测值。");
    if (name.length > 60) throw new Error("水质项目名称过长，请缩短名称并保留单位。");
    if (Object.hasOwn(result, name)) throw new Error(`“${name}”重复，请每个项目只填写一次。`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`“${name}”的实测值不是有效数字。`);
    result[name] = value;
  }
  return result;
}

export function isActiveMaintenanceTask(task: Pick<MaintenanceTask, "status">): boolean {
  return task.status === "pending" || task.status === "in_progress";
}

export function maintenanceTaskList(tasks: MaintenanceTask[], options: {
  date: string; type?: string; owner?: string; scope: "due" | "all" | "upcoming"; treatmentOnly?: boolean;
}): MaintenanceTask[] {
  return tasks.filter(task => isActiveMaintenanceTask(task)
    && (!options.type || task.type === options.type)
    && (!options.owner || (options.owner === "__unassigned" ? !task.assignedTo : task.assignedTo === options.owner))
    && (!options.treatmentOnly || task.type === "treatment")
    && (options.scope === "all" || (options.scope === "due" ? task.dueDate <= options.date : task.dueDate > options.date)))
    .sort((a, b) => `${a.dueDate} ${a.dueTime || "23:59"}`.localeCompare(`${b.dueDate} ${b.dueTime || "23:59"}`) || a.createdAt.localeCompare(b.createdAt));
}

export function maintenanceDateTime(value?: string): string {
  if (!value) return "未记录";
  // Follow-up dates are entered as Beijing local time, not the viewer's browser zone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return value.replace("T", " ");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待核实";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export function maintenancePlanSchedule(plan: Pick<MaintenancePlan, "frequency" | "weekdays" | "dueTime">): string {
  const names = ["", "一", "二", "三", "四", "五", "六", "日"];
  const days = [...new Set(plan.weekdays || [])].filter(day => day >= 1 && day <= 7).sort((a, b) => a - b);
  return `${plan.frequency === "daily" ? "每天" : `每周${days.map(day => names[day]).join("、")}`} ${plan.dueTime || "23:59"}`;
}

export function readMaintenanceSnapshot(value: unknown, siteId: string): MaintenanceSnapshot {
  const data = value as Partial<MaintenanceSnapshot> | null;
  if (!data || data.ok !== true || data.siteId !== siteId || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0
    || !Array.isArray(data.tasks) || !Array.isArray(data.plans) || !Array.isArray(data.handoffs) || !Array.isArray(data.history) || !data.permissions) {
    throw new Error("工作台返回的数据不完整，请刷新重试。");
  }
  return data as MaintenanceSnapshot;
}
