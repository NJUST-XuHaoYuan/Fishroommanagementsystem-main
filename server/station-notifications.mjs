const MAX_STATION_NOTIFICATIONS = 5000;

function normalizedMoney(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.max(0, Number(amount.toFixed(2))) : 0;
}

function notificationMessage(orderNo, amount) {
  return `订单 ${orderNo} 发货前仍有 ¥${amount.toFixed(2)} 未经财务核销。确需先发货，请确认赊销。`;
}

function sortedNotifications(notifications) {
  return [...notifications]
    .sort((left, right) =>
      String(right?.updatedAt ?? right?.createdAt ?? "")
        .localeCompare(String(left?.updatedAt ?? left?.createdAt ?? ""))
    )
    .slice(0, MAX_STATION_NOTIFICATIONS);
}

function normalizeCompletedNotificationReadState(notification) {
  if (
    !notification ||
    notification.status !== "completed" ||
    notification.readAt ||
    notification.notificationRole === "requester" ||
    !["credit_sale_confirmation", "stock_approval"].includes(notification.type)
  ) return notification;
  return {
    ...notification,
    readAt: String(notification.resolvedAt ?? notification.updatedAt ?? notification.createdAt ?? "completed"),
  };
}

export function notificationsForRecipient(notifications = [], username = "") {
  const recipient = String(username ?? "").trim();
  return sortedNotifications((Array.isArray(notifications) ? notifications : []).filter((notification) =>
    String(notification?.recipientUsername ?? "").trim() === recipient
  )).map(normalizeCompletedNotificationReadState);
}

export function ensureCreditSaleNotification(notifications = [], input = {}) {
  const current = Array.isArray(notifications) ? notifications : [];
  const orderId = String(input.orderId ?? "").trim();
  const orderNo = String(input.orderNo ?? "").trim();
  const recipientUsername = String(input.recipientUsername ?? "").trim();
  const recipientName = String(input.recipientName ?? recipientUsername).trim();
  const requiredOutstandingAmount = normalizedMoney(input.requiredOutstandingAmount);
  if (!orderId || !orderNo || !recipientUsername || requiredOutstandingAmount <= 0) {
    throw new Error("无法创建赊销确认站内信");
  }

  const pending = current.find((notification) =>
    notification?.type === "credit_sale_confirmation" &&
    notification?.status === "pending" &&
    String(notification?.orderId ?? "") === orderId &&
    String(notification?.recipientUsername ?? "") === recipientUsername
  );
  const createdAt = String(input.createdAt ?? new Date().toISOString());
  if (pending) {
    if (Math.abs(Number(pending.requiredOutstandingAmount ?? 0) - requiredOutstandingAmount) <= 0.005) {
      return { notifications: current, notification: pending, changed: false };
    }
    const updated = {
      ...pending,
      title: `订单 ${orderNo} 待确认赊销`,
      message: notificationMessage(orderNo, requiredOutstandingAmount),
      requiredOutstandingAmount,
      updatedAt: createdAt,
      createdByName: String(input.createdByName ?? pending.createdByName ?? input.createdBy ?? pending.createdBy ?? "system"),
      readAt: "",
    };
    return {
      notifications: sortedNotifications(current.map((notification) => notification?.id === pending.id ? updated : notification)),
      notification: updated,
      changed: true,
    };
  }

  const reassigned = current.map((notification) =>
    notification?.type === "credit_sale_confirmation" &&
    notification?.status === "pending" &&
    String(notification?.orderId ?? "") === orderId
      ? {
          ...notification,
          status: "completed",
          resolution: "reassigned",
          resolvedAt: createdAt,
          resolvedBy: String(input.createdBy ?? "system"),
          readAt: notification.readAt || createdAt,
        }
      : notification
  );
  const notification = {
    id: String(input.id ?? "").trim(),
    type: "credit_sale_confirmation",
    status: "pending",
    title: `订单 ${orderNo} 待确认赊销`,
    message: notificationMessage(orderNo, requiredOutstandingAmount),
    createdAt,
    createdBy: String(input.createdBy ?? "system"),
    createdByName: String(input.createdByName ?? input.createdBy ?? "system"),
    readAt: "",
    recipientUsername,
    recipientName,
    orderId,
    orderNo,
    siteId: String(input.siteId ?? ""),
    requiredOutstandingAmount,
  };
  if (!notification.id) throw new Error("站内信缺少编号");
  return {
    notifications: sortedNotifications([notification, ...reassigned]),
    notification,
    changed: true,
  };
}

