import test from "node:test";
import assert from "node:assert/strict";
import { commissionMonth, invalidateCommissionAllocations, monthlyCommissionSummary, personalCommissionSummary, reconcileCommissionLedger } from "./commission-ledger.mjs";

const NOW = "2026-12-02T10:00:00+08:00";
const OCT = "2026-10-02T10:00:00+08:00";
const NOV = "2026-11-02T10:00:00+08:00";
const paid = (id, amount, verifiedAt = OCT, type = "balance", extra = {}) => ({ id, amount, verifiedAt, time: "2026-10-01T10:00:00+08:00", type, verificationStatus: "verified", ...extra });
function fixture(extra = {}) {
  return {
    personnel: [{ id: "p1", username: "owner", name: "张三" }, { id: "p2", username: "owner2", name: "李四" }],
    customers: [{ id: "c1", phone: "1", wechat: "w", douyin: "" }], shipments: [],
    orders: [{ id: "o1", orderNo: "SO-1", siteId: "nj", createdAt: "2026-10-01T10:00:00+08:00", date: "2026-10-01", source: "私域线上", status: "completed", contactPersonnelId: "p1", contactPerson: "owner", customerId: "c1", items: [{ price: 1000, minReturnPrice: 1000 }], discount: 0, shippingFeeMode: "prepaid", shippingFee: 0, packagingFee: 0, payments: [paid("pay1", 1000)], ...extra }],
  };
}
function approve(state, reviewedAt = NOV) {
  const order = state.orders[0];
  order.newCustomerApproval = { status: "approved", requestId: "request1", reviewedAt, reviewedBy: "admin", contactPersonnelId: order.contactPersonnelId, customerId: order.customerId, customerSnapshot: { id: "c1", phone: "1", wechat: "w", douyin: "" }, version: 2 };
  return state;
}
function reconcile(state, now = NOW, rows = []) {
  const result = reconcileCommissionLedger(state, rows, now);
  state.commissionLedgerV1 = result.ledger;
  return result;
}
function platformRow(data, extra = {}) {
  return { id: "settlement1", platform: "douyin", site_id: "nj", external_order_no: "123", settlement_time: OCT, data, ...extra };
}

test("ordinary verified receipts accrue exact 0.2% personal and 0.3% pool; old rates/floors/tags are ignored", () => {
  const state = fixture({ commissionRate: 99, isAcquisitionOrder: true });
  const result = reconcile(state);
  assert.equal(result.byOrder.get("o1").commissionAmount, 2);
  assert.equal(result.byOrder.get("o1").teamCommissionAmount, 3);
  assert.deepEqual(personalCommissionSummary(result.ledger, "p1", "2026-10"), { month: "2026-10", policyEffectiveDate: "2026-10-01", personalAmount: 2, newCustomerAmount: 0, regularPersonalAmount: 2 });
  const summary = monthlyCommissionSummary(result.ledger, state.personnel, "2026-10");
  assert.equal(summary.personalTotal, 2); assert.equal(summary.teamPoolTotal, 3); assert.equal(summary.orderCount, 1);
  assert.equal(summary.rows[0].personalAmount, 2);
});

test("pending, unknown-status and future-verification payments do not accrue", () => {
  const state = fixture({ payments: [paid("pending", 200, OCT, "balance", { verificationStatus: "pending" }), paid("bad", 200, OCT, "balance", { verificationStatus: "rejected" }), paid("future", 200, "2027-01-01T00:00:00+08:00"), paid("ok", 100)] });
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 100);
});

test("China verified month is authoritative; legacy missing verifiedAt uses time only", () => {
  const state = fixture({ payments: [paid("at", 500, "2026-10-31T16:00:00Z"), paid("legacy", 500, "", "balance", { time: "2026-10-31 23:59:59" })] });
  const result = reconcile(state);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 1);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 1);
  assert.ok(result.diagnostics.some((item) => item.code === "LEGACY_PAYMENT_TIME_FALLBACK"));
  assert.equal(commissionMonth("2026-10-31T16:00:00Z"), "2026-11");
});

test("createdAt cutoff is authoritative, not editable date, and invalid/missing/future timestamps exclude", () => {
  for (const createdAt of ["2026-09-30T23:59:59+08:00", "", undefined, "2026-10-01", "2026-02-30T12:00:00+08:00", "2027-01-01T00:00:00+08:00"]) {
    const result = reconcile(fixture({ createdAt, date: "2027-01-01" }));
    assert.equal(result.byOrder.get("o1").commissionEligible, false, String(createdAt));
    assert.equal(result.ledger.entries.length, 0);
  }
  assert.equal(reconcile(fixture({ createdAt: "2026-09-30T16:00:00Z", date: "2020-01-01" })).byOrder.get("o1").commissionAmount, 2);
});

