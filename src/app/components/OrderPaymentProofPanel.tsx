import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileCheck2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useStore, type Order, type Store } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerEvidenceAttachment, type NewCustomerSession } from "../utils/newCustomerEvidence";
import type { PaymentProofClaim, PaymentProofDetail } from "../utils/orderPaymentProof";
import { NewCustomerEvidenceGallery, NewCustomerEvidenceUploader } from "./NewCustomerEvidence";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";

const currency = (amount: number) => `¥${Number(amount || 0).toFixed(2)}`;
const initialTime = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
type Draft = { claimId: string; expectedVersion?: number; amount: string; time: string; paymentMethodId: string; externalTransactionNo: string; notes: string; attachments: NewCustomerEvidenceAttachment[] };
const blankDraft = (): Draft => ({ claimId: "", amount: "", time: initialTime(), paymentMethodId: "", externalTransactionNo: "", notes: "", attachments: [] });

export function OrderPaymentProofPanel({ orderId, onApplied, reviewOnly = false }: {
  orderId: string; onApplied?: (result: { order?: Order; orders?: Order[]; operationLog?: Store["operationLogs"][number] }, session: NewCustomerSession) => void | Promise<void>; reviewOnly?: boolean;
}) {
  const { state } = useStore();
  const identity = JSON.stringify([state.user?.username, state.user?.role, state.user?.visibleSiteIds]);
  const [detail, setDetail] = useState<PaymentProofDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [privateOnly, setPrivateOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [reviewChoice, setReviewChoice] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const seq = useRef(0);
  const mounted = useRef(true);
  const viewer = useRef(state.user); viewer.current = state.user;
  const pendingLoad = useRef<AbortController | null>(null);
  const detailSession = useRef<NewCustomerSession | null>(null);
  const onBusyChange = useCallback((value: boolean) => setUploading(value), []);

  const load = useCallback(async () => {
    const request = ++seq.current;
    pendingLoad.current?.abort();
    const controller = new AbortController(); pendingLoad.current = controller;
    const session = captureNewCustomerSession();
    setLoading(true); setPrivateOnly(false); setDetail(null); detailSession.current = null; setReviewChoice({}); setReasons({});
    const current = () => mounted.current && request === seq.current && isNewCustomerSessionCurrent(session, viewer.current);
    try {
      const response = await fetch(`/api/orders/payment-proof/detail?orderId=${encodeURIComponent(orderId)}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (response.status === 403) { setPrivateOnly(true); setError(""); setFormOpen(false); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || "付款凭证加载失败。");
      if (result.orderId !== orderId || !Array.isArray(result.claims) || !Array.isArray(result.paymentMethods) || !Array.isArray(result.eligiblePayments) || !result.summary || !result.reviewToken) throw new Error("付款凭证信息不完整，请重新加载。");
      detailSession.current = session; setDetail(result); setDraft(currentDraft => ({ ...currentDraft, paymentMethodId: currentDraft.paymentMethodId || result.paymentMethods[0]?.id || "" }));
    } catch (cause) { if (current() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败，请重试。"); }
    finally { if (current()) setLoading(false); }
  }, [orderId, identity]);

  useEffect(() => {
    mounted.current = true; setError(""); setFormOpen(false); setDraft(blankDraft()); void load();
    return () => { mounted.current = false; seq.current += 1; pendingLoad.current?.abort(); };
  }, [load]);

  const write = async (path: string, body: unknown) => {
    if (lock.current || uploading) return;
    const session = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(session, viewer.current)) { setError("登录状态已变化，请重新打开订单。"); return; }
    if (session?.key !== detailSession.current?.key) { await load(); setError("登录状态已变化，请核对重新加载的信息后再提交。"); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/orders/payment-proof/${path}`, { method: "POST", headers: authJsonHeaders(), body: JSON.stringify(body), cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!mounted.current || !isNewCustomerSessionCurrent(session, viewer.current)) return;
      if (!response.ok || !result.ok) { if (response.status === 409) await load(); throw new Error(result.error || "操作失败，请重试。"); }
      await onApplied?.(result, session!);
      if (!mounted.current || !isNewCustomerSessionCurrent(session, viewer.current)) return;
      setFormOpen(false); setDraft(blankDraft()); await load();
      toast.success(path === "submit" ? "付款凭证已提交，等待财务核验" : "核验结果已保存");
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
    } catch (cause) { if (mounted.current && isNewCustomerSessionCurrent(session, viewer.current)) setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };

  const submit = () => {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) return setError("请填写大于0、最多两位小数的本次付款金额。");
    if (!draft.time || !draft.paymentMethodId) return setError("请填写付款时间并选择付款方式。");
    if (!draft.attachments.length) return setError("请至少上传一张对应本次付款的图片凭证。");
    void write("submit", { orderId, ...(draft.claimId ? { claimId: draft.claimId, expectedVersion: draft.expectedVersion } : {}), amount, time: draft.time, paymentMethodId: draft.paymentMethodId, externalTransactionNo: draft.externalTransactionNo, notes: draft.notes, evidenceIds: draft.attachments.map(attachment => attachment.id) });
  };
  const review = (claim: PaymentProofClaim, decision: "approve" | "reject") => {
    const selected = reviewChoice[claim.id]; const reason = reasons[claim.id]?.trim();
    if (decision === "approve" && !selected) return setError("请先选择关联现有收款流水，或明确选择新增一笔收款。");
    if (decision === "reject" && !reason) return setError("请填写驳回原因，方便订单负责人补充正确凭证。");
    void write("review", { orderId, claimId: claim.id, expectedVersion: claim.version, reviewToken: detail?.reviewToken, decision, reason: reason || "", ...(decision === "approve" && selected !== "new" ? { existingPaymentId: selected } : {}) });
  };

  return <section aria-label="订单付款凭证" aria-busy={loading || busy || uploading} className="min-w-0 space-y-3 rounded-lg border bg-card p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold sm:text-base">付款凭证与财务核验</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">负责人按每笔实付提交图片和金额。财务核验前不计入确认到账或提成；未覆盖金额发货时自动记赊销。</p></div><Button type="button" variant="ghost" className="min-h-11" disabled={busy || uploading || loading} onClick={() => { setError(""); void load(); }} aria-label="刷新付款凭证"><RefreshCw className="size-4" /></Button></div>
    {error && <p role="alert" className="break-words rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="py-3 text-sm text-muted-foreground">正在加载付款凭证…</p> : privateOnly ? <p className="text-sm leading-6 text-muted-foreground">付款图片仅由当前订单负责人、管理员及有财务核验权限的人员查看。</p> : !detail ? <Button type="button" variant="outline" className="min-h-11" onClick={() => void load()}>重新加载</Button> : <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-muted/30 p-3 text-xs leading-5"><span>已确认到账 <strong>{currency(detail.summary.verifiedAmount)}</strong></span><span>凭证待核验 <strong>{currency(detail.summary.pendingProofAmount)}</strong></span><span>未被凭证或到账覆盖 <strong>{currency(detail.summary.creditAmount)}</strong></span></div>
      {detail.claims.length === 0 && <p className="text-sm text-muted-foreground">尚未上传付款凭证。无凭证也可发货，未确认到账的部分会自动登记赊销。</p>}
      <div className="space-y-3">{detail.claims.map(claim => {
        const eligible = detail.eligiblePayments.filter(payment => payment.type !== "refund" && Math.abs(Number(payment.amount) - claim.amount) < 0.005 && payment.channel === claim.channel && payment.account === claim.account);
        return <article key={claim.id} className="min-w-0 space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-semibold">{currency(claim.amount)} <span className="ml-1 text-xs font-normal text-muted-foreground">{claim.paymentMethodName || claim.channel}</span></div><Badge variant="outline">{{ pending: "凭证待核验", approved: "核验通过", rejected: "已驳回" }[claim.status]}</Badge></div>
          <p className="break-words text-xs leading-5 text-muted-foreground">付款时间：{String(claim.time || "").replace("T", " ")} · 收款账户：{claim.account} · 提交人：{claim.submittedBy}{claim.externalTransactionNo ? ` · 流水号：${claim.externalTransactionNo}` : ""}</p>
          {claim.notes && <p className="break-words text-sm">{claim.notes}</p>}
          <NewCustomerEvidenceGallery payment orderId={orderId} attachments={claim.evidenceAttachments || []} />
          {claim.status === "rejected" && <p className="break-words text-sm text-destructive">驳回原因：{claim.rejectionReason || "请联系财务核对"}</p>}
          {claim.reviewedBy && <p className="text-xs text-muted-foreground">核验人：{claim.reviewedBy} · {String(claim.reviewedAt || "").replace("T", " ")}</p>}
          {claim.status === "rejected" && detail.canSubmit && !reviewOnly && <Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => { setDraft({ claimId: claim.id, expectedVersion: claim.version, amount: String(claim.amount), time: claim.time.slice(0, 16), paymentMethodId: claim.paymentMethodId, externalTransactionNo: claim.externalTransactionNo || "", notes: claim.notes || "", attachments: [] }); setFormOpen(true); setError(""); }}>补充正确凭证并重提</Button>}
          {claim.status === "pending" && detail.canReview && <div className="space-y-3 border-t pt-3">
            <label className="grid gap-1.5 text-sm"><span>核验后关联的收款流水</span><select aria-label={`核验流水 ${claim.id}`} value={reviewChoice[claim.id] || ""} disabled={busy || uploading} className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" onChange={event => setReviewChoice(current => ({ ...current, [claim.id]: event.target.value }))}><option value="">请选择，避免同笔到账重复计收</option>{eligible.map(payment => <option key={payment.id} value={payment.id}>{payment.time} · {currency(payment.amount)} · {payment.externalTransactionNo || payment.id} · {payment.verificationStatus === "pending" ? "待核销" : "已核销"}</option>)}<option value="new" disabled={eligible.length > 0}>无对应现有流水，新增并确认到账</option></select></label>
            <label className="grid gap-1.5 text-sm"><span>核验说明／驳回原因</span><Textarea aria-label={`核验说明 ${claim.id}`} rows={2} disabled={busy} value={reasons[claim.id] || ""} onChange={event => setReasons(current => ({ ...current, [claim.id]: event.target.value }))} placeholder="驳回时必填；通过前请核对图片与真实到账" /></label>
            <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => review(claim, "reject")}><X className="size-4" />驳回凭证</Button><Button type="button" className="min-h-11" disabled={busy || uploading} onClick={() => review(claim, "approve")}><FileCheck2 className="size-4" />核验通过</Button></div>
          </div>}
        </article>;
      })}</div>
      {detail.canSubmit && !reviewOnly && !formOpen && <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => { setDraft(current => current.claimId ? { ...blankDraft(), paymentMethodId: detail.paymentMethods[0]?.id || "" } : { ...current, paymentMethodId: current.paymentMethodId || detail.paymentMethods[0]?.id || "" }); setFormOpen(true); setError(""); }}><Plus className="size-4" />上传本次付款凭证</Button>}
      {formOpen && detail.canSubmit && !reviewOnly && <div className="space-y-4 rounded-md border bg-muted/15 p-3">
        <h4 className="text-sm font-semibold">{draft.claimId ? "补充凭证并重新提交" : "登记本次付款"}</h4>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm">本次付款金额（元）<Input aria-label="本次付款金额" type="number" min="0.01" step="0.01" className="min-h-11" disabled={busy || uploading} value={draft.amount} onChange={event => setDraft(current => ({ ...current, amount: event.target.value }))} /></label>
          <label className="grid min-w-0 gap-1.5 text-sm">付款时间<Input aria-label="付款时间" type="datetime-local" className="min-h-11 min-w-0" disabled={busy || uploading} value={draft.time} onChange={event => setDraft(current => ({ ...current, time: event.target.value }))} /></label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">付款方式与收款账户<select aria-label="付款方式与收款账户" disabled={busy || uploading} className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={draft.paymentMethodId} onChange={event => setDraft(current => ({ ...current, paymentMethodId: event.target.value }))}><option value="">请选择付款方式</option>{detail.paymentMethods.map(method => <option key={method.id} value={method.id}>{method.name} · {method.account}</option>)}</select></label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">外部流水号（选填）<Input aria-label="付款流水号" disabled={busy || uploading} value={draft.externalTransactionNo} onChange={event => setDraft(current => ({ ...current, externalTransactionNo: event.target.value }))} /></label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">备注（选填）<Textarea aria-label="付款备注" rows={2} disabled={busy || uploading} value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} /></label>
        </div>
        {draft.claimId && <p className="text-xs text-muted-foreground">请重新上传正确的图片，原被驳回的凭证保留在审核记录中。</p>}
        <NewCustomerEvidenceUploader key={`${orderId}:${draft.claimId || "new"}`} payment orderId={orderId} attachments={draft.attachments} disabled={busy} onBusyChange={onBusyChange} onChange={attachments => setDraft(current => ({ ...current, attachments }))} />
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => setFormOpen(false)}>取消填写</Button><Button type="button" className="min-h-11" disabled={busy || uploading} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}提交财务核验</Button></div>
      </div>}
      {!detail.canSubmit && !reviewOnly && <p className="text-xs leading-5 text-muted-foreground">由当前订单负责人上传付款凭证。负责人转交未确认前，仍由原负责人提交。</p>}
    </>}
  </section>;
}
