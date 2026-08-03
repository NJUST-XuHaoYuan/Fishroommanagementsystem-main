import assert from "node:assert/strict";
import test from "node:test";
import {
  addApprovalResultNotification,
  ensureApprovalNotifications,
  ensureCreditSaleNotification,
  ensureCreditSaleNotifications,
  markNotificationsRead,
  notificationsForRecipient,
  resolveCreditSaleNotifications,
  resolveApprovalNotifications,
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

test("credit-sale approval fans out to the selected administrators only", () => {
  const input = {
    creditSaleRequestId: "credit-1",
    notificationIds: ["credit-notice-a", "credit-notice-b"],
    orderId: "order-1",
    orderNo: "SO-2026-001",
    requiredOutstandingAmount: 300,
    createdBy: "sales-a",
    createdByName: "销售A",
    recipients: [
      { username: "admin-a", name: "管理员A" },
      { username: "admin-b", name: "管理员B" },
    ],
  };
  const first = ensureCreditSaleNotifications([], input);
  const duplicate = ensureCreditSaleNotifications(first.notifications, {
    ...input,
    creditSaleRequestId: "credit-2",
    notificationIds: ["credit-notice-c", "credit-notice-d"],
  });
  assert.equal(first.notificationsCreated.length, 2);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(
    duplicate.notifications.map((notification) => notification.recipientUsername).sort(),
    ["admin-a", "admin-b"]
  );
  assert.equal(notificationsForRecipient(first.notifications, "sales-a").length, 0);
});

test("one selected administrator resolves every credit-sale approval copy", () => {
  const pending = ensureCreditSaleNotifications([], {
    creditSaleRequestId: "credit-3",
    orderId: "order-3",
    orderNo: "SO-2026-003",
    requiredOutstandingAmount: 500,
    recipients: [{ username: "admin-a" }, { username: "admin-b" }],
  });
  const resolved = resolveCreditSaleNotifications(
    pending.notifications,
    "order-3",
    "credit_confirmed",
    "admin-a",
    "2026-08-04T10:00:00.000Z",
    "管理员A",
    "老客户约定后付",
    "credit-3"
  );
  assert.equal(resolved.changed, true);
  assert.ok(resolved.notifications.every((notification) => notification.status === "completed"));
  assert.ok(resolved.notifications.every((notification) => notification.resolvedByName === "管理员A"));
  assert.ok(resolved.notifications.every((notification) => notification.resolutionNote === "老客户约定后付"));
  assert.ok(resolved.notifications.find((notification) => notification.recipientUsername === "admin-a")?.readAt);
  assert.equal(
    resolved.notifications.find((notification) => notification.recipientUsername === "admin-b")?.readAt,
    ""
  );
});

test("stock approval notifications fan out once to every active admin", () => {
  const input = {
    approvalRequestId: "approval-1",
    approvalAction: "delete_stock",
    title: "库存删除待审批",
    message: "销售A申请删除2条库存。",
    createdBy: "sales-a",
    createdByName: "销售A",
    recipients: [
      { username: "admin", name: "管理员" },
      { username: "finance-admin", name: "财务管理员" },
    ],
    notificationIds: ["notice-a", "notice-b"],
  };
  const first = ensureApprovalNotifications([], input);
  const second = ensureApprovalNotifications(first.notifications, input);
  assert.equal(first.notificationsCreated.length, 2);
  assert.equal(second.changed, false);
  assert.equal(second.notifications.length, 2);
  assert.deepEqual(
    second.notifications.map((notification) => notification.recipientUsername).sort(),
    ["admin", "finance-admin"]
  );
});

test("one admin decision resolves every copy of an approval notification", () => {
  const pending = ensureApprovalNotifications([], {
    approvalRequestId: "approval-2",
    recipients: [{ username: "admin" }, { username: "admin-b" }],
  });
  const resolved = resolveApprovalNotifications(pending.notifications, "approval-2", {
    resolution: "approved",
    resolvedBy: "admin",
    resolvedByName: "管理员",
    resolvedAt: "2026-08-03T14:00:00.000Z",
  });
  assert.equal(resolved.changed, true);
  assert.ok(resolved.notifications.every((notification) => notification.status === "completed"));
  assert.ok(resolved.notifications.every((notification) => notification.resolution === "approved"));
});

test("approval result is visible only to the requester", () => {
  const result = addApprovalResultNotification([], {
    id: "notice-result",
    approvalRequestId: "approval-3",
    resolution: "rejected",
    recipientUsername: "sales-a",
    recipientName: "销售A",
    createdBy: "admin",
    createdByName: "管理员",
  });
  assert.equal(notificationsForRecipient(result.notifications, "sales-a").length, 1);
  assert.equal(notificationsForRecipient(result.notifications, "sales-b").length, 0);
});
