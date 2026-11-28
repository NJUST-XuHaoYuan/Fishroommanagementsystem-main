import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const oldLog = extra => ({ id: "room-log", siteId: "nanjing", tankGroupId: "old-room", date: "2026-11-01T10:00:00", action: "下药", operator: "pricing-editor", notes: "原房间记录",
  photos: ["/uploads/room.jpg"], videos: ["/uploads/room.mp4"], ...extra });
const oldWater = extra => ({ id: "room-water", siteId: "nanjing", tankGroupId: "old-room", measuredAt: "2026-11-01T02:00:00Z", operator: "pricing-editor", notes: "旧水质",
  values: [{ parameterId: "ammonia", parameterName: "历史氨氮", unit: "mg/L", precision: 3, value: 0.125, testMethod: "旧方法", privateMetadata: "SECRET_VALUE" }], photos: [], videos: [], ...extra });
async function setup(t, customize = () => {}) {
  const fixture = structuredClone(stockPricingFixture);
  Object.assign(fixture.state.tankGroups[0], { legacyRoomId: "old-room", legacyRoomName: "原房间一" });
  Object.assign(fixture.state.tankGroups[1], { legacyRoomId: "old-private-room", legacyRoomName: "PRIVATE_ROOM" });
  fixture.state.logs = [oldLog({})]; fixture.state.waterQualityRecords = [oldWater({})];
  fixture.state.bioRecords = [{ id: "old-room-bio", sourceType: "dailyLog", sourceLogId: "room-log", stockItemId: "follower", date: "2026-11-01T10:00:00", text: "原记录，不重新生成", photos: [], videos: [] }];
  customize(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  return { ...server, tokens, fixture,
    history: (groupId = "group-n", role = "editor", suffix = "") => server.request(`/api/tank-groups/legacy-history?tankGroupId=${encodeURIComponent(groupId)}${suffix}`, { token: tokens[role] }),
    saveGroup: body => server.request("/api/tank-groups/save", { token: tokens.admin, body }),
  };
}

test("legacy references return original IDs and historic water snapshots without mutating or synchronizing fish history", async t => {
  const s = await setup(t, state => {
    state.logs[0].syncedStockItemIds = ["follower"];
    state.logs[0].internalMetadata = "SECRET_LOG";
    state.logs[0].photos.push("/api/payment-proof/private.jpg");
    state.waterQualityRecords[0].privateMetadata = "SECRET_WATER";
    state.logs.push(oldLog({ id: "other-room", tankGroupId: "some-other-room", syncedStockItemIds: [] }));
  });
  const before = await s.readPersistedState(); const result = await s.history("group-n", "editor", "&siteId=nanjing&legacyRoomId=old-private-room"); ok(result);
  assert.equal(result.response.headers.get("cache-control"), "no-store, private");
  assert.equal(result.body.legacyRoomId, "old-room"); assert.equal(result.body.legacyRoomName, "原房间一");
  assert.deepEqual(result.body.logs.map(row => row.id), ["room-log"]); assert.deepEqual(result.body.waterQualityRecords.map(row => row.id), ["room-water"]);
  assert.equal(result.body.waterQualityRecords[0].values[0].parameterName, "历史氨氮"); assert.equal(result.body.waterQualityRecords[0].values[0].unit, "mg/L");
  assert.equal(result.body.waterQualityRecords[0].values[0].value, 0.125); assert.equal(result.body.waterQualityRecords[0].values[0].testMethod, "旧方法");
  assert.deepEqual(result.body.logs[0].photos, ["/uploads/room.jpg"]);
  assert.doesNotMatch(JSON.stringify(result.body), /SECRET_|syncedStockItemIds|privateMetadata|internalMetadata|payment-proof/);
  assert.deepEqual(result.body.truncated, { logs: false, waterQualityRecords: false });
  assert.deepEqual(await s.readPersistedState(), before);
  const current = await s.request("/api/mobile-maintenance/history?siteId=nanjing&tankGroupId=group-n", { token: s.tokens.editor }); ok(current);
  assert.deepEqual(current.body.logs, []); assert.deepEqual(current.body.waterQualityRecords, []);
});

test("legacy reader enforces current daily and site permissions and excludes foreign or unproved record sites", async t => {
  const s = await setup(t, state => {
    state.logs.push(oldLog({ id: "foreign", siteId: "jiangyin", syncedStockItemIds: [] }), oldLog({ id: "missing-site", siteId: "", syncedStockItemIds: [] }));
    state.waterQualityRecords.push(oldWater({ id: "foreign-water", siteId: "jiangyin" }), oldWater({ id: "missing-water-site", siteId: "" }));
    state.tankGroups.push({ id: "without-history", name: "新缸", siteId: "nanjing", subTanks: [] });
  });
  const result = await s.history(); ok(result); assert.deepEqual(result.body.logs.map(row => row.id), ["room-log"]); assert.deepEqual(result.body.waterQualityRecords.map(row => row.id), ["room-water"]);
  assert.equal((await s.history("group-n", "viewer")).response.status, 403);
  assert.equal((await s.history("group-j")).response.status, 403);
  assert.equal((await s.history("group-n", "editor", "&siteId=jiangyin")).response.status, 404);
  assert.equal((await s.history("old-room")).response.status, 404);
  const empty = await s.history("without-history"); ok(empty); assert.equal(empty.body.legacyRoomId, ""); assert.deepEqual(empty.body.logs, []);
  const post = await s.request("/api/tank-groups/legacy-history?tankGroupId=group-n", { token: s.tokens.admin, body: {} }); assert.equal(post.response.status, 405);
  await s.patchTestPersonnel("pricing-editor", { permissions: {} }); assert.equal((await s.history()).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { accountEnabled: false }); assert.equal((await s.history()).response.status, 401);
});

test("legacy reader caps each collection and reports truncation without copying records", async t => {
  const s = await setup(t, state => {
    // This fixture is passed through one environment value; keep it below
    // Linux's per-string exec limit while retaining both pagination boundaries.
    state.logs = Array.from({ length: 205 }, (_, i) => ({ id: `log-${String(i).padStart(3, "0")}`, siteId: "nanjing", tankGroupId: "old-room",
      date: "2026-11-01T10:00:00", action: "观察", operator: "pricing-editor", syncedStockItemIds: [] }));
    state.waterQualityRecords = Array.from({ length: 202 }, (_, i) => ({ id: `water-${String(i).padStart(3, "0")}`, siteId: "nanjing", tankGroupId: "old-room",
      measuredAt: "2026-11-01T02:00:00Z", operator: "pricing-editor", values: [] }));
  });
  const before = await s.readPersistedState(); const result = await s.history(); ok(result);
  assert.equal(result.body.limit, 200); assert.equal(result.body.logs.length, 200); assert.equal(result.body.waterQualityRecords.length, 200);
  assert.deepEqual(result.body.truncated, { logs: true, waterQualityRecords: true });
  assert.equal(result.body.logs[0].id, "log-204"); assert.equal(result.body.waterQualityRecords[0].id, "water-201");
  assert.deepEqual(await s.readPersistedState(), before);
  const currentLog = await s.request("/api/daily-logs/save", { token: s.tokens.editor, body: { log: { id: "older-current", tankGroupId: "group-n", date: "2026-10-01T10:00:00", action: "观察", notes: "新缸普通历史", operator: "" } } }); ok(currentLog);
  const global = await s.request("/api/mobile-maintenance/history?siteId=nanjing&limit=1", { token: s.tokens.editor }); ok(global);
  assert.deepEqual(global.body.logs.map(row => row.id), ["older-current"]); assert.deepEqual(global.body.waterQualityRecords, []);
  assert.equal(global.body.truncated, false);
});

test("normal group and sub-tank edits preserve migrated metadata, while client-created associations are ignored", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const group = before.tankGroups[0];
  ok(await s.saveGroup({ mode: "upsertGroup", group: { ...group, name: "更新名称", legacyRoomId: "old-private-room", legacyRoomName: "伪造房间" } }));
  let stored = await s.readPersistedState(); const edited = stored.tankGroups.find(row => row.id === group.id);
  assert.equal(edited.legacyRoomId, "old-room"); assert.equal(edited.legacyRoomName, "原房间一");
  const { legacyRoomId, legacyRoomName, ...oldClientGroup } = edited;
  ok(await s.saveGroup({ mode: "upsertGroup", group: { ...oldClientGroup, location: "新位置" } }));
  ok(await s.saveGroup({ mode: "upsertSubTank", groupId: group.id, subTank: { ...group.subTanks[0], name: "主缸" } }));
  ok(await s.saveGroup({ mode: "upsertGroup", group: { id: "created", name: "新缸无历史", siteId: "nanjing", location: "", subTanks: [], legacyRoomId, legacyRoomName } }));
  stored = await s.readPersistedState(); assert.equal(stored.tankGroups.find(row => row.id === group.id).legacyRoomId, "old-room");
  assert.equal(stored.tankGroups.find(row => row.id === "created").legacyRoomId, undefined);
  assert.deepEqual(stored.logs, before.logs); assert.deepEqual(stored.waterQualityRecords, before.waterQualityRecords); assert.deepEqual(stored.bioRecords, before.bioRecords);
  const stale = await s.saveGroup({ mode: "upsertGroup", group: { id: "old-room", name: "旧页面房间", siteId: "nanjing", subTanks: [] } });
  assert.equal(stale.response.status, 409); assert.equal(stale.body.code, "TANK_GROUP_RESTRUCTURED");
  assert.deepEqual(await s.readPersistedState(), stored);
});

