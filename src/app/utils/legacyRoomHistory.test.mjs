import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
let vite, read;
before(async () => {
  vite = await createServer({ configFile: false, cacheDir: ".data/legacy-room-test-cache", server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } });
  ({ readLegacyRoomHistory: read } = await vite.ssrLoadModule("/src/app/utils/legacyRoomHistory.ts"));
});
after(async () => { await vite?.close(); });
const base = { ok: true, legacyRoomId: "old-room", legacyRoomName: "一号房间", logs: [], waterQualityRecords: [] };
test("mismatched room responses are rejected instead of shown as current tank history", () => {
  assert.throws(() => read({ ...base, legacyRoomId: "other-room" }, "old-room"), /归属不匹配/);
  assert.throws(() => read({ ...base, logs: null }, "old-room"), /格式异常/);
});
test("old text and media are preserved without inferring numeric water measurements", () => {
  const source = { id: "log", tankGroupId: "old-room", action: "水质", date: "2026-11-01", operator: "operator", notes: "氨氮0.1；未区分缸", photos: ["/p.jpg"], videos: ["/v.mp4"] };
  const result = read({ ...base, logs: [source] }, "old-room");
  assert.equal(result.rows[0].text, source.notes);
  assert.deepEqual(result.rows[0].values, []);
  assert.deepEqual(result.rows[0].photos, source.photos);
  assert.deepEqual(result.rows[0].videos, source.videos);
  assert.equal(source.tankGroupId, "old-room");
});
test("structured water history keeps its snapshot and sorts UTC with local dates", () => {
  const reading = { parameterId: "copper", parameterName: "铜（旧名）", unit: "PPM", precision: 3, value: 0, testMethod: "旧试剂" };
  const result = read({ ...base, logs: [{ id: "log", tankGroupId: "old-room", date: "2026-11-28T15:59:00", notes: "旧养护" }], waterQualityRecords: [{ id: "water", tankGroupId: "old-room", measuredAt: "2026-11-28T08:00:00Z", values: [reading], notes: "原记录" }] }, "old-room");
  assert.equal(result.rows[0].id, "water:water");
  assert.equal(result.rows[0].date.slice(11, 16), "16:00");
  assert.deepEqual(result.rows[0].values[0], reading);
  assert.equal(result.rows[0].title, "原房间水质记录");
});
test("duplicate ids are rejected and capped history is disclosed", () => {
  assert.throws(() => read({ ...base, logs: [{ id: "same", tankGroupId: "old-room" }, { id: "same", tankGroupId: "old-room" }] }, "old-room"), /编号异常/);
  assert.equal(read({ ...base, truncated: { logs: true, waterQualityRecords: false } }, "old-room").truncated, true);
  assert.equal(read({ ...base, truncated: { logs: false, waterQualityRecords: false } }, "old-room").truncated, false);
});
