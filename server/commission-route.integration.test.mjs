import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { reconcileCommissionLedger } from "./commission-ledger.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const currentMonth = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
const thisMonth = (day = "01") => `${currentMonth()}-${day}T09:00:00+08:00`;
const meKeys = ["ok", "month", "policyEffectiveDate", "personalAmount", "newCustomerAmount", "regularPersonalAmount"].sort();
const commissionKeys = (value) => !value || typeof value !== "object" ? [] : Object.entries(value)
  .flatMap(([key, nested]) => [/commission/i.test(key) ? key : null, ...commissionKeys(nested)]).filter(Boolean);

function payment(id, amount, overrides = {}) {
  return { id, type: "balance", amount, time: thisMonth(), channel: "cash", account: "commission-qa-cash", recordSource: "manual",
    verificationStatus: "verified", verifiedAt: thisMonth(), verifiedBy: "pricing-admin", notes: "synthetic commission test", proof: [], ...overrides };
}
function order(id, owner, amount, overrides = {}) {
  return { id, orderNo: id, siteId: "nanjing", date: "2026-10-01", createdAt: "2026-10-01T08:00:00+08:00", customerId: `customer-${id}`, customerName: `客户 ${id}`,
    contactPersonnelId: owner, contactPerson: owner === "pricing-editor" ? "员工甲" : "员工乙", status: "confirmed", source: "私域线上", plannedShipDate: "2026-10-02",
    paymentChannel: "cash", paymentAccount: "commission-qa-cash", items: [{ stockItemId: `fish-${id}`, productId: "price-product", price: amount, minReturnPrice: 0 }],
    discount: 0, packagingFee: 0, shippingFee: 0, shippingFeeMode: "collect", payments: [payment(`receipt-${id}`, amount)], ...overrides };
}

function fixture() {
  const value = structuredClone(stockPricingFixture);
  value.state.personnel = value.state.personnel.map((person, index) => ({ ...person, name: person.id === "pricing-editor" ? "员工甲" : person.id === "pricing-viewer" ? "员工乙" : "管理员",
    personnelNo: `COMMISSION-${index}`, department: "销售", role: "销售人员", hireDate: "2026-01-01", siteIds: person.id === "pricing-viewer" ? ["jiangyin"] : ["nanjing"],
    visibleSiteIds: person.accessRole === "admin" ? [] : person.id === "pricing-viewer" ? ["jiangyin"] : ["nanjing"],
    permissions: { ...person.permissions, finance: { create: true, update: true, delete: true }, orders: { create: true, update: true, delete: true } } }));
  value.state.orders = [
    order("A-REGULAR", "pricing-editor", 1000, { payments: [payment("a-receipt", 1000), payment("a-refund", 200, { type: "refund", time: "2026-09-30T10:00:00+08:00" })] }),
    order("A-OTHER-SITE", "pricing-editor", 3000, { siteId: "jiangyin" }),
    order("B-REGULAR", "pricing-viewer", 2000, { siteId: "jiangyin" }),
    order("A-NEW", "pricing-editor", 1000),
    order("A-OLD", "pricing-editor", 999000, { createdAt: "2026-09-30T23:59:59+08:00", date: "2026-10-02" }),
    order("A-PENDING", "pricing-editor", 7000, { payments: [payment("pending-receipt", 7000, { verificationStatus: "pending", verifiedAt: "", verifiedBy: "" })] }),
  ];
  value.state.customers = value.state.orders.map((item) => ({ id: item.customerId, name: item.customerName, wechat: item.id }));
  value.state.stock = value.state.orders.map((item) => ({ id: item.items[0].stockItemId, siteId: item.siteId, productId: "price-product", batchId: item.siteId === "nanjing" ? "batch-n" : "batch-j",
    subTankId: item.siteId === "nanjing" ? "tank-n" : "tank-j", inDate: "2026-10-01", basePrice: item.items[0].price, sold: true, lost: false, status: "healthy", notes: "" }));
  value.state.shipments = [];
  value.state.notifications = [];
  return value;
}

