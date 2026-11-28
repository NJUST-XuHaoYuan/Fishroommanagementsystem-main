import assert from "node:assert/strict";
import test from "node:test";
import { comparableMaintenanceLocation, isGroupMaintenanceLog, maintenanceRecordLocation } from "./maintenance-scope-rules.mjs";

const group = { id: "group", subTanks: [{ id: "sub-1" }, { id: "sub-2" }] };

test("every tank action uses group scope while a legacy sub selection remains an entry location", () => {
  for (const action of ["喂食", "换水", "观察", "清洁", "其他", "自定义操作", "下药"]) {
    const input = { action, scope: "subTank", subTankId: "sub-1" };
    assert.equal(isGroupMaintenanceLog(input), true);
    assert.deepEqual(maintenanceRecordLocation(input, { group }), { scope: "group", recordedFromSubTankId: "sub-1" });
    assert.deepEqual(comparableMaintenanceLocation(input), comparableMaintenanceLocation({ scope: "group", recordedFromSubTankId: "sub-1" }));
  }
});

test("original deleted entry location is immutable and only accepted for the same group", () => {
  const current = { tankGroupId: "group", scope: "subTank", subTankId: "removed" };
  assert.deepEqual(maintenanceRecordLocation({}, { current, group }), { scope: "group", recordedFromSubTankId: "removed" });
  assert.throws(() => maintenanceRecordLocation({ subTankId: "sub-2" }, { current, group }), /原录入位置/);
  assert.throws(() => maintenanceRecordLocation({}, { current, group: { ...group, id: "other" } }), /不属于当前缸组/);
  assert.throws(() => maintenanceRecordLocation({ subTankId: "other-site" }, { group }), /不属于当前缸组/);
});

test("migration ownership metadata is preserved from storage and cannot be supplied by a client", () => {
  const forged = { scope: "group", inheritedTankGroupIds: ["foreign"], scopeMigration: { id: "forged" } };
  assert.deepEqual(maintenanceRecordLocation(forged, { group }), { scope: "group" });
  const current = { tankGroupId: "group", inheritedTankGroupIds: ["group"], scopeMigration: { id: "migration", originalTankGroupId: "old" } };
  const actual = maintenanceRecordLocation(forged, { current, group });
  assert.deepEqual(actual.inheritedTankGroupIds, current.inheritedTankGroupIds);
  assert.deepEqual(actual.scopeMigration, current.scopeMigration);
});
