import type { BioRecord } from "../store";
import { normalizeBioRecordTime } from "./localDateTime.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Validate the response before displaying media belonging to a specific fish. */
export function readStockMaintenanceHistory(payload: unknown, stockItemId: string): BioRecord[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("维护记录返回格式异常，请重试。");
  }
  const body = payload as Record<string, unknown>;
  const stock = body.stockItem as { id?: unknown } | null | undefined;
  if (body.ok !== true || !stock || stock.id !== stockItemId) {
    throw new Error("鱼只记录不匹配，请关闭详情后重新打开。");
  }
  if (!Array.isArray(body.bioRecords)) throw new Error("维护记录返回格式异常，请重试。");
  const seen = new Set<string>();
  const records = body.bioRecords.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("维护记录返回格式异常，请重试。");
    }
    const record = value as Record<string, unknown>;
    const id = text(record.id);
    if (!id.trim() || seen.has(id) || record.stockItemId !== stockItemId) {
      throw new Error("维护记录归属或编号异常，请关闭详情后重新打开。");
    }
    seen.add(id);
    const media = (value: unknown) => Array.isArray(value)
      ? value.filter((src): src is string => typeof src === "string" && Boolean(src.trim()))
      : [];
    return {
      id, stockItemId,
      date: text(record.date), text: text(record.text),
      photos: media(record.photos), videos: media(record.videos),
      sourceType: text(record.sourceType), operator: text(record.operator),
      tankGroupName: text(record.tankGroupName), subTankName: text(record.subTankName),
      tankLocation: text(record.tankLocation),
    };
  });
  return records.sort((a, b) => normalizeBioRecordTime(b.date).localeCompare(normalizeBioRecordTime(a.date)));
}
