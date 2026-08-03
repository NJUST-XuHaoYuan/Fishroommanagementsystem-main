import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureCreditSaleNotification,
  markNotificationsRead,
  notificationsForRecipient,
  resolveCreditSaleNotifications,
} from "./station-notifications.mjs";

const request = {
  id: "notice-1",
  orderId: "order-1",
  orderNo: "SO-2026-001",
  siteId: "nanjing",
  recipientUsername: "sales-a",
  recipientName: "销售A",
  requiredOutstandingAmount: 300,
  createdAt: "2026-08-03T12:00:00.000Z",
  createdBy: "warehouse",
};

test("credit-sale notifications deduplicate an unchanged shipping block", () => {
  const first = ensureCreditSaleNotification([], request);
  const second = ensureCreditSaleNotification(first.notifications, { ...request, id: "notice-2" });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.notifications.length, 1);
});

test("an increased outstanding amount refreshes the pending notification", () => {
  const first = ensureCreditSaleNotification([], request);
  const second = ensureCreditSaleNotification(first.notifications, {
    ...request,
    id: "notice-2",
    requiredOutstandingAmount: 450,
    createdAt: "2026-08-03T13:00:00.000Z",
  });
  assert.equal(second.changed, true);
  assert.equal(second.notification.requiredOutstandingAmount, 450);
  assert.equal(second.notification.readAt, "");
});

test("only the recipient can read their messages", () => {
  const first = ensureCreditSaleNotification([], request);
  assert.equal(notificationsForRecipient(first.notifications, "sales-a").length, 1);
  assert.equal(notificationsForRecipient(first.notifications, "sales-b").length, 0);
  assert.equal(markNotificationsRead(first.notifications, "sales-b").changed, false);
  const read = markNotificationsRead(first.notifications, "sales-a", ["notice-1"]);
  assert.equal(read.changed, true);
  assert.ok(read.notifications[0].readAt);
});

test("credit confirmation resolves the pending notification", () => {
  const first = ensureCreditSaleNotification([], request);
  const resolved = resolveCreditSaleNotifications(
    first.notifications,
    "order-1",
    "credit_confirmed",
    "sales-a",
    "2026-08-03T13:00:00.000Z"
  );
  assert.equal(resolved.changed, true);
  assert.equal(resolved.notifications[0].status, "completed");
  assert.equal(resolved.notifications[0].resolution, "credit_confirmed");
});