export function ensureCreditSaleNotifications(notifications = [], input = {}) {
  const current = Array.isArray(notifications) ? notifications : [];
  const orderId = String(input.orderId ?? "").trim();
  const orderNo = String(input.orderNo ?? "").trim();
  const requiredOutstandingAmount = normalizedMoney(input.requiredOutstandingAmount);
  const recipients = (Array.isArray(input.recipients) ? input.recipients : [])
    .map((recipient) => ({
      username: String(recipient?.username ?? "").trim(),
      name: String(recipient?.name ?? recipient?.username ?? "").trim(),
    }))
    .filter((recipient, index, all) =>
      recipient.username && all.findIndex((item) => item.username === recipient.username) === index
    );
  if (!orderId || !orderNo || requiredOutstandingAmount <= 0 || recipients.length === 0) {
    throw new Error("无法创建赊销审批站内信");
  }

  const pending = current.filter((notification) =>
    notification?.type === "credit_sale_confirmation" &&
    notification?.status === "pending" &&
    String(notification?.orderId ?? "") === orderId
  );
  const pendingRecipients = [...new Set(pending
    .map((notification) => String(notification?.recipientUsername ?? "").trim())
    .filter(Boolean))].sort();
  const requestedRecipients = recipients.map((recipient) => recipient.username).sort();
  const sameRecipients = pendingRecipients.length === requestedRecipients.length &&
    pendingRecipients.every((username, index) => username === requestedRecipients[index]);
  const sameAmount = pending.length > 0 && pending.every((notification) =>
    Math.abs(Number(notification?.requiredOutstandingAmount ?? 0) - requiredOutstandingAmount) <= 0.005
  );
  if (sameRecipients && sameAmount) {
    return {
      notifications: current,
      notificationsCreated: [],
      notification: pending[0],
      creditSaleRequestId: String(pending[0]?.creditSaleRequestId ?? ""),
      changed: false,
    };
  }

  const createdAt = String(input.createdAt ?? new Date().toISOString());
  const createdBy = String(input.createdBy ?? "system");
  const createdByName = String(input.createdByName ?? input.createdBy ?? "system");
  const creditSaleRequestId = String(input.creditSaleRequestId ?? "").trim();
  if (!creditSaleRequestId) throw new Error("赊销审批申请缺少编号");
  const reassigned = current.map((notification) =>
    notification?.type === "credit_sale_confirmation" &&
    notification?.status === "pending" &&
    String(notification?.orderId ?? "") === orderId
      ? {
          ...notification,
          status: "completed",
          resolution: "reassigned",
          resolvedAt: createdAt,
          resolvedBy: createdBy,
          resolvedByName: createdByName,
          resolutionNote: "审批人已重新选择",
          readAt: notification.readAt || createdAt,
        }
      : notification
  );
  const created = recipients.map((recipient, index) => {
    const notification = {
      id: String(input.notificationIds?.[index] ?? `${creditSaleRequestId}-${recipient.username}`).trim(),
      type: "credit_sale_confirmation",
      status: "pending",
      title: `订单 ${orderNo} 待审批赊销`,
      message: notificationMessage(orderNo, requiredOutstandingAmount),
      createdAt,
      createdBy,
      createdByName,
      readAt: "",
      recipientUsername: recipient.username,
      recipientName: recipient.name,
      creditSaleRequestId,
      orderId,
      orderNo,
      siteId: String(input.siteId ?? ""),
      requiredOutstandingAmount,
    };
    if (!notification.id) throw new Error("赊销审批站内信缺少编号");
    return notification;
  });
  return {
    notifications: sortedNotifications([...created, ...reassigned]),
    notificationsCreated: created,
    notification: created[0],
    creditSaleRequestId,
    changed: true,
  };
}

