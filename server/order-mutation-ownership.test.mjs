import test from "node:test";
import assert from "node:assert/strict";
import { assertOrderBusinessMutationOwner, isOrderBusinessMutationOwner, resolveOrderBusinessOwner } from "./order-mutation-ownership.mjs";

const owner = { id: "owner", username: "alice", name: "同名", accessRole: "staff", accountEnabled: true };
const other = { id: "other", username: "bob", name: "同名", accessRole: "staff", accountEnabled: true };
const admin = { id: "admin", username: "admin", accessRole: "admin", accountEnabled: true };
const state = { personnel: [owner, other, admin] };

test("effective stored personnel ID wins over names, creator and a pending transfer", () => {
  const order = { contactPersonnelId: owner.id, contactPerson: other.username, createdBy: other.username,
    ownerAssignment: { status: "pending", toPersonnelId: other.id } };
  assert.equal(resolveOrderBusinessOwner(state, order), owner);
  assert.equal(isOrderBusinessMutationOwner(state, order, owner), true);
  assert.equal(isOrderBusinessMutationOwner(state, order, other), false);
  assert.throws(() => assertOrderBusinessMutationOwner(state, order, other), { statusCode: 403, code: "ORDER_OWNER_REQUIRED" });
  assert.equal(isOrderBusinessMutationOwner(state, { ...order, contactPersonnelId: other.id }, owner), false);
  assert.equal(isOrderBusinessMutationOwner(state, { ...order, contactPersonnelId: other.id }, other), true);
});

test("legacy owner references work only for one exact personnel match", () => {
  assert.equal(resolveOrderBusinessOwner(state, { contactPerson: "alice" }), owner);
  assert.equal(resolveOrderBusinessOwner(state, { contactPerson: "同名" }), null);
  assert.equal(resolveOrderBusinessOwner(state, { contactPerson: "unknown" }), null);
  assert.equal(resolveOrderBusinessOwner(state, {}), null);
  assert.equal(isOrderBusinessMutationOwner(state, { contactPerson: "alice" }, owner), true);
});

test("unknown and duplicate IDs fail closed without legacy fallback", () => {
  for (const contactPersonnelId of ["missing", "other"]) {
    assert.equal(isOrderBusinessMutationOwner(state, { contactPersonnelId, contactPerson: "alice" }, owner), false);
  }
  const duplicate = { personnel: [...state.personnel, { ...owner, username: "duplicate" }] };
  assert.equal(resolveOrderBusinessOwner(duplicate, { contactPersonnelId: owner.id }), null);
  assert.equal(isOrderBusinessMutationOwner(duplicate, { contactPersonnelId: owner.id }, owner), false);
  assert.equal(isOrderBusinessMutationOwner(state, { contactPersonnelId: owner.id }, { ...owner, username: "impostor" }), false);
});

test("disabled/resigned accounts cannot mutate even with an administrator role", () => {
  for (const patch of [{ accountEnabled: false }, { employmentStatus: "resigned" }, { resignedAt: "2026-11-01" }, { username: "" }, { id: "" }]) {
    assert.equal(isOrderBusinessMutationOwner(state, { contactPersonnelId: owner.id }, { ...owner, ...patch }), false);
    assert.equal(isOrderBusinessMutationOwner(state, {}, { ...admin, ...patch }), false);
  }
  const disabledOwner = { personnel: [{ ...owner, accountEnabled: false }] };
  assert.equal(resolveOrderBusinessOwner(disabledOwner, { contactPersonnelId: owner.id }), null);
});

test("enabled administrators can handle unresolved/historical owners while ordinary staff fail closed", () => {
  for (const order of [{}, { contactPersonnelId: "missing" }, { contactPerson: "同名" }]) {
    assert.equal(isOrderBusinessMutationOwner(state, order, admin), true);
    assert.doesNotThrow(() => assertOrderBusinessMutationOwner(state, order, admin));
    assert.equal(isOrderBusinessMutationOwner(state, order, owner), false);
  }
});
