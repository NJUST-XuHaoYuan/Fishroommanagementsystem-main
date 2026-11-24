import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight, Wallet } from "lucide-react";
import { useStore, type Order, type Shipment, type Store } from "../store";
import { orderCashierEntries, orderCashierTotals, type CashierEntry } from "../utils/orderCashier";
import type { PaymentProofDetail } from "../utils/orderPaymentProof";
import type { NewCustomerSession } from "../utils/newCustomerEvidence";
import { OrderPaymentProofPanel, type PaymentProofOpenRequest } from "./OrderPaymentProofPanel";
import { getShippingSettlementSummary } from "../utils/shippingSettlement";
import { OrderShippingSettlementPanel } from "./OrderShippingSettlementPanel";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const currency = (amount: number) => `¥${Number(amount || 0).toFixed(2)}`;
const timeLabel = (time: string) => String(time || "未登记时间").replace("T", " ").slice(0, 16);
type Applied = { order?: Order; orders?: Order[]; operationLog?: Store["operationLogs"][number] };

export function OrderCashierPanel({ order, shipments, amountDue, canUpdate, refundAvailable, refundSaving = false, onRefund, onApplied, onRecordActualFee, children }: {
  order: Order;
  shipments: Shipment[];
  amountDue: number;
  canUpdate: boolean;
  refundAvailable: boolean;
  refundSaving?: boolean;
  onRefund: () => void;
  onApplied?: (result: Applied, session: NewCustomerSession) => void | Promise<void>;
  onRecordActualFee?: () => void;
  children?: ReactNode;
}) {
  const { state } = useStore();
  const contextKey = JSON.stringify([order.id, state.user?.username, state.user?.role, state.user?.visibleSiteIds]);
  const [proofState, setProofState] = useState<{ context: string; detail: PaymentProofDetail | null } | null>(null);
  const proofDetail = proofState?.context === contextKey && proofState.detail?.orderId === order.id ? proofState.detail : null;
  const [openRequest, setOpenRequest] = useState<PaymentProofOpenRequest>();
  const [selectedId, setSelectedId] = useState("");
  const [refundChoiceOpen, setRefundChoiceOpen] = useState(false);
  const [shippingRefundRequest, setShippingRefundRequest] = useState<number>();
  const freight = getShippingSettlementSummary(order, shipments, amountDue);
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const onDetailChange = useCallback((detail: PaymentProofDetail | null) => setProofState({ context: contextKey, detail }), [contextKey]);
  useEffect(() => { setSelectedId(""); setDirection("all"); setProofState(null); setOpenRequest(undefined); setRefundChoiceOpen(false); setShippingRefundRequest(undefined); }, [contextKey]);
  const entries = useMemo(() => orderCashierEntries(order, proofDetail?.claims), [order.payments, order.paymentClaims, proofDetail]);
  const totals = useMemo(() => orderCashierTotals(entries), [entries]);
  const selected = entries.find(entry => entry.id === selectedId);
  const visibleEntries = entries.filter(entry => direction === "all" || entry.direction === direction);
  const canRecord = canUpdate && proofDetail?.canSubmit === true;
  const requestPayment = () => setOpenRequest({ key: Date.now(), purpose: "order" });

  return <section aria-label="订单收银台" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="flex items-center gap-2 text-base font-semibold"><Wallet className="size-4" aria-hidden="true" />收银台</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">按每笔实际收付登记金额、账户和凭证，财务事后核验；完成订单前需核验结清。</p></div>
    </div>

    <OrderCashierBalanceSummary order={order} shipments={shipments} amountDue={amountDue} netRecorded={totals.netRecorded}
      onRecordPayment={canUpdate ? requestPayment : undefined} canRecordPayment={canRecord}
      onRecordRefund={refundAvailable ? () => freight.toRefund > 0 ? setRefundChoiceOpen(true) : onRefund() : undefined} refundSaving={refundSaving} />

    <dl className="grid grid-cols-1 gap-3 border-y py-4 sm:grid-cols-3 sm:gap-6">
      <div><dt className="text-xs text-muted-foreground">已登记收款</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{currency(totals.received)}</dd><p className="mt-1 text-xs text-muted-foreground">财务已确认 {currency(totals.confirmedReceived)}</p></div>
      <div><dt className="text-xs text-muted-foreground">已登记退款</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{currency(totals.refunded)}</dd><p className="mt-1 text-xs text-muted-foreground">出账已核验 {currency(totals.confirmedRefunded)}</p></div>
      <div><dt className="text-xs text-muted-foreground">登记净额</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{currency(totals.netRecorded)}</dd><p className="mt-1 text-xs text-muted-foreground">已登记收款减退款，含待核验记录</p></div>
    </dl>

    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">收支记录 <span className="font-normal text-muted-foreground">{entries.length} 笔</span></h4><div className="flex gap-1" role="group" aria-label="收支记录方向">{([["all", "全部"], ["in", "入账"], ["out", "出账"]] as const).map(([value, label]) => <Button key={value} type="button" size="sm" variant={direction === value ? "secondary" : "ghost"} className="min-h-11" aria-pressed={direction === value} onClick={() => { setDirection(value); setSelectedId(""); }}>{label}</Button>)}</div></div>
      {visibleEntries.length === 0 ? <p className="border-y py-6 text-center text-sm text-muted-foreground">{entries.length ? "暂无此类收支记录" : "尚无收支记录。"}</p> : <div className="divide-y border-y">
        {visibleEntries.map(entry => <div key={entry.id}>
          <button type="button" aria-expanded={selectedId === entry.id} aria-label={`查看${entry.label} ${currency(entry.amount)} ${timeLabel(entry.time)}`} onClick={() => setSelectedId(current => current === entry.id ? "" : entry.id)} className="flex min-h-16 w-full min-w-0 items-start gap-3 rounded-sm px-1 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${entry.direction === "in" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{entry.direction === "in" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span>
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><span className="text-sm font-medium">{entry.label}</span><strong className="whitespace-nowrap text-sm tabular-nums">{entry.direction === "in" ? "+" : "−"}{currency(entry.amount)}</strong></span><span className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><span className="break-words text-xs text-muted-foreground">{timeLabel(entry.time)} · {entry.method}</span><Badge variant="outline" className={entry.status === "rejected" || entry.status === "unmatched" ? "border-rose-200 text-rose-800" : entry.status === "pending" ? "border-amber-200 text-amber-800" : "border-emerald-200 text-emerald-800"}>{entry.statusLabel}</Badge></span></span>
            {selectedId === entry.id ? <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />}
          </button>
          {selectedId === entry.id && <CashierEntryDetail entry={entry} canViewProof={proofDetail !== null} />}
        </div>)}
      </div>}
    </div>

    <OrderPaymentProofPanel key={`cashier-proof:${contextKey}`} orderId={order.id} onApplied={onApplied} openRequest={openRequest} presentation="cashier" selectedClaimId={selected?.claim?.id} onDetailChange={onDetailChange} />

    <OrderShippingSettlementPanel key={`cashier-freight:${contextKey}`} order={order} shipments={shipments} canUpdate={canUpdate} onApplied={onApplied} onRecordActualFee={onRecordActualFee} refundOpenRequest={shippingRefundRequest} amountDue={amountDue} />

    <Dialog open={refundChoiceOpen} onOpenChange={setRefundChoiceOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>选择退款类型</DialogTitle><DialogDescription>本单有运费差额可退，请按本次实际退款原因登记，无需等待财务核验收款。</DialogDescription></DialogHeader>
        <Button type="button" variant="outline" className="h-auto min-h-[44px] justify-start whitespace-normal py-3 text-left" onClick={() => { setRefundChoiceOpen(false); setShippingRefundRequest(Date.now()); }}>
          <span><span className="block font-medium">退运费差额 · {currency(freight.toRefund)}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">实际运费低于预收，退还多收的运费。</span></span>
        </Button>
        <Button type="button" variant="outline" className="h-auto min-h-[44px] justify-start whitespace-normal py-3 text-left" onClick={() => { setRefundChoiceOpen(false); onRefund(); }}>
          <span><span className="block font-medium">其他订单退款</span><span className="mt-1 block text-xs font-normal text-muted-foreground">商品退款、售后退款等，按实际金额登记。</span></span>
        </Button>
      </DialogContent>
    </Dialog>

    {children && <details className="border-t pt-3"><summary className="cursor-pointer py-1 text-sm font-medium">订单应收明细</summary><div className="mt-3">{children}</div></details>}
  </section>;
}

function CashierEntryDetail({ entry, canViewProof }: { entry: CashierEntry; canViewProof: boolean }) {
  const record = entry.payment || entry.claim;
  const shippingAmount = entry.payment?.shippingAmount ?? entry.claim?.shippingAmount;
  const recordedBy = entry.payment?.recordedBy || entry.claim?.submittedBy;
  const verifiedBy = entry.payment?.verifiedBy || entry.claim?.reviewedBy;
  return <div className="mb-3 ml-11 space-y-2 border-t pt-3 text-xs leading-5">
    <dl className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{entry.direction === "in" ? "收款账户" : "退款账户"}</dt><dd className="break-words">{entry.account || "未登记"}</dd></div>
      <div><dt className="text-muted-foreground">流水号</dt><dd className="break-all">{record?.externalTransactionNo || "未登记"}</dd></div>
      {recordedBy && <div><dt className="text-muted-foreground">登记人</dt><dd>{recordedBy}</dd></div>}
      {verifiedBy && <div><dt className="text-muted-foreground">核验人</dt><dd>{verifiedBy}</dd></div>}
      {typeof shippingAmount === "number" && <div><dt className="text-muted-foreground">金额归属</dt><dd>商品及包装 {currency(Math.max(0, entry.amount - shippingAmount))} · 运费 {currency(shippingAmount)}</dd></div>}
      {entry.payment?.refundStage && <div><dt className="text-muted-foreground">退款阶段</dt><dd>{entry.payment.refundStage === "before_shipment" ? "发货前退款" : "发货后退款"}</dd></div>}
    </dl>
    {record?.notes && <p className="break-words whitespace-pre-wrap">{record.notes}</p>}
    {entry.claim && <p className="text-muted-foreground">{canViewProof ? "本笔付款凭证与审核详情见下方。" : "付款凭证仅向订单负责人、管理员及有财务核验权限的人员开放。"}</p>}
    {canViewProof && !entry.claim && Boolean(entry.payment?.proof?.length) && <MediaPreviewTrigger items={entry.payment!.proof.map((src, index) => ({ src, type: "image" as const, title: `收支凭证 ${index + 1}` }))} title="收支凭证"><Button type="button" variant="outline" className="min-h-11">预览凭证（{entry.payment!.proof.length}）</Button></MediaPreviewTrigger>}
  </div>;
}


export function OrderCashierBalanceSummary({ order, shipments, amountDue, netRecorded, onRecordPayment, canRecordPayment = false, onRecordRefund, refundSaving = false }: {
  order: Order; shipments: Shipment[]; amountDue: number; netRecorded: number;
  onRecordPayment?: () => void; canRecordPayment?: boolean; onRecordRefund?: () => void; refundSaving?: boolean;
}) {
  const freight = getShippingSettlementSummary(order, shipments, amountDue);
  const balance = (Math.round(amountDue * 100) - Math.round(netRecorded * 100)) / 100;
  const goodsAndPackaging = Math.round((amountDue - (freight.enabled ? freight.shippingDue : 0)) * 100) / 100;
  const freightLabel = freight.finalized ? "实际运费" : freight.timing === "before_shipping" ? "预收运费" : "已确定运费";
  return <section aria-label="订单应收应付" className="min-w-0 rounded-lg border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0">
        {balance === 0 ? <p className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />无应收应付</p> : <>
          <p className="text-sm font-medium">{balance > 0 ? "应收金额" : "应付金额（退款）"}</p>
          <p className={`mt-1 break-all text-3xl font-semibold tabular-nums ${balance > 0 ? "text-amber-800 dark:text-amber-300" : "text-rose-800 dark:text-rose-300"}`}>{currency(Math.abs(balance))}</p>
        </>}
      </div>
      {balance > 0 && onRecordPayment && <Button type="button" className="min-h-11" disabled={!canRecordPayment} onClick={onRecordPayment}><ArrowDownLeft className="size-4" aria-hidden="true" />登记收款</Button>}
      {balance < 0 && onRecordRefund && <Button type="button" className="min-h-11" disabled={refundSaving} onClick={onRecordRefund}><ArrowUpRight className="size-4" aria-hidden="true" />登记退款</Button>}
    </div>
    <div className="mt-4 min-w-0 border-t pt-3">
      <p className="text-sm">订单应收合计 <strong className="ml-2 font-semibold tabular-nums">{currency(amountDue)}</strong></p>
      {freight.enabled && <>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">商品及包装（优惠调整后）{currency(goodsAndPackaging)} + {freightLabel} {currency(freight.shippingDue)}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{freight.timing === "before_shipping"
          ? "预收运费已合并到订单应收，统一登记收款；全部发货并补录实际运费后，多退少补。"
          : "运费随发货逐笔计入订单应收，全部发货并补录后确认最终金额，统一补收或退差。"}</p>
      </>}
      <p className="mt-1 text-xs leading-5 text-muted-foreground">余额按已登记收退款计算，包含待核验款项；财务核验进度见下方记录。</p>
    </div>
  </section>;
}
