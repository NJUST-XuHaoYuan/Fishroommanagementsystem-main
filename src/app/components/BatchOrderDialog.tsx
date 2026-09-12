import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { canUserAccessSite } from "../utils/sites";
import { batchRecordDate } from "../utils/batchDetailDisplay";
import {
  batchOrderErrorMessage, batchOrderIdentityKey, batchOrderMoney, batchOrderRequestKey, isBatchOrderContextCurrent, shouldRestoreBatchOrderFocus,
  type BatchOrderRequest,
} from "../utils/batchOrderDialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

export type { BatchOrderRequest } from "../utils/batchOrderDialog";

type OrderItem = {
  stockItemId: string;
  code: string;
  productName: string;
  speciesName: string;
  size: string;
  origin: string;
  price: number | null;
  isBatchFish: boolean;
  kind: "sale" | "replacement";
  note: string;
};
type OrderPayment = {
  id: string;
  date: string;
  type: string;
  typeLabel: string;
  amount: number | null;
  verificationStatus: string;
};
type OrderShipment = {
  id: string;
  status: string;
  statusLabel: string;
  shipMethod: string;
  carrier: string;
  trackingNo: string;
  itemCount: number;
  batchFishCount: number;
  createdAt: string;
  outboundDate: string;
  shipDate: string;
  shippedAt: string;
  deliveredAt: string;
  damagedAt: string;
  actualShippingFee: number | null;
  damageResolution: string;
  damageRefundAmount: number | null;
};
type OrderTotals = {
  itemSubtotal: number | null;
  discount: number | null;
  goodsNetTotal: number | null;
  packagingFee: number | null;
  shippingFeeMode: string;
  billableShippingFee: number | null;
  customerShippingFee: number | null;
  damageRefundAdjustment: number | null;
  calculatedReceivable: number | null;
  received: number | null;
  refunded: number | null;
  netReceived: number | null;
  pendingReceived: number | null;
  pendingRefunded: number | null;
  balance: number | null;
};
type OrderDetail = {
  id: string;
  orderNo: string;
  siteId: string;
  siteName: string;
  date: string;
  status: string;
  statusLabel: string;
  customerName: string;
  source: string;
  items: OrderItem[];
  totals: OrderTotals;
  payments: OrderPayment[];
  shipments: OrderShipment[];
  warnings: string[];
};
type BatchOrderResponse = {
  ok: boolean;
  batch: { id: string; batchNo: string; siteId: string; siteName: string };
  order: OrderDetail;
};

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 break-words text-sm [overflow-wrap:anywhere]">{value === "" || value == null ? "未记录" : value}</dd>
  </div>;
}

function Amount({ label, value, strong = false }: { label: string; value: number | null; strong?: boolean }) {
  return <div className={`flex items-baseline justify-between gap-4 py-1.5 text-sm ${strong ? "font-semibold" : ""}`}>
    <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
    <dd className="shrink-0 tabular-nums">{batchOrderMoney(value)}</dd>
  </div>;
}

function LoadingOrder() {
  return <div role="status" aria-label="正在加载订单资料" className="space-y-6">
    <span className="sr-only">正在加载订单资料…</span>
    <div className="grid grid-cols-2 gap-5" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => <div key={index} className="space-y-2">
        <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
        <Skeleton className="h-5 w-3/4 motion-reduce:animate-none" />
      </div>)}
    </div>
    <div className="space-y-3" aria-hidden="true">
      <Skeleton className="h-5 w-24 motion-reduce:animate-none" />
      {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-16 w-full motion-reduce:animate-none" />)}
    </div>
  </div>;
}

