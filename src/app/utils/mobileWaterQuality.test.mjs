import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, water;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } });
  water = await vite.ssrLoadModule("/src/app/utils/mobileWaterQuality.ts");
});
after(async () => { await vite?.close(); });

test("empty and whitespace inputs never become a valid zero measurement", () => {
  for (const raw of ["", "  ", "\t\n", "-", "+", ".", "Infinity", "NaN", "1e2", "1 2", "1,200"]) {
    assert.equal(water.parseMobileWaterValue(raw).value, null, raw);
    assert.ok(water.parseMobileWaterValue(raw).error, raw);
  }
});
test("zero, decimal and negative ORP values remain valid", () => {
  for (const [raw, value] of [["0", 0], [" 0.000 ", 0], ["8.2", 8.2], [".5", .5], ["-150", -150], ["+150", 150]]) {
    assert.deepEqual(water.parseMobileWaterValue(raw), { value, error: "" });
  }
});
test("the phone sign control can enter a negative value without a minus keyboard key", () => {
  assert.equal(water.toggleMobileWaterValueSign(""), "-");
  assert.equal(water.toggleMobileWaterValueSign("150"), "-150");
  assert.equal(water.toggleMobileWaterValueSign("-150"), "150");
  assert.equal(water.toggleMobileWaterValueSign("+150"), "-150");
});
test("group preferences prioritize but never filter configured custom parameters", () => {
  const parameters = ["temperature", "copper", "orp", "salinity"].map(id => ({ id, name: id, unit: "unit", precision: 1 }));
  assert.deepEqual(water.orderMobileWaterParameters(parameters, ["salinity", "removed"]).map(item => item.id), ["salinity", "temperature", "copper", "orp"]);
  assert.deepEqual(parameters.map(item => item.id), ["temperature", "copper", "orp", "salinity"]);
});
test("structured measurement carries chosen parameter, unit and optional method", () => {
  const parameter = { id: "orp", name: "ORP", unit: "mV", precision: 0 };
  assert.deepEqual(water.mobileWaterMeasurement(parameter, "-150", "探头测量"), { parameterId: "orp", parameterName: "ORP", unit: "mV", precision: 0, value: -150, testMethod: "探头测量" });
  assert.equal(water.mobileWaterMeasurement(parameter, "0").value, 0);
  assert.equal("testMethod" in water.mobileWaterMeasurement(parameter, "0"), false);
  assert.equal(water.mobileWaterMeasurement(parameter, " "), null);
});
test("confirmation preview matches server rounding instead of a different display-only rounding", () => {
  assert.equal(water.mobileWaterDisplayValue(1.005, 2), "1.01");
  assert.equal(water.mobileWaterDisplayValue(-150.5, 0), "-150");
  assert.equal(water.mobileWaterDisplayValue(0, 3), "0.000");
  assert.equal(water.mobileWaterDisplayValue(8.1, 2), "8.10");
});

test("UTC water records and local maintenance logs use the same local display and sort order", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(water.mobileMaintenanceHistoryTime("2026-11-27T08:00:00.000Z"), "2026-11-27T16:00:00");
    assert.equal(water.mobileMaintenanceHistoryTime("2026-11-27T16:00:00+08:00"), "2026-11-27T16:00:00");
    const rows = ["2026-11-27T15:00:00", "2026-11-27T08:00:00.000Z"].map(water.mobileMaintenanceHistoryTime).sort((a, b) => b.localeCompare(a));
    assert.deepEqual(rows, ["2026-11-27T16:00:00", "2026-11-27T15:00:00"]);
    assert.equal(water.mobileMaintenanceHistoryTime("2026-11-27"), "2026-11-27T00:00:00");
    assert.equal(water.mobileWaterTimestamp("2026-11-27T16:00:00"), "2026-11-27T08:00:00.000Z");
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("old sub-tank water readings retain only their source position, with a shared group scope", () => {
  assert.deepEqual(water.mobileWaterHistoryLocation("测试缸", "sub-1", "上格"), {
    location: "测试缸 · 整个缸组 / 共用水体", sourceLocation: "上格",
  });
  assert.deepEqual(water.mobileWaterHistoryLocation("测试缸"), {
    location: "测试缸 · 整个缸组 / 共用水体", sourceLocation: undefined,
  });
  assert.equal(water.mobileWaterHistoryLocation(undefined, "removed-sub").sourceLocation, "removed-sub");
});

test("legacy daily water and dosing actions share a group while ordinary sub-tank logs keep their location", () => {
  for (const action of [" 下药 ", "水质", "测水质", "水质检测", "下药", "水体下药", "治疗", "下药治疗"]) {
    assert.equal(water.isMobileSharedWaterLog({ action, subTankId: "sub-1" }), true);
  }
  assert.equal(water.isMobileSharedWaterLog({ action: "观察", subTankId: "sub-1" }), false);
  assert.equal(water.isMobileSharedWaterLog({ action: "换水", subTankId: "sub-1" }), false);
  assert.equal(water.isMobileSharedWaterLog({ action: "喂食", scope: "group" }), true);
});
