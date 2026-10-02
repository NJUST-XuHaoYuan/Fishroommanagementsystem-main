import assert from "node:assert/strict";
import test from "node:test";

import {
  monthlyCommissionSummary,
  personalCommissionSummary,
  reconcileCommissionLedger,
} from "./commission-ledger.mjs";

const OWNER = {
  id: "person-owner",
  username: "owner",
  name: "负责人",
  accountEnabled: true,
  employmentStatus: "active",
  accessRole: "staff",
};

const ADMIN = {
  id: "person-admin",
  username: "admin",
  name: "管理员",
  accountEnabled: true,
  employmentStatus: "active",
  accessRole: "admin",
};

const CUSTOMER = { id: "customer-1", phone: "", wechat: "customer-one", douyin: "" };

function payment(id, amount, verifiedAt, type = "balance", extra = {}) {
  return {
    id,
    amount,
    type,
    verificationStatus: "verified",
    verifiedAt,
    ...extra,
  };
}

function order(id, extra = {}) {
  return {
    id,
    orderNo: `SO-${id}`,
    siteId: "site-nanjing",
    source: "私域线上",
    status: "pending",
    createdAt: "2026-10-01T00:00:00+08:00",
    date: "2026-10-01",
    customerId: CUSTOMER.id,
    contactPersonnelId: OWNER.id,
    contactPerson: OWNER.name,
    items: [{ stockItemId: `stock-${id}`, productId: "product-1", price: 100 }],
    discount: 0,
    shippingFeeMode: "prepaid",
    shippingFee: 0,
    packagingFee: 0,
    payments: [],
    ...extra,
  };
}

function state(orders, ledger) {
  return {
    personnel: [OWNER, ADMIN],
    customers: [CUSTOMER],
    shipments: [],
    orders,
    ...(ledger ? { commissionLedgerV1: ledger } : {}),
  };
}

function approved(orderValue, reviewedAt) {
  return {
    ...orderValue,
    newCustomerApproval: {
      status: "approved",
      requestId: `approval-${orderValue.id}`,
      requestedAt: reviewedAt,
      requestedBy: OWNER.username,
      requestedByName: OWNER.name,
      reason: "已核验客户身份及首次成交证据",
      customerId: CUSTOMER.id,
      customerSnapshot: { ...CUSTOMER },
      contactPersonnelId: OWNER.id,
      reviewedAt,
      reviewedBy: ADMIN.username,
      reviewedByName: ADMIN.name,
      reviewNote: "证据完整",
      version: 2,
    },
  };
}

function platformRow(id, externalOrderNo, data = {}) {
  return {
    batch_id: "batch-platform",
    created_at: "2026-10-10T04:00:00.000Z",
    site_id: "site-nanjing",
    data: {
      fingerprint: id,
      externalOrderNo,
      settlementTime: "2026-10-10 12:00:00",
      userPaid: 0,
      preSettlementRefund: 0,
      incomeTotal: 0,
      ...data,
    },
  };
}

function entryTotals(ledger, { month, orderId } = {}) {
  return (Array.isArray(ledger?.entries) ? ledger.entries : [])
    .filter((entry) => (!month || entry.month === month) && (!orderId || entry.orderId === orderId))
    .reduce((totals, entry) => ({
      baseCents: totals.baseCents + Number(entry.baseCents ?? 0),
      regularPersonalCents: totals.regularPersonalCents + Number(entry.regularPersonalCents ?? 0),
      newCustomerCents: totals.newCustomerCents + Number(entry.newCustomerCents ?? 0),
      teamPoolCents: totals.teamPoolCents + Number(entry.teamPoolCents ?? 0),
    }), { baseCents: 0, regularPersonalCents: 0, newCustomerCents: 0, teamPoolCents: 0 });
}

function entriesForMonth(ledger, month) {
  return (Array.isArray(ledger?.entries) ? ledger.entries : [])
    .filter((entry) => entry.month === month)
    .map((entry) => ({ ...entry }));
}

