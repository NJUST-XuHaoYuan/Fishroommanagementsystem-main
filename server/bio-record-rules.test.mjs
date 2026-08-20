import assert from "node:assert/strict";
import test from "node:test";
import {
  BioRecordConflictError,
  assertUniqueBioRecordIds,
  bioRecordRequiredActions,
  bioRecordExpectedSnapshot,
  canAccessBioStockSite,
  findUniqueBioStockItem,
  maintenanceRequiredPermissions,
  planBioRecordSave,
} from "./bio-record-rules.mjs";

const stockItem = {
  id: "stock-1",
  siteId: "nanjing",
  inDate: "2026-08-01",
  status: "healthy",
  basePrice: 120,
  code: "NJ-1",
  notes: "old",
};

const inputRecord = {
  id: "bio-client-1",
  date: "2026-08-19T09:30",
  text: "状态稳定",
  photos: ["/uploads/original/images/a.jpg"],
  videos: [],
};

test("allows administrators but makes staff stock-site access fail closed", () => {
  assert.equal(canAccessBioStockSite({
    account: { accessRole: "admin" },
    visibleSiteIds: [],
    stockSiteId: "legacy-unknown-site",
  }), true);
  assert.equal(canAccessBioStockSite({
    account: { accessRole: "staff" },
    visibleSiteIds: ["nanjing"],
    stockSiteId: "nanjing",
  }), true);
  assert.equal(canAccessBioStockSite({
    account: { accessRole: "staff" },
    visibleSiteIds: ["nanjing"],
    stockSiteId: "jiangyin",
  }), false);
  assert.equal(canAccessBioStockSite({
    account: { accessRole: "staff" },
    visibleSiteIds: ["nanjing"],
    stockSiteId: "",
  }), false);
});

test("maps every write action to its server-side daily permission", () => {
  assert.deepEqual(bioRecordRequiredActions("create"), ["create"]);
  assert.deepEqual(bioRecordRequiredActions("updateTime"), ["update"]);
  assert.deepEqual(bioRecordRequiredActions("delete"), ["delete"]);
  assert.deepEqual(bioRecordRequiredActions("saveDetails"), ["update"]);
  assert.deepEqual(bioRecordRequiredActions("saveDetails", { includesRecord: true }), ["update", "create"]);
  assert.throws(() => bioRecordRequiredActions("unknown"), /不支持的生物记录操作/);
});

test("maps batch maintenance modes to all permissions they mutate", () => {
  assert.deepEqual(maintenanceRequiredPermissions("record"), [{ module: "daily", action: "create" }]);
  assert.deepEqual(maintenanceRequiredPermissions("move"), [{ module: "daily", action: "update" }]);
  assert.deepEqual(maintenanceRequiredPermissions("status"), [{ module: "daily", action: "update" }]);
  assert.deepEqual(maintenanceRequiredPermissions("loss"), [
    { module: "daily", action: "delete" },
    { module: "lossRecords", action: "create" },
  ]);
  assert.throws(() => maintenanceRequiredPermissions("unknown"), /Unsupported maintenance save mode/);
});

