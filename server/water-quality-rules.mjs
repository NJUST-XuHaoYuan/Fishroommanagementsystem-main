export const DEFAULT_WATER_QUALITY_PARAMETERS = [
  { id: "temperature", name: "温度", unit: "°C", precision: 1 },
  { id: "salinity", name: "盐度", unit: "ppt", precision: 1 },
  { id: "ph", name: "pH", unit: "pH", precision: 2 },
  { id: "ammonia", name: "氨氮", unit: "mg/L", precision: 3 },
  { id: "nitrite", name: "亚硝酸盐", unit: "mg/L", precision: 3 },
  { id: "nitrate", name: "硝酸盐", unit: "mg/L", precision: 1 },
  { id: "phosphate", name: "磷酸盐", unit: "mg/L", precision: 3 },
  { id: "alkalinity", name: "碱度", unit: "dKH", precision: 1 },
  { id: "calcium", name: "钙", unit: "mg/L", precision: 0 },
  { id: "magnesium", name: "镁", unit: "mg/L", precision: 0 },
  { id: "dissolved-oxygen", name: "溶解氧", unit: "mg/L", precision: 1 },
];

export const DEFAULT_FISH_WATER_QUALITY_PARAMETER_IDS = [
  "temperature",
  "salinity",
  "ph",
  "ammonia",
  "nitrite",
  "nitrate",
];

function clampPrecision(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(4, Math.trunc(numeric)));
}

export function normalizeWaterQualityParameters(value, options = {}) {
  const source = Array.isArray(value)
    ? value
    : options.fallbackToDefaults === false ? [] : DEFAULT_WATER_QUALITY_PARAMETERS;
  const usedIds = new Set();
  return source.flatMap((parameter, index) => {
    const name = String(parameter?.name ?? "").trim();
    const unit = String(parameter?.unit ?? "").trim();
    let id = String(parameter?.id ?? "").trim() || `water-parameter-${index + 1}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `${id}-${suffix++}`;
    if (!name || !unit) return [];
    usedIds.add(id);
    return [{ id, name, unit, precision: clampPrecision(parameter?.precision) }];
  });
}

export function validateWaterQualityParameters(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("请至少配置一个水质参数");
  const ids = new Set();
  const names = new Set();
  return value.map((parameter) => {
    const id = String(parameter?.id ?? "").trim();
    const name = String(parameter?.name ?? "").trim();
    const unit = String(parameter?.unit ?? "").trim();
    const precision = Number(parameter?.precision);
    if (!id) throw new Error("水质参数缺少编号");
    if (!name) throw new Error("请填写水质参数名称");
    if (!unit) throw new Error(`请填写「${name}」的单位`);
    if (!Number.isInteger(precision) || precision < 0 || precision > 4) {
      throw new Error(`「${name}」的精度必须是 0 至 4 的整数`);
    }
    const normalizedName = name.toLocaleLowerCase("zh-CN");
    if (ids.has(id)) throw new Error(`水质参数编号重复：${id}`);
    if (names.has(normalizedName)) throw new Error(`水质参数名称重复：${name}`);
    ids.add(id);
    names.add(normalizedName);
    return { id, name, unit, precision };
  });
}

export function waterQualityParameterIdsForGroup(group, parameters) {
  const validIds = new Set((Array.isArray(parameters) ? parameters : []).map((parameter) => parameter.id));
  const source = Array.isArray(group?.waterQualityParameterIds)
    ? group.waterQualityParameterIds
    : DEFAULT_FISH_WATER_QUALITY_PARAMETER_IDS;
  return [...new Set(source.map(String))].filter((id) => validIds.has(id));
}

function parameterSnapshotFromMeasurement(measurement = {}) {
  const id = String(measurement.parameterId ?? "").trim();
  const name = String(measurement.parameterName ?? "").trim();
  const unit = String(measurement.unit ?? "").trim();
  if (!id || !name || !unit) return null;
  return { id, name, unit, precision: clampPrecision(measurement.precision) };
}

export function normalizeWaterQualityRecord(input, context = {}) {
  const parameters = Array.isArray(context.parameters) ? context.parameters : [];
  const currentById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const existingValues = Array.isArray(context.existingRecord?.values) ? context.existingRecord.values : [];
  const historicalById = new Map(existingValues.flatMap((measurement) => {
    const snapshot = parameterSnapshotFromMeasurement(measurement);
    return snapshot ? [[snapshot.id, snapshot]] : [];
  }));
  const allowedIds = new Set([
    ...waterQualityParameterIdsForGroup(context.group, parameters),
    ...historicalById.keys(),
  ]);
  const measuredAt = String(input?.measuredAt ?? "").trim();
  const measuredTime = Date.parse(measuredAt);
  if (!measuredAt || !Number.isFinite(measuredTime)) throw new Error("请选择有效的测量时间");
  const now = Number(context.now ?? Date.now());
  if (measuredTime > now + 5 * 60 * 1000) throw new Error("测量时间不能晚于当前时间");

  const seen = new Set();
  const values = (Array.isArray(input?.values) ? input.values : []).map((measurement) => {
    const parameterId = String(measurement?.parameterId ?? "").trim();
    if (!parameterId || seen.has(parameterId)) throw new Error("水质测量项无效或重复");
    if (!allowedIds.has(parameterId)) throw new Error(`当前缸组未关注水质参数：${parameterId}`);
    const parameter = currentById.get(parameterId) ?? historicalById.get(parameterId);
    if (!parameter) throw new Error(`水质参数不存在：${parameterId}`);
    const value = Number(measurement?.value);
    if (!Number.isFinite(value)) throw new Error(`请填写「${parameter.name}」的有效数值`);
    const factor = 10 ** parameter.precision;
    seen.add(parameterId);
    return {
      parameterId,
      value: Math.round((value + Number.EPSILON) * factor) / factor,
      parameterName: parameter.name,
      unit: parameter.unit,
      precision: parameter.precision,
    };
  });
  if (values.length === 0) throw new Error("请至少填写一项水质测量值");

  return {
    id: String(input?.id || context.existingRecord?.id || context.createId?.() || "").trim(),
    siteId: String(context.siteId ?? input?.siteId ?? context.group?.siteId ?? "").trim(),
    measuredAt: new Date(measuredTime).toISOString(),
    tankGroupId: String(context.group?.id ?? input?.tankGroupId ?? "").trim(),
    values,
    operator: String(context.operator ?? input?.operator ?? "").trim(),
    notes: String(input?.notes ?? "").trim(),
  };
}

export function formatWaterQualityMeasurements(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((measurement) => {
      const precision = clampPrecision(measurement?.precision);
      const value = Number(measurement?.value);
      return `${String(measurement?.parameterName ?? measurement?.parameterId ?? "未知参数")} ${Number.isFinite(value) ? value.toFixed(precision) : "—"} ${String(measurement?.unit ?? "")}`.trim();
    })
    .join("，");
}
