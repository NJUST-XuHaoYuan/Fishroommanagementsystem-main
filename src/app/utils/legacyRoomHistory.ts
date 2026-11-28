import type { TankGroup, WaterQualityMeasurement } from "../store";
import { mobileMaintenanceHistoryTime } from "./mobileWaterQuality";

export type LegacyRoomHistoryRow = { id: string; kind: "log" | "water"; title: string; date: string; operator: string; text: string; values: WaterQualityMeasurement[]; photos: string[]; videos: string[] };
export type LegacyRoomHistoryResult = { legacyRoomName: string; rows: LegacyRoomHistoryRow[]; truncated: boolean };
const text = (value: unknown) => typeof value === "string" ? value : "";
const media = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];

export const legacyRoomIds = (groups: Pick<TankGroup, "legacyRoomId">[]) => new Set(groups.map(group => group.legacyRoomId || "").filter(Boolean));

/** Old room records stay old room records; never infer measurements from text or reassign a tank. */
export function readLegacyRoomHistory(payload: unknown, legacyRoomId: string): LegacyRoomHistoryResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("原房间历史返回格式异常，请重试。");
  const body = payload as Record<string, unknown>;
  if (body.ok !== true || !legacyRoomId || body.legacyRoomId !== legacyRoomId) throw new Error("原房间历史归属不匹配，请重新打开。");
  if (!Array.isArray(body.logs) || !Array.isArray(body.waterQualityRecords)) throw new Error("原房间历史返回格式异常，请重试。");
  const seen = new Set<string>();
  const rows: LegacyRoomHistoryRow[] = [];
  for (const [kind, records] of [["log", body.logs], ["water", body.waterQualityRecords]] as const) {
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("原房间记录格式异常，请重试。");
      const record = value as Record<string, unknown>;
      if (record.tankGroupId !== legacyRoomId) throw new Error("原房间记录归属不匹配，请重试。");
      const id = `${kind}:${text(record.id)}`;
      if (!text(record.id) || seen.has(id)) throw new Error("原房间记录编号异常，请重试。");
      seen.add(id);
      const values: WaterQualityMeasurement[] = kind === "water" && Array.isArray(record.values) ? record.values.map(item => {
        if (!item || typeof item !== "object" || typeof item.value !== "number" || !Number.isFinite(item.value)) throw new Error("历史水质数值格式异常，请重试。");
        return { parameterId: text(item.parameterId), parameterName: text(item.parameterName) || "未命名参数", unit: text(item.unit), precision: typeof item.precision === "number" ? item.precision : 0, value: item.value, testMethod: text(item.testMethod) };
      }) : [];
      rows.push({ id, kind, title: kind === "water" ? "原房间水质记录" : text(record.action) || "原房间养护记录", date: mobileMaintenanceHistoryTime(text(kind === "water" ? record.measuredAt : record.date)), operator: text(record.operator) || text(record.createdBy), text: text(record.notes), values, photos: media(record.photos), videos: media(record.videos) });
    }
  }
  const truncated = body.truncated && typeof body.truncated === "object" ? body.truncated as Record<string, unknown> : {};
  return { legacyRoomName: text(body.legacyRoomName), rows: rows.sort((a, b) => b.date.localeCompare(a.date)), truncated: body.truncated === true || truncated.logs === true || truncated.waterQualityRecords === true };
}
