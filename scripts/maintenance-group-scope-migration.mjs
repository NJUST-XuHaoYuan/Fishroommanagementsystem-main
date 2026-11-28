import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const MAINTENANCE_SCOPE_MIGRATION_ID = "maintenance-group-scope-20261128-v1";
const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pure planning only. No database connection, clock, generated IDs or fish writes. */
export function planMaintenanceGroupScopeMigration(state = {}, { verifiedHistoricalLocations = [] } = {}) {
  const groups = list(state.tankGroups), groupById = new Map(), groupBySub = new Map(), groupsByRoom = new Map();
  for (const group of groups) {
    const id = text(group.id); assert(id && !groupById.has(id), "Tank group IDs must be present and unique");
    groupById.set(id, group);
    for (const sub of list(group.subTanks)) {
      const sid = text(sub.id); assert(sid && !groupBySub.has(sid), "Compartment IDs must be present and unique");
      groupBySub.set(sid, group);
    }
    const room = text(group.legacyRoomId);
    if (room) {
      assert.notEqual(room, id, "A group cannot inherit itself");
      if (!groupsByRoom.has(room)) groupsByRoom.set(room, []);
      groupsByRoom.get(room).push(group);
    }
  }
  // Only a caller-supplied, record-specific historical verification may resolve
  // a deleted compartment whose record has no group. There is no default map.
  assert(Array.isArray(verifiedHistoricalLocations) && verifiedHistoricalLocations.length <= 100, "Historical location verifications must be an array of at most 100 records");
  const verifiedLocations = new Map();
  for (const entry of verifiedHistoricalLocations) {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), "Invalid historical location verification");
    assert(["logs", "waterQualityRecords"].includes(entry.collection), "Historical location collection is invalid");
    const recordId = text(entry.recordId), subTankId = text(entry.subTankId), tankGroupId = text(entry.tankGroupId), evidence = text(entry.evidence);
    const expected = entry.expectedRecord;
    assert(recordId && subTankId && tankGroupId && evidence && evidence.length <= 2000, "Historical verification requires record, compartment, group and evidence");
    assert(expected && typeof expected === "object" && !Array.isArray(expected) && text(expected.id) === recordId, "Historical verification requires the complete expected record");
    assert(!text(expected.tankGroupId) && !text(expected.stockItemId), "Historical override is only allowed for a group-less tank record");
    assert((text(expected.recordedFromSubTankId) || text(expected.subTankId)) === subTankId, "Historical verification compartment does not match the record");
    assert(!groupBySub.has(subTankId), "Historical override cannot replace an existing compartment owner");
    assert(groupById.has(tankGroupId), "Verified historical target group does not exist");
    assert(text(expected.siteId) && text(expected.siteId) === (text(groupById.get(tankGroupId).siteId) || "nanjing"), "Verified historical target must match the recorded site");
    const key = `${entry.collection}:${recordId}`;
    assert(!verifiedLocations.has(key), "Duplicate historical location verification");
    assert(list(state[entry.collection]).some(record => text(record.id) === recordId), "Verified historical record does not exist");
    verifiedLocations.set(key, { recordId, subTankId, tankGroupId, evidence, expectedRecord: expected });
  }
  const historicalTargets = new Map();
  for (const record of list(state.bioRecords)) {
    if (record.sourceType !== "dailyLog" || !text(record.sourceLogId) || !text(record.stockItemId)) continue;
    if (!historicalTargets.has(text(record.sourceLogId))) historicalTargets.set(text(record.sourceLogId), new Set());
    historicalTargets.get(text(record.sourceLogId)).add(text(record.stockItemId));
  }
  const report = { migrationId: MAINTENANCE_SCOPE_MIGRATION_ID, changed: { logs: 0, waterQualityRecords: 0 },
    direct: [], inherited: [], inheritedCoverage: [], verifiedHistoricalMappingsUsed: [], unresolved: [], frozenTargetLists: 0, before: {}, after: {} };
  const patch = {};
  for (const key of ["logs", "waterQualityRecords"]) {
    const records = list(state[key]), ids = new Set(); report.before[key] = hash(records);
    patch[key] = records.map(record => {
      const id = text(record.id); assert(id && !ids.has(id), `${key} IDs must be present and unique`); ids.add(id);
      // A misplaced individual record is never reinterpreted as a whole-tank event.
      if (text(record.stockItemId)) return record;
      if (record.scopeMigration?.id === MAINTENANCE_SCOPE_MIGRATION_ID) return record;
      const originalGroupId = text(record.tankGroupId), originalSubId = text(record.subTankId);
      const sourceSubId = text(record.recordedFromSubTankId) || originalSubId;
      const unresolved = reason => { report.unresolved.push({ key, id, tankGroupId: originalGroupId, subTankId: sourceSubId, reason }); return record; };
      if (record.scopeMigration) return unresolved("已有其他迁移审计，需人工核对");
      if (originalSubId && text(record.recordedFromSubTankId) && originalSubId !== text(record.recordedFromSubTankId)) return unresolved("原子缸与录入位置不一致");
      let targetGroup, inheritedGroups, verifiedHistoricalLocation;
      const legacyGroups = groupsByRoom.get(originalGroupId);
      if (legacyGroups) {
        if (sourceSubId) {
          targetGroup = groupBySub.get(sourceSubId);
          if (!targetGroup || text(targetGroup.legacyRoomId) !== originalGroupId) return unresolved("原房间和子缸无法唯一配对到新缸组");
        } else inheritedGroups = legacyGroups;
      } else {
        targetGroup = groupById.get(originalGroupId);
        if (!targetGroup && !originalGroupId && sourceSubId) targetGroup = groupBySub.get(sourceSubId);
        if (!targetGroup && !originalGroupId && sourceSubId) {
          const verification = verifiedLocations.get(`${key}:${id}`);
          if (verification) {
            if (!isDeepStrictEqual(record, verification.expectedRecord)) return unresolved("记录内容与已核实的历史来源不完全一致");
            if (sourceSubId !== verification.subTankId) return unresolved("历史映射的原子缸不一致");
            targetGroup = groupById.get(verification.tankGroupId);
            verifiedHistoricalLocation = { subTankId: sourceSubId, tankGroupId: targetGroup.id, evidence: verification.evidence };
          }
        }
        if (!targetGroup) return unresolved("缺少可核对的原缸组或子缸");
        const currentSubOwner = sourceSubId && groupBySub.get(sourceSubId);
        if (currentSubOwner && currentSubOwner.id !== targetGroup.id) return unresolved("原缸组和子缸属于不同水体");
        // A removed compartment may remain as an entry-position snapshot when
        // the original group still exists. It never changes group ownership.
      }
      const targets = inheritedGroups ?? [targetGroup];
      const targetSites = new Set(targets.map(group => text(group.siteId) || "nanjing"));
      if (targetSites.size !== 1 || text(record.siteId) && !targetSites.has(text(record.siteId))) return unresolved("记录与目标缸组场地不一致");
      // An implicit ordinary group record already has the required ownership.
      // Avoid rewriting unrelated history just to add an explicit default.
      if (!inheritedGroups && !originalSubId && !["sub", "subTank"].includes(record.scope) && originalGroupId === text(targetGroup.id)) return record;
      const next = { ...record, scope: "group" };
      delete next.subTankId;
      if (sourceSubId) next.recordedFromSubTankId = sourceSubId;
      if (inheritedGroups) next.inheritedTankGroupIds = inheritedGroups.map(group => text(group.id)).sort();
      else next.tankGroupId = text(targetGroup.id);
      if (isDeepStrictEqual(next, record)) return record;
      next.scopeMigration = { id: MAINTENANCE_SCOPE_MIGRATION_ID, originalTankGroupId: originalGroupId,
        ...(originalSubId ? { originalSubTankId: originalSubId } : {}),
        ...(Object.hasOwn(record, "scope") ? { originalScope: record.scope } : {}),
        ...(verifiedHistoricalLocation ? { verifiedHistoricalLocation } : {}) };
      // Never infer old target fish from today's stock or create bioRecords.
      if (key === "logs" && !Array.isArray(record.syncedStockItemIds)) {
        next.syncedStockItemIds = [...(historicalTargets.get(id) ?? [])].sort(); report.frozenTargetLists++;
      }
      report.changed[key]++;
      if (verifiedHistoricalLocation) report.verifiedHistoricalMappingsUsed.push({ key, id, ...verifiedHistoricalLocation });
      if (inheritedGroups) report.inherited.push({ key, id, originalTankGroupId: originalGroupId, inheritedTankGroupIds: next.inheritedTankGroupIds });
      else report.direct.push({ key, id, originalTankGroupId: originalGroupId, tankGroupId: next.tankGroupId, ...(sourceSubId ? { recordedFromSubTankId: sourceSubId } : {}) });
      return next;
    });
    report.after[key] = hash(patch[key]);
    assert.equal(patch[key].length, records.length, `${key} count changed`);
    // Ownership/audit fields are the complete allow-list. Everything else,
    // including identity, dates, authors, media and measurement values, is exact.
    const withoutOwnership = record => Object.fromEntries(Object.entries(record).filter(([key]) => ![
      "tankGroupId", "subTankId", "scope", "recordedFromSubTankId", "scopeMigration", "inheritedTankGroupIds", "syncedStockItemIds",
    ].includes(key)));
    assert.deepEqual(patch[key].map(withoutOwnership), records.map(withoutOwnership), `${key} content changed`);
    records.forEach((record, index) => { if (Array.isArray(record.syncedStockItemIds)) assert.deepEqual(patch[key][index].syncedStockItemIds, record.syncedStockItemIds); });
  }
  const coverage = new Map();
  for (const entry of report.inherited) for (const groupId of entry.inheritedTankGroupIds) {
    if (!coverage.has(groupId)) coverage.set(groupId, { tankGroupId: groupId, originalTankGroupId: entry.originalTankGroupId, logs: 0, waterQualityRecords: 0 });
    coverage.get(groupId)[entry.key]++;
  }
  report.inheritedCoverage = [...coverage.values()].sort((left, right) => left.tankGroupId.localeCompare(right.tankGroupId));
  return { patch, report };
}

/** Caller owns backup, row locking, permissions and an atomic persistence step. */
export function applyMaintenanceGroupScopeMigration(state, options) {
  const plan = planMaintenanceGroupScopeMigration(state, options);
  assert.equal(plan.report.unresolved.length, 0, `Unresolved maintenance locations: ${JSON.stringify(plan.report.unresolved)}`);
  const nextState = { ...state, ...plan.patch };
  for (const key of Object.keys(state)) if (!["logs", "waterQualityRecords"].includes(key)) assert.equal(nextState[key], state[key]);
  return { state: nextState, report: plan.report };
}
