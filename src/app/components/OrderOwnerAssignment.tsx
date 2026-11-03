import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Check, Loader2, RefreshCw, X } from "lucide-react";
import type { Order, Personnel, User } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerSession } from "../utils/newCustomerEvidence";
import { ownerAssignmentActionReady, ownerAssignmentDecisionApplied, ownerAssignmentDetailFromPayload, ownerFieldsFromPayload, type OrderOwnerFields, type OwnerAssignmentDecision, type OwnerAssignmentDetail } from "../utils/orderOwnerAssignment";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function OrderOwnerAssignmentBadge({ order }: { order: Pick<Order, "ownerAssignment"> }) {
  return order.ownerAssignment?.status === "pending"
    ? <Badge variant="outline" className="max-w-full whitespace-normal break-words border-amber-200 bg-amber-50 text-amber-900">负责人待确认：{order.ownerAssignment.toName || order.ownerAssignment.toUsername}</Badge> : null;
}

/** Staff directory intentionally excludes other accounts' permissions. Ask the server for minimal eligible candidates. */
export function useOrderOwnerCandidates(siteId: string | undefined, viewer: User, enabled: boolean, directory: Personnel[], preservedId?: string) {
  const sessionKey = captureNewCustomerSession()?.key || "";
  const scopeKey = JSON.stringify([siteId || "nanjing", sessionKey]);
  const [snapshot, setSnapshot] = useState<{ key: string; currentPersonnelId: string; people: Array<{ id: string; name: string; username: string }> } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  useEffect(() => {
    if (!enabled) return;
    const session = captureNewCustomerSession();
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isNewCustomerSessionCurrent(session, viewerRef.current);
    setLoading(true); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/orders/owner-assignment/candidates?siteId=${encodeURIComponent(siteId || "nanjing")}`, { headers: authJsonHeaders(), cache: "no-store", signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!current()) return;
        if (!response.ok || payload.ok !== true || !Array.isArray(payload.personnel)) throw new Error(payload.error || "可接收订单的人员加载失败。");
        const people = payload.personnel;
        if (people.some((person: any) => !person || typeof person.id !== "string" || !person.id || typeof person.name !== "string" || typeof person.username !== "string" || !person.username)) throw new Error("人员信息不完整，请重试。");
        setSnapshot({ key: scopeKey, people, currentPersonnelId: typeof payload.currentPersonnelId === "string" ? payload.currentPersonnelId : "" });
      } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "人员加载失败，请重试。"); }
      finally { if (current()) setLoading(false); }
    })();
    return () => controller.abort();
  }, [enabled, siteId, scopeKey, revision]);
  const people = snapshot?.key === scopeKey ? snapshot.people : [];
  const preserved = directory.find(person => person.id === preservedId);
  const options = people.map(person => ({ ...directory.find(item => item.id === person.id), ...person }) as Personnel);
  if (preserved && !options.some(person => person.id === preserved.id)) options.unshift(preserved);
  return { options, loading, error, currentPersonnelId: snapshot?.key === scopeKey ? snapshot.currentPersonnelId : "", retry: () => setRevision(value => value + 1) };
}

type Props = {
  orderId: string;
  requestId?: string;
  viewer: User;
  initialDetail?: OwnerAssignmentDetail;
  onOrderUpdated: (order: OrderOwnerFields, session: NewCustomerSession) => void;
  onChanged?: () => void;
};

export function OrderOwnerAssignmentPanel(props: Props) {
  const sessionKey = captureNewCustomerSession()?.key || "";
  return <OrderOwnerAssignmentContent key={JSON.stringify([props.orderId, props.requestId, sessionKey])} {...props} />;
}

function OrderOwnerAssignmentContent({ orderId, requestId, viewer, initialDetail, onOrderUpdated, onChanged }: Props) {
  const [detail, setDetail] = useState<OwnerAssignmentDetail | null>(initialDetail || null);
  const [loading, setLoading] = useState(!initialDetail);
  const [busy, setBusy] = useState<OwnerAssignmentDecision | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const busyRef = useRef(false);
  const propsRef = useRef({ viewer, onOrderUpdated, onChanged });
  propsRef.current = { viewer, onOrderUpdated, onChanged };
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const session = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(session, propsRef.current.viewer)) { setError("登录状态已变化，请重新登录后操作。"); setLoading(false); return; }
    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const current = () => mounted.current && requestSequence.current === sequence && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    setLoading(true); setError(""); setDetail(null);
    try {
      const response = await fetch(`/api/orders/owner-assignment?orderId=${encodeURIComponent(orderId)}`, { headers: authJsonHeaders(), cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || "负责人确认信息加载失败，请重试。");
      const updated = ownerAssignmentDetailFromPayload(payload, orderId);
      if (!updated) throw new Error("服务器返回的负责人信息不完整，请刷新后重试。");
      setDetail(updated);
      if (updated.order) propsRef.current.onOrderUpdated(updated.order, session!);
    } catch (cause) {
      if (current() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败，请重试。");
    } finally { if (current()) setLoading(false); }
  }, [orderId]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; requestSequence.current += 1; controllerRef.current?.abort(); };
  }, [reload]);

  const submit = async (decision: OwnerAssignmentDecision) => {
    if (busyRef.current || loading || !ownerAssignmentActionReady(detail, decision, requestId)) return;
    const session = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(session, propsRef.current.viewer)) { setError("登录状态已变化，请重新登录后操作。"); return; }
    busyRef.current = true; setBusy(decision); setError(""); setMessage("");
    const current = () => mounted.current && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    try {
      const response = await fetch("/api/orders/owner-assignment/decision", {
        method: "POST", headers: authJsonHeaders(), cache: "no-store",
        body: JSON.stringify({ orderId, requestId: detail!.assignment!.requestId, decision, note: note.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || payload.ok !== true) {
        if (response.status === 409) await reload();
        throw new Error(payload.error || "确认操作未成功，请重试。");
      }
      const updated = ownerFieldsFromPayload(payload, orderId);
      if (!updated || !ownerAssignmentDecisionApplied(updated, decision, detail!.assignment!.requestId)) throw new Error("服务器未返回有效结果，请刷新核对，勿重复提交。");
      propsRef.current.onOrderUpdated(updated, session!);
      setDetail(previous => previous ? { ...previous, assignment: updated.ownerAssignment || null,
        currentOwner: { personnelId: updated.contactPersonnelId || "", name: updated.contactPerson || "" }, canAccept: false, canReject: false, canCancel: false } : previous);
      setMessage(decision === "accept" ? "已确认接手，你已成为该订单负责人。" : decision === "reject" ? "已拒绝接手，原负责人保持不变。" : "已撤回申请，原负责人保持不变。");
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
      propsRef.current.onChanged?.();
    } catch (cause) {
      if (current()) setError(cause instanceof TypeError ? "网络连接失败，请刷新核对处理结果后重试。" : cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  };

  const assignment = detail?.assignment;
  const staleRequest = Boolean(requestId && assignment?.requestId !== requestId);
  const actionable = Boolean(!staleRequest && assignment?.status === "pending" && (detail?.canAccept || detail?.canReject || detail?.canCancel));
  const status = assignment?.status === "pending" ? detail?.blockedReason ? "暂不可接手" : "待接收人确认" : assignment?.status === "accepted" ? "已确认接手" : assignment?.status === "rejected" ? "已拒绝接手" : "已撤回或失效";
  return <section aria-label="订单负责人确认" aria-busy={loading || Boolean(busy)} className="min-w-0 space-y-3 border-b pb-4">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">负责人转交确认</h3>
      <Button type="button" variant="ghost" className="!min-h-[44px]" disabled={loading || Boolean(busy)} onClick={() => void reload()}><RefreshCw className="size-4" aria-hidden="true" />刷新</Button>
    </div>
    {loading ? <p role="status" className="rounded-md bg-muted px-3 py-4 text-sm">正在核对当前负责人和确认状态…</p> : detail && <>
      <p className="break-words text-sm">当前有效负责人：<strong>{detail.currentOwner.name || "未记录"}</strong></p>
      {assignment ? <>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><ArrowRightLeft className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{assignment.fromName} → {assignment.toName || assignment.toUsername}</span><Badge variant="outline">{status}</Badge></div>
        <p className="break-words text-xs leading-5 text-muted-foreground">申请人：{assignment.requestedByName || assignment.requestedBy} · {new Date(assignment.requestedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>
        {assignment.resolvedAt && <p className="break-words text-xs leading-5 text-muted-foreground">处理人：{assignment.resolvedByName || assignment.resolvedBy || "系统"} · {new Date(assignment.resolvedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>}
        {assignment.status === "pending" && <p className="break-words text-sm leading-6">只有接收人本人确认后才转交；确认前仍由{detail.currentOwner.name || "当前负责人"}负责。</p>}
        {assignment.note && <p className="whitespace-pre-wrap break-words text-sm">处理备注：{assignment.note}</p>}
      </> : <p className="text-sm text-muted-foreground">暂无负责人转交申请。</p>}
      {staleRequest && <p role="status" className="text-sm leading-6">这条站内信对应的申请已过期或被替换，请查看最新站内信；此处不会处理新的申请。</p>}
      {!staleRequest && assignment?.status === "pending" && detail.blockedReason && <p role="status" className="text-sm leading-6">{detail.blockedReason}</p>}
      {actionable && <>
        {detail.canAccept && <p className="text-sm leading-6">确认后，订单负责人及对应提成归属将变为你。{(detail.approvalResetRequired?.newCustomer || detail.approvalResetRequired?.creditSale) && "原新客审批或赊销批准将失效，需要重新申请。"}</p>}
        <label className="grid gap-2 text-sm">处理备注（选填）<Textarea value={note} maxLength={500} disabled={Boolean(busy)} onChange={event => setNote(event.target.value)} rows={2} placeholder="可填写接手、拒绝或撤回的说明" /></label>
        <div className="flex flex-wrap gap-2">
          {detail.canAccept && <Button type="button" className="!min-h-[44px]" disabled={Boolean(busy) || !ownerAssignmentActionReady(detail, "accept", requestId)} onClick={() => void submit("accept")}>{busy === "accept" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}{busy === "accept" ? "正在确认…" : "确认接手"}</Button>}
          {detail.canReject && <Button type="button" variant="outline" className="!min-h-[44px]" disabled={Boolean(busy)} onClick={() => void submit("reject")}><X className="size-4" aria-hidden="true" />{busy === "reject" ? "正在拒绝…" : "拒绝接手"}</Button>}
          {detail.canCancel && <Button type="button" variant="outline" className="!min-h-[44px]" disabled={Boolean(busy)} onClick={() => void submit("cancel")}>{busy === "cancel" ? "正在撤回…" : "撤回转交申请"}</Button>}
        </div>
      </>}
    </>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="break-words text-sm">{message}</p>}
  </section>;
}
