import assert from "node:assert/strict";
import test from "node:test";
import {
  MaintenanceSaveError,
  assertMaintenanceExpectedItems,
  findMaintenanceMutationLog,
  maintenanceDeltaIds,
  maintenanceExpectedStockSnapshot,
  maintenanceMutationDigest,
  normalizeMaintenanceClientMutationId,
  normalizeMaintenanceSavePayload,
  prepareMaintenanceMutation,
  resolveMaintenanceDeltaByIds,
  withMaintenanceTransaction,
  withMaintenanceMutationMetadata,
} from "./maintenance-save-rules.mjs";

const stocks = [
  { id: "stock-2", subTankId: "tank-b", status: "feeding", lost: false },
  { id: "stock-1", subTankId: "tank-a", status: "healthy", lost: false },
];
const expectedItems = stocks.map(maintenanceExpectedStockSnapshot);

function moveChange(overrides = {}) {
  return {
    mode: "move",
    clientMutationId: "maintenance-client-001",
    itemIds: ["stock-2", "stock-1"],
    expectedItems,
    targetSubTankId: "tank-c",
    moveDate: "2026-08-19",
    moveNotes: "  同批移缸  ",
    ...overrides,
  };
}

test("validates stable client mutation ids with recognizable 400 errors", () => {
  assert.equal(normalizeMaintenanceClientMutationId(" retry:123 "), "retry:123");
  assert.throws(() => normalizeMaintenanceClientMutationId(""), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 400 &&
    error.code === "MAINTENANCE_MUTATION_ID_REQUIRED"
  );
  assert.throws(() => normalizeMaintenanceClientMutationId("含 空格"), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 400 &&
    error.code === "INVALID_MAINTENANCE_MUTATION_ID"
  );
});

test("normalizes all four maintenance payload modes", () => {
  assert.deepEqual(normalizeMaintenanceSavePayload({
    mode: "record",
    clientMutationId: "record-1",
    itemIds: ["stock-2", "stock-1"],
    recordDate: "2026-08-19T09:30",
    recordText: "  状态稳定  ",
    recordPhotos: ["/b.jpg", "/a.jpg"],
    recordVideos: ["/v.mp4"],
  }), {
    mode: "record",
    clientMutationId: "record-1",
    itemIds: ["stock-1", "stock-2"],
    recordDate: "2026-08-19T09:30:00",
    recordText: "状态稳定",
    recordPhotos: ["/b.jpg", "/a.jpg"],
    recordVideos: ["/v.mp4"],
  });

  const moved = normalizeMaintenanceSavePayload(moveChange());
  assert.equal(moved.moveNotes, "同批移缸");
  assert.deepEqual(moved.expectedItems.map((item) => item.id), ["stock-1", "stock-2"]);

  assert.equal(normalizeMaintenanceSavePayload({
    mode: "status",
    clientMutationId: "status-1",
    itemIds: ["stock-1"],
    expectedItems: [expectedItems.find((item) => item.id === "stock-1")],
    targetStatus: "sick",
  }).targetStatus, "sick");

  assert.deepEqual(normalizeMaintenanceSavePayload({
    mode: "loss",
    clientMutationId: "loss-1",
    stockItemId: "stock-1",
    expectedItems: [expectedItems.find((item) => item.id === "stock-1")],
    lossDate: "2026-08-19",
    lossReason: "  死亡  ",
    lossProof: ["/proof-b.jpg", "/proof-a.jpg"],
  }).lossProof, ["/proof-b.jpg", "/proof-a.jpg"]);
});

