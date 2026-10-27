import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
function fixture({ known = true } = {}) {
  const value = structuredClone(stockPricingFixture);
  value.state.customers = [{ id: "new-customer", name: "新客户", wechat: "new-client" }];
  const order = value.state.orders.find((item) => item.id === "ORDER-PENDING");
  Object.assign(order, { createdAt: "2026-10-01T09:00:00+08:00", customerId: known ? "new-customer" : "", contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor",
    source: known ? "私域线上" : "平台下单", platformOrderNo: known ? "" : "NEW-CUSTOMER-QA", paymentChannel: known ? "cash" : "douyin", paymentAccount: "synthetic", plannedShipDate: "2026-10-02" });
  value.state.orders = [order]; value.state.shipments = [];
  return value;
}
async function setup(t, data = fixture()) {
  const server = await startMutableRouteServer(data); t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const owner = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const other = await server.login("pricing-viewer", PRICING_TEST_PASSWORD);
  const read = async () => (await server.readPersistedState()).orders[0];
  const request = (body = {}, token = owner) => server.request("/api/orders/new-customer/request", { token, body: { orderId: "ORDER-PENDING", reason: "已核对客户微信身份且首次购买", expectedApprovalVersion: 0, ...body } });
  const review = async (body = {}, token = admin) => { const order = await read(); return server.request("/api/orders/new-customer/review", { token, body: {
    orderId: order.id, requestId: order.newCustomerApproval?.requestId, expectedApprovalVersion: order.newCustomerApproval?.version,
    decision: "approve", ...body,
  } }); };
  return { ...server, admin, owner, other, read, submit: request, review };
}

test("owner request fans out notifications, administrator approval closes all copies and returns requester unread result", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  const requested = await s.submit(); ok(requested); assert.equal(requested.body.order.newCustomerApproval.status, "pending");
  const duplicate = await s.submit(); ok(duplicate); assert.equal(duplicate.body.unchanged, true);
  const get = (token) => s.request("/api/notifications", { token });
  const adminNotices = await get(s.admin); ok(adminNotices);
  const notice = adminNotices.body.notifications.find((item) => item.type === "new_customer_approval");
  assert.equal(notice.canApprove, true); assert.equal(notice.notificationRole, "approver");
  const detail = await s.request(`/api/notifications/detail?id=${notice.id}`, { token: s.admin }); ok(detail);
  assert.equal(detail.body.notification.newCustomerReview.approval.requestId, requested.body.order.newCustomerApproval.requestId);
  assert.equal((await s.request(`/api/notifications/detail?id=${notice.id}`, { token: s.other })).response.status, 404);
  const approved = await s.review(); ok(approved); assert.equal(approved.body.order.newCustomerApproval.status, "approved");
  const retry = await s.review({ expectedApprovalVersion: 1 }); ok(retry); assert.equal(retry.body.unchanged, true);
  const ownerNotices = await get(s.owner); ok(ownerNotices);
  const result = ownerNotices.body.notifications.find((item) => item.type === "new_customer_approval");
  assert.equal(result.status, "completed"); assert.equal(result.resolution, "approved"); assert.equal(result.readAt, "");
  assert.equal((await get(s.admin)).body.notifications.find((item) => item.type === "new_customer_approval").canApprove, false);
  const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.orders[0].items, before.orders[0].items);
  assert.deepEqual(after.orders[0].payments, before.orders[0].payments); assert.equal(after.operationLogs.length - before.operationLogs.length, 2);
});

test("only the exact owner can request and only enabled admins can review; admin-owner still submits pending", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const token of [s.other, s.admin, ""]) {
    const result = await s.submit({}, token); assert.equal(result.response.status, token ? 403 : 401, JSON.stringify(result.body));
  }
  ok(await s.submit());
  for (const token of [s.owner, s.other]) assert.equal((await s.review({}, token)).response.status, 403);
  assert.equal((await s.read()).newCustomerApproval.status, "pending");
  assert.deepEqual((await s.readPersistedState()).stock, before.stock);
  const own = fixture(); own.state.orders[0].contactPersonnelId = "pricing-admin";
  const a = await setup(t, own); const requested = await a.submit({}, a.admin); ok(requested);
  assert.equal(requested.body.order.newCustomerApproval.status, "pending");
});

