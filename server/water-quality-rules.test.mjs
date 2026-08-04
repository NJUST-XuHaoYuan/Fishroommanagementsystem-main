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
  ]), [{ id: "ph", name: "pH", unit: "pH", precision: 4 }]);
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

test("record normalization rejects parameters not followed by the tank group", () => {
  assert.throws(() => normalizeWaterQualityRecord({
    measuredAt: "2026-08-04T10:00:00.000Z",
    values: [{ parameterId: "calcium", value: 420 }],
  }, {
    group: { id: "group-1", waterQualityParameterIds: ["ph"] },
    parameters: DEFAULT_WATER_QUALITY_PARAMETERS,
    operator: "admin",
    now: Date.parse("2026-08-04T11:00:00.000Z"),
  }), /未关注/);
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
