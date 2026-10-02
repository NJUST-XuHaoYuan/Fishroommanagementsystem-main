import assert from "node:assert/strict";
import test from "node:test";
import { commissionOrderCreatedAtMs, isCommissionEligibleOrder, newCustomerOrderEvidence, isApprovedNewCustomerOrder, resolveNewCustomerOrderOwner, planNewCustomerRequest, planNewCustomerReview } from "./new-customer-approval.mjs";
const now = "2026-10-02T12:00:00+08:00";
const owner = { id: "owner", username: "owner", name: "负责人", accountEnabled: true, accessRole: "staff" };
const admin = { id: "admin", username: "admin", name: "管理员", accountEnabled: true, accessRole: "admin" };
const order = { id: "o1", customerId: "c1", contactPersonnelId: "owner", createdAt: "2026-10-01T00:00:00", date: "2020-01-01", status: "pending" };
const state = { orders: [order], personnel: [owner, admin], customers: [{ id: "c1", wechat: "customer1" }] };
const apply = (o = order, s = state, a = owner) => planNewCustomerRequest(s, o, a, { reason: "已核实客户身份和首次购买", expectedApprovalVersion: 0 }, { requestId: "r1", now }).order;
const approve = (o, s = state, extra = {}) => planNewCustomerReview(s, o, admin, { requestId: "r1", decision: "approve", expectedApprovalVersion: 1, ...extra }, now).order;

test("authoritative creation timestamp gates October policy across explicit and China-local zones without trusting editable date", () => {
  for (const createdAt of ["2026-10-01T00:00:00", "2026-10-01 00:00:00", "2026-09-30T16:00:00Z", "2026-10-01T00:00:00+08:00"]) assert.equal(isCommissionEligibleOrder({ createdAt, date: "2020-01-01" }, now), true);
  for (const createdAt of [undefined, "", "2026-10-01", "2026-09-30T23:59:59+08:00", "2026-10-05T00:00:00", "2026-10-32T00:00:00", "2026-10-01T24:00:00", "invalid"]) assert.equal(isCommissionEligibleOrder({ createdAt, date: "2026-10-02" }, now), false, String(createdAt));
  assert.equal(commissionOrderCreatedAtMs(order), Date.parse("2026-09-30T16:00:00Z"));
});

test("order owner requires unique personnel identity with unambiguous historical fallback", () => {
  assert.equal(resolveNewCustomerOrderOwner(state.personnel, order), owner);
  assert.equal(resolveNewCustomerOrderOwner([owner, { ...owner }], order), null);
  assert.equal(resolveNewCustomerOrderOwner(state.personnel, { contactPerson: "负责人" }), owner);
  assert.equal(resolveNewCustomerOrderOwner([owner, { ...admin, name: "负责人" }], { contactPerson: "负责人" }), null);
});

test("first order follows createdAt, never mutable date, and missing historic timestamps do not imply first purchase", () => {
  const earlier = { ...order, id: "old", date: "2030-01-01", createdAt: "2026-09-30T23:59:59+08:00" };
  assert.equal(newCustomerOrderEvidence({ ...state, orders: [order, earlier] }, order).firstOrderId, "old");
  assert.throws(() => apply(order, { ...state, orders: [order, earlier] }), { code: "NEW_CUSTOMER_REQUEST_BLOCKED" });
  assert.equal(newCustomerOrderEvidence({ ...state, orders: [order, { ...earlier, createdAt: undefined }] }, order).firstOrderId, "");
});

test("owner submits pending only, admin approves, legacy tag and identity changes cannot earn the approved status", () => {
  assert.equal(isApprovedNewCustomerOrder(state, { ...order, isAcquisitionOrder: true }), false);
  const pending = apply(); assert.equal(pending.newCustomerApproval.status, "pending");
  assert.throws(() => planNewCustomerReview(state, pending, owner, { requestId: "r1", decision: "approve", expectedApprovalVersion: 1 }), { statusCode: 403 });
  const approved = approve(pending); assert.equal(isApprovedNewCustomerOrder(state, approved), true);
  assert.equal(isApprovedNewCustomerOrder(state, { ...approved, contactPersonnelId: "admin" }), false);
  assert.throws(() => approve({ ...pending, contactPersonnelId: "admin" }), { code: "NEW_CUSTOMER_IDENTITY_CONFLICT" });
  assert.throws(() => approve(pending, { ...state, customers: [{ id: "c1", wechat: "changed" }] }), { code: "NEW_CUSTOMER_IDENTITY_CONFLICT" });
  const adminOrder = { ...order, contactPersonnelId: "admin" }; assert.equal(apply(adminOrder, { ...state, orders: [adminOrder] }, admin).newCustomerApproval.status, "pending");
});

test("platform orders require administrator confirmation of identity and rejected requests can be resubmitted with CAS", () => {
  const platform = { ...order, customerId: "" }; const pending = apply(platform, { ...state, orders: [platform] });
  assert.throws(() => approve(pending), { code: "NEW_CUSTOMER_IDENTITY_CONFIRMATION_REQUIRED" });
  assert.equal(approve(pending, state, { confirmCustomerIdentity: true }).newCustomerApproval.status, "approved");
  assert.throws(() => planNewCustomerReview(state, pending, admin, { requestId: "r1", decision: "reject", expectedApprovalVersion: 1 }), { code: "NEW_CUSTOMER_REVIEW_NOTE_REQUIRED" });
  const rejected = planNewCustomerReview(state, pending, admin, { requestId: "r1", decision: "reject", expectedApprovalVersion: 1, note: "补充客户依据" }, now).order;
  const again = planNewCustomerRequest(state, rejected, owner, { reason: "补充客户身份核实依据", expectedApprovalVersion: 2 }, { requestId: "r2", now }).order;
  assert.equal(again.newCustomerApproval.version, 3); assert.equal(again.newCustomerApproval.requestId, "r2");
  assert.throws(() => approve(again), { code: "NEW_CUSTOMER_APPROVAL_CONFLICT" });
});

test("customer snapshot equality is independent of PostgreSQL JSONB key order", () => {
  const pending = apply();
  pending.newCustomerApproval.customerSnapshot = { douyin: "", wechat: "customer1", phone: "", id: "c1" };
  const approved = approve(pending);
  assert.equal(isApprovedNewCustomerOrder(state, approved), true);
});
