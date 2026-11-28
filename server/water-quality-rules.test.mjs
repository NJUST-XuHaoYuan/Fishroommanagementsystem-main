import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FISH_WATER_QUALITY_PARAMETER_IDS,
  DEFAULT_WATER_QUALITY_PARAMETERS,
  formatWaterQualityMeasurements,
  normalizeWaterQualityParameters,
  normalizeWaterQualityRecord,
  validateWaterQualityParameters,
  waterQualityParameterIdsForGroup,
} from "./water-quality-rules.mjs";

test("legacy tank groups receive the default fish-water parameter set", () => {
  assert.deepEqual(
    waterQualityParameterIdsForGroup({}, DEFAULT_WATER_QUALITY_PARAMETERS),
    DEFAULT_FISH_WATER_QUALITY_PARAMETER_IDS
  );
});

test("an explicitly empty tank-group selection remains empty", () => {
  assert.deepEqual(
    waterQualityParameterIdsForGroup({ waterQualityParameterIds: [] }, DEFAULT_WATER_QUALITY_PARAMETERS),
    []
  );
});

test("water quality parameter validation rejects duplicate names", () => {
  assert.throws(() => validateWaterQualityParameters([
    { id: "one", name: "温度", unit: "°C", precision: 1 },
    { id: "two", name: "温度", unit: "F", precision: 1 },
  ]), /名称重复/);
});

test("water quality parameter normalization clamps legacy precision", () => {
  assert.deepEqual(normalizeWaterQualityParameters([
    { id: "ph", name: " pH ", unit: " pH ", precision: 8 },
  ]), [{ id: "ph", name: "pH", unit: "pH", precision: 4, testMethods: [] }]);
});

test("record normalization stores rounded values and parameter snapshots", () => {
  const record = normalizeWaterQualityRecord({
    id: "record-1",
    measuredAt: "2026-08-04T10:00:00.000Z",
    tankGroupId: "group-1",
    values: [{ parameterId: "ph", value: 8.126 }],
    notes: "复测一次",
  }, {
    group: { id: "group-1", siteId: "nanjing", waterQualityParameterIds: ["ph"] },
    parameters: DEFAULT_WATER_QUALITY_PARAMETERS,
    operator: "admin",
    now: Date.parse("2026-08-04T11:00:00.000Z"),
  });
  assert.equal(record.values[0].value, 8.13);
  assert.deepEqual(record.values[0], {
    parameterId: "ph",
    value: 8.13,
    parameterName: "pH",
    unit: "pH",
    precision: 2,
  });
  assert.equal(record.operator, "admin");
  assert.equal(record.siteId, "nanjing");
});

test("configured parameters can be recorded even when not followed by the group", () => {
  const record = normalizeWaterQualityRecord({ measuredAt: "2026-08-04T10:00:00.000Z", values: [{ parameterId: "calcium", value: 420 }] }, {
    group: { id: "group-1", waterQualityParameterIds: ["ph"] }, parameters: DEFAULT_WATER_QUALITY_PARAMETERS,
    operator: "admin", now: Date.parse("2026-08-04T11:00:00.000Z"),
  });
  assert.equal(record.values[0].value, 420);
});

test("editing a historical record preserves deleted parameter snapshots", () => {
  const existingRecord = {
    id: "record-old",
    values: [{ parameterId: "legacy", value: 1.2, parameterName: "旧参数", unit: "mg/L", precision: 1 }],
  };
  const record = normalizeWaterQualityRecord({
    id: "record-old",
    measuredAt: "2026-08-04T10:00:00.000Z",
    values: [{ parameterId: "legacy", value: 1.26 }],
  }, {
    existingRecord,
    group: { id: "group-1", waterQualityParameterIds: [] },
    parameters: [],
    operator: "admin",
    now: Date.parse("2026-08-04T11:00:00.000Z"),
  });
  assert.equal(record.values[0].value, 1.3);
  assert.equal(record.values[0].parameterName, "旧参数");
});

test("water-quality history summary respects saved precision and unit", () => {
  assert.equal(formatWaterQualityMeasurements([
    { parameterId: "ph", parameterName: "pH", value: 8.1, precision: 2, unit: "pH" },
    { parameterId: "calcium", parameterName: "钙", value: 420, precision: 0, unit: "mg/L" },
  ]), "pH 8.10 pH，钙 420 mg/L");
});


