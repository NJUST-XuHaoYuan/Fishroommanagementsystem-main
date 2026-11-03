import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const ok = (value) => assert.equal(value.response.status, 200, JSON.stringify(value.body));
const fixture = () => {
  const data = structuredClone(stockPricingFixture);
  data.state.personnel.push({ ...structuredClone(data.state.personnel[1]), id: "recipient", username: "recipient", name: "接收人" });
  data.state.orders = data.state.orders.filter((order) => order.id === "ORDER-PENDING").map((order) => ({ ...order,
    source: "平台下单", platformOrderNo: "OWNER-TEST", paymentChannel: "douyin", paymentAccount: "test-account", plannedShipDate: "2026-11-05",
    contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor", createdAt: "2026-10-10T09:00:00+08:00" }));
  data.state.notifications = [];
  return data;
};
async function setup(t, data = fixture()) {
  const s = await startMutableRouteServer(data); t.after(() => s.stop());
  const tokens = {};
  for (const role of ["pricing-admin", "pricing-editor", "pricing-viewer", "recipient"]) tokens[role] = await s.login(role, PRICING_TEST_PASSWORD);
  const read = async (id = "ORDER-PENDING") => (await s.readPersistedState()).orders.find((order) => order.id === id);
  const assign = async (extra = {}, token = tokens["pricing-editor"]) => {
    const current = await read();
    return s.request("/api/orders/update", { token, body: { ...current, orderId: current.id,
      expectedContactPersonnelId: String(current.contactPersonnelId || ""), expectedOwnerAssignmentRequestId: String(current.ownerAssignment?.requestId || ""),
      contactPersonnelId: "recipient", contactPerson: "接收人", ...extra } });
  };
  const decide = async (decision = "accept", token = tokens.recipient, extra = {}) => s.request("/api/orders/owner-assignment/decision", { token,
    body: { orderId: "ORDER-PENDING", requestId: (await read()).ownerAssignment?.requestId, decision, ...extra } });
  return { ...s, tokens, read, assign, decide };
}

test("creation ignores forged assignment state and attributes to authenticated registrant until target accepts", async (t) => {
  const s = await setup(t);
  const created = await s.request("/api/orders/create", { token: s.tokens["pricing-editor"], body: {
    siteId: "nanjing", source: "平台下单", platformOrderNo: "OWNER-CREATE", date: "2026-10-01", paymentChannel: "douyin", plannedShipDate: "2026-11-05",
    contactPersonnelId: "recipient", items: [{ stockItemId: "follower", price: 150 }], shippingFeeMode: "collect",
    ownerAssignment: { status: "accepted", toPersonnelId: "pricing-admin" }, createdBy: "forged",
  } }); ok(created);
  assert.equal(created.body.order.contactPersonnelId, "pricing-editor"); assert.equal(created.body.order.ownerAssignment.status, "pending");
  assert.equal(created.body.order.ownerAssignment.requestedBy, "pricing-editor"); assert.equal(created.body.order.ownerAssignment.toPersonnelId, "recipient");
  const accepted = await s.decide("accept", undefined, { orderId: created.body.order.id, requestId: created.body.order.ownerAssignment.requestId }); ok(accepted);
  assert.equal(accepted.body.order.contactPersonnelId, "recipient");
});

test("requests keep owner/financial data unchanged, resolve notices atomically and acceptance is idempotent", async (t) => {
  const s = await setup(t); const original = await s.read();
  const assigned = await s.assign(); ok(assigned);
  assert.equal(assigned.body.order.contactPersonnelId, original.contactPersonnelId); assert.deepEqual(assigned.body.order.payments, original.payments);
  const notifications = await s.request("/api/notifications", { token: s.tokens.recipient }); ok(notifications);
  const notice = notifications.body.notifications.find((item) => item.type === "order_owner_assignment");
  assert.equal(notice.canApprove, true); assert.equal(notice.ownerAssignmentRequestId, assigned.body.order.ownerAssignment.requestId);
  const detail = await s.request("/api/notifications/detail?id=" + notice.id, { token: s.tokens.recipient }); ok(detail);
  assert.equal(detail.body.notification.ownerAssignmentReview.canAccept, true);
  const before = await s.readPersistedState(); const accepted = await s.decide(); ok(accepted);
  assert.equal(accepted.body.order.contactPersonnelId, "recipient");
  assert.equal(accepted.body.order.ownerAssignment.status, "accepted");
  const after = await s.readPersistedState(); assert.equal(after.operationLogs.length, before.operationLogs.length + 1);
  assert.ok(after.notifications.every((n) => n.status === "completed"));
  const again = await s.decide(); ok(again); assert.equal(again.body.unchanged, true);
  assert.deepEqual(await s.readPersistedState(), after);
  assert.equal((await s.decide("reject")).response.status, 409);
});

test("only recipient can decide, requester/admin may cancel, rejection never changes effective owner", async (t) => {
  const s = await setup(t); ok(await s.assign());
  for (const user of ["pricing-admin", "pricing-editor", "pricing-viewer"]) {
    assert.equal((await s.decide("accept", s.tokens[user])).response.status, 403);
    assert.equal((await s.decide("reject", s.tokens[user])).response.status, 403);
  }
  assert.equal((await s.decide("cancel")).response.status, 403);
  ok(await s.decide("reject")); assert.equal((await s.read()).contactPersonnelId, "pricing-editor");
  ok(await s.assign()); ok(await s.decide("cancel", s.tokens["pricing-editor"]));
  ok(await s.assign()); ok(await s.decide("cancel", s.tokens["pricing-admin"]));
  assert.equal((await s.read()).contactPersonnelId, "pricing-editor");
});

test("stale requests, direct generic patches, invalid targets and lost permissions cannot bypass confirmation", async (t) => {
  const s = await setup(t); const original = await s.read();
  assert.equal((await s.assign({ contactPersonnelId: "pricing-viewer" })).response.status, 409);
  assert.equal((await s.assign({ expectedContactPersonnelId: "stale" })).response.status, 409);
  ok(await s.assign()); const pending = await s.read();
  for (const token of [s.tokens["pricing-admin"], s.tokens["pricing-editor"]]) for (const patch of [
    { ...pending, contactPersonnelId: "recipient", contactPerson: "接收人" },
    { ...pending, ownerAssignment: { ...pending.ownerAssignment, status: "accepted" } },
  ]) {
    const result = await s.request("/api/state/patch", { token, body: { patch: { orders: [patch] }, basePatch: { orders: [pending] } } });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
  }
  assert.equal((await s.decide("accept", s.tokens.recipient, { requestId: "stale" })).response.status, 409);
  await s.patchTestPersonnel("recipient", { permissions: {} });
  assert.equal((await s.decide()).response.status, 409);
  assert.equal((await s.read()).contactPersonnelId, original.contactPersonnelId);
  const notices = await s.request("/api/notifications", { token: s.tokens.recipient });
  assert.equal(notices.body.notifications[0].canApprove, false);
});

test("cross-site access and revoked sessions fail without leaking private order or mutating state", async (t) => {
  const s = await setup(t); ok(await s.assign());
  await s.patchTestPersonnel("recipient", { visibleSiteIds: ["jiangyin"] });
  const before = await s.readPersistedState();
  assert.equal((await s.decide()).response.status, 403);
  const detail = await s.request("/api/orders/owner-assignment?orderId=ORDER-PENDING", { token: s.tokens.recipient });
  assert.equal(detail.response.status, 403); assert.equal(detail.body.order, undefined);
  await s.patchTestPersonnel("recipient", { accountEnabled: false });
  assert.ok([401, 403].includes((await s.decide()).response.status));
  assert.deepEqual((await s.readPersistedState()).orders, before.orders);
});

test("deleting an order closes its transfer tasks and no stale acceptance can resurrect it", async (t) => {
  const s = await setup(t); ok(await s.assign()); const pending = await s.read();
  const result = await s.request("/api/orders/delete", { token: s.tokens["pricing-editor"], body: { orderId: pending.id } }); ok(result);
  assert.ok((await s.readPersistedState()).notifications.every((n) => n.status === "completed"));
  const rejected = await s.request("/api/orders/owner-assignment/decision", { token: s.tokens.recipient,
    body: { orderId: pending.id, requestId: pending.ownerAssignment.requestId, decision: "accept" } });
  assert.notEqual(rejected.response.status, 200);
});

test("candidate endpoint filters disabled/non-operable/cross-site targets without leaking personnel profiles", async (t) => {
  const s = await setup(t);
  const result = await s.request("/api/orders/owner-assignment/candidates?siteId=nanjing", { token: s.tokens["pricing-editor"] }); ok(result);
  assert.deepEqual(result.body.personnel.map((p) => p.id).sort(), ["pricing-admin", "pricing-editor", "recipient"]);
  assert.equal(result.body.currentPersonnelId, "pricing-editor");
  for (const person of result.body.personnel) assert.deepEqual(Object.keys(person).sort(), ["id", "name", "username"]);
  assert.equal((await s.request("/api/orders/owner-assignment/candidates?siteId=jiangyin", { token: s.tokens["pricing-editor"] })).response.status, 403);
  assert.equal((await s.request("/api/orders/owner-assignment/candidates?siteId=nanjing", { token: s.tokens["pricing-viewer"] })).response.status, 403);
});

function paidFixture() {
  const data = fixture();
  const now = new Date().toISOString();
  data.state.customers = [{ id: "customer", name: "测试客户" }];
  Object.assign(data.state.orders[0], { source: "私域线上", customerId: "customer", platformOrderNo: "", douyinOrderNo: "",
    paymentChannel: "cash", paymentAccount: "cash-qa", shippingFeeMode: "collect", shippingAddress: "测试地址",
    payments: [{ id: "payment", type: "balance", amount: 123.45, time: now, channel: "cash", account: "cash-qa", recordSource: "manual",
      verificationStatus: "verified", verifiedAt: now, verifiedBy: "pricing-admin", notes: "", proof: [] }] });
  return data;
}

test("pending keeps commission with current owner; acceptance transfers once and clears owner-bound approvals", async (t) => {
  const data = paidFixture();
  Object.assign(data.state.orders[0], { creditSaleApproval: { id: "credit", status: "approved" },
    newCustomerApproval: { requestId: "new-customer", status: "pending", version: 1, contactPersonnelId: "pricing-editor", requestedBy: "pricing-editor" } });
  const s = await setup(t, data);
  const total = async (token) => { const result = await s.request("/api/commissions/me", { token }); ok(result); return result.body.personalAmount; };
  const before = await total(s.tokens["pricing-editor"]); assert.equal(before, 0.25);
  ok(await s.assign()); assert.equal(await total(s.tokens["pricing-editor"]), before); assert.equal(await total(s.tokens.recipient), 0);
  const accepted = await s.decide(); ok(accepted);
  assert.equal(accepted.body.order.creditSaleApproval, undefined); assert.equal(accepted.body.order.newCustomerApproval.status, "rejected");
  assert.equal(accepted.body.order.newCustomerApproval.invalidatedReview.status, "pending");
  assert.equal(await total(s.tokens["pricing-editor"]), 0); assert.equal(await total(s.tokens.recipient), before);
  const journal = (await s.readPersistedState()).commissionLedgerV1;
  ok(await s.decide()); assert.deepEqual((await s.readPersistedState()).commissionLedgerV1, journal);
});

test("generic completion persists closed assignment and notices together, not only a recalculated commission ledger", async (t) => {
  const data = fixture();
  data.state.orders[0].shippingFeeMode = "collect";
  data.state.shipments = [{ id: "shipment", orderId: "ORDER-PENDING", siteId: "nanjing", status: "delivered", shipMethod: "express",
    deliveredAt: new Date().toISOString(), itemStockIds: ["ordered-pending"], actualShippingFee: 0, packingProof: ["one", "two"] }];
  const s = await setup(t, data); ok(await s.assign()); const order = await s.read();
  const completed = await s.request("/api/state/patch", { token: s.tokens["pricing-admin"], body: {
    basePatch: { orders: [order] }, patch: { orders: [{ ...order, status: "completed" }] },
  } }); ok(completed);
  const after = await s.readPersistedState(); assert.equal(after.orders[0].ownerAssignment.status, "cancelled");
  assert.ok(after.notifications.every((n) => n.status === "completed"));
  assert.equal((await s.decide()).response.status, 409);
});