test("produces a stable sha256 digest independent of set-like array order", () => {
  const first = moveChange();
  const second = moveChange({
    itemIds: [...first.itemIds].reverse(),
    expectedItems: [...first.expectedItems].reverse(),
  });
  const firstDigest = maintenanceMutationDigest(first);
  assert.match(firstDigest, /^[a-f0-9]{64}$/);
  assert.equal(maintenanceMutationDigest(second), firstDigest);

  const record = {
    mode: "record",
    clientMutationId: "record-2",
    itemIds: ["stock-1", "stock-2"],
    recordDate: "2026-08-19T10:00",
    recordText: "白点观察",
    recordPhotos: ["/one.jpg", "/two.jpg"],
    recordVideos: [],
  };
  assert.equal(maintenanceMutationDigest({
    ...record,
    itemIds: [...record.itemIds].reverse(),
  }), maintenanceMutationDigest(record));
  assert.notEqual(maintenanceMutationDigest({
    ...record,
    recordPhotos: [...record.recordPhotos].reverse(),
  }), maintenanceMutationDigest(record));
  assert.notEqual(maintenanceMutationDigest({ ...record, recordText: "白点治疗" }), maintenanceMutationDigest(record));
  assert.notEqual(maintenanceMutationDigest({ ...record, recordPhotos: ["/three.jpg"] }), maintenanceMutationDigest(record));
});

test("requires one unique expected snapshot for every move/status/loss item", () => {
  assert.throws(() => normalizeMaintenanceSavePayload(moveChange({ expectedItems: undefined })), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 400 &&
    error.code === "MAINTENANCE_EXPECTED_ITEMS_REQUIRED"
  );
  assert.throws(() => normalizeMaintenanceSavePayload(moveChange({
    expectedItems: [expectedItems[0], expectedItems[0]],
  })), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 400 &&
    error.code === "MAINTENANCE_DUPLICATE_EXPECTED_ITEM"
  );
  assert.throws(() => normalizeMaintenanceSavePayload(moveChange({
    expectedItems: [expectedItems[0]],
  })), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 400 &&
    error.code === "INVALID_MAINTENANCE_EXPECTED_ITEMS"
  );
});

test("CAS accepts an exact snapshot and rejects stale or invalid stock state with 409", () => {
  assert.deepEqual(assertMaintenanceExpectedItems({
    mode: "move",
    itemIds: ["stock-2", "stock-1"],
    expectedItems,
    currentItems: stocks,
  }), [...expectedItems].sort((a, b) => a.id.localeCompare(b.id)));

  assert.throws(() => assertMaintenanceExpectedItems({
    mode: "status",
    itemIds: ["stock-1", "stock-2"],
    expectedItems,
    currentItems: stocks.map((item) => item.id === "stock-1" ? { ...item, status: "sick" } : item),
  }), (error) =>
    error instanceof MaintenanceSaveError && error.statusCode === 409 && error.code === "MAINTENANCE_STALE"
  );
  assert.throws(() => assertMaintenanceExpectedItems({
    mode: "loss",
    itemIds: ["stock-1", "stock-2"],
    expectedItems,
    currentItems: [stocks[0]],
  }), (error) =>
    error instanceof MaintenanceSaveError && error.statusCode === 409 && error.code === "MAINTENANCE_STALE"
  );
  assert.throws(() => assertMaintenanceExpectedItems({
    mode: "move",
    itemIds: ["stock-1", "stock-2"],
    expectedItems,
    currentItems: [stocks[0], stocks[1], { ...stocks[1] }],
  }), (error) =>
    error instanceof MaintenanceSaveError && error.statusCode === 409 && error.code === "MAINTENANCE_STOCK_STATE_INVALID"
  );
});

test("double click and response-loss retry return committed metadata without duplicating the log", () => {
  const prepared = prepareMaintenanceMutation(moveChange());
  const delta = {
    stockUpdates: stocks,
    batchUpdates: [{ id: "batch-2", count: 3 }],
    bioRecordUpdates: [{ id: "bio-2", text: "large response body is not stored" }],
    lossRecordUpdates: [],
  };
  const committedLog = withMaintenanceMutationMetadata({
    id: "log-1",
    operator: "staff-a",
    detail: "移缸 2 条",
  }, {
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
    delta,
  });
  const operationLogs = [committedLog];

  const doubleClick = findMaintenanceMutationLog({
    operationLogs,
    operator: "staff-a",
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
  });
  const responseLostRetry = findMaintenanceMutationLog({
    operationLogs,
    operator: "staff-a",
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
  });
  assert.equal(doubleClick.operationLog.id, "log-1");
  assert.deepEqual(responseLostRetry.deltaIds, doubleClick.deltaIds);
  assert.equal(operationLogs.length, 1);
  assert.deepEqual(committedLog.maintenanceDeltaIds, {
    stockUpdateIds: ["stock-1", "stock-2"],
    batchUpdateIds: ["batch-2"],
    bioRecordUpdateIds: ["bio-2"],
    lossRecordUpdateIds: [],
  });
  assert.equal(JSON.stringify(committedLog).includes("large response body is not stored"), false);
});

