import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { newCustomerEvidenceFixture, PRICING_TEST_PASSWORD } from "./test-support/new-customer-evidence-fixture.mjs";
import { requiredProofEnv, uploadRequiredProof } from "./test-support/new-customer-required-proof.mjs";
import { newCustomerEvidencePath } from "./new-customer-evidence.mjs";
import { isApprovedNewCustomerOrder } from "./new-customer-approval.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const orderId = "ORDER-PENDING";
function fixture({ linked = false } = {}) {
  const data = newCustomerEvidenceFixture();
  Object.assign(data.state.orders[0], { customerId: linked ? "new-customer" : "", source: "平台下单", platformOrderNo: "REQUIRED-PROOF-PLATFORM", paymentChannel: "douyin", paymentAccount: "synthetic" });
  return data;
}
async function setup(t, data = fixture()) {
  const s = await startMutableRouteServer(data, { env: requiredProofEnv }); t.after(() => s.stop());
  const admin = await s.login("pricing-admin", PRICING_TEST_PASSWORD), owner = await s.login("pricing-editor", PRICING_TEST_PASSWORD), other = await s.login("pricing-viewer", PRICING_TEST_PASSWORD);
  const read = async () => (await s.readPersistedState()).orders.find((item) => item.id === orderId);
  const link = (body = {}, token = owner) => s.request("/api/orders/new-customer/customer", { token, body: { orderId, expectedCustomerId: "", expectedApprovalVersion: 0, customerId: "new-customer", ...body } });
  const create = (customer, token = admin, extra = {}) => s.request("/api/orders/new-customer/customer", { token, body: { orderId, expectedCustomerId: "", expectedApprovalVersion: 0, customer, ...extra } });
  const submit = (ids = [], extra = {}, token = owner) => s.request("/api/orders/new-customer/request", { token, body: { orderId, reason: "已核实添加客户微信及首次交易", expectedApprovalVersion: 0, evidenceIds: ids, ...extra } });
  const review = async (decision = "approve", extra = {}) => {
    const approval = (await read()).newCustomerApproval;
    return s.request("/api/orders/new-customer/review", { token: admin, body: { orderId, decision, requestId: approval.requestId, expectedApprovalVersion: approval.version, note: "补全微信证明及客户档案后重提", ...extra } });
  };
  return { ...s, admin, owner, other, read, link, create, submit, review };
}

test("real customer and private proof are both required; create-and-link only changes the customer reference and server-owned logs", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  assert.equal((await s.submit([], { confirmCustomerIdentity: true })).body.code, "NEW_CUSTOMER_CUSTOMER_REQUIRED");
  const created = await s.create({ name: "新客户档案", wechat: "new-verified-wechat", id: "forged-id", source: "微信", permissions: { admin: true }, newCustomerApproval: { status: "approved" } }); ok(created);
  const customer = created.body.customer;
  assert.notEqual(customer.id, "forged-id"); assert.equal(customer.name, "新客户档案"); assert.ok(customer.addedDate);
  assert.equal(customer.permissions, undefined); assert.equal(customer.newCustomerApproval, undefined);
  assert.deepEqual(created.body.order, { ...before.orders[0], customerId: customer.id });
  let after = await s.readPersistedState();
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.commissionLedgerV1, before.commissionLedgerV1);
  assert.equal(after.customers.length, before.customers.length + 1); assert.deepEqual(after.customers.at(-1), customer);
  assert.equal((await s.submit()).body.code, "NEW_CUSTOMER_EVIDENCE_REQUIRED");
  assert.equal((await s.submit([], { evidenceAttachments: [{ id: "fake" }], confirmCustomerIdentity: true })).body.code, "NEW_CUSTOMER_EVIDENCE_REQUIRED");
  const proof = await uploadRequiredProof(s, s.owner, orderId); ok(await s.submit([proof.id])); ok(await s.review());
  after = await s.readPersistedState(); assert.equal(after.orders[0].newCustomerApproval.status, "approved");
  assert.equal(isApprovedNewCustomerOrder(after, after.orders[0]), true);
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
});

test("existing customers are linked without modification; exact contact duplicates and malformed input create nothing", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  for (const customer of [{ name: "另一名字", wechat: " evidence-test " }, { name: "" }, { name: "客户", phone: {} }, []]) {
    assert.notEqual((await s.create(customer)).response.status, 200); assert.deepEqual(await s.readPersistedState(), before);
  }
  for (const body of [{ customerId: "missing" }, { customerId: "" }, { customer: { name: "冲突" } }, { expectedApprovalVersion: "0" }, { expectedCustomerId: null }]) {
    assert.notEqual((await s.link(body)).response.status, 200); assert.deepEqual(await s.readPersistedState(), before);
  }
  ok(await s.link()); const after = await s.readPersistedState();
  assert.deepEqual(after.customers, before.customers); assert.deepEqual(after.orders[0], { ...before.orders[0], customerId: "new-customer" });
  assert.equal((await s.link()).body.code, "NEW_CUSTOMER_CUSTOMER_CONFLICT");
  ok(await s.link({ expectedCustomerId: "new-customer" }));
  assert.deepEqual(await s.readPersistedState(), after);
});