async function setup(t, data = fixture(), { approve = true } = {}) {
  const server = await startMutableRouteServer(data);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const a = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const b = await server.login("pricing-viewer", PRICING_TEST_PASSWORD);
  if (approve && data.state.orders.some((item) => item.id === "A-NEW")) {
    const requested = await server.request("/api/orders/new-customer/request", { token: a, body: { orderId: "A-NEW", reason: "已核实客户身份与首次购买", expectedApprovalVersion: 0 } });
    ok(requested);
    const approval = requested.body.order.newCustomerApproval;
    const reviewed = await server.request("/api/orders/new-customer/review", { token: admin, body: { orderId: "A-NEW", requestId: approval.requestId, decision: "approve", note: "测试核实首次购买", expectedApprovalVersion: approval.version } });
    ok(reviewed);
  }
  return { ...server, admin, a, b };
}

test("self-only monthly totals isolate two staff, include own cross-site orders, and exclude the public team pool", async (t) => {
  const s = await setup(t);
  const a = await s.request("/api/commissions/me", { token: s.a }); ok(a);
  const b = await s.request("/api/commissions/me", { token: s.b }); ok(b);
  assert.deepEqual(Object.keys(a.body).sort(), meKeys);
  assert.deepEqual(Object.keys(b.body).sort(), meKeys);
  assert.deepEqual(a.body, { ok: true, month: currentMonth(), policyEffectiveDate: "2026-10-01", personalAmount: 57.6, newCustomerAmount: 50, regularPersonalAmount: 7.6 });
  assert.equal(b.body.personalAmount, 4);
  assert.equal(b.body.newCustomerAmount, 0);
  assert.equal(b.body.regularPersonalAmount, 4);
  assert.match(a.response.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(JSON.stringify(a.body), /员工乙|pricing-viewer|team|rows|orders|A-OTHER-SITE/);
  const again = await s.request("/api/commissions/me", { token: s.a }); ok(again);
  assert.deepEqual(again.body, a.body);
});

test("me ignores forged identity, month and venue query selectors and unauthorized requests disclose no totals", async (t) => {
  const s = await setup(t);
  const expected = await s.request("/api/commissions/me", { token: s.a }); ok(expected);
  for (const query of ["userId=pricing-viewer", "personnelId=pricing-viewer", "username=pricing-admin", "siteId=jiangyin", "month=2026-09", "month=2099-12&userId=pricing-viewer&personnelId=pricing-admin&siteId=all"]) {
    const actual = await s.request(`/api/commissions/me?${query}`, { token: s.a }); ok(actual);
    assert.deepEqual(actual.body, expected.body, query);
  }
  for (const token of [undefined, "not-a-valid-session"]) {
    const denied = await s.request("/api/commissions/me", { token });
    assert.equal(denied.response.status, 401);
    assert.equal(denied.body.personalAmount, undefined);
  }
});

test("a staff account without finance or order management permissions can still read only its own monthly commission", async (t) => {
  const data = fixture();
  data.state.personnel.find((person) => person.id === "pricing-editor").permissions = {};
  data.state.orders = [order("OWN-READ-ONLY", "pricing-editor", 1000)];
  const s = await setup(t, data, { approve: false });
  const own = await s.request("/api/commissions/me", { token: s.a }); ok(own);
  assert.equal(own.body.personalAmount, 2);
  assert.deepEqual(Object.keys(own.body).sort(), meKeys);
  assert.equal((await s.request("/api/finance/overview?siteId=all", { token: s.a })).response.status, 403);
  assert.equal((await s.request(`/api/commissions/summary?month=${currentMonth()}`, { token: s.a })).response.status, 403);
});

test("administrator monthly summary keeps the team pool separate and denies ordinary finance-authorized users", async (t) => {
  const s = await setup(t);
  const summary = await s.request(`/api/commissions/summary?month=${currentMonth()}`, { token: s.admin }); ok(summary);
  assert.equal(summary.body.personalTotal, 61.6);
  assert.equal(summary.body.newCustomerTotal, 50);
  assert.equal(summary.body.regularPersonalTotal, 11.6);
  assert.equal(summary.body.teamPoolTotal, 17.4);
  const a = summary.body.rows.find((row) => row.personnelId === "pricing-editor");
  assert.equal(a.personalAmount, 57.6);
  assert.equal(a.teamAmount, undefined);
  assert.equal(a.teamPoolTotal, undefined);
  assert.match(summary.response.headers.get("cache-control"), /no-store/);
  for (const token of [s.a, s.b]) {
    const denied = await s.request(`/api/commissions/summary?month=${currentMonth()}&userId=pricing-admin`, { token });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.rows, undefined);
    assert.equal(denied.body.teamPoolTotal, undefined);
  }
  for (const month of ["2026-09", "2026-13", "not-a-month"]) {
    const invalid = await s.request(`/api/commissions/summary?month=${month}`, { token: s.admin });
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
  }
});

