import { useEffect, useRef, useState } from "react";
import { Loader2, Tag } from "lucide-react";
import type { Order, Store, User } from "../store";
import { authJsonHeaders, getValidAuthSession } from "../utils/authSession";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export type OrderWholesaleFields = Pick<Order,
  "id" | "isWholesaleOrder" | "wholesaleOrderUpdatedAt" | "wholesaleOrderUpdatedBy" | "wholesaleOrderUpdatedByName"
>;
export type OrderWholesaleFilterValue = "all" | "wholesale" | "unmarked";
export type WholesaleMutationSession = { authSessionKey: string; viewerKey: string };

function wholesaleViewerKey(user: User) {
  return user ? JSON.stringify([user.username, user.role, [...new Set(user.visibleSiteIds || [])].sort()]) : "";
}

function wholesaleAuthSessionKey() {
  if (typeof window === "undefined") return "";
  const session = getValidAuthSession();
  return session?.token ? JSON.stringify([session.username, session.role, session.expiresAt, session.token, [...new Set(session.visibleSiteIds || [])].sort()]) : "";
}

export function captureWholesaleMutationSession(viewer: User): WholesaleMutationSession | null {
  if (!viewer || typeof window === "undefined") return null;
  const session = getValidAuthSession();
  const authSessionKey = wholesaleAuthSessionKey();
  if (!session || !authSessionKey || session.username !== viewer.username || session.role !== viewer.role) return null;
  return { authSessionKey, viewerKey: wholesaleViewerKey(viewer) };
}

export function isWholesaleMutationSessionCurrent(session: WholesaleMutationSession | null, viewer?: User) {
  return Boolean(session?.authSessionKey) && session!.authSessionKey === wholesaleAuthSessionKey()
    && (viewer === undefined || session!.viewerKey === wholesaleViewerKey(viewer));
}

/** Recheck when React executes the updater, not only when the request resolves. */
export function mergeWholesaleOrderTagForSession(current: Store, incoming: OrderWholesaleFields, session: WholesaleMutationSession): Store {
  if (!isWholesaleMutationSessionCurrent(session, current.user) || !current.orders.some(order => order.id === incoming.id)) return current;
  return { ...current, orders: mergeWholesaleOrderTags(current.orders, incoming) };
}

export function matchesWholesaleOrderFilter(order: Pick<Order, "isWholesaleOrder">, filter: OrderWholesaleFilterValue) {
  return filter === "wholesale" ? order.isWholesaleOrder === true
    : filter === "unmarked" ? order.isWholesaleOrder !== true : true;
}

/** Only tag metadata is accepted. Never replace current financial/fulfillment state or reinsert deleted orders. */
export function mergeWholesaleOrderTags<T extends OrderWholesaleFields>(orders: T[], incoming: OrderWholesaleFields): T[] {
  return orders.map(order => {
    if (order.id !== incoming.id || typeof incoming.isWholesaleOrder !== "boolean") return order;
    const currentVersion = Date.parse(order.wholesaleOrderUpdatedAt || "") || 0;
    const incomingVersion = Date.parse(incoming.wholesaleOrderUpdatedAt || "") || 0;
    if (currentVersion > incomingVersion) return order;
    return {
      ...order,
      isWholesaleOrder: incoming.isWholesaleOrder,
      wholesaleOrderUpdatedAt: incoming.wholesaleOrderUpdatedAt,
      wholesaleOrderUpdatedBy: incoming.wholesaleOrderUpdatedBy,
      wholesaleOrderUpdatedByName: incoming.wholesaleOrderUpdatedByName,
    };
  });
}

/** A slower general order response may predate a tag change. Keep its business data but retain newer tag metadata. */
export function retainNewerWholesaleOrderTags<T extends OrderWholesaleFields>(current: T[], incoming: T[]): T[] {
  const currentById = new Map(current.map(order => [order.id, order]));
  return incoming.map(order => {
    const previous = currentById.get(order.id);
    if (!previous || typeof previous.isWholesaleOrder !== "boolean") return order;
    const currentVersion = Date.parse(previous.wholesaleOrderUpdatedAt || "") || 0;
    const incomingVersion = Date.parse(order.wholesaleOrderUpdatedAt || "") || 0;
    if (currentVersion < incomingVersion || (currentVersion === incomingVersion && typeof order.isWholesaleOrder === "boolean")) return order;
    return mergeWholesaleOrderTags([order], previous)[0];
  });
}

export function wholesaleOrderFieldsFromPayload(payload: unknown, expectedOrderId: string): OrderWholesaleFields | null {
  if (!payload || typeof payload !== "object") return null;
  const order = (payload as { order?: unknown }).order;
  if (!order || typeof order !== "object" || Array.isArray(order)) return null;
  const candidate = order as Record<string, unknown>;
  if (candidate.id !== expectedOrderId) return null;
  if (candidate.isWholesaleOrder !== undefined && typeof candidate.isWholesaleOrder !== "boolean") return null;
  const updatedAt = candidate.wholesaleOrderUpdatedAt;
  if (updatedAt !== undefined && (typeof updatedAt !== "string" || (updatedAt !== "" && !Number.isFinite(Date.parse(updatedAt))))) return null;
  return {
    id: expectedOrderId,
    isWholesaleOrder: candidate.isWholesaleOrder === true,
    wholesaleOrderUpdatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    wholesaleOrderUpdatedBy: typeof candidate.wholesaleOrderUpdatedBy === "string" ? candidate.wholesaleOrderUpdatedBy : undefined,
    wholesaleOrderUpdatedByName: typeof candidate.wholesaleOrderUpdatedByName === "string" ? candidate.wholesaleOrderUpdatedByName : undefined,
  };
}

