import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, EVIDENCE_TEST_KEYRING, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const denied = r => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture();
  fixture.state.personnel.find(p => p.id === "finance-reviewer").permissions = {};
  fixture.state.personnel.find(p => p.id === "pricing-editor").permissions.finance = { create: true, update: true, delete: true };
  fixture.state.orders[0].paymentClaims = [{ id: "claim-pending", version: 1, amount: 300, status: "pending", evidenceAttachments: [], submittedBy: "pricing-editor" }];
  fixture.state.orders[0].payments = [{ id: "refund-pending", type: "refund", amount: 10, verificationStatus: "pending", channel: "wechat", account: "合成微信收款账户" }];
  fixture.state.notifications = [{ id: "old-staff-approval", type: "payment_proof", status: "pending", notificationRole: "approver", recipientUsername: "pricing-editor", orderId: "proof-order", claimId: "claim-pending", createdAt: "2026-11-25T01:00:00Z" }];
  customize(fixture.state);
  const s = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } });
  t.after(s.stop);
  const tokens = {};
  for (const name of ["pricing-admin", "pricing-editor", "finance-reviewer"]) tokens[name] = await s.login(name, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = "finance-reviewer") => s.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  return { ...s, tokens, request };
}

test("finance login persists explicit role; scoped pending vouchers can be reviewed without order mutation permission", async t => {
  const s = await setup(t, state => state.orders.push({ ...state.orders[0], id: "jy-private", orderNo: "PRIVATE-JY", siteId: "jiangyin" }));
  const me = await s.request("/api/auth/me"); ok(me);
  assert.equal(me.body.user.role, "finance"); assert.equal(me.body.account.accessRole, "finance");
  assert.deepEqual(me.body.user.visibleSiteIds, ["nanjing"]);
  assert.deepEqual(me.body.account.permissions.finance, { create: true, update: true, delete: false });
  assert.equal(me.body.account.permissions.orders.update, false);
  const queue = await s.request("/api/orders/payment-proof/queue?siteId=all"); ok(queue);
  assert.deepEqual(queue.body.items.map(i => i.orderId), ["proof-order"]);
  const detail = await s.request("/api/orders/payment-proof/detail?orderId=proof-order"); ok(detail);
  assert.equal(detail.body.canReview, true); assert.equal(detail.body.canSubmit, false);
  denied(await s.request("/api/orders/payment-proof/detail?orderId=jy-private"));
  ok(await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: "claim-pending", expectedVersion: 1,
    reviewToken: detail.body.reviewToken, decision: "reject", reason: "凭证待补充" }));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "refund-pending" }));
  denied(await s.request("/api/orders/payment", { orderId: "proof-order", action: "delete", paymentId: "refund-pending" }));
  const persisted = await s.readPersistedState();
  assert.equal(persisted.orders[0].payments[0].verifiedBy, "finance-reviewer");
  assert.equal(persisted.orders[0].paymentClaims[0].reviewedBy, "finance-reviewer");
});

test("old staff finance permissions cannot verify claims, money, import statements or see obsolete approval tasks", async t => {
  const s = await setup(t);
  const actor = "pricing-editor";
  const detail = await s.request("/api/orders/payment-proof/detail?orderId=proof-order", undefined, actor); ok(detail);
  assert.equal(detail.body.canReview, false); assert.equal(detail.body.canSubmit, true);
  for (const [path, body] of [
    ["/api/orders/payment-proof/queue"],
    ["/api/orders/payment-proof/review", { orderId: "proof-order", claimId: "claim-pending", expectedVersion: 1, reviewToken: detail.body.reviewToken, decision: "reject", reason: "越权" }],
    ["/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "refund-pending" }],
    ["/api/finance/statements/import", { siteId: "nanjing" }],
    ["/api/finance/douyin/import", { siteId: "nanjing" }],
    ["/api/finance/transfers", { action: "verify", id: "does-not-matter" }],
  ]) denied(await s.request(path, body, actor));
  const notices = await s.request("/api/notifications", undefined, actor); ok(notices);
  assert.equal(notices.body.notifications.some(n => n.id === "old-staff-approval"), false);
  const state = await s.readPersistedState();
  assert.equal(state.orders[0].paymentClaims[0].status, "pending"); assert.equal(state.orders[0].payments[0].verificationStatus, "pending");
  const adminDetail = await s.request("/api/orders/payment-proof/detail?orderId=proof-order", undefined, "pricing-admin"); ok(adminDetail);
  assert.equal(adminDetail.body.canReview, true);
});

test("administrator creates finance account with scope and no delete or stock privileges; removal revokes its session", async t => {
  const s = await setup(t);
  const body = { name: "新增财务", username: "new-finance", password: PRICING_TEST_PASSWORD, accessRole: "finance", accountEnabled: true,
    department: "财务", role: "财务", hireDate: "2026-11-01", siteIds: ["nanjing"], visibleSiteIds: ["nanjing"] };
  denied(await s.request("/api/personnel/save", body));
  denied(await s.request("/api/personnel/save", { ...body, visibleSiteIds: [] }, "pricing-admin"));
  ok(await s.request("/api/personnel/save", body, "pricing-admin"));
  const token = await s.login("new-finance", PRICING_TEST_PASSWORD);
  // Use raw request because the helper takes an actor name as its third argument.
  const fresh = await fetch(`${s.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await fresh.json(); assert.equal(fresh.status, 200, JSON.stringify(payload));
  assert.equal(payload.user.role, "finance"); assert.equal(payload.account.permissions.daily.update, false);
  assert.equal(payload.account.permissions.finance.delete, false);
  const person = (await s.readPersistedState()).personnel.find(p => p.username === "new-finance");
  await s.patchTestPersonnel(person.id, { accessRole: "staff" });
  const stale = await fetch(`${s.baseUrl}/api/orders/payment-proof/queue`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(stale.status >= 400);
});