function OrderItems({ items }: { items: OrderItem[] }) {
  const batchCount = items.filter(item => item.isBatchFish).length;
  return <section aria-labelledby="batch-order-items-heading">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="batch-order-items-heading" className="font-semibold">订单商品</h3>
      <p className="text-xs text-muted-foreground">{items.length} 条记录 · 本批次 {batchCount} 条</p>
    </div>
    {items.length === 0 ? <p className="text-sm text-muted-foreground">未留存订单商品记录。</p> : <ul className="divide-y overflow-hidden rounded-lg border">
      {items.map((item, index) => <li key={`${item.stockItemId}:${item.kind}:${index}`}
        className={`px-3 py-3 sm:px-4 ${item.isBatchFish ? "bg-teal-50" : "bg-background"}`}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-40">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.productName || "商品未记录"}</span>
              {item.isBatchFish && <span className="rounded border border-teal-200 px-1.5 py-0.5 text-xs font-medium text-teal-900">本批次</span>}
              {item.kind === "replacement" && <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">补发关联</span>}
            </div>
            <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {[`编号 ${item.code || "未记录"}`, item.speciesName, item.size, item.origin].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="text-right text-sm tabular-nums">
            <span className="block font-medium">{batchOrderMoney(item.price)}</span>
            <span className="text-xs text-muted-foreground">{item.kind === "replacement" ? "原鱼订单行价" : "订单行价"}</span>
          </div>
        </div>
        {item.note && <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">{item.note}</p>}
      </li>)}
    </ul>}
  </section>;
}

function OrderAmounts({ totals, cancelled }: { totals: OrderTotals; cancelled: boolean }) {
  const shippingMode = ({ prepaid: "寄付", collect: "到付", free: "包邮" } as Record<string, string>)[totals.shippingFeeMode] || "未记录";
  return <section aria-labelledby="batch-order-amounts-heading" className="border-t pt-5">
    <h3 id="batch-order-amounts-heading" className="font-semibold">订单费用与收款</h3>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">以下为整张订单的金额，包含其他批次商品，不是本批次回款。已核销与待核销分别列示。</p>
    {cancelled && <p className="mt-2 text-sm text-amber-900">订单已取消：下列应收及差额仅为留存账单计算，不代表继续向客户收款。</p>}
    <div className="mt-3 grid gap-5 sm:grid-cols-2 sm:gap-8">
      <dl>
        <Amount label="商品合计" value={totals.itemSubtotal} />
        <Amount label="优惠减免" value={totals.discount} />
        <Amount label="优惠后商品金额" value={totals.goodsNetTotal} />
        <Amount label="包装费" value={totals.packagingFee} />
        <Amount label={`客户承担运费（${shippingMode}）`} value={totals.customerShippingFee} />
        <Amount label="报损应收调减" value={totals.damageRefundAdjustment} />
        <div className="mt-2 border-t pt-2"><Amount label={cancelled ? "留存账单应收" : "订单应收"} value={totals.calculatedReceivable} strong /></div>
      </dl>
      <dl className="border-t pt-3 sm:border-t-0 sm:pt-0">
        <Amount label="已核销收款" value={totals.received} />
        <Amount label="已核销退款" value={totals.refunded} />
        <Amount label="已核销净收款" value={totals.netReceived} strong />
        <Amount label="待核销收款" value={totals.pendingReceived} />
        <Amount label="待核销退款" value={totals.pendingRefunded} />
        <div className="mt-2 border-t pt-2"><Amount label="应收与已核销净收差额" value={totals.balance} strong /></div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">正数表示未收齐，负数表示净收超过应收。待核销金额未计入差额。</p>
      </dl>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">运费核算参考：{batchOrderMoney(totals.billableShippingFee)}；包邮或到付不向客户计收该项。</p>
  </section>;
}

function PaymentRecords({ payments }: { payments: OrderPayment[] }) {
  if (!payments.length) return <p className="border-t pt-5 text-sm text-muted-foreground">未留存收退款登记。</p>;
  const labels: Record<string, string> = { verified: "已核销", pending: "待核销", rejected: "已驳回", unverified: "待核销" };
  return <details className="border-t pt-5">
    <summary className="min-h-10 cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700">收退款登记（{payments.length} 条）</summary>
    <ul className="divide-y">
      {payments.map((payment, index) => <li key={`${payment.id}:${index}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm">
        <div className="min-w-0">
          <p>{payment.typeLabel || "收退款登记"}<span className="ml-2 text-xs text-muted-foreground">{labels[payment.verificationStatus] || "核销状态未记录"}</span></p>
          <time className="text-xs tabular-nums text-muted-foreground">{batchRecordDate(payment.date)}</time>
        </div>
        <span className="tabular-nums">{batchOrderMoney(payment.amount)}</span>
      </li>)}
    </ul>
  </details>;
}

function ShipmentRecords({ shipments }: { shipments: OrderShipment[] }) {
  return <section aria-labelledby="batch-order-shipments-heading" className="border-t pt-5">
    <h3 id="batch-order-shipments-heading" className="font-semibold">发货快照 <span className="text-sm font-normal text-muted-foreground">{shipments.length} 次</span></h3>
    {shipments.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">暂未留存发货记录。</p> : <ol className="mt-3 divide-y">
      {shipments.map((shipment, index) => <li key={`${shipment.id}:${index}`} className="py-4 first:pt-0 last:pb-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="font-medium">{shipment.shipMethod === "pickup" ? "客户自取" : shipment.carrier || "发货记录"} <span className="ml-1 font-normal text-muted-foreground">· {shipment.statusLabel || "状态未记录"}</span></p>
          <p className="text-xs text-muted-foreground">{shipment.itemCount} 条 · 本批次 {shipment.batchFishCount} 条</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
          {shipment.shipMethod !== "pickup" && <Field label="物流单号" value={shipment.trackingNo} />}
          <Field label="创建时间" value={batchRecordDate(shipment.createdAt)} />
          <Field label="出库时间" value={batchRecordDate(shipment.outboundDate)} />
          <Field label={shipment.shippedAt ? "实际发货时间" : "登记发货日期"} value={batchRecordDate(shipment.shippedAt || shipment.shipDate)} />
          <Field label="签收时间" value={batchRecordDate(shipment.deliveredAt)} />
          <Field label="实际运费" value={batchOrderMoney(shipment.actualShippingFee)} />
          {!!shipment.damagedAt && <Field label="物流报损时间" value={batchRecordDate(shipment.damagedAt)} />}
          {!!shipment.damageResolution && <Field label="报损处理" value={shipment.damageResolution === "refund" ? "退款" : shipment.damageResolution === "reship" ? "补发" : "未记录"} />}
          {shipment.damageRefundAmount != null && <Field label="报损应收调减" value={batchOrderMoney(shipment.damageRefundAmount)} />}
        </dl>
      </li>)}
    </ol>}
  </section>;
}

function RequestedBatchOrderDialog({ request, onClose }: { request: BatchOrderRequest; onClose: () => void }) {
  const { state, activeSiteId } = useStore();
  const identityKey = batchOrderIdentityKey(state.user);
  const openingContext = useRef({ identityKey, activeSiteId });
  const currentContext = useRef({ identityKey, activeSiteId });
  currentContext.current = { identityKey, activeSiteId };
  const openingFocus = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const contextCurrent = isBatchOrderContextCurrent(request, openingContext.current, { identityKey, activeSiteId }) &&
    canUserAccessSite(state.user, state, request.siteId);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ loading: boolean; error: string; data: BatchOrderResponse | null }>({ loading: true, error: "", data: null });

  useEffect(() => {
    if (!contextCurrent) {
      setResult({ loading: false, error: "", data: null });
      onCloseRef.current();
      return;
    }
    const controller = new AbortController();
    setResult({ loading: true, error: "", data: null });
    const query = new URLSearchParams(request);
    void fetch(`/api/batches/order-detail?${query}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) {
          throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "订单加载失败，请重试");
        }
        if (body.order?.id !== request.orderId || body.batch?.id !== request.batchId || body.batch?.siteId !== request.siteId) {
          throw new Error("订单资料与当前批次不一致，请关闭后重新打开");
        }
        if (!controller.signal.aborted) setResult({ loading: false, error: "", data: body as BatchOrderResponse });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setResult({ loading: false, error: batchOrderErrorMessage(cause), data: null });
      });
    return () => controller.abort();
  }, [request.batchId, request.siteId, request.orderId, contextCurrent, attempt]);

  // Hide synchronously on identity/site changes; an effect alone would expose one stale frame.
  if (!contextCurrent) return null;
  const data = result.data;
  const order = data?.order;
  return <Dialog open onOpenChange={open => { if (!open) onCloseRef.current(); }}>
    <DialogContent
      onCloseAutoFocus={event => {
        event.preventDefault();
        const target = openingFocus.current;
        if (target && shouldRestoreBatchOrderFocus(request, openingContext.current, currentContext.current, target.isConnected)) {
          target.focus({ preventScroll: true });
        }
      }}
      className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 pb-0 shadow-none motion-reduce:animate-none sm:max-w-4xl sm:p-0 [&>button]:flex [&>button]:size-10 [&>button]:items-center [&>button]:justify-center">
      <DialogHeader className="shrink-0 border-b p-4 pr-16 text-left sm:px-6 sm:pr-16">
        <DialogTitle className="break-words leading-snug [overflow-wrap:anywhere]">订单 {order?.orderNo || request.orderId}</DialogTitle>
        <DialogDescription className="text-xs leading-relaxed">{data ? `${data.batch.batchNo} · ${data.batch.siteName}批次` : "批次关联订单"} · 只读查看，关闭后继续查看批次明细</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        {result.loading && <LoadingOrder />}
        {result.error && <div role="alert" className="py-6 text-sm">
          <p className="font-semibold">订单暂时无法加载</p>
          <p className="mt-2 break-words leading-relaxed text-muted-foreground">{result.error}</p>
          <Button variant="outline" className="mt-4 min-h-10" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />重新加载</Button>
        </div>}
        {order && <div className="space-y-5">
          <section aria-label="订单基本信息">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="rounded-md border bg-muted px-2 py-1 text-sm font-medium">{order.statusLabel || "状态未记录"}</span>
              {order.siteId !== request.siteId && <span className="text-xs text-muted-foreground">跨场地关联 · 仍停留在原批次</span>}
            </div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
              <Field label="订单所属场地" value={order.siteName} />
              <Field label="下单时间" value={batchRecordDate(order.date)} />
              <Field label="客户" value={order.customerName} />
              <Field label="订单来源" value={order.source} />
            </dl>
          </section>
          {!!order.warnings?.length && <ul className="space-y-1 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
            {order.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>}
          <OrderItems items={order.items} />
          <OrderAmounts totals={order.totals} cancelled={order.status === "cancelled"} />
          <PaymentRecords payments={order.payments} />
          <ShipmentRecords shipments={order.shipments} />
        </div>}
      </div>
      <DialogFooter className="shrink-0 border-t p-4 sm:px-6">
        <Button variant="outline" className="min-h-10 w-full sm:w-auto" onClick={() => onCloseRef.current()}>关闭订单</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function BatchOrderDialog({ request, onClose }: { request: BatchOrderRequest | null; onClose: () => void }) {
  return request ? <RequestedBatchOrderDialog key={batchOrderRequestKey(request)} request={request} onClose={onClose} /> : null;
}