test("creates one server-owned manual record and accepts an exact retry idempotently", () => {
  const created = planBioRecordSave({
    action: "create",
    stockItem,
    records: [],
    record: inputRecord,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(created.record.id, "bio-client-1");
  assert.equal(created.record.siteId, "nanjing");
  assert.equal(created.record.operator, "staff-a");
  assert.equal(created.record.sourceType, "manual");
  assert.deepEqual(created.changedKeys, ["bioRecords"]);

  const retried = planBioRecordSave({
    action: "create",
    stockItem,
    records: created.records,
    record: inputRecord,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(retried.idempotent, true);
  assert.equal(retried.records.length, 1);
  assert.deepEqual(retried.changedKeys, []);
});

test("rejects reuse of a client record id for different content", () => {
  const first = planBioRecordSave({
    action: "create",
    stockItem,
    records: [],
    record: inputRecord,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.throws(() => planBioRecordSave({
    action: "create",
    stockItem,
    records: first.records,
    record: { ...inputRecord, text: "另一条内容" },
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), (error) => error instanceof BioRecordConflictError && error.code === "BIO_RECORD_ID_CONFLICT");
});

test("fails closed for duplicate stock and bio-record ids across sites", () => {
  const duplicateStock = [
    { ...stockItem, siteId: "nanjing" },
    { ...stockItem, siteId: "jiangyin", subTankId: "jy-tank-1" },
  ];
  assert.throws(() => findUniqueBioStockItem(duplicateStock, stockItem.id), (error) =>
    error instanceof BioRecordConflictError &&
    error.statusCode === 409 &&
    error.code === "BIO_STOCK_ID_CONFLICT"
  );

  const visibleRecord = {
    ...inputRecord,
    siteId: "nanjing",
    stockItemId: stockItem.id,
    date: "2026-08-19T09:30:00",
    sourceType: "manual",
    operator: "staff-a",
  };
  const hiddenRecord = {
    ...visibleRecord,
    siteId: "jiangyin",
    stockItemId: "stock-hidden",
    text: "另一个场地的记录",
  };
  assert.throws(() => assertUniqueBioRecordIds([visibleRecord, hiddenRecord]), (error) =>
    error instanceof BioRecordConflictError && error.code === "BIO_RECORD_STATE_INVALID"
  );
  assert.throws(() => planBioRecordSave({
    action: "create",
    stockItem,
    records: [visibleRecord, hiddenRecord],
    record: inputRecord,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), (error) =>
    error instanceof BioRecordConflictError && error.code === "BIO_RECORD_STATE_INVALID"
  );
  for (const action of ["updateTime", "delete"]) {
    assert.throws(() => planBioRecordSave({
      action,
      stockItem,
      records: [visibleRecord, hiddenRecord],
      recordId: visibleRecord.id,
      expectedRecord: bioRecordExpectedSnapshot(visibleRecord),
      ...(action === "updateTime" ? { record: { date: "2026-08-19T09:45" } } : {}),
      operator: "staff-a",
      now: "2026-08-19T10:00:00",
    }), (error) =>
      error instanceof BioRecordConflictError &&
      error.statusCode === 409 &&
      error.code === "BIO_RECORD_STATE_INVALID"
    );
  }
});

test("uses a full expected snapshot as CAS for time changes and deletion", () => {
  const current = {
    ...inputRecord,
    siteId: "nanjing",
    stockItemId: "stock-1",
    date: "2026-08-19T09:30:00",
    sourceType: "manual",
    operator: "staff-a",
  };
  const expected = bioRecordExpectedSnapshot(current);
  const updated = planBioRecordSave({
    action: "updateTime",
    stockItem,
    records: [current],
    recordId: current.id,
    expectedRecord: expected,
    record: { date: "2026-08-19T09:45" },
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(updated.record.date, "2026-08-19T09:45:00");

  assert.throws(() => planBioRecordSave({
    action: "delete",
    stockItem,
    records: updated.records,
    recordId: current.id,
    expectedRecord: expected,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), (error) => error instanceof BioRecordConflictError && error.code === "BIO_RECORD_STALE");
});

test("saves only allowed stock details and can atomically append one record", () => {
  const planned = planBioRecordSave({
    action: "saveDetails",
    stockItem,
    records: [],
    details: { status: "feeding", basePrice: 135.126, code: " NJ-2 ", notes: "new" },
    expectedDetails: { status: "healthy", basePrice: 120, code: "NJ-1", notes: "old" },
    record: inputRecord,
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  });
  assert.equal(planned.stockItem.status, "feeding");
  assert.equal(planned.stockItem.basePrice, 135.13);
  assert.equal(planned.stockItem.code, "NJ-2");
  assert.equal(planned.stockItem.priceOverridden, true);
  assert.equal(planned.record.id, "bio-client-1");
  assert.deepEqual(planned.changedKeys, ["stock", "bioRecords"]);
});

test("rejects stale stock details instead of overwriting another writer", () => {
  assert.throws(() => planBioRecordSave({
    action: "saveDetails",
    stockItem: { ...stockItem, status: "sick" },
    records: [],
    details: { status: "feeding" },
    expectedDetails: { status: "healthy" },
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), (error) => error instanceof BioRecordConflictError && error.code === "BIO_DETAILS_STALE");
});

test("rejects records outside the stock lifetime or with no content", () => {
  assert.throws(() => planBioRecordSave({
    action: "create",
    stockItem,
    records: [],
    record: { ...inputRecord, date: "2026-07-31T23:59" },
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), /不能早于入库日期/);
  assert.throws(() => planBioRecordSave({
    action: "create",
    stockItem,
    records: [],
    record: { ...inputRecord, text: " ", photos: [], videos: [] },
    operator: "staff-a",
    now: "2026-08-19T10:00:00",
  }), /填写记录内容/);
});
