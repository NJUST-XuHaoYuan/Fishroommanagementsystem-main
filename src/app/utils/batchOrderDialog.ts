import type { User } from "../store";

export type BatchOrderRequest = { batchId: string; siteId: string; orderId: string };

export function batchOrderRequestKey(request: BatchOrderRequest): string {
  return JSON.stringify([request.batchId, request.siteId, request.orderId]);
}

export function batchOrderIdentityKey(user: User): string {
  if (!user || user.account?.accountEnabled === false) return "";
  return JSON.stringify([user.username, user.role, [...(user.visibleSiteIds ?? [])].sort()]);
}

export function isBatchOrderContextCurrent(
  request: BatchOrderRequest,
  opening: { identityKey: string; activeSiteId: string },
  current: { identityKey: string; activeSiteId: string },
): boolean {
  return Boolean(request.batchId.trim() && request.orderId.trim() && request.siteId.trim() &&
    request.siteId !== "all" && current.identityKey &&
    opening.identityKey === current.identityKey &&
    opening.activeSiteId === current.activeSiteId && request.siteId === current.activeSiteId);
}

export function shouldRestoreBatchOrderFocus(
  request: BatchOrderRequest,
  opening: { identityKey: string; activeSiteId: string },
  current: { identityKey: string; activeSiteId: string },
  targetConnected: boolean,
): boolean {
  return targetConnected && isBatchOrderContextCurrent(request, opening, current);
}

export function batchOrderMoney(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "未记录";
}

export function batchOrderErrorMessage(cause: unknown): string {
  if (cause instanceof TypeError) return "网络连接失败，请检查网络后重试";
  return cause instanceof Error && cause.message ? cause.message : "订单加载失败，请重试";
}
