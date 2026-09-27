import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOrderAcquisitionTagUnchanged,
  planOrderAcquisitionTag,
  requireLockedAcquisitionTagAdmin,
} from "./order-acquisition-tag.mjs";

const admin = { id: "admin-1", username: "admin", name: "管理员", accessRole: "admin", accountEnabled: true, sessionVersion: 2 };
const auth = { user: { username: "admin", role: "admin" }, account: admin };
const now = "2026-09-27T10:00:00.000Z";
const request = { isAcquisitionOrder: true, expectedIsAcquisitionOrder: false, expectedAcquisitionOrderUpdatedAt: "" };

test("acquisition tag requires unique active persisted admin with unchanged account/session identity", () => {
  assert.equal(requireLockedAcquisitionTagAdmin({ personnel: [admin] }, auth), admin);
  for (const personnel of [[], [admin, { ...admin, id: "duplicate" }],
    [{ ...admin, accessRole: "staff" }], [{ ...admin, accountEnabled: false }],
    [{ ...admin, employmentStatus: "resigned" }], [{ ...admin, sessionVersion: 3 }],
    [{ ...admin, id: "replacement-account" }]]) {
    assert.throws(() => requireLockedAcquisitionTagAdmin({ personnel }, auth), { statusCode: 403 });
  }
  assert.throws(() => requireLockedAcquisitionTagAdmin({ personnel: [admin] }, { ...auth, user: { ...auth.user, role: "staff" } }), { statusCode: 403 });
});

test("tag planner changes only classification metadata and uses authenticated actor", () => {
  const order = { id: "order", status: "completed", items: [{ price: 123 }], payments: [{ amount: 123 }], notes: "keep" };
  const result = planOrderAcquisitionTag(order, { ...request, acquisitionOrderUpdatedBy: "forged" }, admin, now);
  assert.deepEqual(result, { unchanged: false, order: { ...order, isAcquisitionOrder: true,
    acquisitionOrderUpdatedAt: now, acquisitionOrderUpdatedBy: "admin", acquisitionOrderUpdatedByName: "管理员" } });
  assert.equal(order.isAcquisitionOrder, undefined);
  assert.deepEqual(planOrderAcquisitionTag(result.order, request, admin, now), { unchanged: true, order: result.order });
});

test("tag planner rejects non-boolean/missing CAS and ABA stale revisions, even in same millisecond", () => {
  for (const isAcquisitionOrder of ["true", 1, null, undefined]) {
    assert.throws(() => planOrderAcquisitionTag({}, { ...request, isAcquisitionOrder }, admin, now), { statusCode: 400 });
  }
  for (const body of [{ isAcquisitionOrder: true }, { ...request, expectedAcquisitionOrderUpdatedAt: undefined }]) {
    assert.throws(() => planOrderAcquisitionTag({}, body, admin, now), { statusCode: 409 });
  }
  const marked = planOrderAcquisitionTag({}, request, admin, now).order;
  const unmarked = planOrderAcquisitionTag(marked, { isAcquisitionOrder: false, expectedIsAcquisitionOrder: true,
    expectedAcquisitionOrderUpdatedAt: now }, admin, now).order;
  assert.equal(unmarked.acquisitionOrderUpdatedAt, "2026-09-27T10:00:00.001Z");
  assert.throws(() => planOrderAcquisitionTag(unmarked, request, admin, now), { statusCode: 409, code: "ORDER_ACQUISITION_TAG_CONFLICT" });
});

test("generic patch guard protects flag, actor, timestamp and removal but allows unrelated edits", () => {
  const tagged = planOrderAcquisitionTag({ notes: "before" }, request, admin, now).order;
  assert.doesNotThrow(() => assertOrderAcquisitionTagUnchanged(tagged, { ...tagged, notes: "after" }));
  for (const key of ["isAcquisitionOrder", "acquisitionOrderUpdatedAt", "acquisitionOrderUpdatedBy", "acquisitionOrderUpdatedByName"]) {
    const removed = { ...tagged }; delete removed[key];
    assert.throws(() => assertOrderAcquisitionTagUnchanged(tagged, removed), { code: "ORDER_ACQUISITION_TAG_PROTECTED" });
    assert.throws(() => assertOrderAcquisitionTagUnchanged(tagged, { ...tagged, [key]: "forged" }), { code: "ORDER_ACQUISITION_TAG_PROTECTED" });
  }
});
