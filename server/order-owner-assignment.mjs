import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";
import { resolveNewCustomerOrderOwner } from "./new-customer-approval.mjs";

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
const sameAccount = (left, right) => Boolean(text(left?.id) && text(left?.id) === text(right?.id) && text(left?.username) === text(right?.username));
const ownerFields = (person) => ({ contactPersonnelId: text(person.id), contactPerson: text(person.name || person.username) });
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function assignmentTargetBlockedReason(state, order, person, canUpdateOrder = (account) => account.accessRole === "admin" || account.permissions?.orders?.update === true) {
  if (!person || !isPersonnelAccountEnabled(person)) return "拟接收负责人账号不存在、已停用或已离职";
  const matches = list(state.personnel).filter((item) => text(item.id) === text(person.id) || text(item.username) === text(person.username));
  if (matches.length !== 1) return "拟接收负责人账号不唯一，请先核对人员资料";
  if (person.accessRole !== "admin" && !list(person.visibleSiteIds).includes(text(order.siteId))) return "拟接收负责人没有订单所属场地的访问权限";
  if (!canUpdateOrder(person)) return "拟接收负责人没有订单修改权限";
  return "";
}

function currentAccount(state, account) {
  const matches = list(state.personnel).filter((person) => text(person.id) === text(account?.id) && text(person.username) === text(account?.username));
  if (matches.length !== 1 || !isPersonnelAccountEnabled(matches[0])) fail(403, "ORDER_OWNER_ACCOUNT_REQUIRED", "当前登录账号未关联唯一启用人员档案，请联系管理员");
  return matches[0];
}

export function assertOrderOwnerAssignmentUnchanged(previous, next) {
  if (["contactPersonnelId", "contactPerson"].some((key) => text(previous?.[key]) !== text(next?.[key])) ||
      canonical(previous?.ownerAssignment ?? null) !== canonical(next?.ownerAssignment ?? null)) {
    fail(409, "ORDER_OWNER_ASSIGNMENT_PROTECTED", "订单负责人必须通过转交确认流程修改，不能直接改写负责人或确认状态");
  }
}

export function planOrderOwnerAssignment(state, currentOrder, nextOrder, account, body, { requestId, now = new Date().toISOString(), canUpdateOrder } = {}) {
  const actor = currentAccount(state, account);
  const requestedOwner = resolveNewCustomerOrderOwner(state.personnel, nextOrder);
  const currentOwner = currentOrder ? resolveNewCustomerOrderOwner(state.personnel, currentOrder) : actor;
  const effectiveOwner = currentOrder ? {
    contactPersonnelId: currentOrder.contactPersonnelId,
    contactPerson: currentOrder.contactPerson,
  } : ownerFields(actor);
  const sameOwner = currentOrder ? (currentOwner && requestedOwner && text(currentOwner.id) === text(requestedOwner.id)) ||
    (text(currentOrder.contactPersonnelId) === text(nextOrder.contactPersonnelId) && text(currentOrder.contactPerson) === text(nextOrder.contactPerson))
    : sameAccount(actor, requestedOwner);
  if (sameOwner) return { order: { ...nextOrder, ...effectiveOwner }, requested: false };
  if (currentOrder && ["completed", "cancelled"].includes(currentOrder.status)) fail(409, "ORDER_OWNER_ORDER_CLOSED", "已完成或已取消的订单不能转交负责人");
  if (currentOrder && (typeof body.expectedContactPersonnelId !== "string" || body.expectedContactPersonnelId !== text(currentOrder.contactPersonnelId) ||
      typeof body.expectedOwnerAssignmentRequestId !== "string" || body.expectedOwnerAssignmentRequestId !== text(currentOrder.ownerAssignment?.requestId))) {
    fail(409, "ORDER_OWNER_ASSIGNMENT_CONFLICT", "订单负责人或转交申请已变化，请刷新后重新选择");
  }
  const blocked = assignmentTargetBlockedReason(state, nextOrder, requestedOwner, canUpdateOrder);
  if (blocked) fail(409, "ORDER_OWNER_TARGET_UNAVAILABLE", blocked);
  if (currentOrder?.ownerAssignment?.status === "pending") {
    if (currentOrder.ownerAssignment.toPersonnelId === requestedOwner.id && currentOrder.ownerAssignment.toUsername === requestedOwner.username) {
      return { order: { ...nextOrder, ...effectiveOwner, ownerAssignment: currentOrder.ownerAssignment }, requested: false };
    }
    fail(409, "ORDER_OWNER_ASSIGNMENT_PENDING", "已有待确认负责人，请先撤回原申请后重新选择");
  }
  if (!requestId) throw new Error("负责人转交申请缺少编号");
  const assignment = {
    requestId, status: "pending", version: Number(currentOrder?.ownerAssignment?.version || 0) + 1, requestedBy: text(actor.username), requestedByPersonnelId: text(actor.id),
    requestedByName: text(actor.name || actor.username), requestedAt: now,
    fromPersonnelId: text(effectiveOwner.contactPersonnelId), fromName: text(effectiveOwner.contactPerson),
    toPersonnelId: text(requestedOwner.id), toUsername: text(requestedOwner.username), toName: text(requestedOwner.name || requestedOwner.username),
  };
  return { order: { ...nextOrder, ...effectiveOwner, ownerAssignment: assignment }, requested: true };
}

