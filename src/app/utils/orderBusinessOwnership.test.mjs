import assert from "node:assert/strict";
import test from "node:test";
import { canManageOrderBusiness, isMyOrder, orderBusinessContext } from "./orderBusinessOwnership.ts";
import { isOrderBusinessMutationOwner } from "../../../server/order-mutation-ownership.mjs";
import { paymentClaimsForOrderScope } from "./personalOrderWorkspace.ts";

const alice = { id: "p-a", username: "alice", name: "小陈", accountEnabled: true, accessRole: "staff" };
const bob = { id: "p-b", username: "bob", name: "小李", accountEnabled: true, accessRole: "staff" };
const staff = { username: "alice", role: "staff", account: { personnelId: "p-a", username: "alice", accessRole: "staff", accountEnabled: true, permissions: {} } };
const base = { id: "order-1", contactPersonnelId: "p-a", contactPerson: "小陈" };

test("stable owner ID works with a redacted directory, while a conflicting ID never falls back to name", () => {
  assert.equal(canManageOrderBusiness(staff, [], base), true);
  assert.equal(canManageOrderBusiness(staff, [alice, { id: "p-b", name: "小李" }], { ...base, contactPersonnelId: "p-b" }), false);
  assert.equal(canManageOrderBusiness(staff, [alice], { ...base, contactPersonnelId: "removed-id" }), false);
});

test("legacy ownership requires exactly one directory match including disabled or resigned duplicates", () => {
  const legacy = { ...base, contactPersonnelId: "" };
  assert.equal(canManageOrderBusiness(staff, [alice, bob], legacy), true);
  assert.equal(canManageOrderBusiness(staff, [alice, { ...bob, name: "小陈", employmentStatus: "resigned" }], legacy), false);
  assert.equal(canManageOrderBusiness(staff, [alice, bob], { ...legacy, contactPerson: "alice" }), true);
  assert.equal(canManageOrderBusiness(staff, [alice, bob], { ...legacy, contactPerson: "" }), false);
});

test("pending transfer keeps old owner; accepted transfer revokes old owner and invalidates drafts", () => {
  const pending = { ...base, ownerAssignment: { status: "pending", toPersonnelId: "p-b" } };
  const recipient = { ...staff, username: "bob", account: { ...staff.account, personnelId: "p-b", username: "bob" } };
  assert.equal(canManageOrderBusiness(staff, [alice, bob], pending), true);
  assert.equal(canManageOrderBusiness(recipient, [alice, bob], pending), false);
  const accepted = { ...pending, contactPersonnelId: "p-b", contactPerson: "小李" };
  assert.equal(canManageOrderBusiness(staff, [alice, bob], accepted), false);
  assert.equal(canManageOrderBusiness(recipient, [alice, bob], accepted), true);
  assert.notEqual(orderBusinessContext(staff, pending, true, "session"), orderBusinessContext(staff, accepted, false, "session"));
  assert.notEqual(orderBusinessContext(staff, base, true, "session"), orderBusinessContext(staff, base, true, "new-session"));
});

test("admin may manage all but 我的订单 still means their own; missing/mismatched auth fails closed", () => {
  const admin = { ...staff, role: "admin", account: { ...staff.account, accessRole: "admin" } };
  const other = { ...base, contactPersonnelId: "p-b", contactPerson: "小李" };
  assert.equal(canManageOrderBusiness(admin, [alice, bob], other), true);
  assert.equal(isMyOrder(admin, [alice, bob], other), false);
  for (const invalid of [null, { ...staff, account: undefined }, { ...staff, account: { ...staff.account, accountEnabled: false } }, { ...staff, username: "bob" }, { ...staff, role: "admin" }]) {
    assert.equal(canManageOrderBusiness(invalid, [alice, bob], base), false);
  }
  assert.equal(canManageOrderBusiness(staff, [alice, bob], { ...other, createdBy: "alice" }), false);
});

test("complete-directory ownership decisions match server and payment candidates exclude others", () => {
  const orders = [base, { ...base, id: "other", contactPersonnelId: "p-b", contactPerson: "小李" }, { ...base, id: "legacy", contactPersonnelId: "" }];
  for (const order of orders) assert.equal(canManageOrderBusiness(staff, [alice, bob], order), isOrderBusinessMutationOwner({ personnel: [alice, bob] }, order, alice));
  const ids = new Set(orders.filter(order => canManageOrderBusiness(staff, [alice, bob], order)).map(order => order.id));
  const scoped = paymentClaimsForOrderScope({ candidates: [{ id: "statement", candidates: [{ orderId: "order-1" }, { orderId: "other" }] }], cashOrders: [{ orderId: "other" }, { orderId: "legacy" }] }, ids);
  assert.deepEqual(scoped.candidates[0].candidates, [{ orderId: "order-1" }]);
  assert.deepEqual(scoped.cashOrders, [{ orderId: "legacy" }]);
});
