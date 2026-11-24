import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, FileCheck2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useStore, type Order, type Store } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerEvidenceAttachment, type NewCustomerSession } from "../utils/newCustomerEvidence";
import { paymentProofDraftAllocation, getShippingSettlementSummary } from "../utils/shippingSettlement";
import type { PaymentProofClaim, PaymentProofDetail } from "../utils/orderPaymentProof";
import { validatePaymentProofDraft, type PaymentProofDraftField, type PaymentProofDraftIssue } from "../utils/paymentProofDraftValidation";
import { NewCustomerEvidenceGallery, NewCustomerEvidenceUploader } from "./NewCustomerEvidence";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";

const currency = (amount: number) => `¥${Number(amount || 0).toFixed(2)}`;
const initialTime = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
export type PaymentProofOpenRequest = { key: number; purpose: "order" | "shipping_fee" };
type Draft = { purpose: "order" | "shipping_fee"; claimId: string; expectedVersion?: number; amount: string; time: string; paymentMethodId: string; externalTransactionNo: string; notes: string; attachments: NewCustomerEvidenceAttachment[] };
const blankDraft = (): Draft => ({ purpose: "order", claimId: "", amount: "", time: initialTime(), paymentMethodId: "", externalTransactionNo: "", notes: "", attachments: [] });

