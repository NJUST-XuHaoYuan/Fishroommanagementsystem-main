import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestCoordinator,
  profileApprovalDetailsReady,
  profileAttachmentChangeKind,
} from "./notificationCenter.ts";

test("a newer detail request aborts and invalidates every older request", () => {
  const coordinator = createLatestRequestCoordinator();
  const first = coordinator.begin("notification-a");
  const second = coordinator.begin("notification-b");

  assert.equal(first.signal.aborted, true);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
});

test("closing detail invalidates the active request", () => {
  const coordinator = createLatestRequestCoordinator();
  const request = coordinator.begin("notification-a");

  coordinator.cancel();

  assert.equal(request.signal.aborted, true);
  assert.equal(coordinator.isCurrent(request), false);
});

test("approval is ready only for the selected notification with non-empty loaded details", () => {
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "notification-a",
    profileChanges: [{ field: "phone" }],
  }), true);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-b",
    loadedNotificationId: "notification-a",
    profileChanges: [{ field: "phone" }],
  }), false);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "notification-a",
    profileChanges: [],
  }), false);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "",
    profileChanges: [{ field: "phone" }],
  }), false);
});

test("attachment changes distinguish add, replace, remove and unchanged", () => {
  assert.equal(profileAttachmentChangeKind(null, { id: "new" }), "added");
  assert.equal(profileAttachmentChangeKind({ id: "old" }, { id: "new" }), "replaced");
  assert.equal(profileAttachmentChangeKind({ id: "old" }, null), "removed");
  assert.equal(profileAttachmentChangeKind({ id: "same" }, { id: "same" }), "unchanged");
});