test("customer association enforces exact owner, admin, current account, order permission, site and unique identities", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  for (const token of ["", s.other]) assert.equal((await s.link({}, token)).response.status, token ? 403 : 401);
  assert.equal((await s.create({ name: "无建档权限" }, s.owner)).response.status, 403);
  assert.deepEqual(await s.readPersistedState(), before);
  await s.patchTestPersonnel("pricing-editor", { permissions: {} }); assert.equal((await s.link()).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { permissions: before.personnel.find((p) => p.id === "pricing-editor").permissions, visibleSiteIds: ["jiangyin"] }); assert.equal((await s.link()).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["nanjing"], sessionVersion: 1 }); assert.equal((await s.link()).response.status, 401);
  const duplicate = fixture(); duplicate.state.orders.push(structuredClone(duplicate.state.orders[0])); const d = await setup(t, duplicate);
  assert.equal((await d.link()).body.code, "ORDER_ID_NOT_UNIQUE");
  const duplicateCustomer = fixture(); duplicateCustomer.state.customers.push(structuredClone(duplicateCustomer.state.customers[0])); const c = await setup(t, duplicateCustomer);
  assert.equal((await c.link()).body.code, "NEW_CUSTOMER_IDENTITY_CONFLICT");
});

test("atomic CAS prevents concurrent double creation and leaves every unrelated state field intact", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  const results = await Promise.all([s.create({ name: "客户甲", wechat: "client-a" }), s.create({ name: "客户乙", wechat: "client-b" })]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const after = await s.readPersistedState(); assert.equal(after.customers.length, before.customers.length + 1);
  assert.equal(after.operationLogs.length, before.operationLogs.length + 1);
  const changedKeys = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(changedKeys.sort(), ["customers", "operationLogs", "orders"].sort());
});

test("pending and approved customers cannot be relinked through dedicated, generic or ordinary edit paths", async (t) => {
  const data = fixture({ linked: true }); data.state.customers.push({ id: "second", name: "另一客户" });
  const s = await setup(t, data), proof = await uploadRequiredProof(s, s.owner, orderId); ok(await s.submit([proof.id]));
  for (const status of ["pending", "approved"]) {
    if (status === "approved") ok(await s.review());
    const current = await s.read(), before = await s.readPersistedState();
    for (const customerId of [current.customerId, "second"]) {
      assert.equal((await s.link({ expectedCustomerId: current.customerId, expectedApprovalVersion: current.newCustomerApproval.version, customerId }, s.admin)).response.status, 409);
    }
    assert.equal((await s.request("/api/orders/update", { token: s.admin, body: { ...current, orderId, customerId: "second" } })).body.code, "NEW_CUSTOMER_CUSTOMER_LOCKED");
    const generic = await s.request("/api/state/patch", { token: s.admin, body: { patch: { orders: [{ ...current, customerId: "second" }] }, basePatch: { orders: [current] } } });
    assert.equal(generic.response.status, 409, JSON.stringify(generic.body)); assert.match(generic.body.error, /不能变更关联客户/);
    assert.deepEqual(await s.readPersistedState(), before);
    const edited = await s.request("/api/orders/update", { token: s.owner, body: { ...current, orderId, customerId: "", notes: "普通编辑不清除平台客户" } }); ok(edited);
    assert.equal(edited.body.order.customerId, current.customerId); assert.deepEqual(edited.body.order.newCustomerApproval, current.newCustomerApproval);
    if (status === "approved") assert.equal(isApprovedNewCustomerOrder(await s.readPersistedState(), edited.body.order), true);
  }
});

test("legacy incomplete pending requests cannot be approved or resubmitted by manual confirmation, but can be rejected", async (t) => {
  for (const linked of [false, true]) {
    const data = fixture({ linked }); const order = data.state.orders[0];
    order.newCustomerApproval = { status: "pending", version: 1, requestId: "old-pending", requestedBy: "pricing-editor", contactPersonnelId: "pricing-editor",
      reason: "已核实添加客户微信及首次交易", customerId: order.customerId, customerSnapshot: linked ? { id: "new-customer", phone: "", wechat: "evidence-test", douyin: "" } : null };
    const s = await setup(t, data), before = await s.readPersistedState();
    assert.notEqual((await s.review("approve", { confirmCustomerIdentity: true })).response.status, 200);
    assert.notEqual((await s.submit([], { confirmCustomerIdentity: true, expectedApprovalVersion: 1 })).response.status, 200);
    assert.deepEqual(await s.readPersistedState(), before);
    const detail = await s.request(`/api/orders/new-customer/detail?orderId=${orderId}`, { token: s.admin }); ok(detail);
    assert.ok(detail.body.approvalBlockedReason); assert.equal(detail.body.canApprove, true); assert.equal(detail.body.canManageCustomer, false);
    ok(await s.review("reject"));
  }
});

