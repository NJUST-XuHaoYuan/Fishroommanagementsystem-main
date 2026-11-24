import test from "node:test";
import assert from "node:assert/strict";
import { orderCashierPaymentMethods, resolveOrderCashierMethod } from "./order-cashier-rules.mjs";
import { matchPaymentStatement } from "./payment-statement-utils.mjs";

const settings = { paymentMethods: [
  { id: "wechat-a", name: "微信A", channel: "wechat", account: "A", enabled: true },
  { id: "wechat-b", name: "微信B", channel: "wechat", account: "B", enabled: true },
  { id: "cash-disabled", name: "停用现金", channel: "cash", account: "C", enabled: false },
  { id: "douyin", name: "抖音", channel: "douyin", account: "D", enabled: true },
] };

test("cashier keeps each selected configured account and rejects missing or disabled methods", () => {
  const order = { orderFormSchemaVersion: 4, source: "私域线上" };
  assert.deepEqual(orderCashierPaymentMethods(settings, order).map(m => m.id), ["wechat-a", "wechat-b"]);
  assert.throws(() => resolveOrderCashierMethod(settings, order, {}), /请选择/);
  assert.throws(() => resolveOrderCashierMethod(settings, order, { paymentMethodId: "cash-disabled" }), /未启用/);
  assert.throws(() => resolveOrderCashierMethod(settings, order, { paymentMethodId: "douyin" }), /来源不一致/);
  assert.equal(resolveOrderCashierMethod(settings, order, { paymentMethodId: "wechat-b", channel: "cash", account: "forged" }).account, "B");
});

test("cashier statement amount alone suggests a candidate without automatically attributing a receipt", () => {
  const order = { id: "v4", orderNo: "SO-CASHIER-1", orderFormSchemaVersion: 4, source: "私域线上", receivable: 1000, matchingOutstanding: 1000, date: "2026-11-20", customerName: "synthetic" };
  const statement = { direction: "income", channel: "wechat", account: "A", amount: 1000, occurredAt: "2026-11-20", payerName: "synthetic" };
  const suggested = matchPaymentStatement(statement, [order]); assert.equal(suggested.matchedOrderId, ""); assert.equal(suggested.candidates[0].orderId, "v4");
  assert.equal(matchPaymentStatement({ ...statement, notes: "SO-CASHIER-1" }, [order]).matchedOrderId, "v4");
  assert.equal(matchPaymentStatement({ ...statement, channel: "douyin", notes: "SO-CASHIER-1" }, [order]).candidates.length, 0);
});

test("cashier expense matches the actual refund account, not a blank order account", () => {
  const order = { id: "v4", orderFormSchemaVersion: 4, source: "私域线上", pendingRefunds: [{ id: "r1", amount: 10, channel: "wechat", account: "B" }] };
  const statement = { direction: "expense", channel: "wechat", account: "A", amount: 10 };
  assert.equal(matchPaymentStatement(statement, [order]).matchedOrderId, "");
  assert.equal(matchPaymentStatement({ ...statement, account: "B" }, [order]).matchedOrderId, "v4");
});