export function wholesaleOrderMutationPayload(order: OrderWholesaleFields, isWholesaleOrder: boolean) {
  return {
    orderId: order.id,
    isWholesaleOrder,
    expectedIsWholesaleOrder: order.isWholesaleOrder === true,
    expectedWholesaleOrderUpdatedAt: order.wholesaleOrderUpdatedAt || "",
  };
}

export function OrderWholesaleBadge({ marked }: { marked?: boolean }) {
  return marked === true ? <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-800" title="订单单独标记为批发，不代表客户类型"><Tag aria-hidden="true" />批发订单</Badge> : null;
}

export function OrderWholesaleFilter({ value, onChange, className = "" }: {
  value: OrderWholesaleFilterValue; onChange: (value: OrderWholesaleFilterValue) => void; className?: string;
}) {
  return <label className={`flex min-w-0 items-center gap-2 text-sm ${className}`}>
    <span className="shrink-0 text-muted-foreground">批发标记</span>
    <select aria-label="筛选订单批发标记" value={value} onChange={event => onChange(event.target.value as OrderWholesaleFilterValue)} className="fishroom-control h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm sm:flex-none">
      <option value="all">全部订单</option>
      <option value="wholesale">批发订单</option>
      <option value="unmarked">未标记批发</option>
    </select>
  </label>;
}

function formatWholesaleTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function OrderWholesaleTag({ order, viewer, canUpdate, onOrderUpdated }: {
  order: OrderWholesaleFields; viewer: User; canUpdate: boolean;
  onOrderUpdated: (order: OrderWholesaleFields, session: WholesaleMutationSession) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pendingRef = useRef(false);
  const currentOrderIdRef = useRef(order.id);
  currentOrderIdRef.current = order.id;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setError(""); setMessage(""); }, [order.id]);

  const toggle = async () => {
    if (!canUpdate || pendingRef.current || !order.id) return;
    const session = captureWholesaleMutationSession(viewer);
    if (!session) { setError("登录状态已变化，请重新登录后操作。"); return; }
    const orderId = order.id;
    const target = order.isWholesaleOrder !== true;
    const stillCurrent = () => mountedRef.current && currentOrderIdRef.current === orderId && isWholesaleMutationSessionCurrent(session);
    pendingRef.current = true;
    setPending(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/orders/wholesale-tag", {
        method: "POST", headers: authJsonHeaders(), cache: "no-store",
        body: JSON.stringify(wholesaleOrderMutationPayload(order, target)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!isWholesaleMutationSessionCurrent(session)) return;
      const updatedOrder = wholesaleOrderFieldsFromPayload(payload, orderId);
      if (response.status === 409) {
        if (updatedOrder) onOrderUpdated(updatedOrder, session);
        if (stillCurrent()) setError(updatedOrder ? "批发标记已被其他人修改，已同步最新标记；请核对后再操作。" : "订单信息已变化，请刷新订单后再操作。");
        return;
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(response.status === 401 ? "登录已过期，请重新登录。" : response.status === 403 ? "当前账号没有修改该订单的权限。" : typeof payload.error === "string" ? payload.error : "批发标记保存失败，请重试。");
      }
      if (!updatedOrder || updatedOrder.isWholesaleOrder !== target) throw new Error("服务端未返回有效的批发标记，请刷新订单后核对。");
      onOrderUpdated(updatedOrder, session);
      if (stillCurrent()) setMessage(target ? "已标记为批发订单。" : "已取消批发标记。");
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof TypeError ? "网络连接失败，请检查网络后重试。" : cause instanceof Error ? cause.message : "批发标记保存失败，请重试。");
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };
  const actor = order.wholesaleOrderUpdatedByName && order.wholesaleOrderUpdatedByName !== order.wholesaleOrderUpdatedBy
    ? `${order.wholesaleOrderUpdatedByName}${order.wholesaleOrderUpdatedBy ? `（${order.wholesaleOrderUpdatedBy}）` : ""}`
    : order.wholesaleOrderUpdatedBy || order.wholesaleOrderUpdatedByName || "操作人未记录";

  return <section aria-label="订单批发标记" className="border-b pb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">批发订单标记</h3><OrderWholesaleBadge marked={order.isWholesaleOrder} />{order.isWholesaleOrder !== true && <span className="text-xs text-muted-foreground">未标记批发</span>}</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">仅分类当前订单，不改变客户类型、订单金额、提成或发货流程。点击后直接保存，可随时取消。</p>
      </div>
      {canUpdate && <Button type="button" variant="outline" className="!min-h-[44px] shrink-0" disabled={pending} onClick={() => void toggle()}>{pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Tag className="size-4" aria-hidden="true" />}{pending ? "正在保存…" : order.isWholesaleOrder === true ? "取消批发标记" : "标记为批发订单"}</Button>}
    </div>
    {order.wholesaleOrderUpdatedAt && <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">最近{order.isWholesaleOrder === true ? "标记" : "取消"}：{actor} · {formatWholesaleTime(order.wholesaleOrderUpdatedAt)}（北京时间）</p>}
    {!canUpdate && <p className="mt-2 text-xs text-muted-foreground">当前账号仅可查看，需有订单修改权限才能更改标记。</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </section>;
}
