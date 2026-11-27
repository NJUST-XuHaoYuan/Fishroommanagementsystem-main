import { useEffect, useRef, useState } from "react";
import { ChevronDown, History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { configuredPaymentMethods, paymentChannelLabel, uid, useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { paymentCorrectionAction, paymentCorrectionNeedsReplacement, type CorrectablePayment, type PaymentCorrection } from "../utils/paymentCorrection";
import { usePermission } from "../utils/permissions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { ImageWithFallback } from "./figma/ImageWithFallback";

const money = (value: number) => `¥${Number(value || 0).toFixed(2)}`;
const time = (value?: string) => String(value || "—").replace("T", " ");

export function PaymentCorrectionDialog({ orderId, orderNo, completed, payment, onClose, onApplied }: {
  orderId: string; orderNo: string; completed: boolean; payment: CorrectablePayment | null;
  onClose: () => void; onApplied: () => Promise<void>;
}) {
  const { state } = useStore();
  const permission = usePermission("finance");
  const [mode, setMode] = useState<"replace" | "retract">("replace");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [paidTime, setPaidTime] = useState("");
  const [methodId, setMethodId] = useState("");
  const [externalNo, setExternalNo] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mutationId = useRef("");
  const mounted = useRef(true);
  const viewer = useRef(state.user); viewer.current = state.user;
  const context = `${orderId}:${payment?.id || ""}:${state.user?.username || ""}`;
  const currentContext = useRef(context); currentContext.current = context;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setMode("replace"); setReason(""); setError("");
    setAmount(String(payment?.amount || "")); setPaidTime(String(payment?.time || "").slice(0, 16));
    setMethodId(""); setExternalNo(payment?.externalTransactionNo || ""); setNotes(payment?.notes || "");
    mutationId.current = uid();
  }, [context, payment?.correctionToken]);
  const action = payment ? paymentCorrectionAction(payment) : null;
  const proofResubmit = payment?.correctionMode === "proof_resubmit";
  const replace = Boolean(payment && paymentCorrectionNeedsReplacement(payment, mode));
  const methods = configuredPaymentMethods(state.systemSettings);
  const title = action === "void" ? "撤销错误登记" : proofResubmit ? "更正凭证核验" : "更正资金流水";

  const submit = async () => {
    if (!payment || !action || lock.current || !permission.requirePermission("update")) return;
    if (!reason.trim()) return setError("请填写更正原因，便于后续核对。");
    if (!payment.correctionToken) return setError("流水信息已变化，请关闭后重新打开。");
    if (replace && (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 100000000 || Math.abs(Number(amount) * 100 - Math.round(Number(amount) * 100)) > 0.00001)) return setError("请输入大于 0、最多两位小数的金额。");
    if (replace && (!paidTime || !Number.isFinite(Date.parse(paidTime)))) return setError("请选择流水登记时间。");
    const session = captureNewCustomerSession();
    const current = () => mounted.current && currentContext.current === context && isNewCustomerSessionCurrent(session, viewer.current);
    if (!current()) return setError("登录状态已变化，请重新打开订单。");
    lock.current = true; setBusy(true); setError("");
    let committed = false;
    try {
      const response = await fetch("/api/orders/payment-correction", {
        method: "POST", headers: authJsonHeaders(), cache: "no-store",
        body: JSON.stringify({ orderId, paymentId: payment.id, action, reason: reason.trim(), expectedToken: payment.correctionToken,
          clientMutationId: mutationId.current, ...(action === "correct" ? { mode: replace ? "replace" : "retract" } : {}),
          ...(replace ? { payment: { amount: Number(amount), time: paidTime, paymentMethodId: methodId,
            channel: payment.channel, account: payment.account, externalTransactionNo: externalNo.trim(), notes: notes.trim() } } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || "更正失败，请重试。");
      committed = true;
      toast.success(result.proofResubmissionRequired ? "已退回负责人补正凭证，原流水已保留" : replace ? "更正已保存，新登记等待财务核验" : "错误登记已撤销，原记录已保留");
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
      await onApplied();
      if (current()) onClose();
    } catch (cause) {
      if (current()) setError(committed ? "更正已保存，页面刷新失败。请关闭后刷新核对，无需再次提交。" : cause instanceof Error ? cause.message : "更正失败，请重试。");
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };

  return <Dialog open={Boolean(payment)} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{title} · {orderNo}</DialogTitle></DialogHeader>
      {payment && <>
        <div className="rounded-md border bg-muted/25 p-3 text-sm leading-6"><p className="font-medium">原{payment.type === "refund" ? "退款" : "收款"} {money(payment.amount)}</p><p className="break-words text-muted-foreground">{time(payment.time)} · {payment.paymentMethodName || paymentChannelLabel(payment.channel || "")} · {payment.account || "未登记账户"}</p></div>
        {action === "correct" && !proofResubmit && <label className="grid gap-1.5 text-sm">如何更正<select className="fishroom-control min-h-11 rounded-md border bg-background px-3" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as "replace" | "retract"); setError(""); }}><option value="replace">修改登记内容</option><option value="retract">撤销误记的这笔收支</option></select></label>}
        <p className="text-sm leading-6 text-muted-foreground">{proofResubmit ? "撤销本次核验，退回订单负责人补正付款凭证。原流水和核验记录仍保留。" : replace ? "保留原流水，生成一笔更正后的待核验登记。" : "撤销后，这笔登记不再计入收退款。原记录和撤销原因仍保留。"} 只修正系统登记，不代表向客户退款。</p>
        {completed && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">此订单已完成。更正后将恢复为未完成，结清并重新核验后才能完成；发货和库存记录不变。</p>}
        {replace && payment.type === "refund" && <p className="text-xs leading-5 text-muted-foreground">这里只更正资金登记，原退款业务日期和发货前／后归属保留。</p>}
        {replace && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">正确金额（元）<Input aria-label="更正金额" type="number" min="0.01" step="0.01" className="min-h-11" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} /></label>
          <label className="grid min-w-0 gap-1.5 text-sm">流水登记时间<Input aria-label="更正流水登记时间" type="datetime-local" className="min-h-11 min-w-0" value={paidTime} disabled={busy} onChange={event => setPaidTime(event.target.value)} /></label>
          <label className="grid gap-1.5 text-sm sm:col-span-2">付款方式与账户<select aria-label="更正付款方式" className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3" value={methodId} disabled={busy} onChange={event => setMethodId(event.target.value)}><option value="">保留原账户：{payment.paymentMethodName || paymentChannelLabel(payment.channel || "")} · {payment.account || "未登记"}</option>{methods.map(method => <option key={method.id} value={method.id}>{method.name} · {method.account}</option>)}</select></label>
          <label className="grid gap-1.5 text-sm sm:col-span-2">外部流水号（选填）<Input value={externalNo} disabled={busy} onChange={event => setExternalNo(event.target.value)} /></label>
          <label className="grid gap-1.5 text-sm sm:col-span-2">收支备注（选填）<Textarea value={notes} rows={2} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
        </div>}
        <label className="grid gap-1.5 text-sm">更正原因（必填）<Textarea aria-label="更正原因" autoFocus rows={3} maxLength={1000} value={reason} disabled={busy} onChange={event => { setReason(event.target.value); setError(""); }} placeholder="例如：重复登记、金额填写错误，说明应如何处理" /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" className="min-h-11" disabled={busy} onClick={onClose}>取消</Button><Button className="min-h-11" disabled={busy || !action} onClick={() => void submit()}>{busy && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}{busy ? "正在保存…" : proofResubmit ? "退回补正凭证" : replace ? "保存更正并待核验" : "确认撤销登记"}</Button></DialogFooter>
      </>}
    </DialogContent>
  </Dialog>;
}

export function PaymentCorrectionHistory({ corrections }: { corrections?: PaymentCorrection[] }) {
  if (!corrections?.length) return null;
  return <details className="group mt-4 rounded-md border bg-background"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-medium"><History className="size-4" />更正记录 <span className="text-muted-foreground">{corrections.length} 笔</span><ChevronDown className="ml-auto size-4 group-open:rotate-180" /></summary><div className="divide-y border-t">{[...corrections].sort((a, b) => b.operatedAt.localeCompare(a.operatedAt)).map(entry => <details key={entry.id} className="p-3 text-sm"><summary className="cursor-pointer leading-6"><span className="font-medium">{entry.action === "void" || !entry.replacementPayment ? "撤销登记" : "更正登记"} · 原{entry.originalPayment.type === "refund" ? "退款" : "收款"} {money(entry.originalPayment.amount)}{entry.replacementPayment ? ` → ${money(entry.replacementPayment.amount)}` : ""}</span><span className="block text-xs text-muted-foreground">{entry.operator} · {time(entry.operatedAt)}</span></summary><div className="mt-2 space-y-2 break-words text-xs leading-5"><p>原因：{entry.reason}</p><p className="text-muted-foreground">原记录：{time(entry.originalPayment.time)} · {entry.originalPayment.paymentMethodName || paymentChannelLabel(entry.originalPayment.channel || "")} · {entry.originalPayment.account || "未登记账户"} · {entry.originalPayment.verificationStatus === "pending" ? "待核验" : "已核验"}</p>{entry.originalPayment.externalTransactionNo && <p>原流水号：{entry.originalPayment.externalTransactionNo}</p>}{entry.originalPayment.notes && <p>原备注：{entry.originalPayment.notes}</p>}{entry.replacementPayment && <p>更正后：{time(entry.replacementPayment.time)} · {entry.replacementPayment.paymentMethodName || paymentChannelLabel(entry.replacementPayment.channel || "")} · {entry.replacementPayment.account || "未登记账户"}。后续核验状态见当前流水。</p>}{entry.affectedClaimIds?.length > 0 && <p>关联付款凭证已退回负责人补正。</p>}{entry.reopenedFromStatus && <p>操作时已将订单恢复为未完成。</p>}{Boolean(entry.originalPayment.proof?.length) && <div className="flex flex-wrap gap-2">{entry.originalPayment.proof.map((src, index) => <MediaPreviewTrigger key={src} src={src} mediaType="image" title="更正前资金凭证" filename={`原资金凭证-${entry.id}-${index + 1}.jpg`} ariaLabel={`查看更正前凭证 ${index + 1}`} className="block size-12 overflow-hidden rounded border"><ImageWithFallback src={src} alt="更正前资金凭证" className="size-full object-cover" /></MediaPreviewTrigger>)}</div>}</div></details>)}</div></details>;
}