export function orderOwnerAssignmentDetail(state, order, account, { canUpdateOrder } = {}) {
  const assignment = order.ownerAssignment ?? null;
  const target = list(state.personnel).find((person) => text(person.id) === text(assignment?.toPersonnelId) && text(person.username) === text(assignment?.toUsername));
  const recipient = sameAccount(account, target);
  const pending = assignment?.status === "pending";
  const ownerUnchanged = text(assignment?.fromPersonnelId) ? text(order.contactPersonnelId) === text(assignment.fromPersonnelId)
    : !text(order.contactPersonnelId) && text(order.contactPerson) === text(assignment?.fromName);
  const blockedReason = !pending ? "申请已处理或不存在" : ["completed", "cancelled"].includes(order.status) ? "订单已完成或已取消，不能接受转交"
    : !ownerUnchanged ? "订单负责人已变化，请撤回后重新申请"
    : assignmentTargetBlockedReason(state, order, target, canUpdateOrder);
  const actorEnabled = isPersonnelAccountEnabled(account);
  return {
    orderId: text(order.id), assignment, ownerAssignment: assignment,
    currentOwner: { personnelId: text(order.contactPersonnelId), name: text(order.contactPerson) },
    canAccept: actorEnabled && recipient && pending && !blockedReason,
    canReject: actorEnabled && recipient && pending,
    canCancel: actorEnabled && pending && (account.accessRole === "admin" ||
      (text(assignment.requestedByPersonnelId) === text(account.id) && text(assignment.requestedBy) === text(account.username))),
    approvalResetRequired: { newCustomer: ["pending", "approved"].includes(order.newCustomerApproval?.status), creditSale: Boolean(order.creditSaleApproval) },
    blockedReason,
  };
}

export function planOrderOwnerAssignmentDecision(state, order, account, body, { now = new Date().toISOString(), canUpdateOrder } = {}) {
  const actor = currentAccount(state, account);
  if (!["accept", "reject", "cancel"].includes(body.decision)) fail(400, "ORDER_OWNER_DECISION_INVALID", "请选择接受、拒绝或撤回");
  const assignment = order.ownerAssignment;
  if (!text(body.requestId) || assignment?.requestId !== body.requestId) fail(409, "ORDER_OWNER_ASSIGNMENT_CONFLICT", "负责人转交申请已变化，请刷新后重试");
  const recipient = text(assignment.toPersonnelId) === text(actor.id) && text(assignment.toUsername) === text(actor.username);
  const cancelActor = actor.accessRole === "admin" || (text(assignment.requestedByPersonnelId) === text(actor.id) && text(assignment.requestedBy) === text(actor.username));
  if (body.decision === "cancel" ? !cancelActor : !recipient) fail(403, "ORDER_OWNER_DECISION_FORBIDDEN", body.decision === "cancel" ? "仅申请人或管理员可以撤回转交" : "仅拟接收负责人本人可以接受或拒绝，管理员不能代确认");
  const status = { accept: "accepted", reject: "rejected", cancel: "cancelled" }[body.decision];
  if (assignment.status === status) return { order, unchanged: true };
  if (assignment.status !== "pending") fail(409, "ORDER_OWNER_ASSIGNMENT_CONFLICT", "负责人转交申请已经处理，请勿重复操作");
  const note = text(body.note);
  if (note.length > 1000) fail(400, "ORDER_OWNER_NOTE_TOO_LONG", "处理说明最多 1000 字");
  if (status === "accepted") {
    const detail = orderOwnerAssignmentDetail(state, order, actor, { canUpdateOrder });
    if (!detail.canAccept) fail(409, "ORDER_OWNER_TARGET_UNAVAILABLE", detail.blockedReason || "当前不能接受负责人转交");
  }
  const nextOrder = { ...order, ownerAssignment: { ...assignment, status, version: Number(assignment.version || 0) + 1, resolvedAt: now, resolvedBy: text(actor.username), resolvedByName: text(actor.name || actor.username), note } };
  if (status === "accepted") {
    Object.assign(nextOrder, ownerFields(actor));
    delete nextOrder.creditSaleApproval;
    if (["pending", "approved"].includes(order.newCustomerApproval?.status)) nextOrder.newCustomerApproval = {
      ...order.newCustomerApproval, status: "rejected", version: Number(order.newCustomerApproval.version || 0) + 1,
      invalidatedAt: now, invalidatedBy: actor.username, invalidatedByPersonnelId: actor.id,
      invalidatedReview: Object.fromEntries(["status", "version", "reviewedAt", "reviewedBy", "reviewedByName", "reviewNote"]
        .filter((key) => Object.hasOwn(order.newCustomerApproval, key)).map((key) => [key, order.newCustomerApproval[key]])),
      reviewedAt: now, reviewedBy: "system", reviewedByName: "系统（负责人转交失效）",
      reviewNote: "订单负责人已转交，原新客申请失效；新负责人须重新上传自己的证明并申请",
    };
  }
  return { order: nextOrder, unchanged: false };
}