test("old or unproven creation timestamps and pending receipts cannot receive commission from current-month collection", async (t) => {
  const data = fixture();
  data.state.orders = [
    order("OLD", "pricing-editor", 100000, { createdAt: "2026-09-30T23:59:59+08:00", date: "2026-10-02" }),
    order("MISSING", "pricing-editor", 200000, { createdAt: undefined }),
    order("INVALID", "pricing-editor", 300000, { createdAt: "not-a-date" }),
    order("UNVERIFIED", "pricing-editor", 400000, { payments: [payment("not-verified", 400000, { verificationStatus: "pending", verifiedAt: "", verifiedBy: "" })] }),
  ];
  const s = await setup(t, data, { approve: false });
  const me = await s.request("/api/commissions/me", { token: s.a }); ok(me);
  assert.equal(me.body.personalAmount, 0);
  const summary = await s.request(`/api/commissions/summary?month=${currentMonth()}`, { token: s.admin }); ok(summary);
  assert.equal(summary.body.personalTotal, 0);
  assert.equal(summary.body.teamPoolTotal, 0);
});

test("verifying a pending receipt enters the verification month once, independent of its entered payment time", async (t) => {
  const data = fixture();
  data.state.orders = [order("VERIFY", "pricing-editor", 1000, { payments: [payment("verify-me", 1000, { time: "2026-09-01T10:00:00+08:00", verificationStatus: "pending", verifiedAt: "", verifiedBy: "" })] })];
  const s = await setup(t, data, { approve: false });
  const before = await s.request("/api/commissions/me", { token: s.a }); ok(before); assert.equal(before.body.personalAmount, 0);
  const verified = await s.request("/api/orders/payment", { token: s.admin, body: { action: "verify", orderId: "VERIFY", paymentId: "verify-me" } }); ok(verified);
  const after = await s.request("/api/commissions/me", { token: s.a }); ok(after); assert.equal(after.body.personalAmount, 2);
  const repeated = await s.request("/api/commissions/me", { token: s.a }); ok(repeated); assert.deepEqual(repeated.body, after.body);
});

test("the financial verification transaction journals commission before any dashboard read and reads do not duplicate it", async (t) => {
  const data = fixture();
  data.state.orders = [order("JOURNAL", "pricing-editor", 1000, { payments: [payment("journal-payment", 1000, { verificationStatus: "pending", verifiedAt: "", verifiedBy: "" })] })];
  const s = await setup(t, data, { approve: false });
  const verified = await s.request("/api/orders/payment", { token: s.admin, body: { action: "verify", orderId: "JOURNAL", paymentId: "journal-payment" } }); ok(verified);
  const committed = (await s.readPersistedState()).commissionLedgerV1;
  assert.ok(committed, "verification must save the private ledger in its own transaction");
  assert.ok(committed.entries.length > 0);
  assert.equal(committed.entries.reduce((sum, entry) => sum + entry.regularPersonalCents, 0), 200);
  assert.equal(committed.entries.reduce((sum, entry) => sum + entry.teamPoolCents, 0), 300);
  const me = await s.request("/api/commissions/me", { token: s.a }); ok(me); assert.equal(me.body.personalAmount, 2);
  assert.deepEqual((await s.readPersistedState()).commissionLedgerV1, committed);
});

