import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDailyLogSyncIdentity,
  DailyLogSaveError,
  planDailyLogSave,
} from "./daily-log-save-rules.mjs";

const groups = [{
  id: "group-nj",
  siteId: "nanjing",
  name: "南京一组",
  subTanks: [{ id: "tank-nj-1", name: "1-1" }],
}];

const current = {
  id: "daily-1",
  siteId: "nanjing",
  date: "2026-08-19T08:00:00",
  tankGroupId: "group-nj",
  action: "换水",
  operator: "staff-a",
  notes: "旧备注",
};

function assertRuleError(fn, { statusCode, code }) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof DailyLogSaveError, true);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

test("plans a compact create delta using the stored group site and authenticated operator", () => {
  const plan = planDailyLogSave({
    change: { log: { date: "2026-08-19T09:00", tankGroupId: "group-nj", siteId: "forged", action: " 喂食 ", operator: "forged" } },
    matchingLogs: [],
    tankGroups: groups,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
    generatedId: "daily-client-1",
  });
  assert.equal(plan.mode, "create");
  assert.equal(plan.log.id, "daily-client-1");
  assert.equal(plan.log.siteId, "nanjing");
  assert.equal(plan.log.operator, "staff-a");
  assert.equal(plan.log.action, "喂食");
});

test("feeding, water changes, observation and custom actions always save at group scope", () => {
  for (const action of ["喂食", "换水", "观察", "清洗滤棉", "其他"]) {
    const log = { ...current, id: `group-${action}`, action, scope: "subTank", subTankId: "tank-nj-1", photos: ["/uploads/tank.jpg"] };
    const options = { change: { log, createOnly: true }, tankGroups: groups, operator: "staff-a", now: "2026-08-19T10:00:00" };
    const plan = planDailyLogSave(options);
    assert.equal(plan.log.scope, "group");
    assert.equal(plan.log.subTankId, undefined);
    assert.equal(plan.log.recordedFromSubTankId, "tank-nj-1");
    assert.deepEqual(plan.log.photos, log.photos);
    const retry = planDailyLogSave({ ...options, matchingLogs: [plan.log] });
    assert.equal(retry.idempotent, true);
    const legacyRetry = planDailyLogSave({ ...options, matchingLogs: [{ ...log, createdBy: "staff-a" }] });
    assert.equal(legacyRetry.idempotent, true);
  }
});

test("editing a legacy observation retains its original position, attachments and migration audit", () => {
  const legacy = { ...current, action: "观察", subTankId: "removed", photos: ["/uploads/old.jpg"], videos: ["/uploads/old.mp4"],
    scopeMigration: { id: "migration", originalTankGroupId: "old" } };
  const plan = planDailyLogSave({ change: { log: { ...current, action: "观察", notes: "修正文字" } }, matchingLogs: [legacy], tankGroups: groups, operator: "staff-b", now: "2026-08-19T10:00:00" });
  assert.equal(plan.log.scope, "group"); assert.equal(plan.log.subTankId, undefined);
  assert.equal(plan.log.recordedFromSubTankId, "removed");
  assert.deepEqual(plan.log.photos, legacy.photos); assert.deepEqual(plan.log.videos, legacy.videos);
  assert.deepEqual(plan.log.scopeMigration, legacy.scopeMigration);
  assert.equal(plan.log.createdBy, "staff-a");
});

test("daily timeline sync fails closed for duplicate stock and bio identities", () => {
  assertRuleError(() => assertDailyLogSyncIdentity({
    targetStock: [{ id: "fish-1" }, { id: "fish-1" }],
    globalStockIdCounts: { "fish-1": 2 },
  }), { statusCode: 409, code: "DAILY_LOG_SYNC_ID_CONFLICT" });

  assertRuleError(() => assertDailyLogSyncIdentity({
    targetStock: [{ id: "fish-1" }],
    existingBioRecords: [
      { id: "bio-1", stockItemId: "fish-1" },
      { id: "bio-2", stockItemId: "fish-1" },
    ],
    globalStockIdCounts: { "fish-1": 1 },
    globalBioRecords: [
      { id: "bio-1" },
      { id: "bio-2" },
    ],
  }), { statusCode: 409, code: "DAILY_LOG_SYNC_ID_CONFLICT" });

  assertRuleError(() => assertDailyLogSyncIdentity({
    targetStock: [{ id: "fish-1" }],
    bioRecordUpdates: [{ id: "bio-daily-log-fish-1", stockItemId: "fish-1" }],
    globalStockIdCounts: { "fish-1": 1 },
    globalBioRecords: [{ id: "bio-daily-log-fish-1" }],
  }), { statusCode: 409, code: "DAILY_LOG_SYNC_ID_CONFLICT" });
});

test("plans an update only when the target id resolves exactly once", () => {
  const plan = planDailyLogSave({
    change: { log: { ...current, action: "换水并清洁" } },
    matchingLogs: [current],
    tankGroups: groups,
    operator: "staff-b",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(plan.mode, "update");
  assert.equal(plan.current, current);
  assert.equal(plan.log.operator, "staff-b");
  assert.equal(plan.currentSiteId, "nanjing");

  assertRuleError(() => planDailyLogSave({
    change: { log: current },
    matchingLogs: [current, { ...current }],
    tankGroups: groups,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), { statusCode: 409, code: "DAILY_LOG_ID_CONFLICT" });
});

test("plans a delete delta and supports the legacy sub-tank group relation", () => {
  const legacy = { ...current, tankGroupId: "", subTankId: "tank-nj-1" };
  const plan = planDailyLogSave({
    change: { deleteId: current.id },
    matchingLogs: [legacy],
    tankGroups: groups,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(plan.mode, "delete");
  assert.equal(plan.deletedLogId, current.id);
  assert.equal(plan.siteId, "nanjing");

  const orphaned = planDailyLogSave({
    change: { deleteId: current.id },
    matchingLogs: [current],
    tankGroups: [],
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(orphaned.mode, "delete");
  assert.equal(orphaned.siteId, "nanjing");
});

test("rejects missing, duplicate and ambiguous mutations", () => {
  assertRuleError(() => planDailyLogSave({ change: {}, tankGroups: groups }), { statusCode: 400 });
  assertRuleError(() => planDailyLogSave({
    change: { log: current, deleteId: current.id },
    matchingLogs: [current],
    tankGroups: groups,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), { statusCode: 400 });
  assertRuleError(() => planDailyLogSave({
    change: { deleteId: "missing" },
    matchingLogs: [],
    tankGroups: groups,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), { statusCode: 404, code: "DAILY_LOG_NOT_FOUND" });
});
