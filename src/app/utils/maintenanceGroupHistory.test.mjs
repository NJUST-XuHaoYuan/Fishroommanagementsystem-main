import assert from "node:assert/strict";
import { test } from "node:test";
import { isInheritedMaintenanceHistory, maintenanceHistoryGroupIds, maintenanceHistoryScopeLabel } from "./maintenanceGroupHistory.ts";

const groups = [
  { id: "a", name: "A缸", subTanks: [{ id: "a-1", name: "A1" }] },
  { id: "b", name: "B缸", subTanks: [{ id: "b-1", name: "B1" }] },
];

test("one original room record is discoverable from either corresponding group without duplicating the all-groups list", () => {
  const room = { id: "r", tankGroupId: "old-room", inheritedTankGroupIds: ["a", "b", "a", "other-site"] };
  const current = { id: "c", tankGroupId: "a" };
  const records = [room, current];
  assert.deepEqual(maintenanceHistoryGroupIds(room, groups), ["a", "b"]);
  assert.equal(records.filter(record => maintenanceHistoryGroupIds(record, groups).includes("a")).length, 2);
  assert.equal(records.filter(record => maintenanceHistoryGroupIds(record, groups).includes("b")).length, 1);
  assert.equal(records.filter(record => maintenanceHistoryGroupIds(record, groups).length).length, 2);
  assert.equal(maintenanceHistoryScopeLabel(room, groups, "b"), "B缸 · 历史继承");
});

test("legacy compartment records resolve to their group; inherited records are identifiable for exclusion from latest readings", () => {
  assert.deepEqual(maintenanceHistoryGroupIds({ subTankId: "a-1" }, groups), ["a"]);
  assert.deepEqual(maintenanceHistoryGroupIds({ tankGroupId: "missing" }, groups), []);
  assert.equal(isInheritedMaintenanceHistory({ tankGroupId: "old-room", inheritedTankGroupIds: ["a"] }), true);
  assert.equal(isInheritedMaintenanceHistory({ tankGroupId: "a" }), false);
  assert.equal(maintenanceHistoryScopeLabel({ tankGroupId: "a", subTankId: "a-1" }, groups), "A缸");
});