test("October creation gate rejects old, missing and malformed timestamps even with an edited October business date", async (t) => {
  for (const createdAt of ["2026-09-30T23:59:59+08:00", undefined, "2026-10-35T09:00:00"]) {
    const f = fixture(); Object.assign(f.state.orders[0], { createdAt, date: "2026-10-02" }); const s = await setup(t, f);
    const before = await s.readPersistedState(); const result = await s.submit(); assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("platform approval needs explicit identity confirmation; rejection returns to owner and allows CAS resubmission", async (t) => {
  const s = await setup(t, fixture({ known: false })); ok(await s.submit());
  assert.equal((await s.review()).body.code, "NEW_CUSTOMER_IDENTITY_CONFIRMATION_REQUIRED");
  assert.equal((await s.review({ decision: "reject" })).response.status, 400);
  ok(await s.review({ decision: "reject", note: "请补充首次购买的核实依据" }));
  assert.equal((await s.submit()).response.status, 409);
  const again = await s.submit({ expectedApprovalVersion: 2 }); ok(again);
  const approved = await s.review({ confirmCustomerIdentity: true }); ok(approved);
  assert.equal(approved.body.order.newCustomerApproval.customerIdentityConfirmed, true);
});

test("owner changes after submission invalidate approval and forged generic state approval cannot bypass review", async (t) => {
  const s = await setup(t, fixture({ known: false })); ok(await s.submit()); const order = await s.read();
  const forged = { ...order, newCustomerApproval: { ...order.newCustomerApproval, status: "approved", reviewedBy: "pricing-admin" } };
  const patch = await s.request("/api/state/patch", { token: s.owner, body: { patch: { orders: [forged] }, basePatch: { orders: [order] } } });
  assert.equal(patch.response.status, 409);
  const changed = await s.request("/api/orders/update", { token: s.admin, body: { ...order, orderId: order.id, contactPersonnelId: "pricing-admin", contactPerson: "价格测试admin" } }); ok(changed);
  const review = await s.review({ confirmCustomerIdentity: true }); assert.equal(review.body.code, "NEW_CUSTOMER_IDENTITY_CONFLICT");
});

test("concurrent approvals are idempotent and an opposite stale decision conflicts", async (t) => {
  const s = await setup(t); ok(await s.submit());
  const before = await s.readPersistedState(); const results = await Promise.all([s.review(), s.review()]); results.forEach(ok);
  assert.equal(results.filter((item) => item.body.unchanged).length, 1);
  assert.equal((await s.readPersistedState()).operationLogs.length - before.operationLogs.length, 1);
  assert.equal((await s.review({ decision: "reject", note: "旧页面操作", expectedApprovalVersion: 1 })).response.status, 409);
});

test("known customers with earlier orders cannot receive a second new-customer approval or leak hidden order evidence", async (t) => {
  const f = fixture(); f.state.orders.push({ ...f.state.orders[0], id: "hidden-earlier", orderNo: "PRIVATE_JY_ORDER", siteId: "jiangyin", date: "2026-10-02", createdAt: "2026-09-30T12:00:00+08:00" });
  const s = await setup(t, f); assert.equal((await s.submit()).response.status, 409);
  const detail = await s.request("/api/orders/new-customer/detail?orderId=ORDER-PENDING", { token: s.owner }); ok(detail);
  assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE_JY_ORDER|hidden-earlier/);
  assert.equal((await s.request("/api/orders/new-customer/detail?orderId=hidden-earlier", { token: s.owner })).response.status, 403);
});

test("deleting an unpaid order closes pending new-customer notices instead of leaving unresolvable inbox tasks", async (t) => {
  const s = await setup(t); ok(await s.submit());
  const deletion = await s.request("/api/orders/delete", { token: s.admin, body: { orderId: "ORDER-PENDING" } }); ok(deletion);
  const state = await s.readPersistedState(); assert.equal(state.orders.length, 0);
  const notifications = state.notifications.filter((item) => item.type === "new_customer_approval");
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every((item) => item.status === "completed" && item.resolution === "rejected"));
});

const linkedPath = (kind, extra = {}) => `/api/orders/new-customer/linked-detail?${new URLSearchParams({ orderId: "ORDER-PENDING", kind, ...extra })}`;

test("approval linked order shows full authoritative amounts and safe review fields without changing approval or business records", async (t) => {
  const f = fixture();
  Object.assign(f.state.orders[0], { notes: "核对首次交易", platformOrderNo: "PLATFORM-IDENTITY", paymentAccount: "PRIVATE_ACCOUNT", secret: "PRIVATE_ORDER_SECRET",
    shippingFeeMode: "prepaid", shippingFee: 20, packagingFee: 10, discount: 3.45,
    payments: [{ id: "receipt", type: "balance", amount: 100, verificationStatus: "verified", account: "PRIVATE_PAYMENT_ACCOUNT", proof: ["PRIVATE_PROOF"] },
      { id: "pending", type: "balance", amount: 50, verificationStatus: "pending" }] });
  f.state.customers[0].password = "PRIVATE_CUSTOMER_SECRET";
  const s = await setup(t, f); ok(await s.submit()); const before = await s.readPersistedState();
  for (const token of [s.admin, s.owner]) {
    const detail = await s.request(linkedPath("order"), { token }); ok(detail);
    assert.equal(detail.response.headers.get("cache-control"), "no-store, private");
    assert.equal(detail.body.approvalOrderId, "ORDER-PENDING");
    assert.equal(detail.body.kind, "order");
    assert.equal(detail.body.order.id, "ORDER-PENDING");
    assert.equal(detail.body.order.customerName, "新客户");
    assert.equal(detail.body.order.contactPerson, "价格测试editor");
    assert.equal(detail.body.order.notes, "核对首次交易");
    assert.equal(detail.body.order.platformOrderNo, "PLATFORM-IDENTITY");
    assert.equal(detail.body.order.totals.goodsNetTotal, 120);
    assert.equal(detail.body.order.totals.calculatedReceivable, 150);
    assert.equal(detail.body.order.totals.netReceived, 100);
    assert.equal(detail.body.order.totals.pendingReceived, 50);
    assert.equal(detail.body.order.totals.balance, 50);
    assert.ok(detail.body.order.items.every((item) => item.isBatchFish === false));
    assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE_|"personnel"|"password"|"newCustomerApproval"|"proof"|"account"|本批次/);
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test("approval customer detail is derived from the current order, allowlisted and includes only authorized same-customer history", async (t) => {
  const f = fixture(); Object.assign(f.state.customers[0], { phone: "13000000000", address: "测试地址", notes: "身份核对备注", secret: "PRIVATE_CUSTOMER_SECRET" });
  f.state.customers.push({ id: "unrelated-customer", name: "PRIVATE_OTHER_CUSTOMER", phone: "PRIVATE_PHONE" });
  f.state.orders.push({ ...f.state.orders[0], id: "same-customer", orderNo: "RELATED", createdAt: "2026-10-03T12:00:00+08:00", status: "cancelled" },
    { ...f.state.orders[0], id: "hidden-customer-order", orderNo: "PRIVATE_JY_ORDER", siteId: "jiangyin" },
    { ...f.state.orders[0], id: "unrelated-order", orderNo: "PRIVATE_OTHER_ORDER", customerId: "unrelated-customer" });
  const s = await setup(t, f); const before = await s.readPersistedState();
  const detail = await s.request(linkedPath("customer", { customerId: "unrelated-customer", siteId: "jiangyin" }), { token: s.owner }); ok(detail);
  assert.equal(detail.body.customer.id, "new-customer");
  assert.equal(detail.body.customer.phone, "13000000000");
  assert.equal(detail.body.customer.address, "测试地址");
  assert.equal(detail.body.customer.notes, "身份核对备注");
  assert.deepEqual(detail.body.orders.map((order) => order.id), ["same-customer", "ORDER-PENDING"]);
  assert.equal(detail.body.orders[0].statusLabel, "已取消");
  assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE_|hidden-customer-order|jiangyin|"payments"|"items"|"secret"/);
  ok(await s.request(linkedPath("order", { targetOrderId: "same-customer" }), { token: s.owner }));
  const admin = await s.request(linkedPath("customer"), { token: s.admin }); ok(admin);
  assert.ok(admin.body.orders.some((order) => order.id === "hidden-customer-order"));
  assert.deepEqual(await s.readPersistedState(), before);
});

test("approval navigation cannot use a visible context to open unrelated or hidden orders or borrow another site's permissions", async (t) => {
  const f = fixture();
  f.state.orders.push({ ...f.state.orders[0], id: "hidden-order", orderNo: "PRIVATE_JY_ORDER", siteId: "jiangyin" },
    { ...f.state.orders[0], id: "unrelated-order", orderNo: "PRIVATE_UNRELATED_ORDER", customerId: "unrelated" });
  const s = await setup(t, f);
  for (const params of [{ targetOrderId: "hidden-order" }, { orderId: "hidden-order" }, { orderId: "hidden-order", targetOrderId: "ORDER-PENDING" }, { targetOrderId: "unrelated-order" }]) {
    const result = await s.request(linkedPath("order", { siteId: "nanjing", ...params }), { token: s.owner });
    assert.ok([403, 404].includes(result.response.status), JSON.stringify(result.body));
    assert.equal(result.body.order, undefined); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|new-client|123\.45/);
  }
  assert.equal((await s.request(linkedPath("customer", { orderId: "hidden-order" }), { token: s.owner })).response.status, 403);
  assert.equal((await s.request(linkedPath("order", { targetOrderId: "unrelated-order" }), { token: s.admin })).response.status, 404);
  ok(await s.request(linkedPath("order", { targetOrderId: "hidden-order" }), { token: s.admin }));
});

test("approval navigation handles unlinked or deleted customers and deleted or duplicate orders without stale snapshot fallback", async (t) => {
  const unknown = await setup(t, fixture({ known: false }));
  assert.equal((await unknown.request(linkedPath("customer"), { token: unknown.admin })).body.code, "NEW_CUSTOMER_CUSTOMER_UNLINKED");
  ok(await unknown.request(linkedPath("order"), { token: unknown.admin }));
  const f = fixture(); f.state.customers = [];
  f.state.orders[0].newCustomerApproval = { customerSnapshot: { id: "new-customer", phone: "PRIVATE_STALE_PHONE" } };
  const deleted = await setup(t, f);
  const customer = await deleted.request(linkedPath("customer"), { token: deleted.admin });
  assert.equal(customer.response.status, 404); assert.doesNotMatch(JSON.stringify(customer.body), /PRIVATE_STALE_PHONE/);
  assert.equal((await deleted.request(linkedPath("order", { orderId: "deleted-order" }), { token: deleted.admin })).response.status, 404);
  assert.equal((await deleted.request(linkedPath("order", { targetOrderId: "deleted-order" }), { token: deleted.admin })).response.status, 404);
  const duplicate = fixture(); duplicate.state.orders.push({ ...duplicate.state.orders[0], siteId: "jiangyin" });
  const d = await setup(t, duplicate);
  assert.equal((await d.request(linkedPath("order"), { token: d.owner })).response.status, 409);
  const duplicateCustomer = fixture(); duplicateCustomer.state.customers.push({ ...duplicateCustomer.state.customers[0] });
  const c = await setup(t, duplicateCustomer);
  assert.equal((await c.request(linkedPath("customer"), { token: c.admin })).response.status, 409);
});

test("approval linked detail requires current enabled authentication and validates request kinds", async (t) => {
  const s = await setup(t);
  const anonymous = await s.request(linkedPath("order"));
  assert.equal(anonymous.response.status, 401); assert.equal(anonymous.response.headers.get("cache-control"), "no-store, private");
  assert.equal((await s.request(linkedPath("invalid"), { token: s.admin })).response.status, 400);
  assert.equal((await s.request(linkedPath("order", { orderId: "" }), { token: s.admin })).response.status, 400);
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["jiangyin"] });
  assert.equal((await s.request(linkedPath("order"), { token: s.owner })).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { accountEnabled: false });
  assert.equal((await s.request(linkedPath("customer"), { token: s.owner })).response.status, 401);
});