test("dedicated shipping receipts never earn commission and later ordinary receipts allocate against remaining balances", () => {
  const subject = order("remaining-balance", {
    shippingFee: 20,
    packagingFee: 15,
    payments: [
      payment("shipping-only", 20, "2026-10-02 10:00:00", "shipping_fee"),
      payment("part-one", 57.5, "2026-10-03 10:00:00"),
      payment("part-two", 57.5, "2026-11-03 10:00:00"),
    ],
  });

  const { ledger } = reconcileCommissionLedger(state([subject]), [], new Date("2026-11-05T00:00:00+08:00"));
  assert.deepEqual(entryTotals(ledger, { month: "2026-10", orderId: subject.id }), {
    baseCents: 5000,
    regularPersonalCents: 10,
    newCustomerCents: 0,
    teamPoolCents: 15,
  });
  assert.deepEqual(entryTotals(ledger, { month: "2026-11", orderId: subject.id }), {
    baseCents: 5000,
    regularPersonalCents: 10,
    newCustomerCents: 0,
    teamPoolCents: 15,
  });
  assert.equal(entryTotals(ledger, { orderId: subject.id }).baseCents, 10000);
});

test("late dedicated shipping reclassifies earlier ordinary shipping allocation in the current month so full payment reaches full goods", () => {
  const octoberOrder = order("late-shipping", {
    shippingFee: 20,
    packagingFee: 15,
    payments: [payment("ordinary-first", 67.5, "2026-10-03 10:00:00")],
  });
  const october = reconcileCommissionLedger(state([octoberOrder]), [], new Date("2026-10-20T00:00:00+08:00"));
  const octoberSnapshot = entriesForMonth(october.ledger, "2026-10");
  assert.equal(entryTotals(october.ledger, { orderId: octoberOrder.id }).baseCents, 5000);

  const novemberOrder = {
    ...octoberOrder,
    payments: [...octoberOrder.payments, payment("shipping-later", 20, "2026-11-03 10:00:00", "shipping_fee")],
  };
  const november = reconcileCommissionLedger(
    state([novemberOrder], october.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );
  assert.deepEqual(entriesForMonth(november.ledger, "2026-10"), octoberSnapshot);
  assert.deepEqual(entryTotals(november.ledger, { month: "2026-11", orderId: octoberOrder.id }), {
    baseCents: 870,
    regularPersonalCents: 2,
    newCustomerCents: 0,
    teamPoolCents: 3,
  });

  const decemberOrder = {
    ...novemberOrder,
    payments: [...novemberOrder.payments, payment("ordinary-final", 47.5, "2026-12-03 10:00:00")],
  };
  const december = reconcileCommissionLedger(
    state([decemberOrder], november.ledger),
    [],
    new Date("2026-12-05T00:00:00+08:00"),
  );
  assert.equal(entryTotals(december.ledger, { orderId: octoberOrder.id }).baseCents, 10000);
  assert.deepEqual(entryTotals(december.ledger, { month: "2026-12", orderId: octoberOrder.id }), {
    baseCents: 4130,
    regularPersonalCents: 8,
    newCustomerCents: 0,
    teamPoolCents: 12,
  });
});

test("platform user-paid net overrides order payments, keeps negative refund rows, and never deducts platform fees", () => {
  const subject = order("platform-net", {
    source: "平台下单",
    douyinOrderNo: '=\"12 34\"',
    payments: [payment("must-not-double-count", 999, "2026-10-03 10:00:00")],
  });
  const rows = [
    platformRow("platform-sale", "1234", {
      userPaid: 110,
      preSettlementRefund: 10,
      incomeTotal: 777,
      expenseTotal: -95,
    }),
    platformRow("platform-refund", "12 34", {
      settlementTime: "2026-11-10 12:00:00",
      userPaid: 0,
      preSettlementRefund: -20,
      incomeTotal: -20,
      expenseTotal: -999,
    }),
  ];

  const { ledger } = reconcileCommissionLedger(state([subject]), rows, new Date("2026-11-15T00:00:00+08:00"));
  assert.equal(entryTotals(ledger, { month: "2026-10", orderId: subject.id }).baseCents, 10000);
  assert.deepEqual(entryTotals(ledger, { month: "2026-11", orderId: subject.id }), {
    baseCents: -2000,
    regularPersonalCents: -4,
    newCustomerCents: 0,
    teamPoolCents: -6,
  });
  assert.equal(entryTotals(ledger, { orderId: subject.id }).baseCents, 8000);
});

test("a refund-labelled platform row with positive userPaid is fail-closed and diagnosed instead of inventing a receipt", () => {
  const subject = order("platform-refund-labelled-net", {
    source: "平台下单",
    douyinOrderNo: "refund-labelled-100",
  });
  const rows = [platformRow("platform-refund-labelled", "refund-labelled-100", {
    settlementType: "退款",
    userPaid: 100,
    preSettlementRefund: 20,
    incomeTotal: 80,
  })];

  const result = reconcileCommissionLedger(
    state([subject]),
    rows,
    new Date("2026-10-20T00:00:00+08:00"),
  );

  assert.deepEqual(entryTotals(result.ledger, { orderId: subject.id }), {
    baseCents: 0,
    regularPersonalCents: 0,
    newCustomerCents: 0,
    teamPoolCents: 0,
  });
  assert.equal(result.diagnostics.some((item) => /REFUND|AMBIGUOUS/.test(item.code)), true);
});

test("incomeTotal fallback is already net of pre-settlement refund and a zero userPaid remains authoritative", () => {
  const fallback = order("platform-fallback", {
    source: "平台下单",
    douyinOrderNo: "fallback-1",
    payments: [payment("fallback-manual", 500, "2026-10-03 10:00:00")],
  });
  const zero = order("platform-zero", {
    source: "平台下单",
    douyinOrderNo: "zero-1",
    payments: [payment("zero-manual", 100, "2026-10-03 10:00:00")],
  });
  const rows = [
    platformRow("fallback-row", "fallback-1", {
      userPaid: undefined,
      preSettlementRefund: 20,
      incomeTotal: 80,
    }),
    platformRow("zero-row", "zero-1", {
      userPaid: 0,
      preSettlementRefund: 0,
      incomeTotal: 90,
    }),
  ];

  const { ledger } = reconcileCommissionLedger(state([fallback, zero]), rows, new Date("2026-10-20T00:00:00+08:00"));
  assert.equal(entryTotals(ledger, { orderId: fallback.id }).baseCents, 8000);
  assert.equal(entryTotals(ledger, { orderId: zero.id }).baseCents, 0);
});

test("malformed platform gross or refund money is excluded instead of silently falling back or treating a refund as zero", () => {
  const invalidGross = order("platform-invalid-gross", {
    source: "平台下单",
    douyinOrderNo: "invalid-gross",
    payments: [payment("invalid-gross-manual", 100, "2026-10-03 10:00:00")],
  });
  const invalidRefund = order("platform-invalid-refund", {
    source: "平台下单",
    douyinOrderNo: "invalid-refund",
  });
  const result = reconcileCommissionLedger(state([invalidGross, invalidRefund]), [
    platformRow("invalid-gross-row", "invalid-gross", { userPaid: "not-money", incomeTotal: 100 }),
    platformRow("invalid-refund-row", "invalid-refund", { userPaid: 100, preSettlementRefund: "not-money" }),
  ], new Date("2026-10-20T00:00:00+08:00"));

  assert.equal(entryTotals(result.ledger, { orderId: invalidGross.id }).baseCents, 0);
  assert.equal(entryTotals(result.ledger, { orderId: invalidRefund.id }).baseCents, 0);
  assert.match(JSON.stringify(result.diagnostics), /INVALID_PLATFORM|PLATFORM.*INVALID|金额|money/i);
});

test("an unmatched imported platform row is explicitly diagnosed", () => {
  const result = reconcileCommissionLedger(
    state([]),
    [platformRow("unmatched-row", "unmatched-9988", { userPaid: 100 })],
    new Date("2026-10-20T00:00:00+08:00"),
  );

  assert.equal(entryTotals(result.ledger).baseCents, 0);
  assert.match(JSON.stringify(result.diagnostics), /unmatched-9988|UNMATCHED|未匹配|未分配/i);
});

test("ambiguous normalized platform associations are excluded with diagnostics rather than choosing the first order", () => {
  const first = order("ambiguous-a", { source: "平台下单", douyinOrderNo: '=\"88 99\"' });
  const second = order("ambiguous-b", { source: "平台下单", douyinOrderNo: "8899" });
  const result = reconcileCommissionLedger(
    state([first, second]),
    [platformRow("ambiguous-row", "'8899", { userPaid: 100 })],
    new Date("2026-10-20T00:00:00+08:00"),
  );

  assert.equal(entryTotals(result.ledger).baseCents, 0);
  assert.ok(Array.isArray(result.diagnostics) && result.diagnostics.length > 0);
  assert.match(JSON.stringify(result.diagnostics), /8899|关联|不唯一|ambiguous/i);
});

test("approval in a later month appends only the 4.8% personal true-up and removes the 0.3% team pool", () => {
  const ordinary = order("cross-month-approval", {
    payments: [payment("receipt-october", 100, "2026-10-08 09:00:00")],
  });
  const october = reconcileCommissionLedger(
    state([ordinary]),
    [],
    new Date("2026-10-20T00:00:00+08:00"),
  );
  const octoberSnapshot = entriesForMonth(october.ledger, "2026-10");
  const reviewed = approved(ordinary, "2026-11-05T02:00:00.000Z");
  const november = reconcileCommissionLedger(
    state([reviewed], october.ledger),
    [],
    new Date("2026-11-05T12:00:00+08:00"),
  );

  assert.deepEqual(entriesForMonth(november.ledger, "2026-10"), octoberSnapshot);
  assert.deepEqual(entryTotals(november.ledger, { month: "2026-11", orderId: ordinary.id }), {
    baseCents: 0,
    regularPersonalCents: -20,
    newCustomerCents: 500,
    teamPoolCents: -30,
  });
});

test("first reconciliation reconstructs a historic approval true-up in its review month, not the receipt month", () => {
  const subject = approved(order("historic-approval", {
    payments: [payment("historic-receipt", 100, "2026-10-08 09:00:00")],
  }), "2026-11-05T02:00:00.000Z");
  const { ledger } = reconcileCommissionLedger(
    state([subject]),
    [],
    new Date("2026-12-01T00:00:00+08:00"),
  );

  assert.deepEqual(entryTotals(ledger, { month: "2026-10", orderId: subject.id }), {
    baseCents: 10000,
    regularPersonalCents: 20,
    newCustomerCents: 0,
    teamPoolCents: 30,
  });
  assert.deepEqual(entryTotals(ledger, { month: "2026-11", orderId: subject.id }), {
    baseCents: 0,
    regularPersonalCents: -20,
    newCustomerCents: 500,
    teamPoolCents: -30,
  });
});

test("discovering an earlier order invalidates new-customer status by a current-month delta without rewriting history", () => {
  const subject = approved(order("claimed-first", {
    createdAt: "2026-10-02T10:00:00+08:00",
    date: "2026-10-02",
    payments: [payment("claimed-first-payment", 100, "2026-10-03 09:00:00")],
  }), "2026-10-03T02:00:00.000Z");
  const initial = reconcileCommissionLedger(state([subject]), [], new Date("2026-10-20T00:00:00+08:00"));
  const octoberSnapshot = entriesForMonth(initial.ledger, "2026-10");
  const earlier = order("actual-first", {
    createdAt: "2026-10-01T10:00:00+08:00",
    date: "2026-10-01",
    customerId: CUSTOMER.id,
    payments: [],
  });
  const corrected = reconcileCommissionLedger(
    state([subject, earlier], initial.ledger),
    [],
    new Date("2026-11-10T00:00:00+08:00"),
  );

  assert.deepEqual(entriesForMonth(corrected.ledger, "2026-10"), octoberSnapshot);
  assert.deepEqual(entryTotals(corrected.ledger, { month: "2026-11", orderId: subject.id }), {
    baseCents: 0,
    regularPersonalCents: 20,
    newCustomerCents: -500,
    teamPoolCents: 30,
  });
  assert.match(JSON.stringify(corrected.diagnostics), /FIRST|首单|APPROVAL/i);
});

test("a later verified refund reverses the approved original rate without rewriting earlier months or duplicating on replay", () => {
  const paid = approved(order("approved-refund", {
    payments: [payment("paid-october", 100, "2026-10-08 09:00:00")],
  }), "2026-10-09T02:00:00.000Z");
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const octoberSnapshot = entriesForMonth(initial.ledger, "2026-10");
  const refunded = {
    ...paid,
    payments: [...paid.payments, payment("refund-december", 20, "2026-12-03 09:00:00", "refund")],
  };
  const december = reconcileCommissionLedger(
    state([refunded], initial.ledger),
    [],
    new Date("2026-12-03T12:00:00+08:00"),
  );

  assert.deepEqual(entriesForMonth(december.ledger, "2026-10"), octoberSnapshot);
  assert.deepEqual(entryTotals(december.ledger, { month: "2026-12", orderId: paid.id }), {
    baseCents: -2000,
    regularPersonalCents: 0,
    newCustomerCents: -100,
    teamPoolCents: 0,
  });

  const replay = reconcileCommissionLedger(
    state([refunded], december.ledger),
    [],
    new Date("2026-12-03T12:00:00+08:00"),
  );
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.ledger, december.ledger);
});