test("default catalog has twelve items without resurrecting deleted configured parameters", () => {
  assert.equal(DEFAULT_WATER_QUALITY_PARAMETERS.length, 12);
  assert.equal(DEFAULT_WATER_QUALITY_PARAMETERS.find(item => item.id === "orp").unit, "mV");
  assert.equal(DEFAULT_WATER_QUALITY_PARAMETERS.find(item => item.id === "ammonia").unit, "PPM");
  assert.equal(DEFAULT_WATER_QUALITY_PARAMETERS.find(item => item.id === "alkalinity").name, "KH");
  assert.deepEqual(normalizeWaterQualityParameters([]), []);
  assert.equal(normalizeWaterQualityParameters([{ id: "copper", name: "铜", unit: "mg/L", precision: 3 }]).length, 1);
});

test("test methods must be bounded unique labels; optional methods remain optional", () => {
  const base = { id: "ph", name: "pH", unit: "pH", precision: 2 };
  assert.deepEqual(validateWaterQualityParameters([{ ...base, testMethods: [" 测试笔 ", "试剂"] }])[0].testMethods, ["测试笔", "试剂"]);
  for (const testMethods of [[""], ["笔", " 笔 "], ["a".repeat(81)], Array(21).fill("x"), "试剂", [1]]) {
    assert.throws(() => validateWaterQualityParameters([{ ...base, testMethods }]));
  }
});

test("blank, whitespace, boolean, NaN and infinite readings are rejected but zero and negative ORP are accepted", () => {
  const context = { parameters: DEFAULT_WATER_QUALITY_PARAMETERS, group: { id: "g" }, operator: "u", now: Date.parse("2026-08-04T11:00:00Z") };
  const input = value => ({ measuredAt: "2026-08-04T10:00:00Z", values: [{ parameterId: "orp", value }] });
  for (const value of ["", " ", null, undefined, false, true, NaN, Infinity, "NaN", [], {}]) assert.throws(() => normalizeWaterQualityRecord(input(value), context));
  assert.equal(normalizeWaterQualityRecord(input(0), context).values[0].value, 0);
  assert.equal(normalizeWaterQualityRecord(input(-120), context).values[0].value, -120);
  assert.throws(() => normalizeWaterQualityRecord({ ...input(1), values: [{ parameterId: "ammonia", value: 1e308 }] }, context), /数值过大/);
});

test("historical names, units, precision and method survive config changes and stale editors", () => {
  const old = { id: "old", operator: "creator", subTankId: "sub", photos: ["/uploads/photo.jpg"], values: [{ parameterId: "ammonia", value: 0.12, parameterName: "旧氨氮", unit: "mg/L", precision: 3, testMethod: "旧试剂" }] };
  const context = { existingRecord: old, parameters: [{ id: "ammonia", name: "新氨氮", unit: "PPM", precision: 1, testMethods: ["新试剂"] }],
    group: { id: "g", subTanks: [{ id: "sub" }] }, operator: "editor", now: Date.parse("2026-08-04T11:00:00Z") };
  const input = { measuredAt: "2026-08-04T10:00:00Z", values: [{ parameterId: "ammonia", value: 0.1234, parameterName: "forged", unit: "forged", precision: 0 }] };
  const record = normalizeWaterQualityRecord(input, context);
  assert.deepEqual(record.values[0], { ...old.values[0], value: 0.123 }); assert.equal(record.createdBy, "creator"); assert.equal(record.operator, "editor");
  assert.equal(record.subTankId, undefined); assert.equal(record.scope, "group"); assert.equal(record.recordedFromSubTankId, "sub"); assert.deepEqual(record.photos, old.photos);
  assert.throws(() => normalizeWaterQualityRecord({ ...input, values: [{ parameterId: "ammonia", value: 1, testMethod: "伪造方法" }] }, context), /已配置/);
  assert.equal(normalizeWaterQualityRecord({ ...input, values: [{ parameterId: "ammonia", value: 1, testMethod: "新试剂" }] }, context).values[0].testMethod, "新试剂");
});


test("datetime-local is interpreted in Shanghai while explicit offsets remain authoritative", () => {
  const context = { parameters: DEFAULT_WATER_QUALITY_PARAMETERS, group: { id: "g" }, operator: "u", now: Date.parse("2026-08-04T11:00:00Z") };
  const input = measuredAt => ({ measuredAt, values: [{ parameterId: "ph", value: 8 }] });
  for (const measuredAt of ["2026-08-04T10:00", "2026-08-04T10:00:00+08:00", "2026-08-04T02:00:00Z"]) {
    assert.equal(normalizeWaterQualityRecord(input(measuredAt), context).measuredAt, "2026-08-04T02:00:00.000Z");
  }
});