export function ensureApprovalNotifications(notifications = [], input = {}) {
  const current = Array.isArray(notifications) ? notifications : [];
  const approvalRequestId = String(input.approvalRequestId ?? "").trim();
  const recipients = (Array.isArray(input.recipients) ? input.recipients : [])
    .map((recipient) => ({
      username: String(recipient?.username ?? "").trim(),
      name: String(recipient?.name ?? recipient?.username ?? "").trim(),
    }))
    .filter((recipient, index, all) =>
      recipient.username && all.findIndex((item) => item.username === recipient.username) === index
    );
  if (!approvalRequestId || recipients.length === 0) {
    throw new Error("无法创建库存审批站内信");
  }

  const existingRecipients = new Set(current
    .filter((notification) =>
      notification?.type === "stock_approval" &&
      notification?.status === "pending" &&
      notification?.notificationRole !== "requester" &&
      String(notification?.approvalRequestId ?? "") === approvalRequestId
    )
    .map((notification) => String(notification?.recipientUsername ?? "").trim())
    .filter(Boolean));
  const createdAt = String(input.createdAt ?? new Date().toISOString());
  let next = current;
  const created = [];
  recipients.forEach((recipient, index) => {
    if (existingRecipients.has(recipient.username)) return;
    const notification = {
      id: String(input.notificationIds?.[index] ?? `${approvalRequestId}-${recipient.username}`).trim(),
      type: "stock_approval",
      status: "pending",
      title: String(input.title ?? "库存操作待审批"),
      message: String(input.message ?? "有一项库存操作等待审批。"),
      createdAt,
      createdBy: String(input.createdBy ?? "system"),
      createdByName: String(input.createdByName ?? input.createdBy ?? "system"),
      readAt: "",
      recipientUsername: recipient.username,
      recipientName: recipient.name,
      notificationRole: "approver",
      approvalRequestId,
      approvalAction: String(input.approvalAction ?? "stock_change"),
      siteId: String(input.siteId ?? ""),
    };
    if (!notification.id) throw new Error("库存审批站内信缺少编号");
    created.push(notification);
    next = [notification, ...next];
  });

  const requesterUsername = String(input.requester?.username ?? input.createdBy ?? "").trim();
  const requesterName = String(input.requester?.name ?? input.createdByName ?? requesterUsername).trim();
  const existingRequester = next.find((notification) =>
    notification?.type === "stock_approval" &&
    notification?.notificationRole === "requester" &&
    String(notification?.approvalRequestId ?? "") === approvalRequestId &&
    String(notification?.recipientUsername ?? "") === requesterUsername
  );
  if (requesterUsername && !existingRequester) {
    const requesterNotification = {
      id: String(input.requesterNotificationId ?? `${approvalRequestId}-requester`).trim(),
      type: "stock_approval",
      status: "pending",
      title: String(input.title ?? "库存操作待审批"),
      message: String(input.message ?? "库存操作申请已提交，等待管理员审批。"),
      createdAt,
      createdBy: String(input.createdBy ?? "system"),
      createdByName: String(input.createdByName ?? input.createdBy ?? "system"),
      // The requester just submitted this record, so it should only become
      // unread when an approver writes the result back to the same thread.
      readAt: createdAt,
      recipientUsername: requesterUsername,
      recipientName: requesterName,
      notificationRole: "requester",
      approvalRequestId,
      approvalAction: String(input.approvalAction ?? "stock_change"),
      siteId: String(input.siteId ?? ""),
    };
    if (!requesterNotification.id) throw new Error("库存审批跟踪站内信缺少编号");
    created.push(requesterNotification);
    next = [requesterNotification, ...next];
  }
  return {
    notifications: sortedNotifications(next),
    notificationsCreated: created,
    changed: created.length > 0,
  };
}

export function resolveApprovalNotifications(notifications = [], approvalRequestId = "", input = {}) {
  const requestId = String(approvalRequestId ?? "").trim();
  const resolution = input.resolution === "approved" ? "approved" : "rejected";
  const resolvedAt = String(input.resolvedAt ?? new Date().toISOString());
  let changed = false;
  const next = (Array.isArray(notifications) ? notifications : []).map((notification) => {
    if (
      notification?.type !== "stock_approval" ||
      notification?.status !== "pending" ||
      String(notification?.approvalRequestId ?? "") !== requestId
    ) return notification;
    changed = true;
    const isRequester = notification?.notificationRole === "requester";
    return {
      ...notification,
      status: "completed",
      resolution,
      resolvedAt,
      updatedAt: resolvedAt,
      resolvedBy: String(input.resolvedBy ?? "system"),
      resolvedByName: String(input.resolvedByName ?? input.resolvedBy ?? "system"),
      resolutionNote: String(input.resolutionNote ?? ""),
      ...(isRequester && input.resultTitle ? { title: String(input.resultTitle) } : {}),
      ...(isRequester && input.resultMessage ? { message: String(input.resultMessage) } : {}),
      readAt: isRequester ? "" : notification.readAt || resolvedAt,
    };
  });
  return { notifications: sortedNotifications(next), changed };
}

export function resolveCreditSaleNotifications(
  notifications = [],
  orderId = "",
  resolution = "resolved",
  resolvedBy = "system",
  resolvedAt = new Date().toISOString(),
  resolvedByName = resolvedBy,
  resolutionNote = "",
  creditSaleRequestId = ""
) {
  let changed = false;
  const next = (Array.isArray(notifications) ? notifications : []).map((notification) => {
    if (
      notification?.type !== "credit_sale_confirmation" ||
      notification?.status !== "pending" ||
      String(notification?.orderId ?? "") !== String(orderId ?? "") ||
      (creditSaleRequestId && String(notification?.creditSaleRequestId ?? "") !== String(creditSaleRequestId))
    ) return notification;
    changed = true;
    return {
      ...notification,
      status: "completed",
      resolution,
      resolvedAt,
      resolvedBy,
      resolvedByName: String(resolvedByName ?? resolvedBy),
      resolutionNote: String(resolutionNote ?? ""),
      readAt: notification.readAt || resolvedAt,
    };
  });
  return { notifications: next, changed };
}

export function markNotificationsRead(notifications = [], username = "", ids = []) {
  const recipient = String(username ?? "").trim();
  const idSet = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id ?? "")).filter(Boolean));
  const markAll = idSet.size === 0;
  const readAt = new Date().toISOString();
  let changed = false;
  const next = (Array.isArray(notifications) ? notifications : []).map((notification) => {
    if (
      String(notification?.recipientUsername ?? "") !== recipient ||
      notification?.readAt ||
      (!markAll && !idSet.has(String(notification?.id ?? "")))
    ) return notification;
    changed = true;
    return { ...notification, readAt };
  });
  return { notifications: next, changed };
}
