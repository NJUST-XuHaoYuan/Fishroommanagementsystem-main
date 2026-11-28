import assert from "node:assert/strict";
import test from "node:test";
import { applyMaintenanceGroupScopeMigration, planMaintenanceGroupScopeMigration } from "./maintenance-group-scope-migration.mjs";

const group = (id, sub, extra = {}) => ({ id, siteId: "jiangyin", name: id, subTanks: [{ id: sub }], ...extra });
const log = (id, extra = {}) => ({ id, siteId: "jiangyin", tankGroupId: "old-room", date: "2026-10-01T08:00:00", action: "观察", operator: "worker", notes: "原文", photos: ["/uploads/original.jpg"], videos: ["/uploads/original.mov"], ...extra });
const fixture = () => ({ tankGroups: [group("new-1", "sub-1", { legacyRoomId: "old-room" }), group("new-2", "sub-2", { legacyRoomId: "old-room" }), group("other", "other-sub")],
  logs: [log("direct", { subTankId: "sub-1", scope: "subTank", syncedStockItemIds: ["fish-moved"] }), log("shared")],
  waterQualityRecords: [{ id: "water", siteId: "jiangyin", tankGroupId: "old-room", measuredAt: "2026-10-01T08:00:00Z", operator: "worker", values: [{ parameterId: "ph", parameterName: "pH", unit: "pH", precision: 2, value: 8.1 }] }],
  bioRecords: [{ id: "bio", stockItemId: "dead-fish", sourceType: "dailyLog", sourceLogId: "shared", tankGroupId: "new-1", subTankId: "sub-1", photos: ["/uploads/fish.jpg"] }, { id: "manual", stockItemId: "fish", photos: ["/uploads/manual.jpg"] }],
  stock: [{ id: "new-fish", subTankId: "sub-2" }], orders: [{ id: "untouched" }], lossRecords: [{ id: "untouched-loss" }] });

test("explicit compartments map once while room-only logs/water retain one canonical shared record", () => {
  const state = fixture(), before = structuredClone(state), { state: after, report } = applyMaintenanceGroupScopeMigration(state);
  assert.deepEqual(state, before);
  assert.equal(after.logs.length, 2); assert.equal(after.waterQualityRecords.length, 1);
  assert.equal(after.logs[0].tankGroupId, "new-1"); assert.equal(after.logs[0].scope, "group"); assert.equal(after.logs[0].subTankId, undefined);
  assert.equal(after.logs[0].recordedFromSubTankId, "sub-1"); assert.equal(after.logs[0].scopeMigration.originalTankGroupId, "old-room");
  assert.equal(after.logs[0].scopeMigration.originalSubTankId, "sub-1");
  assert.deepEqual(after.logs[0].syncedStockItemIds, ["fish-moved"]);
  assert.equal(after.logs[1].id, "shared"); assert.equal(after.logs[1].tankGroupId, "old-room");
  assert.deepEqual(after.logs[1].inheritedTankGroupIds, ["new-1", "new-2"]);
  assert.deepEqual(after.logs[1].syncedStockItemIds, ["dead-fish"]);
  assert.deepEqual(after.waterQualityRecords[0].inheritedTankGroupIds, ["new-1", "new-2"]);
  assert.deepEqual(after.waterQualityRecords[0].values, state.waterQualityRecords[0].values);
  for (const key of ["stock", "orders", "bioRecords", "lossRecords", "tankGroups"]) assert.equal(after[key], state[key]);
  assert.deepEqual(report.changed, { logs: 2, waterQualityRecords: 1 }); assert.equal(report.unresolved.length, 0);
  const repeated = applyMaintenanceGroupScopeMigration(after);
  assert.deepEqual(repeated.state, after); assert.deepEqual(repeated.report.changed, { logs: 0, waterQualityRecords: 0 });
});

test("all ordinary sub actions normalize without guessing new historical fish and preserve deleted entry locations", () => {
  const state = fixture(); state.logs = [log("feed", { tankGroupId: "other", subTankId: "other-sub", action: "喂食" }), log("removed", { tankGroupId: "other", subTankId: "deleted-sub", action: "换水" }), log("custom", { tankGroupId: "", subTankId: "other-sub", action: "擦缸" })];
  const { state: after } = applyMaintenanceGroupScopeMigration(state);
  for (const record of after.logs) { assert.equal(record.scope, "group"); assert.equal(record.subTankId, undefined); assert.equal(record.tankGroupId, "other"); assert.deepEqual(record.syncedStockItemIds, []); }
  assert.equal(after.logs[1].recordedFromSubTankId, "deleted-sub");
});

