import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, History, RefreshCw } from "lucide-react";
import type { Shipment, Store, User } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerSession } from "../utils/newCustomerEvidence";
import {
  fulfillmentCorrectionDraft, fulfillmentCorrectionPayload, fulfillmentCorrectionPreviewFromPayload, shipmentFulfillmentState,
  type FulfillmentCorrection, type FulfillmentCorrectionDraft, type FulfillmentCorrectionHistory, type FulfillmentCorrectionPreview,
} from "../utils/shipmentFulfillmentCorrection";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

const originalStatusLabel: Record<string, string> = { preparing: "待发货", outbound: "已出库/待发货", shipped: "运输中", delivered: "已签收", damaged: "已报损" };
const chinaNow = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
const formatTime = (value?: string) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "未登记";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}（未记录时刻）`;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    const instant = Date.parse(raw);
    if (Number.isFinite(instant)) return new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  return raw.replace("T", " ").slice(0, 19);
};

function correctionSummary(correction: FulfillmentCorrection | null) {
  if (!correction) return "尚未核对实际履约情况，原登记时间保留。";
  const state = shipmentFulfillmentState({ fulfillmentCorrection: correction })!;
  return `实际发货：${correction.shippingTimeStatus === "known" ? formatTime(correction.actualShippedAt) : "无法核实"}；收货：${state.receiptLabel}${correction.receiptStatus === "received" && correction.actualDeliveredAt ? `（${formatTime(correction.actualDeliveredAt)}）` : ""}`;
}

function FulfillmentHistory({ history }: { history: FulfillmentCorrectionHistory[] }) {
  if (!history.length) return null;
  return <details className="group rounded-md border bg-background text-sm">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <History className="size-4 shrink-0" aria-hidden="true" />更正记录（{history.length}）<span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">展开查看</span>
    </summary>
    <ol className="space-y-4 border-t px-3 py-3">
      {[...history].reverse().map(record => <li key={record.id} className="space-y-1.5 break-words text-xs leading-5">
        <p className="font-medium">{formatTime(record.time)} · {record.operatorName || record.operator || "操作员未记录"}</p>
        <p><span className="text-muted-foreground">更正前：</span>{correctionSummary(record.from)}</p>
        <p><span className="text-muted-foreground">更正后：</span>{correctionSummary(record.to)}</p>
        <p className="whitespace-pre-wrap"><span className="text-muted-foreground">原因：</span>{record.reason}</p>
      </li>)}
    </ol>
  </details>;
}

/** Kept separate from workflow status so an old delivery flag is never presented as verified evidence. */
export function ShipmentFulfillmentRecord({ shipment }: { shipment: Shipment }) {
  const status = shipmentFulfillmentState(shipment);
  if (!status) return null;
  const correction = status.correction;
  return <div className="space-y-3 border-t bg-muted/15 px-4 py-3 text-sm">
    <div className="flex items-start gap-2">
      {status.pending && <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{status.label}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">原登记状态：{originalStatusLabel[shipment.status] || shipment.status}。以下核对结果与原记录分别保留。</p>
      </div>
    </div>
    <dl className="grid gap-x-5 gap-y-2 text-xs leading-5 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">原登记发货时间</dt><dd>{formatTime(shipment.shippedAt || shipment.shipDate)}</dd></div>
      <div><dt className="text-muted-foreground">原登记签收时间</dt><dd>{formatTime(shipment.deliveredAt)}</dd></div>
      <div><dt className="text-muted-foreground">实际发货时间</dt><dd className="font-medium">{correction.shippingTimeStatus === "known" ? formatTime(correction.actualShippedAt) : "无法核实"}</dd></div>
      <div><dt className="text-muted-foreground">实际收货情况</dt><dd className="font-medium">{status.receiptLabel}{correction.receiptStatus === "received" && correction.actualDeliveredAt ? ` · ${formatTime(correction.actualDeliveredAt)}` : ""}</dd></div>
    </dl>
    <p className="break-words whitespace-pre-wrap text-xs leading-5"><span className="text-muted-foreground">更正原因：</span>{correction.reason}</p>
    <p className="text-xs text-muted-foreground">{correction.operatorName || correction.operator} · {formatTime(correction.updatedAt)}</p>
    <FulfillmentHistory history={shipment.fulfillmentCorrectionHistory ?? []} />
  </div>;
}

export type ShipmentFulfillmentCorrectionResult = { shipment: Shipment; shipments?: Shipment[]; operationLog?: Store["operationLogs"][number] };
type Props = {
  shipmentId: string;
  viewer: User;
  onClose: () => void;
  onApplied: (result: ShipmentFulfillmentCorrectionResult, session: NewCustomerSession) => void;
};

export function ShipmentFulfillmentCorrectionDialog({ shipmentId, viewer, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<FulfillmentCorrectionPreview | null>(null);
  const [draft, setDraft] = useState<FulfillmentCorrectionDraft>(() => fulfillmentCorrectionDraft(null));
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const descriptionId = useId(), formId = useId();
  const mounted = useRef(false), sequence = useRef(0), busy = useRef(false);
  const controller = useRef<AbortController | null>(null), previewSession = useRef<NewCustomerSession | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ viewer, onClose, onApplied });
  propsRef.current = { viewer, onClose, onApplied };
  const viewerKey = JSON.stringify([viewer?.username, viewer?.role, viewer?.visibleSiteIds]);

  const reload = useCallback(async () => {
    const currentSequence = ++sequence.current;
    controller.current?.abort();
    const requestController = new AbortController(); controller.current = requestController;
    const session = captureNewCustomerSession();
    previewSession.current = null;
    setPreview(null); setLoading(true); setError(""); setStale(false);
    const current = () => mounted.current && currentSequence === sequence.current && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    if (!session || propsRef.current.viewer?.role !== "admin" || !isNewCustomerSessionCurrent(session, propsRef.current.viewer)) { setLoading(false); setError("仅管理员可以更正发货与签收时间，请重新登录后操作。"); return; }
    try {
      const response = await fetch(`/api/shipments/fulfillment-correction?shipmentId=${encodeURIComponent(shipmentId)}`, { headers: authJsonHeaders(), signal: requestController.signal, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || "履约核对信息加载失败，请重试。");
      const next = fulfillmentCorrectionPreviewFromPayload(payload, shipmentId);
      if (!next) throw new Error("服务器返回的履约信息不完整，请重新加载。");
      previewSession.current = session; setPreview(next); setDraft(fulfillmentCorrectionDraft(next.current));
    } catch (cause) {
      if (current() && !requestController.signal.aborted) setError(cause instanceof TypeError ? "网络连接失败，请重新加载核对信息。" : cause instanceof Error ? cause.message : "履约信息加载失败，请重试。");
    } finally { if (current()) setLoading(false); }
  }, [shipmentId]);

  useEffect(() => {
    mounted.current = true; void reload();
    return () => { mounted.current = false; sequence.current += 1; controller.current?.abort(); };
  }, [reload, viewerKey]);

  const patch = (changes: Partial<FulfillmentCorrectionDraft>) => { setDraft(current => ({ ...current, ...changes })); if (!stale) setError(""); };
  const fail = (message: string) => { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); };
  const submit = async () => {
    if (busy.current || loading || stale || !preview) return;
    const session = captureNewCustomerSession();
    if (!session || propsRef.current.viewer?.role !== "admin" || !isNewCustomerSessionCurrent(session, propsRef.current.viewer) || session.key !== previewSession.current?.key) { fail("登录状态已变化，请重新加载核对信息后操作。"); setStale(true); return; }
    let body;
    try { body = fulfillmentCorrectionPayload(preview, draft, chinaNow()); }
    catch (cause) { fail(cause instanceof Error ? cause.message : "请完成履约核对。"); return; }
    busy.current = true; setSaving(true); setError("");
    const current = () => mounted.current && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    try {
      const response = await fetch("/api/shipments/fulfillment-correction", { method: "POST", headers: authJsonHeaders(), cache: "no-store", body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || payload.ok !== true) {
        if (response.status === 409) setStale(true);
        throw new Error(payload.error || "履约更正保存失败，请重试。");
      }
      if (payload.shipment?.id !== shipmentId || payload.shipment?.orderId !== preview.order.id || !payload.shipment?.fulfillmentCorrection || Number(payload.shipment.fulfillmentCorrection.version) <= preview.expectedVersion) { setStale(true); throw new Error("服务器未返回完整更正结果，请重新加载确认保存状态。"); }
      propsRef.current.onApplied(payload, session); propsRef.current.onClose();
    } catch (cause) { if (current()) fail(cause instanceof TypeError ? "网络连接失败，请重试。" : cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { busy.current = false; if (current()) setSaving(false); }
  };

  return <Dialog open onOpenChange={next => { if (!next && !busy.current) onClose(); }}>
    <DialogContent aria-describedby={descriptionId} aria-busy={saving} onEscapeKeyDown={event => { if (busy.current) event.preventDefault(); }} onPointerDownOutside={event => { if (busy.current) event.preventDefault(); }}
      className={`max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto ${saving ? "[&_[data-slot=dialog-close]]:pointer-events-none [&_[data-slot=dialog-close]]:opacity-30" : ""}`}>
      <DialogHeader><DialogTitle>更正发货与签收时间</DialogTitle><DialogDescription id={descriptionId} className="pt-1 leading-6">按实际核对结果填写，北京时间；无法核实就保留未知。更正不重新出库，不改库存、订单金额、收款及提成。</DialogDescription></DialogHeader>
      {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm leading-6 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">{error}</div>}
      {loading ? <div role="status" className="space-y-3 py-2"><p className="text-sm text-muted-foreground">正在加载原登记及更正记录…</p><div className="h-20 rounded-md bg-muted" /><div className="h-28 rounded-md bg-muted" /></div> : preview ? <>
        <div className="space-y-1.5 rounded-md border bg-muted/20 p-3 text-xs leading-5">
          <p className="text-sm font-medium">订单 {preview.order.orderNo}</p>
          <p>原登记状态：{originalStatusLabel[preview.original.status] || preview.original.status}</p>
          <p>原登记发货时间：{formatTime(preview.original.shippedAt || preview.original.shipDate)}</p>
          <p>原登记签收时间：{formatTime(preview.original.deliveredAt)}</p>
        </div>
        <form id={formId} className="space-y-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <fieldset disabled={saving || stale} className="min-w-0 space-y-3">
            <legend className="mb-2 text-sm font-medium">实际发货时间</legend>
            <div className="grid gap-2 sm:grid-cols-2">{([ ["known", "有记录"], ["unknown", "无法核实"] ] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${draft.shippingTimeStatus === value ? "border-foreground bg-muted" : "hover:bg-muted/40"}`}><input type="radio" name={`${formId}-shipping`} value={value} checked={draft.shippingTimeStatus === value} onChange={() => patch({ shippingTimeStatus: value })} className="size-4 accent-current" />{label}</label>)}</div>
            {draft.shippingTimeStatus === "known" ? <div className="grid gap-1.5"><Label htmlFor={`${formId}-shipped`}>实际发货时间<span aria-hidden="true"> *</span></Label><Input id={`${formId}-shipped`} type="datetime-local" step="1" value={draft.actualShippedAt} min={preview.order.date ? `${preview.order.date}T00:00:00` : undefined} max={chinaNow()} onChange={event => patch({ actualShippedAt: event.target.value })} required className="min-h-11 min-w-0" /></div> : <p className="text-xs leading-5 text-muted-foreground">保存为“发货时间无法核实”，不会使用原登记日期代填。</p>}
          </fieldset>
          <fieldset disabled={saving || stale} className="min-w-0 space-y-3">
            <legend className="mb-2 text-sm font-medium">实际收货情况</legend>
            <div className="grid gap-2 sm:grid-cols-3">{([ ["received", "已收到"], ["not_received", "尚未收到"], ["unknown", "无法核实"] ] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${draft.receiptStatus === value ? "border-foreground bg-muted" : "hover:bg-muted/40"}`}><input type="radio" name={`${formId}-receipt`} value={value} checked={draft.receiptStatus === value} onChange={() => patch({ receiptStatus: value })} className="size-4 accent-current" />{label}</label>)}</div>
            {draft.receiptStatus === "received" && <div className="space-y-3"><label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={draft.receiptDateUnknown} onChange={event => patch({ receiptDateUnknown: event.target.checked })} className="size-4 shrink-0 accent-current" />签收日期无法核实</label>{!draft.receiptDateUnknown && <div className="grid gap-1.5"><Label htmlFor={`${formId}-delivered`}>实际签收时间<span aria-hidden="true"> *</span></Label><Input id={`${formId}-delivered`} type="datetime-local" step="1" value={draft.actualDeliveredAt} min={draft.shippingTimeStatus === "known" ? draft.actualShippedAt : preview.order.date ? `${preview.order.date}T00:00:00` : undefined} max={chinaNow()} onChange={event => patch({ actualDeliveredAt: event.target.value })} required className="min-h-11 min-w-0" /></div>}{draft.receiptDateUnknown && <p className="text-xs leading-5 text-muted-foreground">将记录“已收到，签收日期待核实”，不代填签收时间。</p>}</div>}
          </fieldset>
          <div className="grid gap-1.5"><Label htmlFor={`${formId}-reason`}>更正原因及核对依据<span aria-hidden="true"> *</span></Label><Textarea id={`${formId}-reason`} value={draft.reason} maxLength={1000} required disabled={saving || stale} placeholder="例如：核对聊天记录，原鱼延迟发货；实际发货日期与收货情况暂无法核实。" onChange={event => patch({ reason: event.target.value })} className="min-h-24" /><p className="text-xs leading-5 text-muted-foreground">本次核对结果、原因和操作员会保留在更正记录中。</p></div>
        </form>
        <FulfillmentHistory history={preview.history} />
      </> : <p className="text-sm text-muted-foreground">履约核对信息尚未加载完成，请重新加载后操作。</p>}
      <DialogFooter className="gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onClose}>取消</Button>{(!preview || stale) && !loading ? <Button type="button" className="min-h-11" disabled={saving} onClick={() => void reload()}><RefreshCw className="size-4" aria-hidden="true" />重新加载核对信息</Button> : <Button type="submit" form={formId} className="min-h-11" disabled={loading || saving || !preview}>{saving ? "保存中…" : "保存更正记录"}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
