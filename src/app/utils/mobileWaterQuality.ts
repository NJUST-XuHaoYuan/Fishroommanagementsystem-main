import { isoToDatetimeLocal, normalizeBioRecordTime } from "./localDateTime";
import type { WaterQualityMeasurement, WaterQualityParameterSetting } from "../store";

/** Keep every configured parameter available; group preferences only affect order. */
export function orderMobileWaterParameters(parameters: WaterQualityParameterSetting[], preferredIds: string[]) {
  const preferred = new Set(preferredIds);
  return parameters.map((parameter, index) => ({ parameter, index }))
    .sort((a, b) => Number(preferred.has(b.parameter.id)) - Number(preferred.has(a.parameter.id)) || a.index - b.index)
    .map(({ parameter }) => parameter);
}

export function parseMobileWaterValue(raw: string): { value: number; error: "" } | { value: null; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: "请填写测量数值，0 也可以记录。" };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) || !Number.isFinite(Number(trimmed))) {
    return { value: null, error: "请填写有效数字，例如 0、8.2 或 -150。" };
  }
  return { value: Number(trimmed), error: "" };
}

export function toggleMobileWaterValueSign(raw: string) {
  const value = raw.trim();
  return value.startsWith("-") ? value.slice(1) : `-${value.replace(/^\+/, "")}`;
}

export function mobileWaterMeasurement(parameter: WaterQualityParameterSetting, raw: string, testMethod = ""): WaterQualityMeasurement | null {
  const parsed = parseMobileWaterValue(raw);
  if (parsed.value === null) return null;
  if (!Number.isFinite((parsed.value + Number.EPSILON) * 10 ** parameter.precision)) return null;
  return {
    parameterId: parameter.id, parameterName: parameter.name, unit: parameter.unit, precision: parameter.precision,
    value: parsed.value,
    ...(testMethod ? { testMethod } : {}),
  };
}

export function mobileWaterDisplayValue(value: number, precision: number) {
  if (!Number.isFinite(value)) return "—";
  const digits = Math.max(0, Math.min(4, Math.trunc(precision || 0)));
  // Match the server's established rounding, including negative ORP halves.
  const factor = 10 ** digits;
  return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(digits);
}

/** Legacy maintenance timestamps are local; structured water records carry an offset. */
export function mobileMaintenanceHistoryTime(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? isoToDatetimeLocal(value) : normalizeBioRecordTime(value);
}

/** Send an instant, so the server timezone cannot reinterpret the phone's local time. */
export function mobileWaterTimestamp(localValue: string) {
  const time = new Date(localValue);
  return Number.isFinite(time.getTime()) ? time.toISOString() : "";
}

/** A sub-tank on an old water reading is the recording location, never its water scope. */
export function mobileWaterHistoryLocation(groupName?: string, recordedFromSubTankId?: string, subTankName?: string) {
  return {
    location: `${groupName || "原缸组"} · 整个缸组 / 共用水体`,
    sourceLocation: recordedFromSubTankId ? subTankName || recordedFromSubTankId : undefined,
  };
}

export function isMobileSharedWaterLog(log: { scope?: string; action?: string; subTankId?: string }) {
  return log.scope === "group" || !log.subTankId || ["下药", "水体下药", "治疗", "下药治疗", "水质", "测水质", "水质测试", "水质检测"].includes((log.action || "").trim());
}