export function OrderPaymentProofPanel({ orderId, onApplied, reviewOnly = false, openRequest, presentation = "default", selectedClaimId, onDetailChange }: {
  orderId: string; onApplied?: (result: { order?: Order; orders?: Order[]; operationLog?: Store["operationLogs"][number] }, session: NewCustomerSession) => void | Promise<void>; reviewOnly?: boolean; openRequest?: PaymentProofOpenRequest;
  presentation?: "default" | "cashier"; selectedClaimId?: string; onDetailChange?: (detail: PaymentProofDetail | null) => void;
}) {
  const { state } = useStore();
  const order = state.orders.find(item => item.id === orderId);
  const cashierOrder = order?.orderFormSchemaVersion === 4;
  const shippingSummary = order ? getShippingSettlementSummary(order, state.shipments) : null;
  const newShippingFlow = Boolean(shippingSummary?.enabled);
  const financialDataKey = JSON.stringify([order?.id, order?.status, order?.contactPersonnelId, order?.shippingFeeMode, order?.shippingFee, order?.shippingSettlementTiming, order?.items, order?.discount, order?.packagingFee, order?.payments, order?.paymentClaims,
    state.shipments.filter(shipment => shipment.orderId === orderId).map(shipment => [shipment.id, shipment.status, shipment.actualShippingFee, shipment.actualShippingFeeRecordedAt])]);
  const formRef = useRef<HTMLDivElement>(null);
  const submittedRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef<Partial<Record<PaymentProofDraftField, HTMLElement | null>>>({});
  const fieldId = useId();
  const handledOpenRequest = useRef<number | null>(null);
  const identity = JSON.stringify([state.user?.username, state.user?.role, state.user?.visibleSiteIds]);
  const [detail, setDetail] = useState<PaymentProofDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [privateOnly, setPrivateOnly] = useState(false);
  const [error, setError] = useState("");
  const [fieldIssues, setFieldIssues] = useState<PaymentProofDraftIssue[]>([]);
  const [submittedAmount, setSubmittedAmount] = useState<number | null>(null);
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
  const context = `${orderId}:${identity}`;
  const currentContext = useRef(context); currentContext.current = context;
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
      if (response.status === 403) { setPrivateOnly(true); setError(""); setFormOpen(false); setDraft(blankDraft()); setFieldIssues([]); setSubmittedAmount(null); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || "付款凭证加载失败。");
      if (result.orderId !== orderId || !Array.isArray(result.claims) || !Array.isArray(result.paymentMethods) || !Array.isArray(result.eligiblePayments) || !result.summary || !result.reviewToken) throw new Error("付款凭证信息不完整，请重新加载。");
      detailSession.current = session; setDetail(result); setDraft(currentDraft => ({ ...currentDraft, paymentMethodId: currentDraft.paymentMethodId || (cashierOrder ? "" : result.paymentMethods[0]?.id || "") }));
    } catch (cause) { if (current() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败，请重试。"); }
    finally { if (current()) setLoading(false); }
  }, [orderId, identity, financialDataKey]);

  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; seq.current += 1; pendingLoad.current?.abort(); };
  }, [load]);
  useEffect(() => { setError(""); setFieldIssues([]); setSubmittedAmount(null); setFormOpen(false); setDraft(blankDraft()); handledOpenRequest.current = null; }, [orderId, identity]);

  useEffect(() => { onDetailChange?.(detail); }, [detail, onDetailChange]);

  const write = async (path: string, body: unknown) => {
    if (lock.current || uploading) return;
    const session = captureNewCustomerSession();
    const current = () => mounted.current && currentContext.current === context && isNewCustomerSessionCurrent(session, viewer.current);
    if (!isNewCustomerSessionCurrent(session, viewer.current)) { setError("登录状态已变化，请重新打开订单。"); return; }
    if (session?.key !== detailSession.current?.key) { await load(); setError("登录状态已变化，请核对重新加载的信息后再提交。"); return; }
    lock.current = true; setBusy(true); setError("");
    let committed = false;
    try {
      const response = await fetch(`/api/orders/payment-proof/${path}`, { method: "POST", headers: authJsonHeaders(), body: JSON.stringify(body), cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || !result.ok) { if (response.status === 409) await load(); throw new Error(result.error || "操作失败，请重试。"); }
      // The server has saved this receipt. Close the draft before store refreshes
      // can rerender it; a later refresh failure must not invite resubmission.
      committed = true;
      setFormOpen(false); setDraft(blankDraft()); setFieldIssues([]);
      if (path === "submit") setSubmittedAmount(Number((body as { amount: number }).amount));
      toast.success(path === "submit" ? "付款凭证已提交，等待财务核验" : "核验结果已保存");
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
      await onApplied?.(result, session!);
      if (!current()) return;
      await load();
    } catch (cause) { if (current()) setError(committed ? "已保存，但页面刷新失败，请刷新记录核对，无需重复提交。" : cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };

  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest.key || !detail || loading || busy || uploading || reviewOnly) return;
    handledOpenRequest.current = openRequest.key;
    if (!detail.canSubmit) { setError("由当前订单负责人或管理员登记收款。"); return; }
    if (formOpen) {
      formRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      fieldRefs.current.amount?.focus({ preventScroll: true });
      if (draft.purpose !== openRequest.purpose) setError("请先提交或取消当前付款凭证，再登记另一笔收款。");
      return;
    }
    const summary = order ? getShippingSettlementSummary(order, state.shipments) : detail.shippingSettlement;
    setDraft({ ...blankDraft(), purpose: openRequest.purpose, amount: openRequest.purpose === "shipping_fee" && summary?.toCollect > 0 ? String(summary.toCollect) : "", paymentMethodId: cashierOrder ? "" : detail.paymentMethods[0]?.id || "" });
    setFormOpen(true); setError(""); setFieldIssues([]); setSubmittedAmount(null);
  }, [openRequest?.key, detail, loading, busy, uploading, reviewOnly]);

  useEffect(() => {
    if (formOpen) {
      formRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      fieldRefs.current.amount?.focus({ preventScroll: true });
    }
  }, [formOpen]);
  useEffect(() => {
    if (submittedAmount !== null) submittedRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
  }, [submittedAmount]);

  let draftAllocation: { purpose: string; shippingAmount: number; goodsAmount: number } | null = null;
  let allocationError = "";
  const draftMethod = detail?.paymentMethods.find(method => method.id === draft.paymentMethodId);
  const receiptCandidates = (detail?.receiptCandidates || []).filter(payment => Math.abs(Number(payment.amount) - Number(draft.amount)) < 0.005 && payment.channel === draftMethod?.channel && payment.account === draftMethod?.account);
  const matchingReceipt = receiptCandidates.length === 1 ? receiptCandidates[0] : null;
  if (newShippingFlow && order && Number(draft.amount) > 0) {
    try { draftAllocation = paymentProofDraftAllocation(order, state.shipments, Number(draft.amount), draft.purpose, draft.claimId, matchingReceipt); }
    catch (cause) { allocationError = cause instanceof Error ? cause.message : "请核对付款金额与待收金额。"; }
  }

  const submit = () => {
    if (busy || uploading || lock.current) return;
    const issues = validatePaymentProofDraft(draft, detail?.paymentMethods.map(method => method.id) || [], allocationError);
    setError(""); setFieldIssues(issues);
    if (issues.length) { focusField(issues[0].field); return; }
    const amount = Number(draft.amount);
    void write("submit", { orderId, ...(draft.claimId ? { claimId: draft.claimId, expectedVersion: draft.expectedVersion } : {}), amount, ...(newShippingFlow ? { purpose: draft.purpose, shippingAmount: draftAllocation?.shippingAmount ?? 0 } : {}), time: draft.time, paymentMethodId: draft.paymentMethodId, externalTransactionNo: draft.externalTransactionNo, notes: draft.notes, evidenceIds: draft.attachments.map(attachment => attachment.id) });
  };
  const focusField = (field: PaymentProofDraftField) => {
    const element = fieldRefs.current[field];
    element?.scrollIntoView({ behavior: "auto", block: "center" });
    element?.focus({ preventScroll: true });
  };
  const changeDraft = (patch: Partial<Draft>, field?: PaymentProofDraftField) => {
    setDraft(current => ({ ...current, ...patch })); setError("");
    if (field) setFieldIssues(current => current.filter(issue => issue.field !== field));
  };
  const fieldError = (field: PaymentProofDraftField) => fieldIssues.find(issue => issue.field === field)?.message;
  const fieldErrorId = (field: PaymentProofDraftField) => `${fieldId}-${field}-error`;
  const review = (claim: PaymentProofClaim, decision: "approve" | "reject") => {
    const selected = reviewChoice[claim.id]; const reason = reasons[claim.id]?.trim();
    if (decision === "approve" && !selected) return setError("请先选择关联现有收款流水，或明确选择新增一笔收款。");
    if (decision === "reject" && !reason) return setError("请填写驳回原因，方便订单负责人补充正确凭证。");
    void write("review", { orderId, claimId: claim.id, expectedVersion: claim.version, reviewToken: detail?.reviewToken, decision, reason: reason || "", ...(decision === "approve" && selected !== "new" ? { existingPaymentId: selected } : {}) });
  };

  return <section aria-label="订单付款凭证" aria-busy={loading || busy || uploading} className={presentation === "cashier" ? "min-w-0 space-y-3 border-t pt-4" : "min-w-0 space-y-3 rounded-lg border bg-card p-3 sm:p-4"}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold sm:text-base">{presentation === "cashier" ? "收款登记与凭证核验" : "付款凭证与财务核验"}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">负责人按每笔实付提交图片和金额。财务核验前不计入确认到账或提成；未覆盖金额发货时自动记赊销。</p></div><Button type="button" variant="ghost" className="min-h-11" disabled={busy || uploading || loading} onClick={() => { setError(""); void load(); }} aria-label="刷新付款凭证"><RefreshCw className="size-4" /></Button></div>
    {(!formOpen || !detail?.canSubmit || loading || privateOnly || reviewOnly) && error && <p role="alert" className="break-words rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>}
    {submittedAmount !== null && <div ref={submittedRef}><PaymentProofSubmissionFeedback submittedAmount={submittedAmount} /></div>}
    {loading ? <p role="status" className="py-3 text-sm text-muted-foreground">正在加载付款凭证…</p> : privateOnly ? <p className="text-sm leading-6 text-muted-foreground">付款图片仅由当前订单负责人、管理员及有财务核验权限的人员查看。</p> : !detail ? <Button type="button" variant="outline" className="min-h-11" onClick={() => void load()}>重新加载</Button> : <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-muted/30 p-3 text-xs leading-5"><span>已确认到账 <strong>{currency(detail.summary.verifiedAmount)}</strong></span><span>凭证待核验 <strong>{currency(detail.summary.pendingProofAmount)}</strong></span><span>未被凭证或到账覆盖 <strong>{currency(detail.summary.creditAmount)}</strong></span></div>
      {detail.claims.length === 0 && <p className="text-sm text-muted-foreground">尚未上传付款凭证。无凭证也可发货，未确认到账的部分会自动登记赊销。</p>}
      {presentation === "cashier" && !selectedClaimId && detail.claims.length > 0 && !formOpen && <p className="text-sm text-muted-foreground">点击上方收支记录，可查看该笔凭证和核验详情。</p>}
      <div className="space-y-3">{detail.claims.filter(claim => presentation !== "cashier" || claim.id === selectedClaimId).map(claim => {
        const eligible = detail.eligiblePayments.filter(payment => (!claim.matchingPaymentId || payment.id === claim.matchingPaymentId) && payment.type !== "refund" && Math.abs(Number(payment.amount) - claim.amount) < 0.005 && payment.channel === claim.channel && payment.account === claim.account);
        return <article key={claim.id} className="min-w-0 space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-semibold">{claim.purpose === "shipping_fee" ? "运费收款 · " : ""}{currency(claim.amount)} <span className="ml-1 text-xs font-normal text-muted-foreground">{claim.paymentMethodName || claim.channel}</span></div><Badge variant="outline">{{ pending: "凭证待核验", approved: "核验通过", rejected: "已驳回" }[claim.status]}</Badge></div>
          <p className="break-words text-xs leading-5 text-muted-foreground">付款时间：{String(claim.time || "").replace("T", " ")} · 收款账户：{claim.account} · 提交人：{claim.submittedBy}{claim.externalTransactionNo ? ` · 流水号：${claim.externalTransactionNo}` : ""}</p>
          {typeof claim.shippingAmount === "number" && <p className="text-xs text-muted-foreground">其中运费 {currency(claim.shippingAmount)} · 商品及包装 {currency(claim.amount - claim.shippingAmount)}</p>}
          {claim.notes && <p className="break-words text-sm">{claim.notes}</p>}
          <NewCustomerEvidenceGallery payment orderId={orderId} attachments={claim.evidenceAttachments || []} />
          {claim.status === "rejected" && <p className="break-words text-sm text-destructive">驳回原因：{claim.rejectionReason || "请联系财务核对"}</p>}
          {claim.reviewedBy && <p className="text-xs text-muted-foreground">核验人：{claim.reviewedBy} · {String(claim.reviewedAt || "").replace("T", " ")}</p>}
          {claim.status === "rejected" && detail.canSubmit && !reviewOnly && <Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => { setDraft({ purpose: claim.purpose || "order", claimId: claim.id, expectedVersion: claim.version, amount: String(claim.amount), time: claim.time.slice(0, 16), paymentMethodId: claim.paymentMethodId, externalTransactionNo: claim.externalTransactionNo || "", notes: claim.notes || "", attachments: [] }); setFormOpen(true); setError(""); setFieldIssues([]); setSubmittedAmount(null); }}>补充正确凭证并重提</Button>}
          {claim.status === "pending" && detail.canReview && <div className="space-y-3 border-t pt-3">
            <label className="grid gap-1.5 text-sm"><span>核验后关联的收款流水</span><select aria-label={`核验流水 ${claim.id}`} value={reviewChoice[claim.id] || ""} disabled={busy || uploading} className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" onChange={event => setReviewChoice(current => ({ ...current, [claim.id]: event.target.value }))}><option value="">请选择，避免同笔到账重复计收</option>{eligible.map(payment => <option key={payment.id} value={payment.id}>{payment.time} · {currency(payment.amount)} · {payment.externalTransactionNo || payment.id} · {payment.verificationStatus === "pending" ? "待核销" : "已核销"}</option>)}<option value="new" disabled={eligible.length > 0}>无对应现有流水，新增并确认到账</option></select></label>
            <label className="grid gap-1.5 text-sm"><span>核验说明／驳回原因</span><Textarea aria-label={`核验说明 ${claim.id}`} rows={2} disabled={busy} value={reasons[claim.id] || ""} onChange={event => setReasons(current => ({ ...current, [claim.id]: event.target.value }))} placeholder="驳回时必填；通过前请核对图片与真实到账" /></label>
            <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => review(claim, "reject")}><X className="size-4" />驳回凭证</Button><Button type="button" className="min-h-11" disabled={busy || uploading} onClick={() => review(claim, "approve")}><FileCheck2 className="size-4" />核验通过</Button></div>
          </div>}
        </article>;
      })}</div>
      {presentation !== "cashier" && detail.canSubmit && !reviewOnly && !formOpen && <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => { setDraft(current => current.claimId ? { ...blankDraft(), paymentMethodId: cashierOrder ? "" : detail.paymentMethods[0]?.id || "" } : { ...current, paymentMethodId: current.paymentMethodId || (cashierOrder ? "" : detail.paymentMethods[0]?.id || "") }); setFormOpen(true); setError(""); setFieldIssues([]); setSubmittedAmount(null); }}><Plus className="size-4" />上传本次付款凭证</Button>}
      {formOpen && detail.canSubmit && !reviewOnly && <div ref={formRef} className="space-y-4 rounded-md border bg-muted/15 p-3">
        <h4 className="text-sm font-semibold">{draft.claimId ? "补充凭证并重新提交" : draft.purpose === "shipping_fee" ? "登记运费收款" : "登记本次付款"}</h4>
        {newShippingFlow && draft.purpose === "shipping_fee" && <p className="text-sm text-muted-foreground">本笔为历史运费收款，保留原收款用途。</p>}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm">本次付款金额（元，必填）<Input ref={element => { fieldRefs.current.amount = element; }} aria-label="本次付款金额" required aria-invalid={Boolean(fieldError("amount"))} aria-describedby={fieldError("amount") ? fieldErrorId("amount") : undefined} aria-errormessage={fieldError("amount") ? fieldErrorId("amount") : undefined} type="number" min="0.01" max="100000000" step="0.01" className="min-h-11" disabled={busy || uploading} value={draft.amount} onChange={event => changeDraft({ amount: event.target.value }, "amount")} />{fieldError("amount") && <span id={fieldErrorId("amount")} className="text-xs text-destructive">{fieldError("amount")}</span>}</label>
          <label className="grid min-w-0 gap-1.5 text-sm">付款时间（必填）<Input ref={element => { fieldRefs.current.time = element; }} aria-label="付款时间" required aria-invalid={Boolean(fieldError("time"))} aria-describedby={fieldError("time") ? fieldErrorId("time") : undefined} aria-errormessage={fieldError("time") ? fieldErrorId("time") : undefined} type="datetime-local" className="min-h-11 min-w-0" disabled={busy || uploading} value={draft.time} onChange={event => changeDraft({ time: event.target.value }, "time")} />{fieldError("time") && <span id={fieldErrorId("time")} className="text-xs text-destructive">{fieldError("time")}</span>}</label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">付款方式与收款账户（必填）<select ref={element => { fieldRefs.current.paymentMethodId = element; }} aria-label="付款方式与收款账户" required aria-invalid={Boolean(fieldError("paymentMethodId"))} aria-describedby={fieldError("paymentMethodId") ? fieldErrorId("paymentMethodId") : undefined} aria-errormessage={fieldError("paymentMethodId") ? fieldErrorId("paymentMethodId") : undefined} disabled={busy || uploading} className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={draft.paymentMethodId} onChange={event => changeDraft({ paymentMethodId: event.target.value }, "paymentMethodId")}><option value="">请选择付款方式</option>{detail.paymentMethods.map(method => <option key={method.id} value={method.id}>{method.name} · {method.account}</option>)}</select>{fieldError("paymentMethodId") && <span id={fieldErrorId("paymentMethodId")} className="text-xs text-destructive">{fieldError("paymentMethodId")}</span>}</label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">外部流水号（选填）<Input aria-label="付款流水号" disabled={busy || uploading} value={draft.externalTransactionNo} onChange={event => changeDraft({ externalTransactionNo: event.target.value })} /></label>
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">备注（选填）<Textarea aria-label="付款备注" rows={2} disabled={busy || uploading} value={draft.notes} onChange={event => changeDraft({ notes: event.target.value })} /></label>
        </div>
        {newShippingFlow && <p className="text-xs leading-5 text-muted-foreground">{draft.purpose === "shipping_fee" ? "本笔全部登记为运费，不计商品提成。" : "订单收款先覆盖商品及包装，剩余部分计入运费。"} {draftAllocation && `本次：商品及包装 ${currency(draftAllocation.goodsAmount)}，运费 ${currency(draftAllocation.shippingAmount)}。`}</p>}
        {matchingReceipt && newShippingFlow && <p className="text-xs leading-5 text-muted-foreground">已有一笔相同金额、账户的收款；这次补充凭证后，由财务关联原流水核验，不再重复入账。</p>}
        {allocationError && !fieldError("amount") && <p role="alert" className="text-sm text-destructive">{allocationError}</p>}
        {draft.claimId && <p className="text-xs text-muted-foreground">请重新上传正确的图片，原被驳回的凭证保留在审核记录中。</p>}
        <div ref={element => { fieldRefs.current.attachments = element; }} tabIndex={-1} role="group" aria-label="付款图片凭证（必填）" aria-invalid={Boolean(fieldError("attachments"))} aria-describedby={fieldError("attachments") ? fieldErrorId("attachments") : undefined} className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4">
          <NewCustomerEvidenceUploader key={`${orderId}:${draft.claimId || "new"}`} payment orderId={orderId} attachments={draft.attachments} disabled={busy} onBusyChange={onBusyChange} onChange={attachments => changeDraft({ attachments }, "attachments")} />
          {fieldError("attachments") && <p id={fieldErrorId("attachments")} className="mt-2 text-sm text-destructive">{fieldError("attachments")}</p>}
        </div>
        <PaymentProofSubmissionFeedback issues={fieldIssues} error={error} onFocusField={focusField} />
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy || uploading} onClick={() => { setFormOpen(false); setError(""); setFieldIssues([]); }}>取消填写</Button><Button type="button" className="min-h-11" disabled={busy || uploading} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Check className="size-4" />}{busy ? "正在提交…" : "提交财务核验"}</Button></div>
      </div>}
      {!detail.canSubmit && !reviewOnly && <p className="text-xs leading-5 text-muted-foreground">由当前订单负责人上传付款凭证。负责人转交未确认前，仍由原负责人提交。</p>}
    </>}
  </section>;
}

export function PaymentProofSubmissionFeedback({ issues = [], error = "", submittedAmount = null, onFocusField }: {
  issues?: PaymentProofDraftIssue[]; error?: string; submittedAmount?: number | null;
  onFocusField?: (field: PaymentProofDraftField) => void;
}) {
  if (submittedAmount !== null) return <p role="status" aria-live="polite" className="rounded-md border px-3 py-3 text-sm">已提交 {currency(submittedAmount)}，等待财务核验。</p>;
  if (!error && !issues.length) return null;
  return <div role="alert" className="space-y-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
    <p className="font-medium">本次付款尚未提交</p>
    {error && <p className="break-words">{error}</p>}
    {issues.length > 0 && <ul className="space-y-1">{issues.map(issue => <li key={issue.field}><button type="button" className="min-h-9 text-left underline underline-offset-2" onClick={() => onFocusField?.(issue.field)}>{issue.message}</button></li>)}</ul>}
  </div>;
}
