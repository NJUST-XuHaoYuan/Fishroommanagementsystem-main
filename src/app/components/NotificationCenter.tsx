import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  HandCoins,
  Loader2,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";

type StationNotification = {
  id: string;
  type: "credit_sale_confirmation" | string;
  status: "pending" | "completed";
  resolution?: string;
  title: string;
  message: string;
  createdAt: string;
  createdBy?: string;
  createdByName?: string;
  updatedAt?: string;
  readAt?: string;
  recipientUsername: string;
  recipientName: string;
  orderId?: string;
  orderNo?: string;
  siteId?: string;
  requiredOutstandingAmount?: number;
  approvalRequestId?: string;
  approvalAction?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  resolutionNote?: string;
};

function formatNotificationTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace("T", " ").slice(0, 16);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function notificationResultLabel(notification: StationNotification): string {
  if (notification.status === "pending") {
    return notification.type === "stock_approval" ? "待审批" : "待处理";
  }
  return {
    approved: "已批准",
    rejected: "已驳回",
    credit_confirmed: "已确认赊销",
    finance_verified: "财务已核销",
    platform_exempt: "平台免核销",
    offline_credit: "线下默认赊销",
    order_updated: "订单已更新",
    order_deleted: "订单已删除",
    reassigned: "已转交",
  }[notification.resolution ?? ""] ?? "已处理";
}

function actorLabel(name?: string, username?: string): string {
  const safeName = String(name ?? "").trim();
  const safeUsername = String(username ?? "").trim();
  if (safeName && safeUsername && safeName !== safeUsername) return `${safeName}（${safeUsername}）`;
  return safeName || safeUsername || "系统";
}

