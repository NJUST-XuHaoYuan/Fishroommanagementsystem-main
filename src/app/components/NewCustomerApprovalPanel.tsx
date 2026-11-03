import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  FileText,
  UserRound,
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
import { Textarea } from "./ui/textarea";
import { NewCustomerLinkedDetailDialog, type NewCustomerLinkedTarget } from "./NewCustomerLinkedDetailDialog";
import { NewCustomerEvidenceGallery, NewCustomerEvidenceUploader } from "./NewCustomerEvidence";
import { NewCustomerAssociation } from "./NewCustomerAssociation";
import type { NewCustomerLinkChange } from "../utils/newCustomerLink";
import {
  captureNewCustomerSession, isNewCustomerSessionCurrent, normalizeNewCustomerEvidence,
  type NewCustomerEvidenceAttachment, type NewCustomerSession,
} from "../utils/newCustomerEvidence";

export type NewCustomerApprovalUpdatedOrder = { id: string } & Record<string, unknown>;

export type NewCustomerApprovalPanelProps = {
  orderId: string;
  /** When set, detail is loaded through the station-notification endpoint. */
  notificationId?: string;
  /** Prevents a stale notification from opening a different approval request. */
  approvalRequestId?: string;
  /** Optional server-provided detail for embedding or deterministic rendering. */
  initialDetail?: NewCustomerApprovalDetail | null;
  onOrderUpdated?: (order: NewCustomerApprovalUpdatedOrder, session?: NewCustomerSession) => void;
  onCustomerLinked?: (change: NewCustomerLinkChange, session: NewCustomerSession) => void;
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

export function NewCustomerApprovalPanel(props: NewCustomerApprovalPanelProps) {
  const sessionKey = captureNewCustomerSession()?.key || "";
  return <NewCustomerApprovalPanelContent key={JSON.stringify([props.orderId, props.notificationId, props.approvalRequestId, sessionKey])} {...props} />;
}

function NewCustomerApprovalPanelContent({
  orderId,
  notificationId,
  approvalRequestId,
  initialDetail = null,
  onOrderUpdated,
  onCustomerLinked,
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
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [linkedTarget, setLinkedTarget] = useState<NewCustomerLinkedTarget | null>(null);
  const [draftEvidence, setDraftEvidence] = useState<NewCustomerEvidenceAttachment[]>(() => initialMatches && initialDetail?.canRequest ? normalizeNewCustomerEvidence(initialDetail.draftEvidenceAttachments) : []);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [customerBusy, setCustomerBusy] = useState(false);
  const customerBusyRef = useRef(false);
  const onCustomerBusyChange = useCallback((busy: boolean) => { customerBusyRef.current = busy; setCustomerBusy(busy); }, []);
  const evidenceBusyRef = useRef(false);
  const draftEvidenceRef = useRef(draftEvidence);
  const draftsRestoredRef = useRef(initialMatches && initialDetail?.canRequest && initialDetail?.draftEvidenceAttachments !== undefined);
  const mountedRef = useRef(true);
  const ownerSessionRef = useRef(captureNewCustomerSession());
  const mutationControllerRef = useRef<AbortController | null>(null);
  const onEvidenceBusyChange = useCallback((busy: boolean) => { evidenceBusyRef.current = busy; setEvidenceBusy(busy); }, []);
  const onEvidenceChange = useCallback((attachments: NewCustomerEvidenceAttachment[]) => {
    draftEvidenceRef.current = attachments; setDraftEvidence(attachments);
  }, []);
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
    const session = captureNewCustomerSession();
    try {
      if (!session || session.key !== ownerSessionRef.current?.key) throw new Error("登录状态已变化，请重新打开申请。");
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
      let nextDetail = newCustomerApprovalDetailFromPayload(payload);
      if (!nextDetail) throw new Error("服务端未返回可核对的新客首单申请详情");
      // Notification snapshots do not load the private draft registry. Recover the
      // current applicant's drafts from the order endpoint before enabling upload.
      if (notificationId && !fromOrderEndpoint && nextDetail.canRequest && nextDetail.draftEvidenceAttachments === undefined) {
        if (controller.signal.aborted || !isNewCustomerSessionCurrent(session)) return;
        const orderResponse = await fetch(`/api/orders/new-customer/detail?orderId=${encodeURIComponent(orderId)}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
        const orderPayload = await orderResponse.json().catch(() => ({}));
        if (!orderResponse.ok || orderPayload.ok === false) throw new Error(errorMessage(orderPayload, "图片草稿恢复失败，请重试"));
        nextDetail = newCustomerApprovalDetailFromPayload(orderPayload);
        if (!nextDetail) throw new Error("图片草稿恢复失败，请重试");
      }
      if (nextDetail.orderId !== orderId) throw new Error("申请详情与当前订单不匹配，请重新打开后重试");
      if (
        approvalRequestId &&
        String(nextDetail.approval?.requestId ?? "") !== String(approvalRequestId)
      ) throw new Error("站内信与当前审批申请不匹配，请刷新后重试");
      if (requestRef.current.sequence !== sequence || controller.signal.aborted || !isNewCustomerSessionCurrent(session)) return;
      if (!draftsRestoredRef.current && nextDetail.canRequest) {
        draftsRestoredRef.current = true;
        onEvidenceChange(normalizeNewCustomerEvidence([...draftEvidenceRef.current, ...normalizeNewCustomerEvidence(nextDetail.draftEvidenceAttachments)]));
      }
      setDetail(nextDetail);
    } catch (error) {
      if (controller.signal.aborted || requestRef.current.sequence !== sequence || (session && !isNewCustomerSessionCurrent(session))) return;
      setLoadError(error instanceof Error ? error.message : "新客首单申请详情加载失败");
    } finally {
      if (requestRef.current.sequence === sequence && !controller.signal.aborted) setLoading(false);
    }
  }, [approvalRequestId, notificationId, onEvidenceChange, orderId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; mutationControllerRef.current?.abort(); };
  }, []);

  useEffect(() => {
    setLinkedTarget(null);
    setActionError("");
    setRequestReason("");
    setReviewNote("");
    if (initialDetail?.orderId === orderId) {
      requestRef.current.controller?.abort();
      setDetail(initialDetail);
      setLoadError("");
      setLoading(false);
      if (initialDetail.canRequest && initialDetail.draftEvidenceAttachments === undefined) void loadDetail(true);
    } else {
      setDetail(null);
      void loadDetail();
    }
    return () => requestRef.current.controller?.abort();
  }, [initialDetail, loadDetail, orderId]);

  const mutationCurrent = (session: NewCustomerSession) => mountedRef.current && session.key === ownerSessionRef.current?.key && isNewCustomerSessionCurrent(session);

  const applyReturnedOrder = (payload: unknown, session: NewCustomerSession) => {
    const order = resultOrder(payload);
    if (order?.id === orderId && mutationCurrent(session)) {
      try {
        onOrderUpdated?.(order, session);
      } catch {
        toast.error("审批已保存，但订单列表同步失败，请手动刷新");
      }
      return order;
    }
    return undefined;
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

  const handleConflict = async (payload: unknown, fallback: string, session: NewCustomerSession) => {
    if (!mutationCurrent(session)) return;
    applyReturnedOrder(payload, session);
    await loadDetail(true);
    if (mutationCurrent(session)) setActionError(errorMessage(payload, fallback));
  };

  const submitRequest = async () => {
    if (mutationPendingRef.current || evidenceBusyRef.current || customerBusyRef.current || !newCustomerRequestActionReady({
      orderId,
      canRequest: detail?.canRequest,
      reason: requestReason,
      identityKnown,
      customerId: detail?.currentOrder.customerId,
      evidenceCount: draftEvidenceRef.current.length,
      processing: busyAction !== null || evidenceBusy || customerBusy || loading,
    })) return;
    const session = captureNewCustomerSession();
    if (!session || !mutationCurrent(session)) { setActionError("登录状态已变化，请重新打开申请后提交。"); return; }
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    mutationPendingRef.current = true;
    setBusyAction("request");
    setActionError("");
    try {
      const response = await fetch("/api/orders/new-customer/request", {
        method: "POST",
        headers: authJsonHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          orderId,
          reason: requestReason.trim(),
          expectedApprovalVersion: detail?.approval?.version ?? 0,
          evidenceIds: draftEvidenceRef.current.map(attachment => attachment.id),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!mutationCurrent(session)) return;
      if (response.status === 409) {
        await handleConflict(payload, "申请状态已变化，已刷新为最新内容", session);
        return;
      }
      if (!response.ok || (payload as { ok?: boolean }).ok === false) {
        throw new Error(errorMessage(payload, "新客首单申请提交失败"));
      }
      const order = applyReturnedOrder(payload, session);
      onEvidenceChange([]);
      setRequestReason("");
      await loadDetail(true);
      if (!mutationCurrent(session)) return;
      await notifyChanged({ action: "request", order });
      toast.success("新客首单申请已提交，等待管理员审批");
    } catch (error) {
      if (mutationCurrent(session)) setActionError(error instanceof Error ? error.message : "新客首单申请提交失败");
    } finally {
      mutationPendingRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const submitReview = async (decision: "approve" | "reject") => {
    if (mutationPendingRef.current || customerBusyRef.current || !newCustomerReviewActionReady({
      requestId: detail?.approval?.requestId,
      decision,
      canApprove: detail?.canApprove,
      note: reviewNote,
      identityKnown,
      customerId: detail?.currentOrder.customerId,
      evidenceCount: normalizeNewCustomerEvidence(detail?.approval?.evidenceAttachments).length,
      approvalBlockedReason: detail?.approvalBlockedReason,
      processing: busyAction !== null || customerBusy || loading,
    })) return;
    const session = captureNewCustomerSession();
    if (!session || !mutationCurrent(session)) { setActionError("登录状态已变化，请重新打开申请后审批。"); return; }
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    mutationPendingRef.current = true;
    setBusyAction(decision);
    setActionError("");
    try {
      const response = await fetch("/api/orders/new-customer/review", {
        method: "POST",
        headers: authJsonHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          orderId,
          requestId: detail?.approval?.requestId,
          decision,
          note: reviewNote.trim(),
          expectedApprovalVersion: detail?.approval?.version ?? 0,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!mutationCurrent(session)) return;
      if (response.status === 409) {
        await handleConflict(payload, "该申请已被其他管理员处理，已刷新为最新状态", session);
        return;
      }
      if (!response.ok || (payload as { ok?: boolean }).ok === false) {
        throw new Error(errorMessage(payload, decision === "approve" ? "批准失败" : "驳回失败"));
      }
      const order = applyReturnedOrder(payload, session);
      setReviewNote("");
      await loadDetail(true);
      if (!mutationCurrent(session)) return;
      await notifyChanged({ action: decision, order });
      toast.success(decision === "approve" ? "新客首单申请已批准" : "新客首单申请已驳回");
    } catch (error) {
      if (mutationCurrent(session)) setActionError(error instanceof Error ? error.message : decision === "approve" ? "批准失败" : "驳回失败");
    } finally {
      mutationPendingRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const approval = detail?.approval;
  const statusCopy = approval ? STATUS_COPY[approval.status] : null;
  const StatusIcon = statusCopy?.icon;
  const identityKnown = detail?.customerEvidence.identityKnown === true && Boolean(detail.currentOrder.customerId)
    && detail.linkedCustomer?.id === detail.currentOrder.customerId && Boolean(detail.linkedCustomer.name?.trim());
  const customerIdentityRestricted = detail?.canViewEvidence === false && Boolean(detail.currentOrder.customerId);
  const submittedEvidenceCount = normalizeNewCustomerEvidence(approval?.evidenceAttachments).length;
  const missingApprovalConditions = [!identityKnown && "未关联有效客户档案", submittedEvidenceCount < 1 && "未上传添加微信证明"].filter(Boolean);
  const approvalBlockedReason = detail?.approvalBlockedReason || (missingApprovalConditions.length ? `${missingApprovalConditions.join("；")}。请驳回，由负责人补齐后重新申请。` : "");
  const canSubmitRequest = newCustomerRequestActionReady({
    orderId,
    canRequest: detail?.canRequest,
    reason: requestReason,
    identityKnown,
    customerId: detail?.currentOrder.customerId,
    evidenceCount: draftEvidence.length,
    processing: busyAction !== null || evidenceBusy || customerBusy || loading,
  });
  const canApprove = newCustomerReviewActionReady({
    requestId: approval?.requestId,
    decision: "approve",
    canApprove: detail?.canApprove,
    note: reviewNote,
    identityKnown,
    customerId: detail?.currentOrder.customerId,
    evidenceCount: submittedEvidenceCount,
    approvalBlockedReason,
    processing: busyAction !== null || customerBusy || loading,
  });
  const canReject = newCustomerReviewActionReady({
    requestId: approval?.requestId,
    decision: "reject",
    canApprove: detail?.canApprove,
    note: reviewNote,
    identityKnown,
    processing: busyAction !== null || customerBusy || loading,
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

          <div className="flex flex-wrap gap-2" aria-label="审核关联资料">
            <Button type="button" variant="outline" className="min-h-11" disabled={loading || busyAction !== null}
              onClick={() => setLinkedTarget({ kind: "order", targetOrderId: detail.orderId })}>
              <FileText className="size-4" aria-hidden="true" />查看订单
            </Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={!identityKnown || loading || busyAction !== null}
              onClick={() => setLinkedTarget({ kind: "customer", customerId: detail.currentOrder.customerId! })}>
              <UserRound className="size-4" aria-hidden="true" />查看客户
            </Button>
            <p className="w-full text-xs leading-5 text-muted-foreground">
              {identityKnown ? "在本页查看，关闭资料后继续审核，已填写的审批说明会保留。" : customerIdentityRestricted ? "客户核验资料仅向申请人、订单负责人和管理员开放。" : "未关联有效客户档案，可先查看订单核对客户识别信息。"}
            </p>
          </div>

          <div className="rounded-md border bg-muted/20 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4 text-sky-700" aria-hidden="true" />客户与首单核验
            </div>
            <dl className="mt-2 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">客户身份</dt>
                <dd className="mt-0.5">{identityKnown ? `已关联客户档案${detail.linkedCustomer?.name ? `：${detail.linkedCustomer.name}` : ""}` : customerIdentityRestricted ? "已有关联，当前账号无权核对" : "未关联客户档案"}</dd>
                {identityKnown && (detail.linkedCustomer?.wechat || detail.linkedCustomer?.phone) && <dd className="mt-1 break-words text-xs text-muted-foreground">{[detail.linkedCustomer.wechat && `微信：${detail.linkedCustomer.wechat}`, detail.linkedCustomer.phone && `电话：${detail.linkedCustomer.phone}`].filter(Boolean).join(" · ")}</dd>}
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
                      <button type="button" className="min-h-11 text-left font-medium text-sky-800 underline underline-offset-4 hover:text-sky-950 focus-visible:outline-2 focus-visible:outline-offset-2"
                        disabled={loading || busyAction !== null}
                        onClick={() => setLinkedTarget({ kind: "order", targetOrderId: order.id })}>
                        查看订单 {order.orderNo || order.id}
                      </button>
                      <span>{[order.date, order.status].filter(Boolean).join(" · ") || "信息未完整"}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {!identityKnown && !customerIdentityRestricted && approval?.status !== "approved" && <NewCustomerAssociation
            detail={detail}
            disabled={loading || busyAction !== null || evidenceBusy}
            onBusyChange={onCustomerBusyChange}
            onConflict={async (change, session) => {
              if (!mutationCurrent(session)) return;
              try {
                if (change) { onCustomerLinked?.(change, session); onOrderUpdated?.(change.order, session); }
                await loadDetail(true);
              } finally { if (mountedRef.current) onCustomerBusyChange(false); }
            }}
            onLinked={async (change, session) => {
              if (!mutationCurrent(session)) return;
              try {
                onCustomerLinked?.(change, session);
                // Only reload server eligibility; entered reason and recovered image drafts stay intact.
                await loadDetail(true);
                if (mutationCurrent(session)) toast.success("客户档案已关联，请由订单负责人补充添加微信证明并提交申请");
              } finally { if (mountedRef.current) onCustomerBusyChange(false); }
            }}
          />}

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
              <div className="mt-3 space-y-2">
                <h4 className="text-sm font-medium">{approval.status === "rejected" ? "上次申请图片凭证" : "申请图片凭证"}</h4>
                {detail.canViewEvidence === false ? <p className="text-xs text-muted-foreground">仅申请人、订单负责人和管理员可查看凭证。</p> : <NewCustomerEvidenceGallery orderId={orderId} attachments={normalizeNewCustomerEvidence(approval.evidenceAttachments)} />}
                {normalizeNewCustomerEvidence(approval.evidenceAttachments).length > 0 && detail.canViewEvidence !== false && <p className="text-xs text-muted-foreground">已随申请提交，只读查看，不可修改或删除。</p>}
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
              {approval.status === "approved" && detail.canViewEvidence !== false && (!identityKnown || submittedEvidenceCount < 1) && <p className="mt-2 text-xs leading-5 text-muted-foreground">历史已批准记录保留原审批结果，不按新增材料要求追溯修改。</p>}
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
              {approvalBlockedReason && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
                  <div className="flex gap-2">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div>
                      <div className="font-medium">暂不能批准</div>
                      <p className="mt-1 leading-6">{approvalBlockedReason}</p>
                      <p className="mt-1 text-xs">可填写驳回说明，让负责人补齐后重新申请；不能用人工确认跳过客户档案或图片证明。</p>
                    </div>
                  </div>
                </div>
              )}
              {!approvalBlockedReason && <p className="text-xs leading-5 text-muted-foreground">批准前请核对客户档案、历史订单及添加微信截图。系统不自动识别图片真伪。</p>}
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
              <NewCustomerEvidenceUploader orderId={orderId} attachments={draftEvidence} disabled={busyAction !== null || customerBusy || loading} onChange={onEvidenceChange} onBusyChange={onEvidenceBusyChange} />
              {!canSubmitRequest && !busyAction && <p className="text-xs leading-5 text-muted-foreground">{evidenceBusy ? "图片处理中，请稍候。" : [!identityKnown && "请先关联有效客户档案", draftEvidence.length < 1 && "请至少上传 1 张添加微信证明", requestReason.trim().length < 5 && "申请理由至少填写 5 个字"].filter(Boolean).join("；")}</p>}
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
      {linkedTarget && <NewCustomerLinkedDetailDialog
        key={JSON.stringify([orderId, linkedTarget])}
        orderId={orderId}
        target={linkedTarget}
        onClose={() => setLinkedTarget(null)}
      />}
    </div>
  );
}
