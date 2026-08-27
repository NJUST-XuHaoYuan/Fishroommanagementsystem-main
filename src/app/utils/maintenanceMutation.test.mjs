import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  beginMaintenanceRequest,
  createMaintenanceClientMutationId,
  finishMaintenanceRequest,
  isMaintenanceRequestInFlight,
  maintenanceSaveFailure,
  maintenanceMutationTicket,
  maintenanceStockExpectedSnapshot,
} = await import("./maintenanceMutation.ts");

test("generated maintenance mutation ids are non-empty and server-safe", () => {
  const first = createMaintenanceClientMutationId();
  const second = createMaintenanceClientMutationId();
  assert.match(first, /^maintenance-[A-Za-z0-9._:-]+$/);
  assert.notEqual(first, second);
});

test("maintenance request lock rejects a double click until the request finishes", () => {
  const lock = { current: false };
  assert.equal(isMaintenanceRequestInFlight(lock), false);
  assert.equal(beginMaintenanceRequest(lock), true);
  assert.equal(isMaintenanceRequestInFlight(lock), true);
  assert.equal(beginMaintenanceRequest(lock), false);
  finishMaintenanceRequest(lock);
  assert.equal(beginMaintenanceRequest(lock), true);
});

test("preserves the server maintenance error and conflict metadata for the UI", () => {
  assert.deepEqual(maintenanceSaveFailure(
    "Failed to save maintenance action: 库存鱼已被其他人修改，请刷新后重试",
    409,
    "MAINTENANCE_STALE",
  ), {
    ok: false,
    error: "库存鱼已被其他人修改，请刷新后重试",
    code: "MAINTENANCE_STALE",
    conflict: true,
  });
  assert.equal(maintenanceSaveFailure("当前账户没有执行该操作的权限", 403).error,
    "当前账户没有执行该操作的权限");
});

const recordChange = {
  mode: "record",
  itemIds: ["stock-2", "stock-1"],
  recordDate: "2026-08-19T10:30:00",
  recordText: "状态稳定",
  recordPhotos: [],
  recordVideos: [],
};

test("an unchanged retry reuses its stable client mutation id", () => {
  let sequence = 0;
  const first = maintenanceMutationTicket(null, recordChange, () => `mutation-${++sequence}`);
  const retry = maintenanceMutationTicket(first, { ...recordChange }, () => `mutation-${++sequence}`);

  assert.equal(first.clientMutationId, "mutation-1");
  assert.equal(retry, first);
  assert.equal(sequence, 1);
});

test("editing a failed request starts a new logical mutation", () => {
  let sequence = 0;
  const first = maintenanceMutationTicket(null, recordChange, () => `mutation-${++sequence}`);
  const edited = maintenanceMutationTicket(
    first,
    { ...recordChange, recordText: "已经用药" },
    () => `mutation-${++sequence}`,
  );

  assert.equal(edited.clientMutationId, "mutation-2");
  assert.notEqual(edited.fingerprint, first.fingerprint);
});

test("object key order does not change the mutation fingerprint", () => {
  let sequence = 0;
  const first = maintenanceMutationTicket(null, recordChange, () => `mutation-${++sequence}`);
  const reordered = maintenanceMutationTicket(first, {
    recordVideos: [],
    recordPhotos: [],
    recordText: "状态稳定",
    recordDate: "2026-08-19T10:30:00",
    itemIds: ["stock-2", "stock-1"],
    mode: "record",
  }, () => `mutation-${++sequence}`);

  assert.equal(reordered, first);
  assert.equal(sequence, 1);
});

test("stock CAS snapshots contain only the guarded maintenance fields", () => {
  assert.deepEqual(maintenanceStockExpectedSnapshot({
    id: "stock-1",
    subTankId: "tank-a",
    status: "healthy",
    lost: undefined,
  }), {
    id: "stock-1",
    subTankId: "tank-a",
    status: "healthy",
    lost: false,
  });
});