export function ownerAssignmentNotifications(notifications, order, { now, actor, createId }) {
  const current = list(notifications);
  const assignment = order.ownerAssignment;
  if (!assignment) return current;
  if (assignment.status === "pending") {
    const added = [
      { username: assignment.toUsername, name: assignment.toName, role: "assignee" },
      { username: assignment.requestedBy, name: assignment.requestedByName, role: "requester" },
    ].filter((recipient) => !current.some((notice) => notice.type === "order_owner_assignment" && notice.ownerAssignmentRequestId === assignment.requestId && notice.notificationRole === recipient.role && notice.recipientUsername === recipient.username))
      .map((recipient) => ({ id: createId(), type: "order_owner_assignment", status: "pending", notificationRole: recipient.role,
        ownerAssignmentRequestId: assignment.requestId, orderId: order.id, orderNo: order.orderNo, siteId: order.siteId,
        title: `订单 ${order.orderNo} 负责人待确认`, message: `${assignment.requestedByName} 申请将订单负责人由 ${assignment.fromName || "原负责人"} 转交给 ${assignment.toName}；接受前原负责人不变。`,
        createdAt: now, updatedAt: now, createdBy: assignment.requestedBy, createdByName: assignment.requestedByName,
        recipientUsername: recipient.username, recipientName: recipient.name, readAt: "" }));
    return [...added, ...current];
  }
  const label = { accepted: "已接受", rejected: "已拒绝", cancelled: "已撤回" }[assignment.status] || "已关闭";
  return current.map((notice) => notice.type === "order_owner_assignment" && notice.ownerAssignmentRequestId === assignment.requestId && notice.status === "pending" ? {
    ...notice, status: "completed", resolution: assignment.status, title: `订单 ${order.orderNo} 负责人转交${label}`,
    message: `负责人转交${label}，当前负责人：${order.contactPerson || "未填写"}。${assignment.note || ""}`,
    updatedAt: now, resolvedAt: now, resolvedBy: actor.username, resolvedByName: actor.name || actor.username,
    resolutionNote: assignment.note || "", readAt: notice.notificationRole === "requester" ? "" : now,
  } : notice);
}

// All normal order mutations run through the commission transaction. Close
// requests there as well, so completing/deleting an order never leaves a live task.
export function closeEndedOrderOwnerAssignments(before, after, now = new Date().toISOString()) {
  let notifications = list(after.notifications);
  let changed = false;
  const currentIds = new Set(list(after.orders).map((order) => text(order.id)));
  const close = (order, deleted = false) => {
    if (order.ownerAssignment?.status !== "pending" || (!deleted && !["completed", "cancelled"].includes(order.status))) return order;
    changed = true;
    const closed = { ...order, ownerAssignment: { ...order.ownerAssignment, status: "cancelled",
      version: Number(order.ownerAssignment.version || 0) + 1, resolvedAt: now, resolvedBy: "system", resolvedByName: "系统",
      note: deleted ? "订单已删除，负责人转交自动关闭" : "订单已完成或取消，负责人转交自动关闭" } };
    notifications = ownerAssignmentNotifications(notifications, closed, { now, actor: { username: "system", name: "系统" } });
    return closed;
  };
  const orders = list(after.orders).map((order) => close(order));
  list(before.orders).filter((order) => !currentIds.has(text(order.id))).forEach((order) => close(order, true));
  return changed ? { ...after, orders, notifications } : after;
}
