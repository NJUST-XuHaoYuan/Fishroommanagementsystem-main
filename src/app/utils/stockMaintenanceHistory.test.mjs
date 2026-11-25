import assert from "node:assert/strict";
import test from "node:test";
import { readStockMaintenanceHistory } from "./stockMaintenanceHistory.ts";

const record = (id, extra = {}) => ({ id, stockItemId: "fish-1", date: "2026-11-20T09:00:00", text: "观察正常", photos: [], ...extra });
const response = records => ({ ok: true, stockItem: { id: "fish-1", lost: true }, bioRecords: records });

test("lost fish retains all records, ordered newest first without a twenty-record data cutoff", () => {
  const source = response(Array.from({ length: 47 }, (_, index) => record(`record-${index}`, { date: `2026-11-20T09:${String(index).padStart(2, "0")}:00` })));
  const before = structuredClone(source);
  const result = readStockMaintenanceHistory(source, "fish-1");
  assert.equal(result.length, 47);
  assert.equal(result[0].id, "record-46");
  assert.equal(result[46].id, "record-0");
  assert.deepEqual(source, before);
});

test("history retains photos, videos, actor, source and original location", () => {
  const result = readStockMaintenanceHistory(response([record("record-1", {
    photos: ["/uploads/photo.jpg"], videos: ["/uploads/video.mp4"], operator: "养护员",
    sourceType: "dailyLog", tankGroupName: "鱼D", subTankName: "D2", tankLocation: "南京",
  })]), "fish-1")[0];
  assert.deepEqual(result.photos, ["/uploads/photo.jpg"]);
  assert.deepEqual(result.videos, ["/uploads/video.mp4"]);
  assert.equal(result.operator, "养护员"); assert.equal(result.sourceType, "dailyLog");
  assert.equal(result.subTankName, "D2"); assert.equal(result.tankLocation, "南京");
});

test("a response for another fish, even with no records, fails closed", () => {
  assert.throws(() => readStockMaintenanceHistory({ ...response([]), stockItem: { id: "other-fish" } }, "fish-1"), /不匹配/);
  assert.throws(() => readStockMaintenanceHistory(response([record("record-1", { stockItemId: "other-fish" })]), "fish-1"), /归属/);
});

test("failed, malformed and deleted-stock responses are errors rather than empty histories", () => {
  for (const invalid of [null, [], {}, { ok: false, error: "生物不存在或无权查看" }, { ...response([]), stockItem: null }, { ...response([]), bioRecords: null }]) {
    assert.throws(() => readStockMaintenanceHistory(invalid, "fish-1"));
  }
  assert.deepEqual(readStockMaintenanceHistory(response([]), "fish-1"), []);
});

test("conflicting record ids and non-record entries cannot misassociate media", () => {
  for (const records of [[record("same"), record("same")], [record("")], [null], ["bad"]]) {
    assert.throws(() => readStockMaintenanceHistory(response(records), "fish-1"));
  }
});

test("missing legacy metadata remains unknown without dropping the record", () => {
  const result = readStockMaintenanceHistory(response([{ id: "legacy", stockItemId: "fish-1" }]), "fish-1");
  assert.equal(result.length, 1); assert.equal(result[0].operator, "");
  assert.equal(result[0].date, ""); assert.deepEqual(result[0].photos, []); assert.deepEqual(result[0].videos, []);
});

test("equal dates retain the server's stable order and date-only records precede older dates", () => {
  const result = readStockMaintenanceHistory(response([
    record("old", { date: "2026-11-18" }), record("same-a", { date: "2026-11-20" }),
    record("same-b", { date: "2026-11-20" }), record("missing", { date: "" }),
  ]), "fish-1");
  assert.deepEqual(result.map(entry => entry.id), ["same-a", "same-b", "old", "missing"]);
});