test("ambiguous, cross-site and mismatched room/sub records are reported and cannot be partially applied", () => {
  const state = fixture(); state.logs = [log("bad-pair", { subTankId: "other-sub" }), log("unknown", { tankGroupId: "gone" }), log("cross-site", { siteId: "nanjing" })];
  const plan = planMaintenanceGroupScopeMigration(state); assert.equal(plan.report.unresolved.length, 3);
  assert.deepEqual(plan.patch.logs, state.logs); assert.throws(() => applyMaintenanceGroupScopeMigration(state), /Unresolved maintenance locations/);
  const duplicate = fixture(); duplicate.tankGroups.push(group("duplicate", "sub-1")); assert.throws(() => planMaintenanceGroupScopeMigration(duplicate), /Compartment IDs/);
});

test("single-fish records and stable shared references remain unchanged on subsequent topology changes", () => {
  const state = fixture(); state.logs.push(log("fish-log", { stockItemId: "fish" }));
  const applied = applyMaintenanceGroupScopeMigration(state).state;
  assert.equal(applied.logs.find(record => record.id === "fish-log"), state.logs[2]);
  applied.tankGroups = [...applied.tankGroups, group("new-3", "sub-3", { legacyRoomId: "old-room" })];
  const rerun = applyMaintenanceGroupScopeMigration(applied);
  assert.deepEqual(rerun.state.logs[1].inheritedTankGroupIds, ["new-1", "new-2"]);
  assert.equal(rerun.state.bioRecords, state.bioRecords);
});

test("an exact record-specific verified historical location resolves a deleted compartment without a default guess", () => {
  const state = fixture(), orphan = log("seed-log", { tankGroupId: undefined, subTankId: "deleted-seed-compartment", action: "换水", notes: "20%" });
  state.logs = [orphan]; state.waterQualityRecords = [];
  assert.equal(planMaintenanceGroupScopeMigration(state).report.unresolved.length, 1);
  const verification = { collection: "logs", recordId: orphan.id, subTankId: orphan.subTankId, tankGroupId: "other", expectedRecord: structuredClone(orphan), evidence: "verified historical seed source and exact persisted record" };
  const options = { verifiedHistoricalLocations: [verification] };
  const result = applyMaintenanceGroupScopeMigration(state, options), migrated = result.state.logs[0];
  assert.equal(migrated.tankGroupId, "other"); assert.equal(migrated.scope, "group"); assert.equal(migrated.subTankId, undefined);
  assert.equal(migrated.recordedFromSubTankId, orphan.subTankId); assert.equal(migrated.scopeMigration.originalTankGroupId, "");
  assert.equal(migrated.scopeMigration.originalSubTankId, orphan.subTankId);
  assert.deepEqual(migrated.scopeMigration.verifiedHistoricalLocation, { subTankId: orphan.subTankId, tankGroupId: "other", evidence: verification.evidence });
  assert.equal(result.report.verifiedHistoricalMappingsUsed.length, 1);
  for (const key of ["id", "date", "operator", "notes", "photos", "videos"]) assert.deepEqual(migrated[key], orphan[key]);
  assert.deepEqual(migrated.syncedStockItemIds, []); assert.equal(result.state.bioRecords, state.bioRecords);
  assert.deepEqual(applyMaintenanceGroupScopeMigration(result.state, options).state, result.state);
  const changed = structuredClone(state); changed.logs[0].notes = "changed after verification";
  assert.match(planMaintenanceGroupScopeMigration(changed, options).report.unresolved[0].reason, /不完全一致/);
  assert.throws(() => applyMaintenanceGroupScopeMigration(changed, options), /Unresolved maintenance locations/);
});

test("historical fallback rejects missing evidence, cross-site, duplicate, absent or currently owned locations", () => {
  const state = fixture(); state.logs = [log("orphan", { tankGroupId: "", subTankId: "gone" })];
  const valid = { collection: "logs", recordId: "orphan", subTankId: "gone", tankGroupId: "other", expectedRecord: structuredClone(state.logs[0]), evidence: "verified" };
  for (const patch of [{ evidence: "" }, { tankGroupId: "missing" }, { recordId: "missing" }, { expectedRecord: { ...valid.expectedRecord, siteId: "nanjing" } }, { expectedRecord: { ...valid.expectedRecord, tankGroupId: "new-1" } }]) {
    assert.throws(() => planMaintenanceGroupScopeMigration(state, { verifiedHistoricalLocations: [{ ...valid, ...patch }] }));
  }
  assert.throws(() => planMaintenanceGroupScopeMigration(state, { verifiedHistoricalLocations: [valid, valid] }), /Duplicate/);
  const nowOwned = structuredClone(state); nowOwned.tankGroups[0].subTanks.push({ id: "gone" });
  assert.throws(() => planMaintenanceGroupScopeMigration(nowOwned, { verifiedHistoricalLocations: [valid] }), /existing compartment owner/);
  const unrelated = structuredClone(state); unrelated.logs = [];
  assert.throws(() => planMaintenanceGroupScopeMigration(unrelated, { verifiedHistoricalLocations: [valid] }), /record does not exist/);
});