test("partial receipts allocate goods and fees proportionally and goods never exceed receivable", () => {
  const state = fixture({ items: [{ price: 1100 }], discount: 100, shippingFee: 80, packagingFee: 20, payments: [paid("one", 550)] });
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 500);
  state.orders[0].payments.push(paid("two", 550, NOV));
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 1000);
  state.orders[0].payments.push(paid("over", 10000, NOW));
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 1000);
});

test("shipping-fee first fills only shipping, then remaining ordinary payment fills all goods", () => {
  const state = fixture({ shippingFee: 100, packagingFee: 20, payments: [paid("ship", 100, OCT, "shipping_fee"), paid("goods", 1020, NOV)] });
  const result = reconcile(state);
  assert.equal(result.byOrder.get("o1").commissionBase, 1000);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 0);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 2);
});

test("later shipping reclassifies only ordinary cash that funded shipping; excess shipping never becomes goods", () => {
  const state = fixture({ shippingFee: 100, payments: [paid("initial", 550)] });
  reconcile(state, OCT);
  state.orders[0].payments.push(paid("ship", 1000, NOV, "shipping_fee"));
  const result = reconcile(state, NOV);
  assert.equal(result.byOrder.get("o1").commissionBase, 550);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 0.1);
  assert.ok(Object.values(result.ledger.receiptSnapshots).filter((item) => item.type === "shipping").every((item) => item.parts[0] === 0));
});

test("shipping reclassification snapshot survives a later pending item return and its eventual verified refund", () => {
  const state = fixture({ shippingFee: 100, payments: [paid("initial", 550)] });
  reconcile(state, OCT);
  state.orders[0].payments.push(paid("ship", 100, NOV, "shipping_fee"));
  const reclassified = reconcile(state, NOV);
  assert.equal(reclassified.byOrder.get("o1").commissionBase, 550);
  state.orders[0].items = [];
  state.orders[0].shippingFee = 0;
  state.orders[0].payments.push(paid("refund", 650, NOW, "refund", { verificationStatus: "pending" }));
  assert.equal(reconcile(state, NOW).byOrder.get("o1").commissionBase, 550);
  state.orders[0].payments.at(-1).verificationStatus = "verified";
  assert.equal(reconcile(state, NOW).byOrder.get("o1").commissionBase, 0);
  assert.equal(reconcile(state, NOW).changed, false);
});

test("later item removal cannot reallocate a previously verified partial refund before the new refund is verified", () => {
  const state = fixture({ items: [{ price: 100 }, { price: 100 }], shippingFee: 20, payments: [paid("cash", 220), paid("old-refund", 110, "2026-10-03T12:00:00+08:00", "refund")] });
  assert.equal(reconcile(state, "2026-10-04T12:00:00+08:00").byOrder.get("o1").commissionBase, 100);
  state.orders[0].items.pop();
  state.orders[0].payments.push(paid("new-refund", 110, NOV, "refund", { verificationStatus: "pending" }));
  assert.equal(reconcile(state, NOV).byOrder.get("o1").commissionBase, 100);
  assert.equal(personalCommissionSummary(state.commissionLedgerV1, "p1", "2026-11").personalAmount, 0);
  state.orders[0].payments.at(-1).verificationStatus = "verified";
  assert.equal(reconcile(state, NOV).byOrder.get("o1").commissionBase, 0);
});

test("collect/free shipping is excluded, while packaging remains a non-goods fee", () => {
  for (const shippingFeeMode of ["collect", "free"]) {
    const result = reconcile(fixture({ shippingFeeMode, shippingFee: 100, packagingFee: 20, payments: [paid("one", 510)] }));
    assert.equal(result.byOrder.get("o1").commissionBase, 500);
  }
});

test("actual shipment fee supersedes estimated shipping without counting damage refund twice", () => {
  const state = fixture({ shippingFee: 10, payments: [paid("one", 550), paid("refund", 110, NOV, "refund")] });
  state.shipments = [{ orderId: "o1", status: "damaged", actualShippingFee: 100, damageResolution: "refund", damageRefundAmount: 110 }];
  const result = reconcile(state);
  assert.equal(result.byOrder.get("o1").commissionBase, 400);
});