test("same operator and mutation id with different content conflicts, while another operator is independent", () => {
  const first = prepareMaintenanceMutation(moveChange());
  const committedLog = withMaintenanceMutationMetadata({ id: "log-1", operator: "staff-a" }, {
    clientMutationId: first.clientMutationId,
    digest: first.digest,
    delta: {},
  });
  const changedDigest = maintenanceMutationDigest(moveChange({ moveNotes: "另一项操作" }));
  assert.throws(() => findMaintenanceMutationLog({
    operationLogs: [committedLog],
    operator: "staff-a",
    clientMutationId: first.clientMutationId,
    digest: changedDigest,
  }), (error) =>
    error instanceof MaintenanceSaveError &&
    error.statusCode === 409 &&
    error.code === "MAINTENANCE_MUTATION_ID_CONFLICT"
  );
  assert.equal(findMaintenanceMutationLog({
    operationLogs: [committedLog],
    operator: "staff-b",
    clientMutationId: first.clientMutationId,
    digest: changedDigest,
  }), null);
});

test("idempotency is based on committed transaction state and resolves compact delta ids", () => {
  const prepared = prepareMaintenanceMutation(moveChange());
  const stagedLog = withMaintenanceMutationMetadata({ id: "log-tx", operator: "staff-a" }, {
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
    delta: {
      stockUpdates: stocks,
      bioRecordUpdates: [{ id: "bio-1", text: "moved" }],
    },
  });

  assert.equal(findMaintenanceMutationLog({
    operationLogs: [],
    operator: "staff-a",
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
  }), null, "a rolled-back or not-yet-committed log must not deduplicate the request");

  const committed = findMaintenanceMutationLog({
    operationLogs: [stagedLog],
    operator: "staff-a",
    clientMutationId: prepared.clientMutationId,
    digest: prepared.digest,
  });
  assert.deepEqual(resolveMaintenanceDeltaByIds({
    stock: stocks,
    batches: [],
    bioRecords: [{ id: "bio-1", text: "moved" }],
    lossRecords: [],
  }, committed.deltaIds), {
    stockUpdates: [stocks[1], stocks[0]],
    batchUpdates: [],
    bioRecordUpdates: [{ id: "bio-1", text: "moved" }],
    lossRecordUpdates: [],
  });
  assert.deepEqual(maintenanceDeltaIds({ stockUpdateIds: ["stock-2", "stock-1", "stock-2"] }).stockUpdateIds,
    ["stock-1", "stock-2"]);
});

test("maintenance transaction commits success and rolls back every failed mutation", async () => {
  const committedQueries = [];
  const committed = await withMaintenanceTransaction({
    query: async (sql) => { committedQueries.push(sql); },
  }, async () => {
    committedQueries.push("MUTATE");
    return { ok: true };
  });
  assert.deepEqual(committed, { ok: true });
  assert.deepEqual(committedQueries, ["BEGIN", "MUTATE", "COMMIT"]);

  const rolledBackQueries = [];
  const transactionError = new Error("update failed");
  await assert.rejects(() => withMaintenanceTransaction({
    query: async (sql) => { rolledBackQueries.push(sql); },
  }, async () => {
    rolledBackQueries.push("MUTATE");
    throw transactionError;
  }), transactionError);
  assert.deepEqual(rolledBackQueries, ["BEGIN", "MUTATE", "ROLLBACK"]);

  await assert.rejects(() => withMaintenanceTransaction({
    query: async (sql) => {
      if (sql === "ROLLBACK") throw new Error("connection closed");
    },
  }, async () => {
    throw transactionError;
  }), transactionError, "rollback failure must not hide the original mutation error");
});