test("approval verifies registry ownership and request binding rather than trusting attachment metadata", async (t) => {
  const id = `nce_${"a".repeat(32)}`;
  for (const variant of ["missing", "foreign-order", "foreign-uploader", "wrong-request"]) {
    const data = fixture({ linked: true }), order = data.state.orders[0];
    order.newCustomerApproval = { status: "pending", version: 1, requestId: "current-request", requestedBy: "pricing-editor", contactPersonnelId: "pricing-editor", customerId: order.customerId,
      customerSnapshot: { id: "new-customer", phone: "", wechat: "evidence-test", douyin: "" }, evidenceAttachments: [{ id, mime: "image/jpeg", size: 100 }] };
    data.state.newCustomerEvidenceAttachments = variant === "missing" ? [] : [{ id, orderId: variant === "foreign-order" ? "other-order" : orderId,
      uploaderPersonnelId: variant === "foreign-uploader" ? "pricing-admin" : "pricing-editor", uploaderUsername: "pricing-editor", boundRequestIds: [variant === "wrong-request" ? "other-request" : "current-request"] }];
    const s = await setup(t, data), before = await s.readPersistedState();
    assert.notEqual((await s.review()).response.status, 200, variant); assert.deepEqual(await s.readPersistedState(), before);
    ok(await s.review("reject"));
  }
});

test("deleted or corrupt private images prevent approval and failed approval writes nothing; rejection remains available", async (t) => {
  for (const corrupt of [false, true]) {
    const s = await setup(t, fixture({ linked: true })), proof = await uploadRequiredProof(s, s.owner, orderId); ok(await s.submit([proof.id]));
    const before = await s.readPersistedState(), path = newCustomerEvidencePath(s.uploadDir, proof.id);
    if (corrupt) await writeFile(path, "corrupt-ciphertext"); else await rm(path);
    const denied = await s.review(); assert.equal(denied.response.status, 409, JSON.stringify(denied.body));
    assert.deepEqual(await s.readPersistedState(), before); ok(await s.review("reject"));
  }
});

test("historical approved no-customer/no-image orders keep their commission and approval retry remains unchanged", async (t) => {
  const data = fixture(), order = data.state.orders[0], now = new Date().toISOString();
  order.items[0].price = 1000; order.packagingFee = 0; order.shippingFee = 0; order.discount = 0;
  order.payments = [{ id: "historic-paid", amount: 1000, type: "balance", time: now, verifiedAt: now, verifiedBy: "pricing-admin", verificationStatus: "verified", channel: "cash", account: "synthetic", proof: [] }];
  order.newCustomerApproval = { status: "approved", version: 2, requestId: "old-approved", requestedBy: "pricing-editor", requestedAt: now,
    contactPersonnelId: "pricing-editor", customerId: "", customerSnapshot: null, customerIdentityConfirmed: true, reviewedBy: "pricing-admin", reviewedAt: now };
  const s = await setup(t, data), before = await s.readPersistedState();
  const retry = await s.review(); ok(retry); assert.equal(retry.body.unchanged, true);
  assert.deepEqual(await s.readPersistedState(), before); assert.equal(isApprovedNewCustomerOrder(before, before.orders[0]), true);
  const summary = await s.request("/api/commissions/me", { token: s.owner }); ok(summary); assert.equal(summary.body.newCustomerAmount, 50);
  assert.deepEqual((await s.read()).newCustomerApproval, order.newCustomerApproval);
});

test("linking a repeat customer is allowed but does not make the order eligible for first-order approval", async (t) => {
  const data = fixture(); data.state.orders.push({ ...data.state.orders[0], id: "earlier", customerId: "new-customer", createdAt: "2026-09-30T09:00:00+08:00" });
  const s = await setup(t, data); ok(await s.link());
  const detail = await s.request(`/api/orders/new-customer/detail?orderId=${orderId}`, { token: s.owner }); ok(detail);
  assert.equal(detail.body.canRequest, false); assert.match(detail.body.requestBlockedReason, /更早/);
  assert.equal((await s.submit()).body.code, "NEW_CUSTOMER_REQUEST_BLOCKED");
});

test("customer lookup is authorized, bounded, allowlisted and does not expose order or financial history", async (t) => {
  const data = fixture(); data.state.customers.push(...Array.from({ length: 35 }, (_, i) => ({ id: `c-${i}`, name: `查找客户${i}`, wechat: `find-${i}`, notes: "PRIVATE_NOTES", password: "PRIVATE_SECRET" })));
  const s = await setup(t, data), before = await s.readPersistedState();
  const path = `/api/orders/new-customer/customers?orderId=${orderId}`;
  const result = await s.request(path, { token: s.owner }); ok(result); assert.equal(result.body.customers.length, 30); assert.equal(result.body.hasMore, true);
  const exact = await s.request(`${path}&q=find-34`, { token: s.owner }); ok(exact); assert.equal(exact.body.customers[0].id, "c-34");
  assert.deepEqual(Object.keys(exact.body.customers[0]).sort(), ["id", "name", "phone", "wechat", "douyin"].sort());
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|payments|approval|items|notes/);
  assert.equal((await s.request(path, { token: s.other })).response.status, 403);
  assert.deepEqual(await s.readPersistedState(), before);
});