test("initial reconstruction recognizes Oct regular and Nov approval delta without rewriting Oct", () => {
  const state = approve(fixture());
  const result = reconcile(state);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 2);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 48);
  assert.equal(monthlyCommissionSummary(result.ledger, state.personnel, "2026-11").teamPoolTotal, -3);
  assert.equal(result.byOrder.get("o1").commissionAmount, 50);
  assert.equal(result.byOrder.get("o1").teamCommissionAmount, 0);
});

test("approval before receipt accrues 5% with no ordinary personal or pool", () => {
  const result = reconcile(approve(fixture(), "2026-10-01T11:00:00+08:00"));
  const october = personalCommissionSummary(result.ledger, "p1", "2026-10");
  assert.equal(october.personalAmount, 50); assert.equal(october.regularPersonalAmount, 0);
  assert.equal(result.byOrder.get("o1").teamCommissionAmount, 0);
});

test("PostgreSQL JSONB key reordering does not invalidate an approved customer snapshot", () => {
  const state = approve(fixture(), "2026-10-01T11:00:00+08:00");
  state.orders[0].newCustomerApproval.customerSnapshot = { douyin: "", wechat: "w", phone: "1", id: "c1" };
  assert.equal(reconcile(state).byOrder.get("o1").commissionAmount, 50);
});

test("same-second shipping and ordinary receipts allocate shipping first regardless of payment id or array order", () => {
  const state = fixture({ shippingFee: 100, payments: [paid("a-goods", 1000), paid("z-shipping", 100, OCT, "shipping_fee")] });
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 1000);
});

test("later approval appends current-month adjustment and old entries are byte-for-byte immutable", () => {
  const state = fixture();
  const first = reconcile(state, OCT);
  const oldEntries = JSON.stringify(first.ledger.entries);
  approve(state, NOV);
  const second = reconcile(state, NOW);
  assert.equal(JSON.stringify(second.ledger.entries.slice(0, first.ledger.entries.length)), oldEntries);
  assert.equal(personalCommissionSummary(second.ledger, "p1", "2026-10").personalAmount, 2);
  assert.equal(personalCommissionSummary(second.ledger, "p1", "2026-11").personalAmount, 0);
  assert.equal(personalCommissionSummary(second.ledger, "p1", "2026-12").personalAmount, 48);
  assert.equal(reconcile(state, NOW).changed, false);
});

test("refunds in subsequent month reverse original approved rate, even cancelled order", () => {
  const state = approve(fixture(), "2026-10-01T11:00:00+08:00");
  const first = reconcile(state, OCT);
  state.orders[0].status = "cancelled";
  state.orders[0].payments.push(paid("refund", 500, NOV, "refund"));
  const second = reconcile(state, NOV);
  assert.equal(personalCommissionSummary(second.ledger, "p1", "2026-11").personalAmount, -25);
  assert.equal(second.byOrder.get("o1").commissionAmount, 25);
  assert.equal(JSON.stringify(second.ledger.entries.slice(0, first.ledger.entries.length)), JSON.stringify(first.ledger.entries));
});

test("refund before approval upgrades only remaining merchandise and full refund later reaches zero", () => {
  const state = approve(fixture({ payments: [paid("one", 1000), paid("r1", 200, "2026-10-10T12:00:00+08:00", "refund"), paid("r2", 800, "2026-12-01T12:00:00+08:00", "refund")] }));
  const result = reconcile(state);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 1.6);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 38.4);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-12").personalAmount, -40);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0);
});

test("refund prorates merchandise and original non-goods fees, but refunds overpayment first", () => {
  const state = fixture({ shippingFee: 100, payments: [paid("one", 1100), paid("refund", 550, NOV, "refund")] });
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 500);
  const overpaid = fixture({ payments: [paid("over", 2000), paid("returnover", 1000, NOV, "refund")] });
  assert.equal(reconcile(overpaid).byOrder.get("o1").commissionBase, 1000);
});

test("verified refund before receipt remains cash debt and offsets later receipts across months", () => {
  const state = fixture({ payments: [paid("early-refund", 100, OCT, "refund")] });
  assert.equal(reconcile(state, OCT).byOrder.get("o1").commissionBase, 0);
  state.orders[0].payments.push(paid("later-receipt", 100, NOV));
  let result = reconcile(state, NOV);
  assert.equal(result.byOrder.get("o1").commissionBase, 0);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, 0);
  state.orders[0].payments.push(paid("fresh-receipt", 100, NOW));
  result = reconcile(state, NOW);
  assert.equal(result.byOrder.get("o1").commissionBase, 100);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-12").personalAmount, 0.2);
  assert.equal(reconcile(state, NOW).changed, false);
});