export function NotificationCenter({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const { setState, setActiveSiteId } = useStore();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState<StationNotification[]>([]);
  const [selected, setSelected] = useState<StationNotification | null>(null);
  const [creditNote, setCreditNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<StationNotification | null>(null);
  const [approvalDecision, setApprovalDecision] = useState<"approve" | "reject">("approve");
  const [approvalNote, setApprovalNote] = useState("");
  const [processingApproval, setProcessingApproval] = useState(false);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.readAt).length,
    [notifications]
  );

  const loadNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/notifications", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "站内信加载失败");
      setNotifications(Array.isArray(result.notifications) ? result.notifications : []);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "站内信加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotifications(true);
    const timer = window.setInterval(() => void loadNotifications(true), 30_000);
    const refresh = () => void loadNotifications(true);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("fishroom:notifications-refresh", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("fishroom:notifications-refresh", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadNotifications]);

  const markRead = async (notification: StationNotification) => {
    if (notification.readAt) return;
    setNotifications((current) => current.map((item) =>
      item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item
    ));
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: authJsonHeaders(),
      body: JSON.stringify({ id: notification.id }),
    }).catch(() => undefined);
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setNotifications((current) => current.map((notification) => ({
      ...notification,
      readAt: notification.readAt || new Date().toISOString(),
    })));
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ all: true }),
      });
      if (!response.ok) throw new Error("标记失败");
    } catch {
      toast.error("全部已读保存失败，请重试");
      void loadNotifications(true);
    }
  };

  const openOrder = (notification: StationNotification) => {
    void markRead(notification);
    if (!notification.orderId) return;
    if (notification.siteId) setActiveSiteId(notification.siteId);
    setOpen(false);
    onOpenOrder(notification.orderId);
  };

  const startCreditConfirmation = (notification: StationNotification) => {
    void markRead(notification);
    setOpen(false);
    setCreditNote("");
    setSelected(notification);
  };

  const confirmCreditSale = async () => {
    if (!selected?.orderId || confirming) return;
    setConfirming(true);
    try {
      const response = await fetch("/api/orders/credit-sale/confirm", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ orderId: selected.orderId, note: creditNote.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "确认赊销失败");
      setState((current) => ({
        ...current,
        orders: Array.isArray(result.orders) ? result.orders : current.orders,
        operationLogs: result.operationLog
          ? [result.operationLog, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, 10000)
          : current.operationLogs,
      }));
      setSelected(null);
      setCreditNote("");
      await loadNotifications(true);
      toast.success(
        result.alreadyVerified
          ? "财务已经核销，无需确认赊销"
          : result.alreadyAllowed
            ? result.allowance === "offline_credit"
              ? "线下自提默认赊销，可以直接出库"
              : "平台订单无需确认赊销"
            : "赊销已确认，可以继续发货"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认赊销失败");
    } finally {
      setConfirming(false);
    }
  };

  const startStockApproval = (
    notification: StationNotification,
    decision: "approve" | "reject"
  ) => {
    void markRead(notification);
    setOpen(false);
    setApprovalDecision(decision);
    setApprovalNote("");
    setSelectedApproval(notification);
  };

  const processStockApproval = async () => {
    if (!selectedApproval?.approvalRequestId || processingApproval) return;
    setProcessingApproval(true);
    try {
      const response = await fetch("/api/approvals/stock", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          requestId: selectedApproval.approvalRequestId,
          decision: approvalDecision,
          note: approvalNote.trim(),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "库存审批处理失败");
      setState((current) => ({
        ...current,
        stock: Array.isArray(result.stock) ? result.stock : current.stock,
        batches: Array.isArray(result.batches) ? result.batches : current.batches,
        orders: Array.isArray(result.orders) ? result.orders : current.orders,
        shipments: Array.isArray(result.shipments) ? result.shipments : current.shipments,
        operationLogs: result.operationLog
          ? [result.operationLog, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, 10000)
          : current.operationLogs,
      }));
      setSelectedApproval(null);
      setApprovalNote("");
      await loadNotifications(true);
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
      toast.success(result.message || (approvalDecision === "approve" ? "已批准并执行" : "已驳回"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "库存审批处理失败");
    } finally {
      setProcessingApproval(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void loadNotifications();
      }}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative shrink-0"
            title="站内信"
            aria-label={unreadCount > 0 ? `站内信，${unreadCount} 条未读` : "站内信"}
          >
            <Bell className="size-4.5" />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(92vw,420px)] p-0">
          <div className="flex h-12 items-center justify-between border-b px-3.5">
            <div className="flex items-center gap-2">
              <span className="font-semibold">站内信</span>
              {unreadCount > 0 && <Badge variant="secondary">{unreadCount} 条未读</Badge>}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markAllRead()}
              disabled={unreadCount === 0}
              title="全部标为已读"
            >
              <CheckCheck className="size-4" />
              全部已读
            </Button>
          </div>
          <ScrollArea className="max-h-[min(65dvh,460px)]">
            {loading && notifications.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />加载中
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <Bell className="size-5" />暂无站内信
              </div>
            ) : (
              <div className="divide-y">
                {notifications.map((notification) => {
                  const pending = notification.status === "pending";
                  return (
                    <div
                      key={notification.id}
                      className={`px-3.5 py-3 ${notification.readAt ? "bg-background" : "bg-sky-50/70"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {!notification.readAt && <span className="size-2 shrink-0 rounded-full bg-sky-500" />}
                            <div className="truncate text-sm font-semibold">{notification.title}</div>
                          </div>
                          <div className="mt-1 text-xs leading-5 text-muted-foreground">{notification.message}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <UserRound className="size-3.5" />
                              来自：{actorLabel(notification.createdByName, notification.createdBy)}
                            </span>
                            {notification.resolvedBy && (
                              <span>
                                处理人：{actorLabel(notification.resolvedByName, notification.resolvedBy)}
                              </span>
                            )}
                          </div>
                          {notification.resolutionNote && (
                            <div className="mt-1 text-xs leading-5 text-muted-foreground">
                              处理说明：{notification.resolutionNote}
                            </div>
                          )}
                        </div>
                        <Badge
                          variant="outline"
                          className={pending
                            ? "shrink-0 border-amber-200 bg-amber-50 text-amber-700"
                            : notification.resolution === "rejected"
                              ? "shrink-0 border-red-200 bg-red-50 text-red-700"
                            : "shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700"}
                        >
                          {notificationResultLabel(notification)}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {formatNotificationTime(notification.updatedAt || notification.createdAt)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {notification.orderId && (
                            <Button variant="ghost" size="sm" onClick={() => openOrder(notification)}>
                              <ExternalLink className="size-3.5" />查看订单
                            </Button>
                          )}
                          {pending && notification.type === "credit_sale_confirmation" && (
                            <Button size="sm" onClick={() => startCreditConfirmation(notification)}>
                              <HandCoins className="size-3.5" />确认赊销
                            </Button>
                          )}
                          {pending && notification.type === "stock_approval" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => startStockApproval(notification, "reject")}
                              >
                                <XCircle className="size-3.5" />驳回
                              </Button>
                              <Button size="sm" onClick={() => startStockApproval(notification, "approve")}>
                                <CheckCircle2 className="size-3.5" />批准
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <Dialog open={!!selected} onOpenChange={(nextOpen) => {
        if (!nextOpen && !confirming) setSelected(null);
      }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>确认赊销 · {selected?.orderNo}</DialogTitle>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
            确认后，该订单可在尚有 ¥{Number(selected?.requiredOutstandingAmount ?? 0).toFixed(2)} 未核销的情况下发货。此操作会记录确认人和时间。
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="credit-sale-note">赊销说明</label>
            <Textarea
              id="credit-sale-note"
              rows={3}
              maxLength={500}
              value={creditNote}
              onChange={(event) => setCreditNote(event.target.value)}
              placeholder="例如：老客户，约定 8 月 10 日付款"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={confirming} onClick={() => setSelected(null)}>取消</Button>
            <Button disabled={confirming} onClick={() => void confirmCreditSale()}>
              {confirming ? <Loader2 className="size-4 animate-spin" /> : <HandCoins className="size-4" />}
              {confirming ? "确认中" : "确认赊销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedApproval} onOpenChange={(nextOpen) => {
        if (!nextOpen && !processingApproval) setSelectedApproval(null);
      }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {approvalDecision === "approve" ? "批准库存操作" : "驳回库存操作"}
            </DialogTitle>
          </DialogHeader>
          <div className={`rounded-md border px-3 py-2 text-sm leading-6 ${
            approvalDecision === "approve"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-900"
          }`}>
            <div>{selectedApproval?.message}</div>
            <div className="mt-1 text-xs opacity-80">
              发起人：{actorLabel(selectedApproval?.createdByName, selectedApproval?.createdBy)}
            </div>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="stock-approval-note">审批说明</label>
            <Textarea
              id="stock-approval-note"
              rows={3}
              maxLength={500}
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              placeholder={approvalDecision === "approve" ? "可填写批准说明" : "建议填写驳回原因"}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={processingApproval}
              onClick={() => setSelectedApproval(null)}
            >
              取消
            </Button>
            <Button
              variant={approvalDecision === "approve" ? "default" : "destructive"}
              disabled={processingApproval}
              onClick={() => void processStockApproval()}
            >
              {processingApproval
                ? <Loader2 className="size-4 animate-spin" />
                : approvalDecision === "approve"
                  ? <CheckCircle2 className="size-4" />
                  : <XCircle className="size-4" />}
              {processingApproval
                ? "处理中"
                : approvalDecision === "approve"
                  ? "批准并执行"
                  : "确认驳回"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