test("an earlier verified refund remains a debt against a later receipt instead of being forgotten", () => {
  const refundedFirst = order("refund-before-receipt", {
    payments: [payment("refund-first", 100, "2026-10-02 09:00:00", "refund")],
  });
  const october = reconcileCommissionLedger(
    state([refundedFirst]),
    [],
    new Date("2026-10-20T00:00:00+08:00"),
  );
  const octoberEntries = entriesForMonth(october.ledger, "2026-10");
  assert.equal(entryTotals(october.ledger, { orderId: refundedFirst.id }).baseCents, 0);
  assert.equal(october.diagnostics.some((item) => item.code === "REFUND_EXCEEDS_VERIFIED_RECEIPTS"), true);

  const paidLater = {
    ...refundedFirst,
    payments: [...refundedFirst.payments, payment("receipt-later", 100, "2026-11-03 09:00:00")],
  };
  const november = reconcileCommissionLedger(
    state([paidLater], october.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );

  assert.deepEqual(entriesForMonth(november.ledger, "2026-10"), octoberEntries);
  assert.deepEqual(entryTotals(november.ledger, { orderId: refundedFirst.id }), {
    baseCents: 0,
    regularPersonalCents: 0,
    newCustomerCents: 0,
    teamPoolCents: 0,
  });
});

test("cancellation alone invents no refund or rate downgrade; only a verified refund reverses the approved lot", () => {
  const paid = approved(order("cancelled-liability", {
    payments: [payment("cancelled-paid", 100, "2026-10-08 09:00:00")],
  }), "2026-10-09T02:00:00.000Z");
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const cancelled = { ...paid, status: "cancelled" };
  const afterCancellation = reconcileCommissionLedger(
    state([cancelled], initial.ledger),
    [],
    new Date("2026-11-10T00:00:00+08:00"),
  );

  assert.equal(afterCancellation.changed, false);
  assert.deepEqual(afterCancellation.ledger, initial.ledger);
  assert.equal(entryTotals(afterCancellation.ledger, { orderId: paid.id }).newCustomerCents, 500);

  const refunded = {
    ...cancelled,
    payments: [...cancelled.payments, payment("cancelled-refund", 100, "2026-12-03 09:00:00", "refund")],
  };
  const afterRefund = reconcileCommissionLedger(
    state([refunded], afterCancellation.ledger),
    [],
    new Date("2026-12-03T12:00:00+08:00"),
  );
  assert.equal(entryTotals(afterRefund.ledger, { month: "2026-11", orderId: paid.id }).newCustomerCents, 0);
  assert.equal(entryTotals(afterRefund.ledger, { month: "2026-12", orderId: paid.id }).newCustomerCents, -500);
});

test("removing a paid item with a pending refund preserves its receipt allocation until the refund is verified", () => {
  const paid = order("pending-return", {
    items: [
      { stockItemId: "return-a", productId: "product-1", price: 100 },
      { stockItemId: "return-b", productId: "product-1", price: 100 },
    ],
    payments: [payment("return-paid", 200, "2026-10-08 09:00:00")],
  });
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const octoberSnapshot = entriesForMonth(initial.ledger, "2026-10");
  const pendingReturn = {
    ...paid,
    items: [paid.items[0]],
    payments: [...paid.payments, {
      id: "return-refund",
      type: "refund",
      amount: 100,
      verificationStatus: "pending",
      time: "2026-11-03 09:00:00",
    }],
  };
  const pending = reconcileCommissionLedger(
    state([pendingReturn], initial.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );

  assert.equal(pending.changed, false);
  assert.deepEqual(entriesForMonth(pending.ledger, "2026-10"), octoberSnapshot);
  assert.equal(entryTotals(pending.ledger, { orderId: paid.id }).baseCents, 20000);

  const verifiedReturn = {
    ...pendingReturn,
    payments: pendingReturn.payments.map((item) => item.id === "return-refund"
      ? { ...item, verificationStatus: "verified", verifiedAt: "2026-12-03 09:00:00" }
      : item),
  };
  const verified = reconcileCommissionLedger(
    state([verifiedReturn], pending.ledger),
    [],
    new Date("2026-12-05T00:00:00+08:00"),
  );
  assert.deepEqual(entryTotals(verified.ledger, { month: "2026-12", orderId: paid.id }), {
    baseCents: -10000,
    regularPersonalCents: -20,
    newCustomerCents: 0,
    teamPoolCents: -30,
  });
  assert.equal(entryTotals(verified.ledger, { orderId: paid.id }).baseCents, 10000);
});

test("a verified return refund reverses the frozen returned-goods lot before consuming later overpayment", () => {
  const paid = order("pending-return-with-new-cash", {
    items: [
      { stockItemId: "return-new-a", productId: "product-1", price: 100 },
      { stockItemId: "return-new-b", productId: "product-1", price: 100 },
    ],
    payments: [payment("return-new-paid", 200, "2026-10-08 09:00:00")],
  });
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const pendingReturn = {
    ...paid,
    items: [paid.items[0]],
    payments: [
      ...paid.payments,
      {
        id: "return-new-pending-refund",
        type: "refund",
        amount: 100,
        verificationStatus: "pending",
        time: "2026-11-03 09:00:00",
      },
      payment("return-new-extra-cash", 100, "2026-11-04 09:00:00"),
    ],
  };
  const pending = reconcileCommissionLedger(
    state([pendingReturn], initial.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );

  assert.equal(entryTotals(pending.ledger, { orderId: paid.id }).baseCents, 20000);
  assert.deepEqual(entryTotals(pending.ledger, { month: "2026-11", orderId: paid.id }), {
    baseCents: 0,
    regularPersonalCents: 0,
    newCustomerCents: 0,
    teamPoolCents: 0,
  });

  const verifiedReturn = {
    ...pendingReturn,
    payments: pendingReturn.payments.map((item) => item.id === "return-new-pending-refund"
      ? { ...item, verificationStatus: "verified", verifiedAt: "2026-12-03 09:00:00" }
      : item),
  };
  const verified = reconcileCommissionLedger(
    state([verifiedReturn], pending.ledger),
    [],
    new Date("2026-12-05T00:00:00+08:00"),
  );

  assert.deepEqual(entryTotals(verified.ledger, { month: "2026-12", orderId: paid.id }), {
    baseCents: -10000,
    regularPersonalCents: -20,
    newCustomerCents: 0,
    teamPoolCents: -30,
  });
  assert.equal(entryTotals(verified.ledger, { orderId: paid.id }).baseCents, 10000);
});

test("source amount corrections adjust the frozen lot now, while new receipts use the current remaining goods cap", () => {
  const paid = order("allocation-snapshot", {
    items: [
      { stockItemId: "snapshot-a", productId: "product-1", price: 100 },
      { stockItemId: "snapshot-b", productId: "product-1", price: 100 },
    ],
    payments: [payment("snapshot-paid", 200, "2026-10-08 09:00:00")],
  });
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const correctedOrder = {
    ...paid,
    items: [paid.items[0]],
    payments: [
      { ...paid.payments[0], amount: 150 },
      { id: "snapshot-pending-refund", type: "refund", amount: 50, verificationStatus: "pending", time: "2026-11-03 09:00:00" },
    ],
  };
  const corrected = reconcileCommissionLedger(
    state([correctedOrder], initial.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );
  assert.equal(entryTotals(corrected.ledger, { orderId: paid.id }).baseCents, 15000);
  assert.deepEqual(entryTotals(corrected.ledger, { month: "2026-11", orderId: paid.id }), {
    baseCents: -5000,
    regularPersonalCents: -10,
    newCustomerCents: 0,
    teamPoolCents: -15,
  });

  const withNewReceipt = {
    ...correctedOrder,
    payments: [...correctedOrder.payments, payment("snapshot-new-payment", 100, "2026-12-03 09:00:00")],
  };
  const appended = reconcileCommissionLedger(
    state([withNewReceipt], corrected.ledger),
    [],
    new Date("2026-12-05T00:00:00+08:00"),
  );
  assert.equal(entryTotals(appended.ledger, { orderId: paid.id }).baseCents, 15000);
  assert.equal(entryTotals(appended.ledger, { month: "2026-12", orderId: paid.id }).baseCents, 0);
});

test("increasing an earlier source reflows later frozen lots instead of exceeding the original goods cap", () => {
  const paid = order("correction-reflow", {
    items: [
      { stockItemId: "reflow-a", productId: "product-1", price: 100 },
      { stockItemId: "reflow-b", productId: "product-1", price: 100 },
    ],
    payments: [
      payment("reflow-first", 100, "2026-10-02 09:00:00"),
      payment("reflow-second", 100, "2026-10-03 09:00:00"),
    ],
  });
  const initial = reconcileCommissionLedger(state([paid]), [], new Date("2026-10-20T00:00:00+08:00"));
  const octoberSnapshot = entriesForMonth(initial.ledger, "2026-10");
  const correctedOrder = {
    ...paid,
    payments: paid.payments.map((item) => item.id === "reflow-first" ? { ...item, amount: 150 } : item),
  };
  const corrected = reconcileCommissionLedger(
    state([correctedOrder], initial.ledger),
    [],
    new Date("2026-11-05T00:00:00+08:00"),
  );

  assert.deepEqual(entriesForMonth(corrected.ledger, "2026-10"), octoberSnapshot);
  assert.equal(entryTotals(corrected.ledger, { orderId: paid.id }).baseCents, 20000);
  assert.deepEqual(entryTotals(corrected.ledger, { month: "2026-11", orderId: paid.id }), {
    baseCents: 0,
    regularPersonalCents: 0,
    newCustomerCents: 0,
    teamPoolCents: 0,
  });
  assert.ok(corrected.ledger.entries.filter((entry) => entry.month === "2026-11").length >= 2);
  const snapshotGoods = Object.values(corrected.ledger.receiptSnapshots ?? {})
    .filter((snapshot) => snapshot.orderId === paid.id)
    .reduce((sum, snapshot) => sum + snapshot.parts[0], 0);
  assert.equal(snapshotGoods, 20000);
});

test("the October gate uses immutable createdAt, legacy verification status remains compatible, and malformed money is diagnosed", () => {
  const old = order("old-created", {
    createdAt: "2026-09-30T23:59:59+08:00",
    date: "2026-10-20",
    payments: [payment("old-payment", 100, "2026-10-20 10:00:00")],
  });
  const boundary = order("china-boundary", {
    createdAt: "2026-09-30T16:00:00Z",
    payments: [{ id: "legacy-payment", type: "balance", amount: 100, verifiedAt: "2026-10-20 10:00:00" }],
  });
  const malformed = order("malformed-money", {
    items: [{ stockItemId: "bad-stock", productId: "product-1", price: "not-a-number" }],
    payments: [payment("bad-payment", 100, "2026-10-20 10:00:00")],
  });
  const result = reconcileCommissionLedger(
    state([old, boundary, malformed]),
    [],
    new Date("2026-10-21T00:00:00+08:00"),
  );

  assert.equal(entryTotals(result.ledger, { orderId: old.id }).baseCents, 0);
  assert.equal(entryTotals(result.ledger, { orderId: boundary.id }).baseCents, 10000);
  assert.equal(entryTotals(result.ledger, { orderId: malformed.id }).baseCents, 0);
  assert.match(JSON.stringify(result.diagnostics), /malformed-money|金额|price|invalid/i);
});

test("cent allocation uses deterministic largest remainders and never emits fractional cents", () => {
  const subject = order("cent-rounding", {
    items: [{ stockItemId: "cent-stock", productId: "product-1", price: 0.01 }],
    shippingFee: 0.01,
    packagingFee: 0.01,
    payments: [
      payment("cent-one", 0.01, "2026-10-03 10:00:00"),
      payment("cent-two", 0.02, "2026-10-04 10:00:00"),
    ],
  });
  const { ledger } = reconcileCommissionLedger(state([subject]), [], new Date("2026-10-20T00:00:00+08:00"));

  assert.equal(entryTotals(ledger, { orderId: subject.id }).baseCents, 1);
  for (const entry of ledger.entries) {
    for (const key of ["baseCents", "regularPersonalCents", "newCustomerCents", "teamPoolCents"]) {
      assert.equal(Number.isSafeInteger(entry[key]), true, `${key} must be integer cents`);
      assert.equal(Object.is(entry[key], -0), false, `${key} must not be negative zero`);
    }
  }
});

test("summary helpers keep the public team pool separate from a salesperson's own monthly amount", () => {
  const ordinary = order("summary-ordinary", {
    payments: [payment("summary-payment", 100, "2026-10-08 09:00:00")],
  });
  const newcomer = approved(order("summary-new", {
    payments: [payment("summary-new-payment", 100, "2026-10-09 09:00:00")],
  }), "2026-10-09T10:00:00.000Z");
  const { ledger } = reconcileCommissionLedger(state([ordinary, newcomer]), [], new Date("2026-10-20T00:00:00+08:00"));

  const personal = personalCommissionSummary(ledger, OWNER.id, "2026-10");
  assert.equal(personal.personalAmount, 5.2);
  assert.equal(personal.regularPersonalAmount, 0.2);
  assert.equal(personal.newCustomerAmount, 5);
  assert.ok(!Object.prototype.hasOwnProperty.call(personal, "teamPoolTotal"));

  const monthly = monthlyCommissionSummary(ledger, [OWNER, ADMIN], "2026-10");
  assert.equal(monthly.personalTotal, 5.2);
  assert.equal(monthly.teamPoolTotal, 0.3);
  assert.equal(monthly.rows.find((row) => row.personnelId === OWNER.id)?.personalAmount, 5.2);
});

test("the public team pool still accrues when the individual owner is unresolved", () => {
  const subject = order("owner-unresolved", {
    contactPersonnelId: "missing-person",
    contactPerson: "同名但不可猜",
    payments: [payment("owner-unresolved-payment", 100, "2026-10-08 09:00:00")],
  });
  const result = reconcileCommissionLedger(state([subject]), [], new Date("2026-10-20T00:00:00+08:00"));

  assert.deepEqual(entryTotals(result.ledger, { month: "2026-10", orderId: subject.id }), {
    baseCents: 10000,
    regularPersonalCents: 0,
    newCustomerCents: 0,
    teamPoolCents: 30,
  });
  assert.match(JSON.stringify(result.diagnostics), /ORDER_OWNER_UNRESOLVED/);
  const monthly = monthlyCommissionSummary(result.ledger, [OWNER, ADMIN], "2026-10");
  assert.equal(monthly.personalTotal, 0);
  assert.equal(monthly.teamPoolTotal, 0.3);
  assert.deepEqual(monthly.rows, []);
});
