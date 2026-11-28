import type { ReactNode } from "react";
import { AlertTriangle, Camera, ChevronDown, CircleDollarSign, Clock, MapPin, PackageCheck, RotateCcw, Truck } from "lucide-react";
import type { Order, Shipment } from "../store";
import { orderShippingFeeMode, shipmentHasPendingActualShippingFee } from "../utils/orderFees";
import { canEditShipmentActualShippingFee } from "../utils/shipmentFee";
import { shipmentFulfillmentState } from "../utils/shipmentFulfillmentCorrection";
import { shipmentPackingProofs } from "./ShipmentProofDialog";
import { Button } from "./ui/button";

type Props = {
  order: Order;
  shipment: Shipment;
  number: number;
  itemCount: number;
  statusBadge: ReactNode;
  onProgress?: () => void;
  onEditFee?: () => void;
  onViewProof?: () => void;
  onCorrect?: () => void;
  onCancel?: () => void;
};

function recordedTime(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return "未登记";
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
  return raw.replace("T", " ").slice(0, 16);
}

/** Shipment facts, the next routine action, and corrections have separate places. */
export function ShipmentWorkflowHeader({ order, shipment, number, itemCount, statusBadge, onProgress, onEditFee, onViewProof, onCorrect, onCancel }: Props) {
  const pickup = shipment.shipMethod === "pickup";
  const outbound = shipment.status === "outbound";
  const editable = !["completed", "cancelled"].includes(order.status);
  const fulfillment = shipmentFulfillmentState(shipment);
  const correction = fulfillment?.correction;
  const needsAttention = Boolean(fulfillment?.pending);
  const canCorrect = Boolean(onCorrect && shipment.status !== "preparing");
  const showProgress = Boolean(onProgress && editable && (outbound || (shipment.status === "shipped" && !pickup)));
  const canCancel = Boolean(onCancel && editable && ["outbound", "shipped"].includes(shipment.status));
  const mode = orderShippingFeeMode(order);
  const feePending = shipmentHasPendingActualShippingFee(order, shipment);
  const fee = Number(shipment.actualShippingFee ?? 0);
  const feeKnown = Number.isFinite(fee) && (fee > 0 || (fee === 0 && Boolean(shipment.actualShippingFeeRecordedAt)));
  const showEditFee = Boolean(onEditFee && !pickup && canEditShipmentActualShippingFee(shipment, mode, order.status));
  const proofs = shipmentPackingProofs(shipment);
  const unknownFacts = correction ? [
    fulfillment?.shippingTimePending ? "实际发货时间" : "",
    correction.receiptStatus === "unknown" ? "收货情况" : "",
    correction.receiptStatus === "received" && !correction.actualDeliveredAt ? "实际签收时间" : "",
  ].filter(Boolean).join("、") : "";
  const recordLabel = outbound ? "登记出库" : correction ? "原登记发货" : "登记发货";
  const recordTime = outbound ? shipment.createdAt || shipment.outboundDate || shipment.shipDate : shipment.shippedAt || shipment.shipDate;

  return <section aria-label={`发货单 ${number} 物流信息与操作`} className="min-w-0 space-y-3 border-t bg-muted/15 px-4 py-4">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">{pickup ? <MapPin className="size-4 shrink-0" aria-hidden="true" /> : <Truck className="size-4 shrink-0" aria-hidden="true" />}发货单 {number}<span className="font-normal text-muted-foreground">{itemCount} 条鱼</span></h4>
          <div className="flex items-center [&_.ml-auto]:ml-0">{statusBadge}</div>
        </div>
        <p className="mt-2 break-words text-sm">{pickup ? "上门自取" : shipment.carrier || "承运方未登记"}{!pickup && <span className="ml-2 text-muted-foreground">{shipment.trackingNo ? `运单号 ${shipment.trackingNo}` : "运单号未填写"}</span>}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{recordLabel}：{recordedTime(recordTime)}</p>
      </div>
      {showProgress && <div className="flex w-full flex-col items-start gap-1.5 sm:w-auto sm:max-w-72 sm:items-end">
        <Button type="button" className="h-auto min-h-[44px] max-w-full whitespace-normal" disabled={outbound && Boolean(fulfillment?.shippingTimePending)} onClick={onProgress}>
          {outbound ? <Camera className="size-4" aria-hidden="true" /> : <PackageCheck className="size-4" aria-hidden="true" />}
          {outbound ? pickup ? "上传照片并确认自提" : "上传照片并发货" : "登记收货结果"}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground sm:text-right">{outbound ? "至少 2 张：捞鱼照片、封箱前照片。" : canCancel ? "客户收到后登记签收；发现损耗可报损。" : "客户收到后登记签收；损耗请联系订单负责人。"}</p>
      </div>}
    </div>

    {needsAttention && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-amber-200 pt-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex items-start gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{fulfillment?.needsVerification ? `${unknownFacts}待核实` : "已核对：客户尚未收到"}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{fulfillment?.needsVerification
          ? `请${canCorrect ? "先" : "联系管理员"}核对实际情况${outbound && fulfillment.shippingTimePending ? "后再确认发货" : "后再确认收货"}。`
          : `客户收到后，请${canCorrect ? "更新核对记录" : "联系管理员更新核对记录"}，再确认收货。`}</p>
      </div>
      {canCorrect && <Button type="button" variant="outline" className="h-auto min-h-[44px] max-w-full whitespace-normal" onClick={onCorrect}><Clock className="size-4" aria-hidden="true" />核对发货与签收时间</Button>}
    </div>}

    <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-t pt-3">
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <CircleDollarSign className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">实际运费</span>
          <span className="font-medium tabular-nums">{pickup ? "自提无需运费" : mode === "collect" ? "到付，客户付给承运方" : feeKnown && !feePending ? `¥${fee.toFixed(2)}` : "待补录"}</span>
          {showEditFee && <Button type="button" variant="ghost" className="min-h-[44px] px-2 text-sm" onClick={onEditFee}>{feePending || !feeKnown ? "补录运费" : "修改运费"}</Button>}
        </div>
        {!pickup && mode !== "collect" && <p className="mt-1 text-xs leading-5 text-muted-foreground">{feePending || !feeKnown ? "费用确定后补录，不影响发货或签收。" : mode === "free" ? "商家承担，不向客户收取。" : "按实际运费结算，收退差额在收银台登记。"}</p>}
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"><Camera className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="text-muted-foreground">打包照片</span><span className="font-medium">{proofs.length ? `${proofs.length} 张` : "未上传"}</span>{proofs.length > 0 && onViewProof && <Button type="button" variant="ghost" className="min-h-[44px] px-2 text-sm" onClick={onViewProof}>查看照片</Button>}</div>
      </div>
    </div>

    {((canCorrect && !needsAttention) || canCancel) && <details className="group border-t pt-1">
      <summary className="flex min-h-[44px] w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">更多操作<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
      <div className="flex flex-wrap items-start gap-2 pb-1">
        {canCorrect && !needsAttention && <Button type="button" variant="ghost" className="h-auto min-h-[44px] max-w-full whitespace-normal text-sm" onClick={onCorrect}><Clock className="size-4" aria-hidden="true" />更正发货与签收时间</Button>}
        {canCancel && <Button type="button" variant="ghost" className="h-auto min-h-[44px] max-w-full whitespace-normal text-sm text-amber-800 hover:text-amber-900 dark:text-amber-300" onClick={onCancel}><RotateCcw className="size-4" aria-hidden="true" />{outbound ? "取消出库" : "取消发货"}</Button>}
      </div>
    </details>}
  </section>;
}