test("returning an item with a pending refund preserves verified cash commission until the refund is verified", async (t) => {
  const data = fixture();
  const stockIds = ["return-cash-fish-1", "return-cash-fish-2"];
  data.state.orders = [order("RETURN-CASH", "pricing-editor", 200, {
    items: stockIds.map((stockItemId) => ({ stockItemId, productId: "price-product", price: 100, minReturnPrice: 0 })),
    payments: [payment("return-cash-receipt", 200)],
  })];
  const stockTemplate = data.state.stock[0];
  data.state.stock = stockIds.map((id) => ({ ...stockTemplate, id, basePrice: 100, sold: true }));
  const s = await setup(t, data, { approve: false });
  assert.equal((await s.readPersistedState()).commissionLedgerV1, undefined, "do not initialize via a dashboard read before the return");

  const returned = await s.request("/api/orders/return-item", { token: s.a, body: {
    orderId: "RETURN-CASH", stockItemId: stockIds[0],
    refund: { id: "return-cash-refund", type: "refund", amount: 100, time: thisMonth(), notes: "退还一件商品，等待财务核销", proof: [] },
  } }); ok(returned);
  const pendingState = await s.readPersistedState();
  const pendingOrder = pendingState.orders.find((item) => item.id === "RETURN-CASH");
  assert.equal(pendingOrder.items.length, 1);
  assert.equal(pendingOrder.items[0].price, 100);
  assert.equal(pendingOrder.payments.find((item) => item.id === "return-cash-refund").verificationStatus, "pending");
  const pendingLedger = pendingState.commissionLedgerV1;
  assert.ok(pendingLedger, "the return mutation must snapshot the existing verified receipt before removing an order item");
  const totals = (ledger) => ledger.entries.filter((entry) => entry.orderId === "RETURN-CASH")
    .reduce((sum, entry) => ({ base: sum.base + entry.baseCents, personal: sum.personal + entry.regularPersonalCents + entry.newCustomerCents, team: sum.team + entry.teamPoolCents }), { base: 0, personal: 0, team: 0 });
  assert.deepEqual(totals(pendingLedger), { base: 20000, personal: 40, team: 60 });
  const pendingMe = await s.request("/api/commissions/me", { token: s.a }); ok(pendingMe); assert.equal(pendingMe.body.personalAmount, 0.4);
  const pendingFinance = await s.request("/api/finance/overview?siteId=all", { token: s.admin }); ok(pendingFinance);
  assert.equal(pendingFinance.body.orders.find((item) => item.id === "RETURN-CASH").commissionBase, 200);
  assert.deepEqual((await s.readPersistedState()).commissionLedgerV1, pendingLedger, "reads must not resize the receipt to the remaining item value");

  const verified = await s.request("/api/orders/payment", { token: s.admin, body: { action: "verify", orderId: "RETURN-CASH", paymentId: "return-cash-refund" } }); ok(verified);
  const verifiedState = await s.readPersistedState();
  const verifiedLedger = verifiedState.commissionLedgerV1;
  assert.deepEqual(totals(verifiedLedger), { base: 10000, personal: 20, team: 30 });
  assert.equal(verifiedState.orders[0].payments.find((item) => item.id === "return-cash-refund").verificationStatus, "verified");
  const verifiedMe = await s.request("/api/commissions/me", { token: s.a }); ok(verifiedMe); assert.equal(verifiedMe.body.personalAmount, 0.2);
  const summary = await s.request(`/api/commissions/summary?month=${currentMonth()}`, { token: s.admin }); ok(summary);
  assert.equal(summary.body.personalTotal, 0.2);
  assert.equal(summary.body.teamPoolTotal, 0.3);
  const finance = await s.request("/api/finance/overview?siteId=all", { token: s.admin }); ok(finance);
  assert.equal(finance.body.orders[0].commissionBase, 100);
  assert.deepEqual((await s.readPersistedState()).commissionLedgerV1, verifiedLedger, "repeated reads must not duplicate the refund deduction");
});

test("JSONB-style object key reordering does not dirty the ledger or duplicate receipt and approval events", async (t) => {
  const s = await setup(t);
  const initial = await s.request("/api/commissions/me", { token: s.a }); ok(initial);
  const persisted = await s.readPersistedState();
  const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reorder(value[key])])) : value;
  const reordered = reorder(persisted);
  assert.notEqual(JSON.stringify(reordered.commissionLedgerV1), JSON.stringify(persisted.commissionLedgerV1));
  const recalculated = reconcileCommissionLedger(reordered, [], new Date());
  assert.equal(recalculated.changed, false, "a serialization-only change must not request another database write");
  assert.equal(recalculated.ledger, reordered.commissionLedgerV1);
  assert.equal(recalculated.byOrder.get("A-NEW").personalCommissionAmount, 50, "JSONB reordering must not invalidate the approved customer snapshot");

  const restarted = await setup(t, { revision: 300, state: reordered }, { approve: false });
  const after = await restarted.request("/api/commissions/me", { token: restarted.a }); ok(after);
  assert.deepEqual(after.body, initial.body);
  assert.deepEqual((await restarted.readPersistedState()).commissionLedgerV1, reordered.commissionLedgerV1);
  const again = await restarted.request("/api/commissions/me", { token: restarted.a }); ok(again);
  assert.deepEqual(again.body, initial.body);
  assert.deepEqual((await restarted.readPersistedState()).commissionLedgerV1, reordered.commissionLedgerV1);
});