test("excess refund debt spans multiple later payments without creating false merchandise receipts", () => {
  const state = fixture({ payments: [paid("first", 100), paid("refund", 250, NOV, "refund"), paid("later", 100, "2026-11-03T12:00:00+08:00"), paid("last", 100, NOW)] });
  const result = reconcile(state, NOW);
  assert.equal(result.byOrder.get("o1").commissionBase, 50);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0.1);
});

test("tiny receipts use cumulative integer rounding and full refunds exactly reverse pennies", () => {
  const state = fixture({ items: [{ price: "3.335" }], payments: Array.from({ length: 334 }, (_, i) => paid(`tiny${i}`, 0.01)) });
  const result = reconcile(state, OCT);
  assert.equal(result.byOrder.get("o1").commissionBase, 3.34);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0.01);
  assert.equal(result.byOrder.get("o1").teamCommissionAmount, 0.01);
  state.orders[0].payments.push(paid("full-refund", 3.34, NOV, "refund"));
  const reversed = reconcile(state, NOV);
  assert.equal(reversed.byOrder.get("o1").commissionAmount, 0);
  assert.equal(reversed.byOrder.get("o1").teamCommissionAmount, 0);
});

test("amount changes, unverification and deletion append correction in current month only", () => {
  const state = fixture();
  reconcile(state, OCT);
  state.orders[0].payments[0].amount = 500;
  let result = reconcile(state, NOV);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 2);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, -1);
  state.orders[0].payments[0].verificationStatus = "pending";
  result = reconcile(state, NOW);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-12").personalAmount, -1);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0);
  state.orders = [];
  assert.equal(reconcile(state).changed, false);
});

test("owner reassignment transfers lifetime commission in current month, not old months", () => {
  const state = fixture();
  reconcile(state, OCT);
  state.orders[0].contactPersonnelId = "p2";
  const result = reconcile(state, NOV);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 2);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, -2);
  assert.equal(personalCommissionSummary(result.ledger, "p2", "2026-11").personalAmount, 2);
  assert.equal(monthlyCommissionSummary(result.ledger, state.personnel, "2026-11").teamPoolTotal, 0);
});

test("invalid or ambiguous owner does not send commission to username lookalike", () => {
  const state = fixture({ contactPersonnelId: "", contactPerson: "owner" });
  state.personnel.push({ id: "duplicate", name: "owner" });
  const result = reconcile(state);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0);
  assert.ok(result.diagnostics.some((item) => item.code === "ORDER_OWNER_UNRESOLVED"));
});

test("approved customer identity mutation causes current adjustment rather than retroactive rewrite", () => {
  const state = approve(fixture(), "2026-10-01T11:00:00+08:00");
  reconcile(state, OCT);
  state.customers[0].phone = "changed";
  const result = reconcile(state, NOV);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-10").personalAmount, 50);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, -48);
});

test("platform gross userPaid minus refund replaces payments; platform fees never reduce base", () => {
  const state = fixture({ source: "平台下单", douyinOrderNo: "123", items: [{ price: 120 }], payments: [paid("mirror", 110)] });
  const result = reconcile(state, NOW, [platformRow({ userPaid: 110, preSettlementRefund: 10, incomeTotal: 100, expenseTotal: -5, settlementAmount: 95 })]);
  assert.equal(result.byOrder.get("o1").commissionBase, 100);
  assert.equal(result.byOrder.get("o1").commissionAmount, 0.2);
  assert.ok(result.diagnostics.some((item) => item.code === "PLATFORM_REPLACES_ORDER_PAYMENTS"));
});

test("platform income fallback is already net of refund, and actual zero userPaid does not fallback", () => {
  const state = fixture({ source: "平台下单", douyinOrderNo: "123", items: [{ price: 120 }] });
  const result = reconcile(state, NOW, [platformRow({ preSettlementRefund: 10, incomeTotal: 100, expenseTotal: -5, settlementAmount: 95 })]);
  assert.equal(result.byOrder.get("o1").commissionBase, 100);
  assert.ok(result.diagnostics.some((item) => item.code === "PLATFORM_NET_INCOME_FALLBACK"));
  const zero = reconcile(fixture({ source: "平台下单", douyinOrderNo: "123" }), NOW, [platformRow({ userPaid: 0, incomeTotal: 900 })]);
  assert.equal(zero.byOrder.get("o1").commissionBase, 0);
});

