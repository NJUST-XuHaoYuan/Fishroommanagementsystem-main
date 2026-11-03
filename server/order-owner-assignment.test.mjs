import test from "node:test";
import assert from "node:assert/strict";
import { assertOrderOwnerAssignmentUnchanged, planOrderOwnerAssignment, orderOwnerAssignmentDetail,
  planOrderOwnerAssignmentDecision, ownerAssignmentNotifications, closeEndedOrderOwnerAssignments } from "./order-owner-assignment.mjs";

const a = { id: "a", username: "alice", name: "甲", accessRole: "staff", visibleSiteIds: ["nanjing"], permissions: { orders: { update: true } } };
const b = { ...a, id: "b", username: "bob", name: "乙" };
const admin = { ...a, id: "admin", username: "admin", name: "管理员", accessRole: "admin" };
const state = { personnel: [a, b, admin] };
const order = { id: "order", orderNo: "SO-1", siteId: "nanjing", status: "pending", contactPersonnelId: a.id, contactPerson: a.name };
const now = "2026-11-04T08:00:00.000Z";
const pending = () => planOrderOwnerAssignment(state, order, { ...order, contactPersonnelId: b.id, contactPerson: b.name }, a,
  { expectedContactPersonnelId: a.id, expectedOwnerAssignmentRequestId: "" }, { requestId: "request-1", now }).order;
const decision = (input = pending(), actor = b, body = {}) => planOrderOwnerAssignmentDecision(state, input, actor,
  { requestId: "request-1", decision: "accept", ...body }, { now });

test("new orders always belong to the authenticated registrant until selected other account accepts", () => {
  const result = planOrderOwnerAssignment(state, null, { ...order, contactPersonnelId: b.id }, a, {}, { requestId: "r", now });
  assert.equal(result.order.contactPersonnelId, a.id); assert.equal(result.order.contactPerson, a.name);
  assert.equal(result.order.ownerAssignment.toPersonnelId, b.id); assert.equal(result.order.ownerAssignment.status, "pending");
  const self = planOrderOwnerAssignment(state, null, order, a, {}, { requestId: "r", now });
  assert.equal(self.requested, false); assert.equal(self.order.ownerAssignment, undefined);
});

test("accept uses stable identity and invalidates old-owner approvals while preserving money and merchandise", () => {
  const input = { ...pending(), contactPerson: "甲的新姓名", payments: [{ amount: 100 }], items: [{ price: 100 }],
    creditSaleApproval: { status: "approved" }, newCustomerApproval: { status: "approved", version: 2, requestId: "nc", evidenceAttachments: [{ id: "proof" }],
      reviewedBy: "admin", reviewedAt: "2026-11-01T09:00:00Z", reviewNote: "原管理员批准说明" } };
  const result = decision(input).order;
  assert.equal(result.contactPersonnelId, "b"); assert.equal(result.ownerAssignment.version, 2);
  assert.equal(result.creditSaleApproval, undefined); assert.equal(result.newCustomerApproval.status, "rejected");
  assert.equal(result.newCustomerApproval.version, 3); assert.deepEqual(result.newCustomerApproval.evidenceAttachments, input.newCustomerApproval.evidenceAttachments);
  assert.equal(result.newCustomerApproval.invalidatedReview.reviewedBy, "admin");
  assert.equal(result.newCustomerApproval.invalidatedReview.reviewedAt, "2026-11-01T09:00:00Z");
  assert.equal(result.newCustomerApproval.invalidatedReview.reviewNote, "原管理员批准说明");
  assert.equal(result.newCustomerApproval.reviewedBy, "system");
  assert.deepEqual(result.items, input.items); assert.deepEqual(result.payments, input.payments);
});

test("only target can accept or reject; admin cannot impersonate, and only requester/admin can cancel", () => {
  for (const actor of [a, admin]) for (const action of ["accept", "reject"]) assert.throws(() => decision(pending(), actor, { decision: action }), { statusCode: 403 });
  assert.throws(() => decision(pending(), b, { decision: "cancel" }), { statusCode: 403 });
  for (const actor of [a, admin]) assert.equal(decision(pending(), actor, { decision: "cancel" }).order.contactPersonnelId, "a");
  assert.equal(decision(pending(), b, { decision: "reject" }).order.contactPersonnelId, "a");
});

