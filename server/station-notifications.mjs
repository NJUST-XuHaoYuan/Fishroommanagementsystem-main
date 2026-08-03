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
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")))
    .slice(0, MAX_STATION_NOTIFICATIONS);
}

export function notificationsForRecipient(notifications = [], username = "") {
  const recipient = String(username ?? "").trim();
  return sortedNotifications((Array.isArray(notifications) ? notifications : []).filter((notification) =>
    String(notification?.recipientUsername ?? "").trim() === recipient
  ));
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

export function resolveCreditSaleNotifications(
  notifications = [],
  orderId = "",
  resolution = "resolved",
  resolvedBy = "system",
  resolvedAt = new Date().toISOString()
) {
  let changed = false;
  const next = (Array.isArray(notifications) ? notifications : []).map((notification) => {
    if (
      notification?.type !== "credit_sale_confirmation" ||
      notification?.status !== "pending" ||
      String(notification?.orderId ?? "") !== String(orderId ?? "")
    ) return notification;
    changed = true;
    return {
      ...notification,
      status: "completed",
      resolution,
      resolvedAt,
      resolvedBy,
      ...(resolution === "credit_confirmed" ? { readAt: notification.readAt || resolvedAt } : {}),
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
