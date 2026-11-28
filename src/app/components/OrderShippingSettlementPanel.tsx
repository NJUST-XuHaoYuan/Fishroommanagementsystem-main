import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useStore, type Order, type PaymentRecord, type Shipment, type Store } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerEvidenceAttachment, type NewCustomerSession } from "../utils/newCustomerEvidence";
import { getShippingSettlementSummary, shippingRefundDraftAmount, shippingSettlementStatusLabel, type ShippingSettlementSummary } from "../utils/shippingSettlement";
import { NewCustomerEvidenceGallery, NewCustomerEvidenceUploader } from "./NewCustomerEvidence";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const currency = (amount: number) => `¥${Number(amount || 0).toFixed(2)}`;
const initialTime = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
type RefundRecord = PaymentRecord & { evidenceAttachments?: NewCustomerEvidenceAttachment[] };
type SettlementDetail = {
  ok: true; orderId: string; shippingSettlement: ShippingSettlementSummary; canRefund: boolean;
  paymentMethods: { id: string; name: string; account: string }[]; refunds?: RefundRecord[];
};
type RefundDraft = { id: string; amount: string; time: string; paymentMethodId: string; notes: string; attachments: NewCustomerEvidenceAttachment[] };
const blankRefund = (): RefundDraft => ({ id: `shipping-refund-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, amount: "", time: initialTime(), paymentMethodId: "", notes: "", attachments: [] });

type Applied = { order?: Order; orders?: Order[]; operationLog?: Store["operationLogs"][number] };
export function OrderShippingSettlementPanel({ order, shipments, canUpdate, onApplied, onRecordActualFee, refundOpenRequest, amountDue }: {
  order: Order; shipments: Shipment[]; canUpdate: boolean;
  onApplied?: (result: Applied, session: NewCustomerSession) => void | Promise<void>;
  onRecordActualFee?: () => void; refundOpenRequest?: number; amountDue?: number;
}) {
  const { state } = useStore();
  const fallback = getShippingSettlementSummary(order, shipments, amountDue);
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refundOpen, setRefundOpen] = useState(false);
  const [draft, setDraft] = useState<RefundDraft>(blankRefund);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const lock = useRef(false);
  const refundFormRef = useRef<HTMLDivElement>(null);
  const handledRefundRequest = useRef<number>();
  const alive = useRef(true);
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const orderRef = useRef(order.id); orderRef.current = order.id;
  const viewer = useRef(state.user); viewer.current = state.user;
  const detailSession = useRef<NewCustomerSession | null>(null);
  const identity = JSON.stringify([state.user?.username, state.user?.role, state.user?.visibleSiteIds, state.user?.account, captureNewCustomerSession()?.key, order.contactPersonnelId, order.contactPerson, canUpdate]);
  const dataKey = JSON.stringify([order.id, order.status, order.shippingFee, order.shippingSettlementTiming, amountDue, order.items, order.payments, order.paymentClaims,
    shipments.filter(shipment => shipment.orderId === order.id).map(shipment => [shipment.id, shipment.status, shipment.actualShippingFee, shipment.actualShippingFeeRecordedAt])]);
  const onBusyChange = useCallback((value: boolean) => setUploading(value), []);

  const load = useCallback(async () => {
    if (!fallback.enabled) return;
    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    const session = captureNewCustomerSession();
    setLoading(true); setError("");
    const current = () => alive.current && orderRef.current === order.id && sequence === requestSequence.current && isNewCustomerSessionCurrent(session, viewer.current);
    try {
      const response = await fetch(`/api/orders/shipping-settlement?orderId=${encodeURIComponent(order.id)}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || "运费结算信息加载失败，请重试。");
      if (result.orderId !== order.id || !result.shippingSettlement?.version || !Array.isArray(result.paymentMethods)) throw new Error("运费结算信息不完整，请重新加载。");
      setDetail(result); detailSession.current = session;
    } catch (cause) {
      if (current() && !controller.signal.aborted) { setDetail(null); detailSession.current = null; setError(cause instanceof Error ? cause.message : "运费结算加载失败。"); }
    } finally { if (current()) setLoading(false); }
  }, [order.id, identity, fallback.enabled, dataKey]);

  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; ++requestSequence.current; controllerRef.current?.abort(); };
  }, [load]);
  useEffect(() => { setRefundOpen(false); setDraft(blankRefund()); setDetail(null); handledRefundRequest.current = undefined; }, [order.id, identity]);

  const summary = detail?.shippingSettlement || fallback;
  const actionAllowed = canUpdate && detail?.canRefund && order.status !== "cancelled" && !loading && !saving && !uploading;
  useEffect(() => {
    if (!refundOpenRequest || handledRefundRequest.current === refundOpenRequest || loading || saving || uploading) return;
    handledRefundRequest.current = refundOpenRequest;
    if (!actionAllowed || summary.toRefund <= 0) { setError("当前没有可登记的运费差额退款，请刷新后核对。"); return; }
    if (refundOpen) { refundFormRef.current?.scrollIntoView({ behavior: "auto", block: "start" }); return; }
    setDraft({ ...blankRefund(), amount: shippingRefundDraftAmount(summary), paymentMethodId: "" });
    setRefundOpen(true); setError("");
  }, [refundOpenRequest, loading, saving, uploading, actionAllowed, summary.toRefund, refundOpen]);
  useEffect(() => { if (refundOpen) refundFormRef.current?.scrollIntoView({ behavior: "auto", block: "start" }); }, [refundOpen]);

  const submitRefund = async () => {
    if (lock.current || !actionAllowed || !detail) return;
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) { setError("退款金额必须大于0，且最多两位小数。"); return; }
    if (amount - summary.toRefund > 0.005) { setError(`当前最多可退运费差额 ${currency(summary.toRefund)}，请核对金额。`); return; }
    if (!draft.time || !draft.paymentMethodId) { setError("请填写退款时间并选择退款账户。"); return; }
    if (!draft.attachments.length) { setError("请上传至少一张实际退款的图片凭证。"); return; }
    const session = captureNewCustomerSession();
    if (!session || session.key !== detailSession.current?.key || !isNewCustomerSessionCurrent(session, viewer.current)) { setError("登录状态已变化，请重新打开订单。"); return; }
    const targetOrder = order.id;
    lock.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/orders/shipping-refund", { method: "POST", headers: authJsonHeaders(), cache: "no-store", body: JSON.stringify({
        orderId: targetOrder, id: draft.id, expectedVersion: summary.version, amount, time: draft.time,
        paymentMethodId: draft.paymentMethodId, notes: draft.notes.trim(), evidenceIds: draft.attachments.map(attachment => attachment.id),
      }) });
      const result = await response.json().catch(() => ({}));
      if (!alive.current || targetOrder !== orderRef.current || !isNewCustomerSessionCurrent(session, viewer.current)) return;
      if (!response.ok || !result.ok) { if (response.status === 409) await load(); throw new Error(result.error || "运费退款登记失败，请重试。"); }
      await onApplied?.(result, session);
      if (!alive.current || targetOrder !== orderRef.current || !isNewCustomerSessionCurrent(session, viewer.current)) return;
      setRefundOpen(false); setDraft(blankRefund()); await load();
      toast.success("运费退款已登记，待财务核对出账");
    } catch (cause) {
      if (alive.current && targetOrder === orderRef.current && isNewCustomerSessionCurrent(session, viewer.current)) setError(cause instanceof Error ? cause.message : "运费退款登记失败，请重试。");
    } finally { lock.current = false; if (alive.current && targetOrder === orderRef.current) setSaving(false); }
  };

  if (!fallback.enabled) return null;
  return <section aria-label="运费结算" aria-busy={loading || saving || uploading} className="min-w-0 space-y-3 rounded-lg border bg-card p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold sm:text-base">运费核对与退差</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{summary.timing === "before_shipping" ? "预收运费已包含在订单应收中，实际费用确定后调整整单应收，多退少补。" : "实际运费确定后计入订单应收，通过上方登记收款统一补收。"}</p></div>
      <div className="flex items-center gap-2"><Badge variant="outline">{shippingSettlementStatusLabel(summary.status)}</Badge><Button type="button" variant="ghost" className="min-h-11" aria-label="刷新运费结算" disabled={loading || saving || uploading} onClick={() => void load()}><RefreshCw className="size-4" /></Button></div>
    </div>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      {summary.timing === "before_shipping" && <div><dt className="text-xs text-muted-foreground">创建时预收运费</dt><dd className="mt-1 font-medium tabular-nums">{currency(summary.estimatedFee)}</dd></div>}
      <div><dt className="text-xs text-muted-foreground">{summary.finalized ? "实际运费合计" : "已确定实际运费"}</dt><dd className="mt-1 font-medium tabular-nums">{summary.actualFee > 0 || summary.finalized ? currency(summary.actualFee) : "待确定"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">计入订单应收的运费</dt><dd className="mt-1 font-medium tabular-nums">{summary.timing === "after_shipping" && !summary.finalized && summary.shippingDue === 0 ? "待确定" : currency(summary.shippingDue)}</dd></div>
    </dl>
    {!summary.finalized && <p className="text-xs leading-5 text-muted-foreground">{summary.pendingShipmentCount > 0 ? `还有 ${summary.pendingShipmentCount} 笔发货的实际运费未补录。` : "尚未完成全部商品发货，运费还未最终确定。"}分批发货逐笔累计，运费待确定不影响出库和签收。</p>}
    {summary.pendingShipping > 0 && <p className="text-xs leading-5 text-muted-foreground">运费收款 {currency(summary.pendingShipping)} 待财务核验，已从待收金额中扣除，请勿重复收款。</p>}
    {summary.pendingRefundAmount > 0 && <p className="text-xs leading-5 text-muted-foreground">运费退款 {currency(summary.pendingRefundAmount)} 已登记，待财务核对出账，请勿重复退款。</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <div className="text-sm font-medium">{summary.toRefund > 0 ? `待退运费差额 ${currency(summary.toRefund)}` : summary.toCollect > 0 ? "待收运费已包含在整单待收金额中" : summary.finalized ? summary.status === "settled" ? "运费已结清" : "运费收退已登记，待财务核验" : "实际运费待确定"}</div>
      <div className="flex flex-wrap gap-2">
        {onRecordActualFee && !summary.finalized && <Button type="button" variant="outline" className="min-h-11" disabled={saving || uploading} onClick={onRecordActualFee}>补录实际运费</Button>}
        {summary.toRefund > 0 && !refundOpen && <span className="text-xs text-muted-foreground">请从上方“登记退款”选择退运费差额</span>}
      </div>
    </div>
    {loading && <p role="status" className="text-xs text-muted-foreground">正在核对最新运费记录…</p>}
    {error && !refundOpen && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {refundOpen && <div ref={refundFormRef} className="space-y-4 border-t pt-4">
      <div><h4 className="text-sm font-semibold">登记已退运费差额</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">先向客户完成退款，再登记金额和凭证，财务事后核验。待核验收款可用于登记退款；这里不会自动转账，也不影响鱼只、订单商品或提成。</p></div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5 text-sm">退款金额（元）<Input aria-label="运费退款金额" type="number" min="0.01" max={summary.toRefund} step="0.01" className="min-h-11" disabled={saving || uploading} value={draft.amount} onChange={event => setDraft(current => ({ ...current, amount: event.target.value }))} /></label>
        <label className="grid min-w-0 gap-1.5 text-sm">实际退款时间<Input aria-label="运费退款时间" type="datetime-local" className="min-h-11 min-w-0" disabled={saving || uploading} value={draft.time} onChange={event => setDraft(current => ({ ...current, time: event.target.value }))} /></label>
        <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">退款方式与账户<select aria-label="运费退款账户" className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" disabled={saving || uploading} value={draft.paymentMethodId} onChange={event => setDraft(current => ({ ...current, paymentMethodId: event.target.value }))}><option value="">请选择退款账户</option>{detail?.paymentMethods.map(method => <option key={method.id} value={method.id}>{method.name} · {method.account}</option>)}</select></label>
        <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">备注（选填）<Textarea aria-label="运费退款备注" rows={2} disabled={saving || uploading} value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} placeholder="例如：实际运费低于预收金额，退还差额" /></label>
      </div>
      <NewCustomerEvidenceUploader key={`${order.id}:${draft.id}`} payment refund orderId={order.id} attachments={draft.attachments} disabled={saving} onBusyChange={onBusyChange} onChange={attachments => setDraft(current => ({ ...current, attachments }))} />
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving || uploading} onClick={() => setRefundOpen(false)}>取消填写</Button><Button type="button" className="min-h-11" disabled={!actionAllowed} onClick={() => void submitRefund()}><Check className="size-4" />{saving ? "登记中…" : "登记已退款"}</Button></div>
    </div>}
    {!!detail?.refunds?.length && <div className="space-y-3 border-t pt-3"><h4 className="text-sm font-medium">运费退款记录</h4>{detail.refunds.map(refund => <article key={refund.id} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{currency(refund.amount)} · {String(refund.time || "").replace("T", " ")}</span><Badge variant="outline">{refund.verificationStatus === "pending" ? "出账待核验" : "出账已核验"}</Badge></div>
      {refund.notes && <p className="text-xs text-muted-foreground">{refund.notes}</p>}
      {refund.evidenceAttachments?.length ? <NewCustomerEvidenceGallery payment orderId={order.id} attachments={refund.evidenceAttachments} /> : null}
    </article>)}</div>}
  </section>;
}