test("archived original logs are untouched by startup and cannot be deleted, moved or re-synchronized by save APIs", async t => {
  const s = await setup(t); const state = await s.readPersistedState();
  assert.equal(state.logs[0].syncedStockItemIds, undefined); assert.deepEqual(state.bioRecords, s.fixture.state.bioRecords);
  const attempts = [
    ["/api/daily-logs/save", { deleteId: "room-log" }],
    ["/api/daily-logs/save", { log: { ...state.logs[0], tankGroupId: "group-n", notes: "试图挪到新组" } }],
    ["/api/water-quality-records/save", { deleteId: "room-water" }],
    ["/api/water-quality-records/save", { record: { ...state.waterQualityRecords[0], tankGroupId: "group-n" } }],
  ];
  for (const [path, body] of attempts) {
    const result = await s.request(path, { token: s.tokens.admin, body });
    assert.equal(result.response.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, path.includes("daily") ? "LEGACY_ROOM_HISTORY_READ_ONLY" : undefined);
  }
  assert.deepEqual(await s.readPersistedState(), state);
  const normal = await s.request("/api/daily-logs/save", { token: s.tokens.editor, body: { log: { id: "new-log", tankGroupId: "group-n", date: "2026-11-02T12:00:00", action: "观察", notes: "新组正常维护", operator: "" } } }); ok(normal);
  assert.deepEqual((await s.readPersistedState()).bioRecords.find(row => row.id === "old-room-bio"), state.bioRecords[0]);
});

test("last migrated group keeps the history entry point; another surviving reference permits normal deletion", async t => {
  const s = await setup(t, state => { state.tankGroups.push({ id: "second-reference", name: "另一缸", siteId: "nanjing", subTanks: [], legacyRoomId: "old-room", legacyRoomName: "原房间一" }); });
  ok(await s.saveGroup({ mode: "deleteGroup", groupId: "second-reference" }));
  const blocked = await s.saveGroup({ mode: "deleteGroup", groupId: "group-n" });
  assert.equal(blocked.response.status, 409); assert.equal(blocked.body.code, "LEGACY_ROOM_LAST_REFERENCE");
});

test("legacy history SQL projects only authorized bounded logs and water, never complete state or fish histories", async () => {
  const source = await readFile(new URL("./tank-group-legacy-history.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SELECT\s+data\s+FROM|data\s*->\s*'(?:stock|bioRecords)'|(?:UPDATE|INSERT INTO|DELETE FROM)\s+app_state/i);
  assert.match(source, /REPEATABLE READ READ ONLY/); assert.equal((source.match(/LIMIT \$5/g) || []).length, 2);
  assert.equal((source.match(/jsonb_array_elements/g) || []).length, 2);
});
