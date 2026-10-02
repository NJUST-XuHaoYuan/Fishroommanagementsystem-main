import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { authJsonHeaders } from "../utils/authSession";
import {
  newCustomerApprovalDetailFromPayload,
  newCustomerRequestActionReady,
  newCustomerReviewActionReady,
  type NewCustomerApprovalDetail,
  type NewCustomerApprovalStatus,
} from "../utils/notificationCenter";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";

export type NewCustomerApprovalUpdatedOrder = { id: string } & Record<string, unknown>;

export type NewCustomerApprovalPanelProps = {
  orderId: string;
  /** When set, detail is loaded through the station-notification endpoint. */
  notificationId?: string;
  /** Prevents a stale notification from opening a different approval request. */
  approvalRequestId?: string;
  /** Optional server-provided detail for embedding or deterministic rendering. */
  initialDetail?: NewCustomerApprovalDetail | null;
  onOrderUpdated?: (order: NewCustomerApprovalUpdatedOrder) => void;
  onChanged?: (change: {
    action: "request" | "approve" | "reject";
    order?: NewCustomerApprovalUpdatedOrder;
  }) => void | Promise<void>;
  className?: string;
};

type BusyAction = "request" | "approve" | "reject" | null;

const STATUS_COPY: Record<NewCustomerApprovalStatus, {
  label: string;
  className: string;
  icon: typeof Clock3;
}> = {
  pending: {
    label: "待管理员审批",
    className: "border-amber-200 bg-amber-50 text-amber-800",
    icon: Clock3,
  },
  approved: {
    label: "已批准为新客首单",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    icon: CheckCircle2,
  },
  rejected: {
    label: "申请已驳回",
    className: "border-red-200 bg-red-50 text-red-800",
    icon: XCircle,
  },
};

function formatTime(value?: string): string {
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

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  return String((payload as { error?: unknown }).error ?? "").trim() || fallback;
}

function resultOrder(payload: unknown): NewCustomerApprovalUpdatedOrder | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const order = (payload as { order?: unknown }).order;
  if (!order || typeof order !== "object" || Array.isArray(order)) return undefined;
  const id = String((order as { id?: unknown }).id ?? "").trim();
  return id ? order as NewCustomerApprovalUpdatedOrder : undefined;
}