test("disabled accounts and revoked sessions lose access to their commission immediately", async (t) => {
  const s = await setup(t);
  ok(await s.request("/api/commissions/me", { token: s.a }));
  const sensitive = await s.request("/api/personnel/sensitive", { token: s.admin, body: { id: "pricing-editor" } }); ok(sensitive);
  const disabled = await s.request("/api/personnel/save", { token: s.admin, body: { personnel: { id: "pricing-editor", accountEnabled: false, sensitiveRevision: sensitive.body.sensitiveRevision } } }); ok(disabled);
  const denied = await s.request("/api/commissions/me", { token: s.a }); assert.equal(denied.response.status, 401, JSON.stringify(denied.body));
  assert.equal(denied.body.personalAmount, undefined);
  const changed = await s.request("/api/personnel/password", { token: s.admin, body: { targetId: "pricing-viewer", newPassword: "commission-revocation-test-password" } }); ok(changed);
  const revoked = await s.request("/api/commissions/me", { token: s.b }); assert.equal(revoked.response.status, 401, JSON.stringify(revoked.body));
  const fresh = await s.login("pricing-viewer", "commission-revocation-test-password");
  const valid = await s.request("/api/commissions/me", { token: fresh }); ok(valid); assert.equal(valid.body.personalAmount, 4);
});

test("private commission ledger never appears in general state and cannot be injected using a generic patch", async (t) => {
  const s = await setup(t);
  ok(await s.request("/api/commissions/me", { token: s.a }));
  const before = await s.readPersistedState();
  assert.ok(before.commissionLedgerV1, "the route must persist its private audit ledger");
  for (const token of [s.admin, s.a, s.b]) {
    for (const path of ["/api/state", "/api/state/slice?keys=orders,systemSettings", "/api/state/slice?keys=commissionLedgerV1"]) {
      const response = await s.request(path, { token });
      assert.ok([200, 400].includes(response.response.status), JSON.stringify(response.body));
      if (response.response.status === 200) assert.doesNotMatch(JSON.stringify(response.body), /commissionLedgerV1|"targets"|"entries"/);
    }
    const injected = await s.request("/api/state/patch", { token, body: { patch: { commissionLedgerV1: { version: 1, entries: [{ personnelId: "pricing-editor", personalAmount: 999999 }] } }, basePatch: { commissionLedgerV1: before.commissionLedgerV1 } } });
    assert.ok([400, 403, 409].includes(injected.response.status), JSON.stringify(injected.body));
    assert.deepEqual((await s.readPersistedState()).commissionLedgerV1, before.commissionLedgerV1);
  }
});

test("legacy commission configuration routes are retired without mutating order settings", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  const settings = await s.request("/api/finance/settings", { token: s.admin, body: { defaultCommissionRate: 99 } });
  assert.equal(settings.response.status, 410, JSON.stringify(settings.body));
  const perOrder = await s.request("/api/finance/order-commission", { token: s.admin, body: { orderId: "A-REGULAR", commissionRate: 99 } });
  assert.equal(perOrder.response.status, 410, JSON.stringify(perOrder.body));
  const after = await s.readPersistedState();
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.systemSettings, before.systemSettings);
});

test("finance-authorized staff retain financial workflows but do not receive anyone's commission fields", async (t) => {
  const s = await setup(t);
  const admin = await s.request("/api/finance/overview?siteId=all", { token: s.admin }); ok(admin);
  assert.ok(admin.body.orders.some((item) => item.commissionEligible === true));
  assert.equal(admin.body.orders.find((item) => item.id === "A-NEW").personalCommissionAmount, 50);
  for (const token of [s.a, s.b]) {
    const staff = await s.request("/api/finance/overview?siteId=all", { token }); ok(staff);
    assert.ok(staff.body.orders.length > 0);
    assert.ok(staff.body.orders.every((item) => Number.isFinite(item.receivable)));
    assert.deepEqual(commissionKeys(staff.body.orders), []);
    assert.deepEqual(commissionKeys(staff.body.summary), []);
    assert.deepEqual(commissionKeys(staff.body), ["commissionPolicyEffectiveDate"]);
    assert.equal(staff.body.settings.commissionPolicyEffectiveDate, "2026-10-01");
  }
});
