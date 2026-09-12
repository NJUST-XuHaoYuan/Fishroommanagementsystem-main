import assert from "node:assert/strict";
import test from "node:test";
import { batchOrderErrorMessage, batchOrderIdentityKey, batchOrderMoney, batchOrderRequestKey, isBatchOrderContextCurrent, shouldRestoreBatchOrderFocus } from "./batchOrderDialog.ts";

const request = { batchId: "batch-1", siteId: "nanjing", orderId: "order-1" };
const opening = { identityKey: batchOrderIdentityKey({ username: "admin", role: "admin" }), activeSiteId: "nanjing" };

test("order requests are isolated by batch, source site and order without ambiguous separators", () => {
  const key = batchOrderRequestKey(request);
  for (const changed of [{ ...request, batchId: "batch-2" }, { ...request, siteId: "jiangyin" }, { ...request, orderId: "order-2" }]) {
    assert.notEqual(batchOrderRequestKey(changed), key);
  }
  assert.notEqual(batchOrderRequestKey({ batchId: "a|b", siteId: "c", orderId: "d" }), batchOrderRequestKey({ batchId: "a", siteId: "b|c", orderId: "d" }));
});

test("an order dialog remains on its opening batch site and cannot reuse data after scope changes", () => {
  assert.equal(isBatchOrderContextCurrent(request, opening, opening), true);
  assert.equal(isBatchOrderContextCurrent(request, opening, { ...opening, activeSiteId: "jiangyin" }), false);
  assert.equal(isBatchOrderContextCurrent({ ...request, siteId: "jiangyin" }, opening, opening), false);
  assert.equal(isBatchOrderContextCurrent({ ...request, siteId: "all" }, opening, { ...opening, activeSiteId: "all" }), false);
  assert.equal(isBatchOrderContextCurrent(request, opening, { ...opening, identityKey: "another-account" }), false);
  assert.equal(isBatchOrderContextCurrent(request, opening, { ...opening, identityKey: "" }), false);
});

test("identity ignores site ordering but changes for user, role, visibility or disabled account", () => {
  const user = { username: "staff", role: "staff", visibleSiteIds: ["nanjing", "jiangyin"] };
  const key = batchOrderIdentityKey(user);
  assert.equal(batchOrderIdentityKey({ ...user, visibleSiteIds: ["jiangyin", "nanjing"] }), key);
  for (const changed of [{ ...user, username: "other" }, { ...user, role: "admin" }, { ...user, visibleSiteIds: ["nanjing"] }]) {
    assert.notEqual(batchOrderIdentityKey(changed), key);
  }
  assert.equal(batchOrderIdentityKey(null), "");
  assert.equal(batchOrderIdentityKey({ ...user, account: { accountEnabled: false } }), "");
});

test("missing order amounts never become zero and zero remains a real amount", () => {
  for (const amount of [null, undefined, NaN, Infinity]) assert.equal(batchOrderMoney(amount), "未记录");
  assert.equal(batchOrderMoney(0), "¥0.00");
  assert.equal(batchOrderMoney(1234.5), "¥1,234.50");
});

test("network failures give a retry instruction while authorized API errors retain their explanation", () => {
  assert.equal(batchOrderErrorMessage(new TypeError("Failed to fetch")), "网络连接失败，请检查网络后重试");
  assert.equal(batchOrderErrorMessage(new Error("订单不存在或无权查看")), "订单不存在或无权查看");
  assert.equal(batchOrderErrorMessage(null), "订单加载失败，请重试");
});

test("closing restores focus only to a connected opener in the same identity and batch site", () => {
  assert.equal(shouldRestoreBatchOrderFocus(request, opening, opening, true), true);
  assert.equal(shouldRestoreBatchOrderFocus(request, opening, opening, false), false);
  assert.equal(shouldRestoreBatchOrderFocus(request, opening, { ...opening, identityKey: "another-user" }, true), false);
  assert.equal(shouldRestoreBatchOrderFocus(request, opening, { ...opening, identityKey: "" }, true), false);
  assert.equal(shouldRestoreBatchOrderFocus(request, opening, { ...opening, activeSiteId: "jiangyin" }, true), false);
});