export function NewCustomerApprovalPanel({
  orderId,
  notificationId,
  approvalRequestId,
  initialDetail = null,
  onOrderUpdated,
  onChanged,
  className = "",
}: NewCustomerApprovalPanelProps) {
  const initialMatches = initialDetail?.orderId === orderId;
  const [detail, setDetail] = useState<NewCustomerApprovalDetail | null>(initialMatches ? initialDetail : null);
  const [loading, setLoading] = useState(!initialMatches);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [requestReason, setRequestReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [confirmUnknownCustomer, setConfirmUnknownCustomer] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const mutationPendingRef = useRef(false);
  const requestRef = useRef<{ sequence: number; controller: AbortController | null }>({
    sequence: 0,
    controller: null,
  });

  const loadDetail = useCallback(async (fromOrderEndpoint = false) => {
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = requestRef.current.sequence + 1;
    requestRef.current = { sequence, controller };
    setLoading(true);
    setLoadError("");
    try {
      const endpoint = notificationId && !fromOrderEndpoint
        ? `/api/notifications/detail?id=${encodeURIComponent(notificationId)}`
        : `/api/orders/new-customer/detail?orderId=${encodeURIComponent(orderId)}`;
      const response = await fetch(endpoint, {
        headers: authJsonHeaders(),
        signal: controller.signal,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload as { ok?: boolean }).ok === false) {
        throw new Error(errorMessage(payload, "新客首单申请详情加载失败"));
      }
      const nextDetail = newCustomerApprovalDetailFromPayload(payload);
      if (!nextDetail) throw new Error("服务端未返回可核对的新客首单申请详情");
      if (nextDetail.orderId !== orderId) throw new Error("申请详情与当前订单不匹配，请重新打开后重试");
      if (
        approvalRequestId &&
        String(nextDetail.approval?.requestId ?? "") !== String(approvalRequestId)
      ) throw new Error("站内信与当前审批申请不匹配，请刷新后重试");
      if (requestRef.current.sequence !== sequence || controller.signal.aborted) return;
      setDetail(nextDetail);
      setConfirmUnknownCustomer(false);
    } catch (error) {
      if (controller.signal.aborted || requestRef.current.sequence !== sequence) return;
      setLoadError(error instanceof Error ? error.message : "新客首单申请详情加载失败");
    } finally {
      if (requestRef.current.sequence === sequence && !controller.signal.aborted) setLoading(false);
    }
  }, [approvalRequestId, notificationId, orderId]);

  useEffect(() => {
    setActionError("");
    setRequestReason("");
    setReviewNote("");
    setConfirmUnknownCustomer(false);
    if (initialDetail?.orderId === orderId) {
      requestRef.current.controller?.abort();
      setDetail(initialDetail);
      setLoadError("");
      setLoading(false);
    } else {
      setDetail(null);
      void loadDetail();
    }
    return () => requestRef.current.controller?.abort();
  }, [initialDetail, loadDetail, orderId]);

  const applyReturnedOrder = (payload: unknown) => {
    const order = resultOrder(payload);
    if (order) {
      try {
        onOrderUpdated?.(order);
      } catch {
        toast.error("审批已保存，但订单列表同步失败，请手动刷新");
      }
    }
    return order;
  };

  const notifyChanged = async (change: {
    action: "request" | "approve" | "reject";
    order?: NewCustomerApprovalUpdatedOrder;
  }) => {
    try {
      await onChanged?.(change);
    } catch {
      toast.error("审批已保存，但关联页面刷新失败，请手动刷新");
    }
  };

  const handleConflict = async (payload: unknown, fallback: string) => {
    applyReturnedOrder(payload);
    await loadDetail(true);
    setActionError(errorMessage(payload, fallback));
  };

  const submitRequest = async () => {
    if (mutationPendingRef.current || !newCustomerRequestActionReady({
      orderId,
      canRequest: detail?.canRequest,
      reason: requestReason,
      processing: busyAction !== null,
    })) return;
    mutationPendingRef.current = true;
    setBusyAction("request");
    setActionError("");
    try {
      const response = await fetch("/api/orders/new-customer/request", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          orderId,
          reason: requestReason.trim(),
          expectedApprovalVersion: detail?.approval?.version ?? 0,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        await handleConflict(payload, "申请状态已变化，已刷新为最新内容");
        return;
      }
      if (!response.ok || (payload as { ok?: boolean }).ok === false) {
        throw new Error(errorMessage(payload, "新客首单申请提交失败"));
      }
      const order = applyReturnedOrder(payload);
      setRequestReason("");
      await loadDetail(true);
      await notifyChanged({ action: "request", order });
      toast.success("新客首单申请已提交，等待管理员审批");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "新客首单申请提交失败");
    } finally {
      mutationPendingRef.current = false;
      setBusyAction(null);
    }
  };

  const submitReview = async (decision: "approve" | "reject") => {
    if (mutationPendingRef.current || !newCustomerReviewActionReady({
      requestId: detail?.approval?.requestId,
      decision,
      canApprove: detail?.canApprove,
      note: reviewNote,
      identityKnown: detail?.customerEvidence.identityKnown,
      confirmCustomerIdentity: confirmUnknownCustomer,
      processing: busyAction !== null,
    })) return;
    mutationPendingRef.current = true;
    setBusyAction(decision);
    setActionError("");
    try {
      const response = await fetch("/api/orders/new-customer/review", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          orderId,
          requestId: detail?.approval?.requestId,
          decision,
          note: reviewNote.trim(),
          expectedApprovalVersion: detail?.approval?.version ?? 0,
          ...(
            decision === "approve" && detail?.customerEvidence.identityKnown !== true
              ? { confirmCustomerIdentity: true }
              : {}
          ),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        await handleConflict(payload, "该申请已被其他管理员处理，已刷新为最新状态");
        return;
      }
      if (!response.ok || (payload as { ok?: boolean }).ok === false) {
        throw new Error(errorMessage(payload, decision === "approve" ? "批准失败" : "驳回失败"));
      }
      const order = applyReturnedOrder(payload);
      setReviewNote("");
      setConfirmUnknownCustomer(false);
      await loadDetail(true);
      await notifyChanged({ action: decision, order });
      toast.success(decision === "approve" ? "新客首单申请已批准" : "新客首单申请已驳回");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : decision === "approve" ? "批准失败" : "驳回失败");
    } finally {
      mutationPendingRef.current = false;
      setBusyAction(null);
    }
  };

  const approval = detail?.approval;
  const statusCopy = approval ? STATUS_COPY[approval.status] : null;
  const StatusIcon = statusCopy?.icon;
  const identityKnown = detail?.customerEvidence.identityKnown === true;
  const canSubmitRequest = newCustomerRequestActionReady({
    orderId,
    canRequest: detail?.canRequest,
    reason: requestReason,
    processing: busyAction !== null,
  });
  const canApprove = newCustomerReviewActionReady({
    requestId: approval?.requestId,
    decision: "approve",
    canApprove: detail?.canApprove,
    note: reviewNote,
    identityKnown,
    confirmCustomerIdentity: confirmUnknownCustomer,
    processing: busyAction !== null,
  });
  const canReject = newCustomerReviewActionReady({
    requestId: approval?.requestId,
    decision: "reject",
    canApprove: detail?.canApprove,
    note: reviewNote,
    identityKnown,
    confirmCustomerIdentity: confirmUnknownCustomer,
    processing: busyAction !== null,
  });

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="border-b pb-3 text-sm leading-6 text-muted-foreground">
        <p>
          普通订单按核销商品实收计：负责人个人 0.2%，另有 0.3% 进入公共团队池；新客首单获批后改按负责人个人 5% 计，不再计上述两项。运费、包装费不计入。
        </p>
        <p className="mt-1 text-xs">
          仅适用于中国时区 2026-10-01 00:00 起创建的订单；在商品实收核销月计入，退款在退款核销月扣回，不追溯旧单。资格以服务端核验为准。
        </p>
      </div>

      {loading && !detail && (
        <div aria-label="正在加载新客首单申请" className="space-y-3" aria-busy="true">
          <div className="h-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          <div className="h-20 animate-pulse rounded-md bg-muted/70 motion-reduce:animate-none" />
          <div className="h-10 animate-pulse rounded-md bg-muted/50 motion-reduce:animate-none" />
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex flex-col items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-900 sm:flex-row sm:items-center">
          <div>
            <div className="font-medium">申请详情暂时无法加载</div>
            <div className="mt-1 text-xs leading-5 text-red-800">{loadError}</div>
          </div>
          <Button type="button" variant="outline" size="sm" className="min-h-10 shrink-0" onClick={() => void loadDetail()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />重试
          </Button>
        </div>
      )}

      {detail && !loadError && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {detail.currentOrder.orderNo ? `订单 ${detail.currentOrder.orderNo}` : "当前订单"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                负责人：{detail.currentOrder.contactPerson || "未填写"}
                {detail.currentOrder.createdAt
                  ? ` · 创建时间 ${formatTime(detail.currentOrder.createdAt)}`
                  : detail.currentOrder.date
                    ? ` · 订单日期 ${detail.currentOrder.date}`
                    : ""}
              </div>
            </div>
            {statusCopy && StatusIcon && (
              <Badge variant="outline" className={`gap-1 ${statusCopy.className}`}>
                <StatusIcon className="size-3.5" aria-hidden="true" />{statusCopy.label}
              </Badge>
            )}
          </div>

          <div className="rounded-md border bg-muted/20 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4 text-sky-700" aria-hidden="true" />客户与首单核验
            </div>
            <dl className="mt-2 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">客户身份</dt>
                <dd className="mt-0.5">{identityKnown ? "已关联客户档案" : "未关联客户档案"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">同一客户其他订单</dt>
                <dd className="mt-0.5">{identityKnown ? `${Number(detail.customerEvidence.otherOrderCount ?? 0)} 笔` : "无法自动判定"}</dd>
              </div>
            </dl>
            {detail.customerEvidence.warning && (
              <p className="mt-2 text-xs leading-5 text-amber-800">{detail.customerEvidence.warning}</p>
            )}
            {Array.isArray(detail.customerEvidence.priorOrders) && detail.customerEvidence.priorOrders.length > 0 && (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">查看历史订单证据</summary>
                <ul className="mt-2 space-y-1.5">
                  {detail.customerEvidence.priorOrders.map((order) => (
                    <li key={order.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t pt-1.5 first:border-t-0 first:pt-0">
                      <span>{order.orderNo || order.id}</span>
                      <span>{[order.date, order.status].filter(Boolean).join(" · ") || "信息未完整"}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {approval && (
            <div className="text-sm leading-6">
              <div>
                <span className="text-muted-foreground">申请人：</span>
                {approval.requestedByName || approval.requestedBy || "未知"}
                {approval.requestedAt ? ` · ${formatTime(approval.requestedAt)}` : ""}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words">
                <span className="text-muted-foreground">申请理由：</span>{approval.reason || "未填写"}
              </div>
              {approval.reviewedAt && (
                <div className="mt-1">
                  <span className="text-muted-foreground">审批人：</span>
                  {approval.reviewedByName || approval.reviewedBy || "未知"} · {formatTime(approval.reviewedAt)}
                </div>
              )}
              {approval.reviewNote && (
                <div className="mt-1 whitespace-pre-wrap break-words">
                  <span className="text-muted-foreground">审批说明：</span>{approval.reviewNote}
                </div>
              )}
              {approval.status === "approved" && (
                <p className="mt-2 text-xs leading-5 text-emerald-800">
                  未核销不计提；已有核销的，批准当月补计新客提成差额，往月不改写。退款仍在核销月份扣回。
                </p>
              )}
            </div>
          )}

          {approval?.status === "pending" && detail.canApprove && (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor={`new-customer-review-note-${orderId}`}>
                  审批说明 <span className="font-normal text-muted-foreground">（驳回时必填）</span>
                </label>
                <Textarea
                  id={`new-customer-review-note-${orderId}`}
                  rows={3}
                  maxLength={1000}
                  value={reviewNote}
                  disabled={busyAction !== null}
                  onChange={(event) => setReviewNote(event.target.value)}
                  placeholder="批准可填写核对依据；驳回请说明需补充或修正的内容"
                />
              </div>
              {!identityKnown && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
                  <div className="flex gap-2">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div>
                      <div className="font-medium">当前订单未关联客户档案，系统无法自动确认是否首单</div>
                      <label className="mt-2 flex cursor-pointer items-start gap-2 leading-5" htmlFor={`confirm-new-customer-identity-${orderId}`}>
                        <Checkbox
                          id={`confirm-new-customer-identity-${orderId}`}
                          checked={confirmUnknownCustomer}
                          disabled={busyAction !== null}
                          onCheckedChange={(checked) => setConfirmUnknownCustomer(checked === true)}
                          className="mt-0.5"
                        />
                        <span>我已人工核对客户身份和历史订单，确认可按新客首单批准。</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={!canReject}
                  aria-busy={busyAction === "reject"}
                  onClick={() => void submitReview("reject")}
                >
                  {busyAction === "reject" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <XCircle className="size-4" />}
                  {busyAction === "reject" ? "驳回中" : "驳回申请"}
                </Button>
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={!canApprove}
                  aria-busy={busyAction === "approve"}
                  onClick={() => void submitReview("approve")}
                >
                  {busyAction === "approve" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCircle2 className="size-4" />}
                  {busyAction === "approve" ? "批准中" : "批准并采用 5%"}
                </Button>
              </div>
            </div>
          )}

          {(!approval || approval.status === "rejected") && detail.canRequest && (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor={`new-customer-request-reason-${orderId}`}>
                  {approval?.status === "rejected" ? "重新申请理由" : "申请理由"}<span className="ml-0.5 text-red-600">*</span>
                </label>
                <Textarea
                  id={`new-customer-request-reason-${orderId}`}
                  rows={3}
                  minLength={5}
                  maxLength={1000}
                  value={requestReason}
                  disabled={busyAction !== null}
                  onChange={(event) => setRequestReason(event.target.value)}
                  placeholder="说明客户来源、首次成交依据或需要管理员核对的情况"
                />
                <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span>至少填写 5 个字</span>
                  <span>{requestReason.trim().length}/1000</span>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  className="min-h-11 w-full sm:w-auto"
                  disabled={!canSubmitRequest}
                  aria-busy={busyAction === "request"}
                  onClick={() => void submitRequest()}
                >
                  {busyAction === "request" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Send className="size-4" />}
                  {busyAction === "request" ? "提交中" : approval?.status === "rejected" ? "重新提交申请" : "申请新客首单审批"}
                </Button>
              </div>
            </div>
          )}

          {!detail.canRequest && !detail.canApprove && (!approval || approval.status === "rejected") && (
            <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm leading-6 text-muted-foreground">
              {detail.requestBlockedReason || "当前账号或订单不符合申请条件。"}
            </div>
          )}

          {approval?.status === "pending" && !detail.canApprove && (
            <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
              申请已提交，管理员处理后会通过站内信通知结果。
            </div>
          )}
        </>
      )}

      {actionError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900">
          {actionError}
        </div>
      )}
    </div>
  );
}
