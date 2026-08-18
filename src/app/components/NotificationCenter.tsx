import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Check,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  FilterX,
  FileUser,
  HandCoins,
  Inbox,
  Loader2,
  MapPin,
  RefreshCw,
  Trash2,
  Download,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  useStore,
  type Order,
  type PurchaseBatch,
  type Shipment,
  type StockItem,
} from "../store";
import { authJsonHeaders } from "../utils/authSession";
import {
  createLatestRequestCoordinator,
  profileApprovalActionReady,
  profileApprovalDetailsReady,
  profileAttachmentChangeKind,
} from "../utils/notificationCenter";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

type StockApprovalLinkedOrder = {
  id: string;
  orderNo: string;
  status: string;
  source: string;
};

type StockApprovalItemDetail = {
  stockItemId: string;
  code: string;
  productName?: string;
  speciesName?: string;
  size?: string;
  origin?: string;
  imageUrl?: string;
  tankName?: string;
  batchNo?: string;
  supplier?: string;
  inDate?: string;
  status?: string;
  sold?: boolean;
  lost?: boolean;
  basePrice?: number;
  notes?: string;
  siteId?: string;
  missing?: boolean;
  linkedOrders?: StockApprovalLinkedOrder[];
};

type StockDeletionApprovalDetails = {
  type: "stock_delete";
  requestedCount: number;
  availableCount: number;
  items: StockApprovalItemDetail[];
};

type StockChangeApprovalRow = {
  productId: string;
  productName: string;
  speciesName?: string;
  size?: string;
  origin?: string;
  batchId?: string;
  batchNo: string;
  batchDate?: string;
  supplier?: string;
  addCount: number;
  removeCount: number;
  updateCount: number;
};

type StockChangeApprovalDetails = {
  type: "stock_change";
  requestedCount: number;
  totals: { addCount: number; removeCount: number; updateCount: number };
  tanks: Array<{
    subTankId: string;
    tankName: string;
    addCount: number;
    removeCount: number;
    updateCount: number;
    rows: StockChangeApprovalRow[];
  }>;
  batches: Array<{
    batchId?: string;
    batchNo: string;
    batchDate?: string;
    supplier?: string;
    origins?: string[];
    addCount: number;
    removeCount: number;
    updateCount: number;
  }>;
  items: Array<{
    operation: "add" | "remove" | "update";
    stockItemId: string;
    before?: StockApprovalItemDetail | null;
    after?: StockApprovalItemDetail | null;
  }>;
};

type StockApprovalDetails = StockDeletionApprovalDetails | StockChangeApprovalDetails;

type PersonnelProfileAttachment = {
  id: string;
  kind: string;
  originalName?: string;
  mime?: string;
  size?: number;
};

type PersonnelProfileChange = {
  field: string;
  label: string;
  section: string;
  beforeValue?: string;
  afterValue?: string;
  sensitive?: boolean;
  beforeAttachment?: PersonnelProfileAttachment | null;
  afterAttachment?: PersonnelProfileAttachment | null;
};

type StationNotification = {
  id: string;
  type: "credit_sale_confirmation" | "stock_approval" | "approval_result" | string;
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
  canApprove?: boolean;
  approvalRequestId?: string;
  approvalAction?: string;
  notificationRole?: "approver" | "requester";
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  resolutionNote?: string;
  stockDetails?: StockApprovalDetails | null;
  profileRequestId?: string;
  profileChanges?: PersonnelProfileChange[];
};

type NotificationFilter = "all" | "unread" | "pending" | "completed";

type NotificationFacet = {
  value: string;
  label: string;
};

type NotificationRefreshDetail = {
  source?: "notification-center";
  unreadCount?: number;
};

function mergeEntityChanges<T extends { id: string }>(
  current: T[],
  updates: T[] = [],
  deleteIds: string[] = []
): T[] {
  const deleted = new Set(deleteIds.map(String));
  const updatesById = new Map(updates.map((item) => [String(item.id), item]));
  const currentIds = new Set(current.map((item) => String(item.id)));
  const merged = current
    .filter((item) => !deleted.has(String(item.id)))
    .map((item) => updatesById.get(String(item.id)) ?? item);
  for (const update of updates) {
    if (!currentIds.has(String(update.id)) && !deleted.has(String(update.id))) merged.push(update);
  }
  return merged;
}

function formatNotificationTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace("T", " ").slice(0, 16);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function notificationResultLabel(notification: StationNotification): string {
  if (notification.status === "pending") {
    return ["stock_approval", "credit_sale_confirmation", "personnel_profile_approval"].includes(notification.type)
      ? "待审批"
      : "待处理";
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

function notificationTypeKey(notification: StationNotification): string {
  if (notification.type === "stock_approval") {
    return `stock_approval:${notification.approvalAction || "stock_change"}`;
  }
  return notification.type || "system";
}

function notificationTypeLabel(notification: StationNotification): string {
  if (notification.type === "stock_approval") {
    return {
      delete_stock: "库存删除",
      update_stock: "库存修改",
      add_stock_to_old_batch: "超时批次入库",
      inventory_adjustment: "盘库调整",
      mixed_stock_change: "库存综合变更",
      stock_change: "库存变更",
    }[notification.approvalAction ?? ""] ?? "库存审批";
  }
  if (notification.type === "approval_result") return "审批结果";
  if (notification.type === "credit_sale_confirmation") return "赊销确认";
  if (notification.type === "personnel_profile_approval") return "人员资料审批";
  return "系统消息";
}

function formatAttachmentSize(value?: number): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PROFILE_ATTACHMENT_CHANGE_COPY = {
  added: { label: "新增附件", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  replaced: { label: "替换附件", className: "border-sky-200 bg-sky-50 text-sky-700" },
  removed: { label: "删除附件", className: "border-red-200 bg-red-50 text-red-700" },
  unchanged: { label: "附件未变", className: "border-slate-200 bg-slate-50 text-slate-700" },
} as const;

function ProfileAttachmentSnapshot({
  heading,
  attachment,
  requested,
  download,
  busy,
  disabled,
  onAccess,
}: {
  heading: string;
  attachment: PersonnelProfileAttachment | null | undefined;
  requested: boolean;
  download: boolean;
  busy: boolean;
  disabled: boolean;
  onAccess: (attachment: PersonnelProfileAttachment, download: boolean) => void;
}) {
  return (
    <div className={`min-w-0 rounded-md border px-3 py-3 ${requested ? "border-sky-200 bg-sky-50/70" : "bg-muted/30"}`}>
      <div className={`text-[11px] font-medium ${requested ? "text-sky-800" : "text-muted-foreground"}`}>{heading}</div>
      {attachment ? (
        <div className="mt-2 grid gap-2">
          <div className="min-w-0">
            <div className="font-medium [overflow-wrap:anywhere]">{attachment.originalName || "资料附件"}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {[attachment.mime, formatAttachmentSize(attachment.size)].filter(Boolean).join(" · ") || "受保护附件"}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 w-full"
            disabled={disabled}
            aria-label={`${heading}：${download ? "下载附件并留痕" : "在线预览附件"}`}
            onClick={() => onAccess(attachment, download)}
          >
            {busy
              ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              : download
                ? <Download className="size-3.5" aria-hidden="true" />
                : <ExternalLink className="size-3.5" aria-hidden="true" />}
            {busy ? "读取中" : download ? "下载核对（留痕）" : "在线预览"}
          </Button>
        </div>
      ) : (
        <div className={`mt-2 rounded border border-dashed px-3 py-4 text-center text-sm ${requested ? "border-sky-200 text-sky-800" : "text-muted-foreground"}`}>
          {requested ? "申请删除，不再保留附件" : "当前档案未上传附件"}
        </div>
      )}
    </div>
  );
}

function actorLabel(name?: string, username?: string): string {
  const safeName = String(name ?? "").trim();
  const safeUsername = String(username ?? "").trim();
  if (safeName && safeUsername && safeName !== safeUsername) return `${safeName}（${safeUsername}）`;
  return safeName || safeUsername || "系统";
}

function notificationSenderKey(notification: StationNotification): string {
  const username = String(notification.createdBy ?? "").trim();
  const name = String(notification.createdByName ?? "").trim();
  return username || (name ? `name:${name}` : "system");
}

function notificationDateKey(notification: StationNotification): string {
  const value = notification.updatedAt || notification.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "").slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function stockStatusLabel(status?: string): string {
  return {
    healthy: "正常",
    feeding: "开口",
    sick: "疾病",
  }[String(status ?? "")] ?? "状态未知";
}

function notifyNotificationRefresh(unreadCount?: number) {
  window.dispatchEvent(new CustomEvent<NotificationRefreshDetail>("fishroom:notifications-refresh", {
    detail: {
      source: "notification-center",
      ...(Number.isFinite(unreadCount) ? { unreadCount } : {}),
    },
  }));
}

export function useNotificationUnreadCount() {
  const [unreadCount, setUnreadCount] = useState(0);

  const loadUnreadCount = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications?limit=1", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) return;
      setUnreadCount(Math.max(0, Number(result.unreadCount ?? 0)));
    } catch {
      // The indicator stays silent when the background refresh is unavailable.
    }
  }, []);

  useEffect(() => {
    void loadUnreadCount();
    const timer = window.setInterval(() => void loadUnreadCount(), 30_000);
    const refresh = (event: Event) => {
      const nextUnreadCount = Number((event as CustomEvent<NotificationRefreshDetail>).detail?.unreadCount);
      if (Number.isFinite(nextUnreadCount)) {
        setUnreadCount(Math.max(0, nextUnreadCount));
        return;
      }
      void loadUnreadCount();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadUnreadCount();
    };
    window.addEventListener("fishroom:notifications-refresh", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("fishroom:notifications-refresh", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadUnreadCount]);

  return unreadCount;
}

export function NotificationNavBadge({ unreadCount }: { unreadCount: number }) {
  if (unreadCount <= 0) return null;
  return (
    <span
      className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-5 text-white"
      aria-label={`${unreadCount} 条未读站内信`}
    >
      {unreadCount > 99 ? "99+" : unreadCount}
    </span>
  );
}

export function NotificationCenterView({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const { setState, setActiveSiteId } = useStore();
  const [loading, setLoading] = useState(true);
  const [notificationLoadError, setNotificationLoadError] = useState("");
  const [notifications, setNotifications] = useState<StationNotification[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [senderFilter, setSenderFilter] = useState("all");
  const [selected, setSelected] = useState<StationNotification | null>(null);
  const [creditNote, setCreditNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<StationNotification | null>(null);
  const [approvalDecision, setApprovalDecision] = useState<"approve" | "reject" | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [processingApproval, setProcessingApproval] = useState(false);
  const [loadingApprovalDetails, setLoadingApprovalDetails] = useState(false);
  const [approvalDetailError, setApprovalDetailError] = useState("");
  const [selectedProfileApproval, setSelectedProfileApproval] = useState<StationNotification | null>(null);
  const [profileDecision, setProfileDecision] = useState<"approve" | "reject" | null>(null);
  const [profileNote, setProfileNote] = useState("");
  const [processingProfileApproval, setProcessingProfileApproval] = useState(false);
  const [loadingProfileDetails, setLoadingProfileDetails] = useState(false);
  const [profileDetailError, setProfileDetailError] = useState("");
  const [loadedProfileDetailNotificationId, setLoadedProfileDetailNotificationId] = useState("");
  const [accessingProfileAttachmentId, setAccessingProfileAttachmentId] = useState("");
  const profileDetailRequestCoordinator = useMemo(() => createLatestRequestCoordinator(), []);

  const typeOptions = useMemo<NotificationFacet[]>(() => {
    const options = new Map<string, string>();
    notifications.forEach((notification) => {
      options.set(notificationTypeKey(notification), notificationTypeLabel(notification));
    });
    return [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  }, [notifications]);
  const senderOptions = useMemo<NotificationFacet[]>(() => {
    const options = new Map<string, string>();
    notifications.forEach((notification) => {
      options.set(
        notificationSenderKey(notification),
        actorLabel(notification.createdByName, notification.createdBy)
      );
    });
    return [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  }, [notifications]);
  const facetFilteredNotifications = useMemo(() => notifications.filter((notification) => {
    const date = notificationDateKey(notification);
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    if (typeFilter !== "all" && notificationTypeKey(notification) !== typeFilter) return false;
    if (senderFilter !== "all" && notificationSenderKey(notification) !== senderFilter) return false;
    return true;
  }), [endDate, notifications, senderFilter, startDate, typeFilter]);
  const pendingCount = useMemo(
    () => facetFilteredNotifications.filter((notification) => notification.status === "pending").length,
    [facetFilteredNotifications]
  );
  const completedCount = useMemo(
    () => facetFilteredNotifications.filter((notification) => notification.status === "completed").length,
    [facetFilteredNotifications]
  );
  const filteredNotifications = useMemo(() => facetFilteredNotifications.filter((notification) => {
    if (filter === "unread") return !notification.readAt;
    if (filter === "pending") return notification.status === "pending";
    if (filter === "completed") return notification.status === "completed";
    return true;
  }), [facetFilteredNotifications, filter]);
  const hasFacetFilters = Boolean(startDate || endDate || typeFilter !== "all" || senderFilter !== "all");

  const loadNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setNotificationLoadError("");
    try {
      const response = await fetch("/api/notifications?limit=500", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "站内信加载失败");
      const loaded = Array.isArray(result.notifications) ? result.notifications : [];
      setNotifications(loaded);
      setTotalCount(Math.max(loaded.length, Number(result.totalCount ?? loaded.length)));
      setUnreadCount(Math.max(0, Number(result.unreadCount ?? 0)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "站内信加载失败";
      setNotificationLoadError(message);
      if (!silent) toast.error(message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(true), 30_000);
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<NotificationRefreshDetail>).detail;
      if (detail?.source === "notification-center") return;
      void loadNotifications(true);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadNotifications(true);
    };
    window.addEventListener("fishroom:notifications-refresh", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("fishroom:notifications-refresh", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      profileDetailRequestCoordinator.cancel();
    };
  }, [loadNotifications, profileDetailRequestCoordinator]);

  const applyNotificationPayload = (result: {
    notifications?: StationNotification[];
    totalCount?: number;
    unreadCount?: number;
  }): boolean => {
    if (!Array.isArray(result.notifications)) return false;
    const nextUnreadCount = Math.max(0, Number(result.unreadCount ?? 0));
    setNotifications(result.notifications);
    setTotalCount(Math.max(result.notifications.length, Number(result.totalCount ?? result.notifications.length)));
    setUnreadCount(nextUnreadCount);
    notifyNotificationRefresh(nextUnreadCount);
    return true;
  };

  const markRead = async (notification: StationNotification) => {
    if (notification.readAt) return;
    const readAt = new Date().toISOString();
    setNotifications((current) => current.map((item) =>
      item.id === notification.id ? { ...item, readAt } : item
    ));
    setUnreadCount((current) => Math.max(0, current - 1));
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ id: notification.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || "标记失败");
      const nextUnreadCount = Math.max(0, Number(result.unreadCount ?? 0));
      setUnreadCount(nextUnreadCount);
      notifyNotificationRefresh(nextUnreadCount);
    } catch {
      toast.error("标记已读失败，请重试");
      void loadNotifications(true);
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    const readAt = new Date().toISOString();
    setNotifications((current) => current.map((notification) => ({
      ...notification,
      readAt: notification.readAt || readAt,
    })));
    setUnreadCount(0);
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ all: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || "标记失败");
      const nextUnreadCount = Math.max(0, Number(result.unreadCount ?? 0));
      setUnreadCount(nextUnreadCount);
      notifyNotificationRefresh(nextUnreadCount);
    } catch {
      toast.error("全部已读保存失败，请重试");
      void loadNotifications(true);
    }
  };

  const openOrder = (notification: StationNotification) => {
    void markRead(notification);
    if (!notification.orderId) return;
    if (notification.siteId) setActiveSiteId(notification.siteId);
    onOpenOrder(notification.orderId);
  };

  const startCreditConfirmation = (notification: StationNotification) => {
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
        body: JSON.stringify({
          orderId: selected.orderId,
          note: creditNote.trim(),
          responseMode: "compact",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "确认赊销失败");
      setState((current) => ({
        ...current,
        orders: Array.isArray(result.orders)
          ? result.orders
          : result.order
            ? mergeEntityChanges<Order>(current.orders, [result.order])
            : current.orders,
        operationLogs: result.operationLog
          ? [result.operationLog, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, 10000)
          : current.operationLogs,
      }));
      setSelected(null);
      setCreditNote("");
      if (!applyNotificationPayload(result)) {
        notifyNotificationRefresh();
        void loadNotifications(true);
      }
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

  const loadStockApprovalDetails = async (notification: StationNotification) => {
    if (notification.stockDetails) {
      setLoadingApprovalDetails(false);
      setApprovalDetailError("");
      return;
    }
    setLoadingApprovalDetails(true);
    setApprovalDetailError("");
    try {
      const response = await fetch(`/api/notifications/detail?id=${encodeURIComponent(notification.id)}`, {
        headers: authJsonHeaders(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.notification) {
        throw new Error(result.error || "库存审批明细加载失败");
      }
      setSelectedApproval((current) => current?.id === notification.id ? result.notification : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "库存审批明细加载失败";
      setApprovalDetailError(message);
      toast.error(message);
    } finally {
      setLoadingApprovalDetails(false);
    }
  };

  const openStockApproval = (
    notification: StationNotification,
    decision: "approve" | "reject" | null
  ) => {
    setApprovalDecision(decision);
    setApprovalNote("");
    setSelectedApproval(notification);
    void markRead(notification);
    void loadStockApprovalDetails(notification);
  };

  const processStockApproval = async () => {
    if (
      !selectedApproval?.approvalRequestId ||
      !approvalDecision ||
      processingApproval ||
      loadingApprovalDetails ||
      approvalDetailError
    ) return;
    setProcessingApproval(true);
    try {
      const response = await fetch("/api/approvals/stock", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          requestId: selectedApproval.approvalRequestId,
          decision: approvalDecision,
          note: approvalNote.trim(),
          responseMode: "compact",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "库存审批处理失败");
      setState((current) => ({
        ...current,
        stock: Array.isArray(result.stock)
          ? result.stock
          : result.mutation
            ? mergeEntityChanges<StockItem>(
                current.stock,
                Array.isArray(result.mutation.stockUpserts) ? result.mutation.stockUpserts : [],
                Array.isArray(result.mutation.stockDeleteIds) ? result.mutation.stockDeleteIds : []
              )
            : current.stock,
        batches: Array.isArray(result.batches)
          ? result.batches
          : result.mutation
            ? mergeEntityChanges<PurchaseBatch>(
                current.batches,
                Array.isArray(result.mutation.batchUpdates) ? result.mutation.batchUpdates : []
              )
            : current.batches,
        orders: Array.isArray(result.orders)
          ? result.orders
          : result.mutation
            ? mergeEntityChanges<Order>(
                current.orders,
                Array.isArray(result.mutation.orderUpdates) ? result.mutation.orderUpdates : []
              )
            : current.orders,
        shipments: Array.isArray(result.shipments)
          ? result.shipments
          : result.mutation
            ? mergeEntityChanges<Shipment>(
                current.shipments,
                Array.isArray(result.mutation.shipmentUpdates) ? result.mutation.shipmentUpdates : []
              )
            : current.shipments,
        operationLogs: result.operationLog
          ? [result.operationLog, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, 10000)
          : current.operationLogs,
      }));
      setSelectedApproval(null);
      setApprovalNote("");
      if (!applyNotificationPayload(result)) {
        notifyNotificationRefresh();
        void loadNotifications(true);
      }
      toast.success(result.message || (approvalDecision === "approve" ? "已批准并执行" : "已驳回"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "库存审批处理失败");
    } finally {
      setProcessingApproval(false);
    }
  };

  const loadProfileApprovalDetails = async (notification: StationNotification, force = false) => {
    profileDetailRequestCoordinator.cancel();
    setLoadedProfileDetailNotificationId("");
    if (!force && Array.isArray(notification.profileChanges)) {
      setLoadingProfileDetails(false);
      setProfileDetailError("");
      setLoadedProfileDetailNotificationId(notification.id);
      return;
    }
    const request = profileDetailRequestCoordinator.begin(notification.id);
    setLoadingProfileDetails(true);
    setProfileDetailError("");
    try {
      const response = await fetch(`/api/notifications/detail?id=${encodeURIComponent(notification.id)}`, {
        headers: authJsonHeaders(),
        signal: request.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.notification || !Array.isArray(result.notification.profileChanges)) {
        throw new Error(result.error || "人员资料审批明细加载失败");
      }
      if (!profileDetailRequestCoordinator.isCurrent(request)) return;
      if (
        String(result.notification.id ?? "") !== notification.id ||
        String(result.notification.profileRequestId ?? "") !== String(notification.profileRequestId ?? "")
      ) throw new Error("人员资料审批明细与当前申请不匹配，请重新打开后重试");
      setSelectedProfileApproval((current) => current?.id === notification.id ? result.notification : current);
      setLoadedProfileDetailNotificationId(notification.id);
    } catch (error) {
      if (!profileDetailRequestCoordinator.isCurrent(request)) return;
      const message = error instanceof Error ? error.message : "人员资料审批明细加载失败";
      setProfileDetailError(message);
      toast.error(message);
    } finally {
      if (profileDetailRequestCoordinator.isCurrent(request)) setLoadingProfileDetails(false);
    }
  };

  const closeProfileApproval = () => {
    profileDetailRequestCoordinator.cancel();
    setSelectedProfileApproval(null);
    setProfileDecision(null);
    setProfileNote("");
    setProfileDetailError("");
    setLoadedProfileDetailNotificationId("");
    setLoadingProfileDetails(false);
    setAccessingProfileAttachmentId("");
  };

  const openProfileApproval = (
    notification: StationNotification,
    decision: "approve" | "reject" | null
  ) => {
    profileDetailRequestCoordinator.cancel();
    setProfileDecision(decision);
    setProfileNote("");
    setProfileDetailError("");
    setLoadedProfileDetailNotificationId("");
    setLoadingProfileDetails(true);
    setSelectedProfileApproval(notification);
    void markRead(notification);
    void loadProfileApprovalDetails(notification);
  };

  const processProfileApproval = async () => {
    if (profileDecision === "reject" && !profileNote.trim()) {
      toast.error("请填写驳回原因，便于申请人修改后重新提交");
      return;
    }
    if (!profileActionReady) return;
    setProcessingProfileApproval(true);
    try {
      const response = await fetch("/api/personnel/profile-requests/decision", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          requestId: selectedProfileApproval.profileRequestId,
          decision: profileDecision,
          note: profileNote.trim(),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "人员资料审批处理失败");
      if (Array.isArray(result.personnel)) {
        setState((current) => ({
          ...current,
          personnel: result.personnel,
          operationLogs: result.operationLog
            ? [result.operationLog, ...(current.operationLogs ?? [])]
                .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
                .slice(0, 10000)
            : current.operationLogs,
        }));
      }
      closeProfileApproval();
      if (!applyNotificationPayload(result)) {
        notifyNotificationRefresh();
        void loadNotifications(true);
      }
      toast.success(result.message || (profileDecision === "approve" ? "人员资料已批准并生效" : "人员资料申请已驳回"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "人员资料审批处理失败");
    } finally {
      setProcessingProfileApproval(false);
    }
  };

  const accessProfileAttachment = async (attachment: PersonnelProfileAttachment, download: boolean) => {
    if (!attachment.id || accessingProfileAttachmentId) return;
    setAccessingProfileAttachmentId(attachment.id);
    try {
      const response = await fetch(
        `/api/personnel/attachments/${encodeURIComponent(attachment.id)}${download ? "?download=1" : ""}`,
        { headers: authJsonHeaders() }
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || (download ? "附件下载失败" : "附件预览失败"));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (!download) {
        const preview = document.createElement("a");
        preview.href = url;
        preview.target = "_blank";
        preview.rel = "noopener noreferrer";
        preview.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.originalName || "人员资料附件";
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : download ? "附件下载失败" : "附件预览失败");
    } finally {
      setAccessingProfileAttachmentId((current) => current === attachment.id ? "" : current);
    }
  };

  const filters: { value: NotificationFilter; label: string; count: number }[] = [
    { value: "all", label: "全部", count: hasFacetFilters ? facetFilteredNotifications.length : totalCount },
    { value: "unread", label: "未读", count: facetFilteredNotifications.filter((notification) => !notification.readAt).length },
    { value: "pending", label: "待处理", count: pendingCount },
    { value: "completed", label: "已处理", count: completedCount },
  ];
  const selectedStockDetails = selectedApproval?.stockDetails?.type === "stock_delete"
    ? selectedApproval.stockDetails
    : null;
  const selectedStockChangeDetails = selectedApproval?.stockDetails?.type === "stock_change"
    ? selectedApproval.stockDetails
    : null;
  const groupedProfileChanges = (selectedProfileApproval?.profileChanges ?? []).reduce<Record<string, PersonnelProfileChange[]>>(
    (groups, change) => {
      const section = change.section || "资料变更";
      (groups[section] ??= []).push(change);
      return groups;
    },
    {}
  );
  const profileDetailsReady = profileApprovalDetailsReady({
    selectedNotificationId: selectedProfileApproval?.id,
    loadedNotificationId: loadedProfileDetailNotificationId,
    profileChanges: selectedProfileApproval?.profileChanges,
  });
  const profileActionReady = profileApprovalActionReady({
    profileRequestId: selectedProfileApproval?.profileRequestId,
    decision: profileDecision,
    processing: processingProfileApproval,
    loadingDetails: loadingProfileDetails,
    detailError: profileDetailError,
    detailsReady: profileDetailsReady,
    note: profileNote,
  });

  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-sky-700">
              <Inbox className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">站内信中心</h1>
              <p className="mt-1 text-sm text-muted-foreground">集中查看系统提醒、审批事项和处理结果</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadNotifications()} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1">
            {filters.map((item) => (
              <Button
                key={item.value}
                type="button"
                variant={filter === item.value ? "default" : "ghost"}
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setFilter(item.value)}
              >
                {item.label}
                <span className={filter === item.value ? "text-primary-foreground/75" : "text-muted-foreground"}>
                  {item.count}
                </span>
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void markAllRead()}
            disabled={unreadCount === 0}
          >
            <CheckCheck className="size-4" />
            全部已读
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b pb-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] lg:items-end">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="notification-start-date">
              开始日期
            </label>
            <Input
              id="notification-start-date"
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="notification-end-date">
              结束日期
            </label>
            <Input
              id="notification-end-date"
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">消息类型</label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-full" aria-label="消息类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                {typeOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">发件人</label>
            <Select value={senderFilter} onValueChange={setSenderFilter}>
              <SelectTrigger className="w-full" aria-label="发件人"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部发件人</SelectItem>
                {senderOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="col-span-2 w-full lg:col-span-1 lg:w-auto"
            disabled={!hasFacetFilters}
            onClick={() => {
              setStartDate("");
              setEndDate("");
              setTypeFilter("all");
              setSenderFilter("all");
            }}
          >
            <FilterX className="size-4" />清除筛选
          </Button>
        </div>

        <div className="overflow-hidden rounded-md border bg-card">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2">
            <div className="text-sm font-semibold">
              {filters.find((item) => item.value === filter)?.label}消息
            </div>
            <div className="text-xs text-muted-foreground">
              {filteredNotifications.length} 条
            </div>
          </div>

          {notificationLoadError && (
            <div className="m-3 flex flex-col items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-900 sm:flex-row sm:items-center" role="alert">
              <div>
                <div className="font-medium">
                  {notifications.length > 0 ? "站内信刷新失败，以下内容可能不是最新" : "站内信暂时无法加载"}
                </div>
                <div className="mt-1 text-xs leading-5 text-red-800">{notificationLoadError}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                disabled={loading}
                onClick={() => void loadNotifications()}
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                {loading ? "重新加载中" : "重新加载"}
              </Button>
            </div>
          )}

          {loading && notifications.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />正在加载站内信
            </div>
          ) : notificationLoadError && notifications.length === 0 ? null : filteredNotifications.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Inbox className="size-6" />
              当前筛选下暂无站内信
            </div>
          ) : (
            <div className="divide-y">
              {filteredNotifications.map((notification) => {
                const pending = notification.status === "pending";
                return (
                  <div
                    key={notification.id}
                    className={`px-4 py-4 sm:px-5 ${notification.readAt ? "bg-card" : "bg-sky-50/60"}`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {!notification.readAt && <span className="size-2 shrink-0 rounded-full bg-sky-500" />}
                          <div className="text-sm font-semibold text-foreground">{notification.title}</div>
                          <Badge variant="secondary" className="font-normal">
                            {notificationTypeLabel(notification)}
                          </Badge>
                        </div>
                        <div className="mt-1.5 text-sm leading-6 text-muted-foreground">{notification.message}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatNotificationTime(notification.updatedAt || notification.createdAt)}</span>
                          <span className="inline-flex items-center gap-1">
                            <UserRound className="size-3.5" />
                            来自：{actorLabel(notification.createdByName, notification.createdBy)}
                          </span>
                          {notification.resolvedBy && (
                            <span>
                              {notification.type === "credit_sale_confirmation" ? "审批人" : "处理人"}：
                              {actorLabel(notification.resolvedByName, notification.resolvedBy)}
                            </span>
                          )}
                        </div>
                        {notification.resolutionNote && (
                          <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                            处理说明：{notification.resolutionNote}
                          </div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={pending
                          ? "w-fit shrink-0 border-amber-200 bg-amber-50 text-amber-700"
                          : notification.resolution === "rejected"
                            ? "w-fit shrink-0 border-red-200 bg-red-50 text-red-700"
                            : "w-fit shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700"}
                      >
                        {notificationResultLabel(notification)}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      {!notification.readAt && (
                        <Button variant="ghost" size="sm" onClick={() => void markRead(notification)}>
                          <Check className="size-3.5" />标为已读
                        </Button>
                      )}
                      {notification.orderId && (
                        <Button variant="outline" size="sm" onClick={() => openOrder(notification)}>
                          <ExternalLink className="size-3.5" />查看订单
                        </Button>
                      )}
                      {notification.type === "stock_approval" && notification.approvalRequestId && (
                        <Button variant="outline" size="sm" onClick={() => openStockApproval(notification, null)}>
                          <Boxes className="size-3.5" />查看明细
                        </Button>
                      )}
                      {notification.type === "personnel_profile_approval" && notification.profileRequestId && (
                        <Button variant="outline" size="sm" onClick={() => openProfileApproval(notification, null)}>
                          <FileUser className="size-3.5" />查看资料变更
                        </Button>
                      )}
                      {pending && notification.type === "credit_sale_confirmation" && notification.canApprove === true && (
                        <Button size="sm" onClick={() => startCreditConfirmation(notification)}>
                          <HandCoins className="size-3.5" />同意赊销
                        </Button>
                      )}
                      {pending && notification.type === "stock_approval" && notification.canApprove === true && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openStockApproval(notification, "reject")}
                          >
                            <XCircle className="size-3.5" />驳回
                          </Button>
                          <Button size="sm" onClick={() => openStockApproval(notification, "approve")}>
                            <CheckCircle2 className="size-3.5" />批准
                          </Button>
                        </>
                      )}
                      {pending && notification.type === "personnel_profile_approval" && notification.canApprove === true && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openProfileApproval(notification, "reject")}
                          >
                            <XCircle className="size-3.5" />驳回
                          </Button>
                          <Button size="sm" onClick={() => openProfileApproval(notification, "approve")}>
                            <CheckCircle2 className="size-3.5" />批准
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {totalCount > notifications.length && (
            <div className="border-t bg-muted/20 px-4 py-2 text-center text-xs text-muted-foreground">
              当前显示最近 {notifications.length} 条，共 {totalCount} 条
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(nextOpen) => {
        if (!nextOpen && !confirming) setSelected(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>审批赊销 · {selected?.orderNo}</DialogTitle>
            <DialogDescription className="sr-only">
              核对订单未核销金额并填写赊销审批说明。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
            同意后，该订单可在尚有 ¥{Number(selected?.requiredOutstandingAmount ?? 0).toFixed(2)} 未核销的情况下发货。审批人、时间和说明会同步给其他被选审批人。
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
              {confirming ? "提交中" : "同意赊销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedApproval} onOpenChange={(nextOpen) => {
        if (!nextOpen && !processingApproval) {
          setSelectedApproval(null);
          setApprovalDetailError("");
          setLoadingApprovalDetails(false);
        }
      }}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {approvalDecision === "approve"
                ? "批准库存操作"
                : approvalDecision === "reject"
                  ? "驳回库存操作"
                  : "库存操作明细"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              核对库存操作涉及的批次、供应商、产地、商品和各缸位增减数量。
            </DialogDescription>
          </DialogHeader>
          <div className={`rounded-md border px-3 py-2 text-sm leading-6 ${
            approvalDecision === "approve"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : approvalDecision === "reject"
                ? "border-red-200 bg-red-50 text-red-900"
                : "border-sky-200 bg-sky-50 text-sky-900"
          }`}>
            <div>{selectedApproval?.message}</div>
            <div className="mt-1 text-xs opacity-80">
              发起人：{actorLabel(selectedApproval?.createdByName, selectedApproval?.createdBy)}
            </div>
          </div>
          {loadingApprovalDetails && (
            <div className="flex min-h-28 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />正在加载库存审批明细
            </div>
          )}
          {approvalDetailError && (
            <div className="flex flex-col items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800 sm:flex-row sm:items-center">
              <span>{approvalDetailError}</span>
              {selectedApproval && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadStockApprovalDetails(selectedApproval)}
                >
                  <RefreshCw className="size-3.5" />重试
                </Button>
              )}
            </div>
          )}
          {selectedStockChangeDetails && (
            <section className="grid gap-3" aria-label="库存变更明细">
              <div className="grid grid-cols-3 divide-x rounded-md border bg-muted/30 text-center">
                <div className="px-2 py-2">
                  <div className="text-xs text-muted-foreground">涉及缸位</div>
                  <div className="mt-0.5 font-semibold">{selectedStockChangeDetails.tanks.length}</div>
                </div>
                <div className="px-2 py-2">
                  <div className="text-xs text-muted-foreground">增加</div>
                  <div className="mt-0.5 font-semibold text-emerald-700">+{selectedStockChangeDetails.totals.addCount}</div>
                </div>
                <div className="px-2 py-2">
                  <div className="text-xs text-muted-foreground">减少</div>
                  <div className="mt-0.5 font-semibold text-red-700">-{selectedStockChangeDetails.totals.removeCount}</div>
                </div>
              </div>

              <div className="overflow-hidden rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">批次信息</div>
                <div className="divide-y">
                  {selectedStockChangeDetails.batches.map((batch) => (
                    <div key={batch.batchId || batch.batchNo} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[150px_120px_1fr_auto] sm:items-center sm:gap-3">
                      <div className="font-semibold">{batch.batchNo}</div>
                      <div className="text-muted-foreground">{batch.batchDate || "日期未记录"}</div>
                      <div className="min-w-0">
                        <div>{batch.supplier || "供应商未记录"}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          产地：{batch.origins?.length ? batch.origins.join("、") : "未记录"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 sm:justify-end">
                        {batch.addCount > 0 && <Badge className="bg-emerald-100 text-emerald-800">增加 {batch.addCount}</Badge>}
                        {batch.removeCount > 0 && <Badge className="bg-red-100 text-red-800">减少 {batch.removeCount}</Badge>}
                        {batch.updateCount > 0 && <Badge variant="secondary">修改 {batch.updateCount}</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
                {selectedStockChangeDetails.tanks.map((tank) => (
                  <div key={tank.subTankId || tank.tankName} className="overflow-hidden rounded-md border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-3 py-2">
                      <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
                        <MapPin className="size-3.5 text-sky-700" />{tank.tankName}
                      </div>
                      <div className="flex gap-1.5 text-xs">
                        {tank.addCount > 0 && <span className="font-semibold text-emerald-700">+{tank.addCount}</span>}
                        {tank.removeCount > 0 && <span className="font-semibold text-red-700">-{tank.removeCount}</span>}
                        {tank.updateCount > 0 && <span className="font-semibold text-sky-700">修改 {tank.updateCount}</span>}
                      </div>
                    </div>
                    <div className="divide-y">
                      {tank.rows.map((row) => (
                        <div key={`${row.productId}-${row.batchId}`} className="grid gap-2 px-3 py-2.5 text-sm md:grid-cols-[1.2fr_1fr_1.35fr_auto] md:items-center">
                          <div>
                            <div className="font-medium">{row.productName}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {[row.speciesName !== row.productName ? row.speciesName : "", row.size, row.origin].filter(Boolean).join(" · ") || "商品信息未完整记录"}
                            </div>
                          </div>
                          <div className="text-xs">
                            <div>{row.batchNo}</div>
                            <div className="mt-0.5 text-muted-foreground">{row.batchDate || "日期未记录"}</div>
                          </div>
                          <div className="text-xs">
                            <div>{row.supplier || "供应商未记录"}</div>
                            <div className="mt-0.5 text-muted-foreground">产地：{row.origin || "未记录"}</div>
                          </div>
                          <div className="flex flex-wrap gap-1.5 md:justify-end">
                            {row.addCount > 0 && <Badge className="bg-emerald-100 text-emerald-800">增加 {row.addCount}</Badge>}
                            {row.removeCount > 0 && <Badge className="bg-red-100 text-red-800">减少 {row.removeCount}</Badge>}
                            {row.updateCount > 0 && <Badge variant="secondary">修改 {row.updateCount}</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {selectedStockDetails && (
            <section className="grid gap-2" aria-label="待删除库存明细">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Trash2 className="size-4 text-red-600" />
                  删除明细
                </div>
                <Badge variant="outline">
                  共 {selectedStockDetails.requestedCount} 条
                </Badge>
              </div>
              {selectedStockDetails.availableCount < selectedStockDetails.requestedCount && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  有 {selectedStockDetails.requestedCount - selectedStockDetails.availableCount} 条库存已无法从当前数据中读取，仍保留申请时的库存 ID 供核对。
                </div>
              )}
              <div className="max-h-[46vh] overflow-auto rounded-md border">
                <div className="divide-y md:hidden">
                  {selectedStockDetails.items.map((item) => (
                    <div key={item.stockItemId} className="grid gap-3 p-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="size-14 shrink-0 rounded-md border object-cover"
                          />
                        ) : (
                          <div className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                            <Boxes className="size-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="break-all text-sm font-semibold">{item.code}</div>
                          <div className="mt-0.5 text-sm">{item.missing ? "原库存已不存在" : item.productName}</div>
                          {!item.missing && (
                            <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                              {item.speciesName && item.speciesName !== item.productName && <span>{item.speciesName}</span>}
                              {item.size && <span>{item.size}</span>}
                              {item.origin && <span>{item.origin}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                      {!item.missing && (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                          <div>
                            <div className="text-muted-foreground">缸位</div>
                            <div className="mt-0.5 inline-flex items-start gap-1 font-medium">
                              <MapPin className="mt-0.5 size-3 shrink-0" />{item.tankName || "未设置"}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">批次 / 供应商</div>
                            <div className="mt-0.5 font-medium">{item.batchNo || "未设置"}</div>
                            {item.supplier && <div className="mt-0.5 text-muted-foreground">{item.supplier}</div>}
                          </div>
                          <div>
                            <div className="text-muted-foreground">库存状态</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{stockStatusLabel(item.status)}</Badge>
                              {item.sold && <Badge className="h-5 bg-amber-100 px-1.5 text-[11px] text-amber-800">已售</Badge>}
                              {item.lost && <Badge className="h-5 bg-red-100 px-1.5 text-[11px] text-red-800">已损耗</Badge>}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">入库日期 / 底价</div>
                            <div className="mt-0.5 font-medium">{item.inDate || "未记录"}</div>
                            <div className="mt-0.5">¥{Number(item.basePrice ?? 0).toFixed(2)}</div>
                          </div>
                        </div>
                      )}
                      {!!item.linkedOrders?.length && (
                        <div className="rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900">
                          关联订单：{item.linkedOrders.map((order) => order.orderNo || order.id).join("、")}
                        </div>
                      )}
                      {item.notes && (
                        <div className="text-xs leading-5 text-muted-foreground">备注：{item.notes}</div>
                      )}
                    </div>
                  ))}
                </div>

                <table className="hidden w-full min-w-[920px] table-fixed text-sm md:table">
                  <thead className="sticky top-0 z-10 bg-muted/95 text-left text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="w-[210px] px-3 py-2 font-medium">鱼只</th>
                      <th className="w-[135px] px-3 py-2 font-medium">缸位</th>
                      <th className="w-[150px] px-3 py-2 font-medium">批次 / 供应商</th>
                      <th className="w-[110px] px-3 py-2 font-medium">状态</th>
                      <th className="w-[120px] px-3 py-2 font-medium">入库 / 底价</th>
                      <th className="w-[145px] px-3 py-2 font-medium">关联订单</th>
                      <th className="px-3 py-2 font-medium">备注</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {selectedStockDetails.items.map((item) => (
                      <tr key={item.stockItemId} className="align-top">
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 gap-2.5">
                            {item.imageUrl ? (
                              <img src={item.imageUrl} alt="" className="size-10 shrink-0 rounded border object-cover" />
                            ) : (
                              <div className="flex size-10 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                                <Boxes className="size-4" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="break-all font-semibold">{item.code}</div>
                              <div className="mt-0.5 break-words text-xs text-muted-foreground">
                                {item.missing
                                  ? "原库存已不存在"
                                  : [item.productName, item.speciesName !== item.productName ? item.speciesName : "", item.size, item.origin]
                                      .filter(Boolean)
                                      .join(" · ")}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="break-words px-3 py-3 text-xs">
                          {item.missing ? "-" : item.tankName || "未设置"}
                        </td>
                        <td className="break-words px-3 py-3 text-xs">
                          <div>{item.missing ? "-" : item.batchNo || "未设置"}</div>
                          {item.supplier && <div className="mt-1 text-muted-foreground">{item.supplier}</div>}
                        </td>
                        <td className="px-3 py-3">
                          {!item.missing && (
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{stockStatusLabel(item.status)}</Badge>
                              {item.sold && <Badge className="h-5 bg-amber-100 px-1.5 text-[11px] text-amber-800">已售</Badge>}
                              {item.lost && <Badge className="h-5 bg-red-100 px-1.5 text-[11px] text-red-800">已损耗</Badge>}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          {item.missing ? (
                            "-"
                          ) : (
                            <>
                              <div>{item.inDate || "未记录"}</div>
                              <div className="mt-1 font-medium">¥{Number(item.basePrice ?? 0).toFixed(2)}</div>
                            </>
                          )}
                        </td>
                        <td className="break-words px-3 py-3 text-xs leading-5">
                          {item.linkedOrders?.length
                            ? item.linkedOrders.map((order) => (
                                <div key={order.id || order.orderNo}>
                                  {order.orderNo || order.id}
                                  {order.source && <span className="text-muted-foreground"> · {order.source}</span>}
                                </div>
                              ))
                            : "无"}
                        </td>
                        <td className="break-words px-3 py-3 text-xs leading-5 text-muted-foreground">
                          {item.notes || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {approvalDecision && <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="stock-approval-note">审批说明</label>
            <Textarea
              id="stock-approval-note"
              rows={3}
              maxLength={500}
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              placeholder={approvalDecision === "approve" ? "可填写批准说明" : "建议填写驳回原因"}
            />
          </div>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={processingApproval}
              onClick={() => setSelectedApproval(null)}
            >
              {approvalDecision ? "取消" : "关闭"}
            </Button>
            {approvalDecision && <Button
              variant={approvalDecision === "approve" ? "default" : "destructive"}
              disabled={processingApproval || loadingApprovalDetails || Boolean(approvalDetailError)}
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
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedProfileApproval} onOpenChange={(nextOpen) => {
        if (!nextOpen && !processingProfileApproval) closeProfileApproval();
      }}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {profileDecision === "approve"
                ? "批准人员资料修改"
                : profileDecision === "reject"
                  ? "驳回人员资料修改"
                  : "人员资料修改明细"}
            </DialogTitle>
            <DialogDescription>
              仅批准后才会写入正式人员档案。申请本人只能在线预览自己的附件；管理员下载当前或申请附件均会留痕，请妥善保管本地副本。
            </DialogDescription>
          </DialogHeader>

          <div className={`rounded-md border px-3 py-2 text-sm leading-6 ${
            profileDecision === "approve"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : profileDecision === "reject"
                ? "border-red-200 bg-red-50 text-red-900"
                : "border-sky-200 bg-sky-50 text-sky-900"
          }`}>
            <div>{selectedProfileApproval?.message}</div>
            <div className="mt-1 text-xs opacity-80">
              申请人：{actorLabel(selectedProfileApproval?.createdByName, selectedProfileApproval?.createdBy)}
            </div>
            {profileDecision === "approve" && (
              <div className="mt-1 text-xs opacity-80">
                本次只写入下方本人资料；部门、岗位、入职日期和工作区域可由管理员后续补充，不影响本次批准。
              </div>
            )}
          </div>

          {loadingProfileDetails && (
            <div className="flex min-h-28 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />正在安全加载资料变更
            </div>
          )}
          {profileDetailError && (
            <div className="flex flex-col items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800 sm:flex-row sm:items-center">
              <span>{profileDetailError}</span>
              {selectedProfileApproval && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadProfileApprovalDetails(selectedProfileApproval)}
                >
                  <RefreshCw className="size-3.5" />重试
                </Button>
              )}
            </div>
          )}

          {!loadingProfileDetails && !profileDetailError && (
            <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {Object.entries(groupedProfileChanges).length === 0 ? (
                <div className="grid justify-items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-8 text-center text-sm text-amber-900" role="alert">
                  <span>没有可核对的资料差异，当前申请不可批准或驳回。</span>
                  {selectedProfileApproval && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => void loadProfileApprovalDetails(selectedProfileApproval, true)}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" />重新加载明细
                    </Button>
                  )}
                </div>
              ) : Object.entries(groupedProfileChanges).map(([section, changes]) => (
                <section key={section} className="overflow-hidden rounded-md border" aria-label={section}>
                  <div className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">{section}</div>
                  <div className="divide-y">
                    {changes.map((change) => {
                      const hasAttachmentChange = Boolean(change.beforeAttachment || change.afterAttachment);
                      const attachmentChange = profileAttachmentChangeKind(change.beforeAttachment, change.afterAttachment);
                      const attachmentChangeCopy = PROFILE_ATTACHMENT_CHANGE_COPY[attachmentChange];
                      const requesterPreview = selectedProfileApproval?.notificationRole === "requester";
                      return (
                        <div key={change.field} className="grid gap-2 px-3 py-3 text-sm md:grid-cols-[9rem_1fr_1fr] md:items-start">
                          <div className="font-medium">
                            {change.label}
                            {change.sensitive && (
                                <Badge variant="outline" className="ml-2 border-amber-200 text-[10px] text-amber-700">敏感</Badge>
                              )}
                            {hasAttachmentChange && (
                              <Badge variant="outline" className={`ml-2 text-[10px] ${attachmentChangeCopy.className}`}>
                                {attachmentChangeCopy.label}
                              </Badge>
                            )}
                          </div>
                          {hasAttachmentChange ? (
                            <div className="grid gap-2 sm:grid-cols-2 md:col-span-2">
                              <ProfileAttachmentSnapshot
                                heading="当前档案"
                                attachment={change.beforeAttachment}
                                requested={false}
                                download={!requesterPreview}
                                busy={accessingProfileAttachmentId === change.beforeAttachment?.id}
                                disabled={Boolean(accessingProfileAttachmentId)}
                                onAccess={(attachment, download) => void accessProfileAttachment(attachment, download)}
                              />
                              <ProfileAttachmentSnapshot
                                heading="申请修改为"
                                attachment={change.afterAttachment}
                                requested
                                download={!requesterPreview}
                                busy={accessingProfileAttachmentId === change.afterAttachment?.id}
                                disabled={Boolean(accessingProfileAttachmentId)}
                                onAccess={(attachment, download) => void accessProfileAttachment(attachment, download)}
                              />
                            </div>
                          ) : (
                            <>
                              <div className="rounded-md bg-muted/30 px-3 py-2 text-muted-foreground">
                                <div className="mb-0.5 text-[11px]">修改前</div>
                                <div className="break-words whitespace-pre-wrap">{change.beforeValue || "未填写"}</div>
                              </div>
                              <div className="rounded-md bg-sky-50 px-3 py-2 text-sky-950">
                                <div className="mb-0.5 text-[11px] text-sky-700">申请修改为</div>
                                <div className="break-words whitespace-pre-wrap">{change.afterValue || "未填写"}</div>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {profileDecision && (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="profile-approval-note">
                审批说明{profileDecision === "reject" && <span className="ml-0.5 text-red-500">*</span>}
              </label>
              <Textarea
                id="profile-approval-note"
                rows={3}
                maxLength={500}
                value={profileNote}
                onChange={(event) => setProfileNote(event.target.value)}
                placeholder={profileDecision === "approve" ? "可填写核对说明" : "请说明需要修改的内容"}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={processingProfileApproval}
              onClick={closeProfileApproval}
            >
              {profileDecision ? "取消" : "关闭"}
            </Button>
            {profileDecision && (
              <Button
                variant={profileDecision === "approve" ? "default" : "destructive"}
                disabled={!profileActionReady}
                onClick={() => void processProfileApproval()}
              >
                {processingProfileApproval
                  ? <Loader2 className="size-4 animate-spin" />
                  : profileDecision === "approve"
                    ? <CheckCircle2 className="size-4" />
                    : <XCircle className="size-4" />}
                {processingProfileApproval
                  ? "处理中"
                  : profileDecision === "approve"
                    ? "批准并写入档案"
                    : "确认驳回"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
