import test from "node:test";
import assert from "node:assert/strict";
import { matchPaymentStatement, parsePaymentStatementCsv } from "./payment-statement-utils.mjs";

test("fully paid proof-backed orders remain discoverable but only a unique transaction reference can auto-reuse the receipt", () => {
  const statement = { channel: "wechat", account: "已核验账户", amount: 600, direction: "income", occurredAt: "2026-11-18 12:00:00",
    externalTransactionNo: "BANK-REF-001", notes: "SO-PAID-PROOF 鱼款" };
  const receipt = { id: "proof-receipt", amount: 600, channel: "wechat", account: "已核验账户", externalTransactionNo: "" };
  const order = { id: "paid-proof-order", orderNo: "SO-PAID-PROOF", paymentChannel: "wechat", paymentAccount: "已核验账户",
    receivable: 600, matchingOutstanding: 0, status: "completed", proofReceipts: [receipt] };
  const manual = matchPaymentStatement(statement, [order]);
  assert.equal(manual.matchedOrderId, ""); assert.equal(manual.candidates.length, 1);
  assert.equal(manual.candidates[0].requiresPaymentSelection, true);
  assert.deepEqual(manual.candidates[0].existingPaymentOptions.map(payment => payment.id), [receipt.id]);
  const exact = matchPaymentStatement(statement, [{ ...order, proofReceipts: [{ ...receipt, externalTransactionNo: "BANK-REF-001" }] }]);
  assert.equal(exact.matchedOrderId, order.id); assert.equal(exact.candidates[0].requiresPaymentSelection, false);
  const ambiguous = matchPaymentStatement(statement, [{ ...order, proofReceipts: [
    { ...receipt, externalTransactionNo: "BANK-REF-001" }, { ...receipt, id: "another-proof-receipt", externalTransactionNo: "BANK-REF-001" },
  ] }]);
  assert.equal(ambiguous.matchedOrderId, ""); assert.equal(ambiguous.candidates[0].requiresPaymentSelection, true);
});

test("parses common WeChat and bank statement columns", () => {
  const csv = [
    "交易时间,交易单号,收支类型,交易金额,付款方,备注",
    "2026-08-06 10:12:00,WX-1001,收入,600.00,张三,鱼款",
    "2026-08-06 11:20:00,WX-1002,支出,100.00,李四,退款",
  ].join("\n");
  const parsed = parsePaymentStatementCsv(csv, {
    channel: "wechat",
    account: "微信经营账户",
    paymentMethodId: "pm-wechat",
    paymentMethodName: "微信",
  });

  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.totals, { income: 600, expense: 100 });
  assert.equal(parsed.records[0].externalTransactionNo, "WX-1001");
  assert.equal(parsed.records[0].direction, "income");
  assert.equal(parsed.records[1].direction, "expense");
});

test("finds the statement header after export instructions", () => {
  const csv = [
    "微信支付账单明细",
    "导出时间,2026-08-06 12:00:00",
    "交易时间,交易单号,收支类型,交易金额,付款方",
    "2026-08-06 10:12:00,WX-1003,收入,88.00,王五",
  ].join("\n");
  const parsed = parsePaymentStatementCsv(csv, {
    channel: "wechat",
    account: "微信经营账户",
    paymentMethodId: "pm-wechat",
    paymentMethodName: "微信",
  });

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].rowNumber, 4);
  assert.equal(parsed.records[0].amount, 88);
});

test("automatically matches one unambiguous receipt", () => {
  const result = matchPaymentStatement({
    channel: "wechat",
    account: "微信经营账户",
    amount: 600,
    direction: "income",
    occurredAt: "2026-08-06 10:12:00",
    payerName: "张三",
  }, [{
    id: "order-1",
    orderNo: "SO-2026-1800",
    customerName: "张三",
    contactPerson: "销售甲",
    paymentChannel: "wechat",
    paymentAccount: "微信经营账户",
    receivable: 600,
    matchingOutstanding: 600,
    date: "2026-08-05",
    status: "pending",
  }]);

  assert.equal(result.matchedOrderId, "order-1");
  assert.match(result.reason, /金额等于待收余额/);
});

test("keeps equal-amount orders for manual claiming", () => {
  const orders = ["order-1", "order-2"].map((id, index) => ({
    id,
    orderNo: `SO-2026-18${index + 1}0`,
    customerName: `客户${index + 1}`,
    contactPerson: `销售${index + 1}`,
    paymentChannel: "alipay",
    paymentAccount: "支付宝经营账户",
    receivable: 500,
    matchingOutstanding: 500,
    date: "2026-08-05",
    status: "pending",
  }));
  const result = matchPaymentStatement({
    channel: "alipay",
    account: "支付宝经营账户",
    amount: 500,
    direction: "income",
    occurredAt: "2026-08-06 10:12:00",
    payerName: "",
  }, orders);

  assert.equal(result.matchedOrderId, "");
  assert.equal(result.candidates.length, 2);
  assert.match(result.reason, /需要负责人或财务确认/);
});

test("order number in statement note wins an otherwise ambiguous match", () => {
  const result = matchPaymentStatement({
    channel: "bank",
    account: "农行 1234",
    amount: 800,
    direction: "income",
    occurredAt: "2026-08-06 10:12:00",
    notes: "货款 SO-2026-1802",
  }, [
    { id: "a", orderNo: "SO-2026-1801", paymentChannel: "bank", paymentAccount: "农行 1234", receivable: 800, matchingOutstanding: 800, date: "2026-08-05" },
    { id: "b", orderNo: "SO-2026-1802", paymentChannel: "bank", paymentAccount: "农行 1234", receivable: 800, matchingOutstanding: 800, date: "2026-08-05" },
  ]);

  assert.equal(result.matchedOrderId, "b");
  assert.match(result.reason, /账单备注含订单号/);
});

test("does not auto-match the full receivable after a partial receipt", () => {
  const result = matchPaymentStatement({
    channel: "bank",
    account: "农行 1234",
    amount: 800,
    direction: "income",
    occurredAt: "2026-08-06 10:12:00",
  }, [{
    id: "partially-paid",
    orderNo: "SO-2026-1804",
    paymentChannel: "bank",
    paymentAccount: "农行 1234",
    receivable: 800,
    matchingOutstanding: 200,
    date: "2026-08-05",
  }]);

  assert.equal(result.matchedOrderId, "");
  assert.equal(result.candidates.length, 0);
});

test("matches one imported expense to an existing pending refund", () => {
  const result = matchPaymentStatement({
    channel: "wechat",
    account: "微信经营账户",
    amount: 120,
    direction: "expense",
    occurredAt: "2026-08-06 12:00:00",
  }, [{
    id: "order-refund",
    orderNo: "SO-2026-1803",
    customerName: "退款客户",
    contactPerson: "销售甲",
    paymentChannel: "wechat",
    paymentAccount: "微信经营账户",
    receivable: 600,
    pendingRefunds: [{ id: "refund-1", amount: 120 }],
  }]);

  assert.equal(result.matchedOrderId, "order-refund");
  assert.match(result.reason, /待核销退款/);
});