test("CAS and idempotency reject old requests or opposite decisions without duplicate writes", () => {
  const accepted = decision().order;
  assert.equal(decision(accepted).unchanged, true);
  assert.throws(() => decision(accepted, b, { decision: "reject" }), { statusCode: 409 });
  assert.throws(() => decision(pending(), b, { requestId: "old" }), { code: "ORDER_OWNER_ASSIGNMENT_CONFLICT" });
  assert.throws(() => decision({ ...pending(), contactPersonnelId: "admin" }), { statusCode: 409 });
  assert.throws(() => planOrderOwnerAssignment(state, order, { ...order, contactPersonnelId: b.id }, a, {}, { requestId: "r" }), { statusCode: 409 });
});

test("existing pending request cannot be replaced implicitly and changing unrelated data preserves it", () => {
  const input = pending();
  const expectation = { expectedContactPersonnelId: "a", expectedOwnerAssignmentRequestId: "request-1" };
  assert.throws(() => planOrderOwnerAssignment(state, input, { ...input, contactPersonnelId: "admin" }, a, expectation, { requestId: "r" }), { code: "ORDER_OWNER_ASSIGNMENT_PENDING" });
  const unchanged = planOrderOwnerAssignment(state, input, { ...input, notes: "edit" }, a, {}, { requestId: "r" });
  assert.equal(unchanged.order.ownerAssignment, input.ownerAssignment); assert.equal(unchanged.order.contactPersonnelId, "a");
});

test("fresh identity/site/update permissions and closed-order state are rechecked when accepting", () => {
  for (const patch of [{ accountEnabled: false }, { employmentStatus: "resigned" }, { visibleSiteIds: ["jiangyin"] }, { permissions: {} }, { username: "rebound" }]) {
    const altered = { ...b, ...patch }; const fresh = { personnel: [a, altered, admin] };
    assert.throws(() => planOrderOwnerAssignmentDecision(fresh, pending(), altered, { requestId: "request-1", decision: "accept" }), /账号|权限|本人/);
  }
  for (const status of ["completed", "cancelled"]) assert.equal(orderOwnerAssignmentDetail(state, { ...pending(), status }, b).canAccept, false);
});

test("generic state mutation cannot forge owner or assignment, but JSON object key order is irrelevant", () => {
  const input = pending();
  for (const patch of [{ contactPersonnelId: "b" }, { contactPerson: "乙" }, { ownerAssignment: undefined }, { ownerAssignment: { ...input.ownerAssignment, status: "accepted" } }]) {
    assert.throws(() => assertOrderOwnerAssignmentUnchanged(input, { ...input, ...patch }), { code: "ORDER_OWNER_ASSIGNMENT_PROTECTED" });
  }
  assert.doesNotThrow(() => assertOrderOwnerAssignmentUnchanged(input, { ...input, ownerAssignment: Object.fromEntries(Object.entries(input.ownerAssignment).reverse()), notes: "safe" }));
});

test("notices are generated once and closed for receiver/requester together; deletion/completion also close them", () => {
  const input = pending(); let id = 0;
  const opts = { now, actor: a, createId: () => `notice-${++id}` };
  const notices = ownerAssignmentNotifications([], input, opts); assert.equal(notices.length, 2);
  assert.equal(ownerAssignmentNotifications(notices, input, opts).length, 2);
  const resolved = ownerAssignmentNotifications(notices, decision().order, { ...opts, actor: b });
  assert.ok(resolved.every((n) => n.status === "completed")); assert.equal(resolved.find((n) => n.notificationRole === "requester").readAt, "");
  const before = { orders: [input], notifications: notices };
  for (const nextOrders of [[], [{ ...input, status: "completed" }], [{ ...input, status: "cancelled" }]]) {
    const result = closeEndedOrderOwnerAssignments(before, { ...before, orders: nextOrders }, now);
    assert.ok(result.notifications.every((n) => n.status === "completed"));
    if (result.orders.length) assert.equal(result.orders[0].ownerAssignment.status, "cancelled");
  }
});