test("separate negative platform refund reverses once, not twice, in refund month", () => {
  const state = fixture({ source: "平台下单", douyinOrderNo: "123" });
  const rows = [platformRow({ userPaid: 1000 }), platformRow({ userPaid: -200, preSettlementRefund: -200, settlementType: "退款" }, { id: "refund", settlement_time: NOV })];
  const result = reconcile(state, NOW, rows);
  assert.equal(result.byOrder.get("o1").commissionBase, 800);
  assert.equal(personalCommissionSummary(result.ledger, "p1", "2026-11").personalAmount, -0.4);
});

test("pending or invalid platform records cannot fall back to mirrored manual payments", () => {
  for (const data of [{ verificationStatus: "pending", userPaid: 1000 }, { userPaid: "bad", incomeTotal: "bad" }]) {
    const state = fixture({ source: "平台下单", douyinOrderNo: "123" });
    assert.equal(reconcile(state, NOW, [platformRow(data)]).byOrder.get("o1").commissionBase, 0);
  }
});

test("exact duplicated payment and settlement records do not double accrue", () => {
  const state = fixture({ payments: [paid("one", 100), paid("one", 100)] });
  assert.equal(reconcile(state).byOrder.get("o1").commissionBase, 100);
  const platform = fixture({ source: "平台下单", douyinOrderNo: "123" });
  const row = platformRow({ userPaid: 100 });
  assert.equal(reconcile(platform, NOW, [row, row]).byOrder.get("o1").commissionBase, 100);
});

test("reconciliation never mutates caller state or prior ledger and stable replay is idempotent", () => {
  const state = fixture();
  const before = JSON.stringify(state);
  const first = reconcileCommissionLedger(state, [], OCT);
  assert.equal(JSON.stringify(state), before);
  const withLedger = { ...state, commissionLedgerV1: first.ledger };
  const snapshot = JSON.stringify(withLedger);
  const second = reconcileCommissionLedger(withLedger, [], NOV);
  assert.equal(JSON.stringify(withLedger), snapshot);
  assert.equal(second.changed, false);
  assert.equal(second.ledger, first.ledger);
});

test("JSONB target key normalization does not trigger ledger writes on every GET", () => {
  const state = fixture({ payments: [paid("one", 500), paid("two", 500, NOV)] });
  reconcile(state);
  state.commissionLedgerV1.targets = Object.fromEntries(Object.entries(state.commissionLedgerV1.targets).reverse().map(([key, target]) => [key, Object.fromEntries(Object.entries(target).reverse())]));
  assert.equal(reconcile(state).changed, false);
});

test("explicit finance correction invalidates only selected receipt allocations and appends the changed price in the current month", () => {
  const state = fixture();
  const original = reconcile(state, OCT).ledger;
  const oldEntries = JSON.stringify(original.entries);
  state.orders[0].items[0].price = 500;
  assert.equal(reconcile(state, NOV).byOrder.get("o1").commissionBase, 1000, "implicit item removal alone is not a cash refund");
  const invalidated = invalidateCommissionAllocations(state.commissionLedgerV1, ["o1"]);
  assert.equal(Object.keys(invalidated.receiptSnapshots).length, 0);
  assert.equal(Object.keys(original.receiptSnapshots).length, 1, "input ledger is immutable");
  state.commissionLedgerV1 = invalidated;
  const corrected = reconcile(state, NOV);
  assert.equal(corrected.byOrder.get("o1").commissionBase, 500);
  assert.equal(personalCommissionSummary(corrected.ledger, "p1", "2026-11").personalAmount, -1);
  assert.equal(JSON.stringify(corrected.ledger.entries.slice(0, original.entries.length)), oldEntries);
  assert.equal(reconcile(state, NOW).changed, false);
  assert.equal(invalidateCommissionAllocations(corrected.ledger, ["other"]), corrected.ledger);
});

test("malformed private ledger fails closed instead of silently resetting history", () => {
  assert.throws(() => reconcileCommissionLedger({ ...fixture(), commissionLedgerV1: { version: 2 } }), /manual audit/);
  assert.throws(() => monthlyCommissionSummary({}, [], "2026-13"), /Invalid commission month/);
});
