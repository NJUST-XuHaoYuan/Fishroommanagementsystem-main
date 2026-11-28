import type { PurchaseBatch } from "../store";
import { Button } from "./ui/button";
import { batchPrice } from "../utils/batchDetailDisplay";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { batchPurchaseTotal, purchaseLineLabel } from "../utils/purchaseBatchDisplay";
import { PurchaseCostAllocationSection } from "./PurchaseCostAllocationSection";

type Revenue = {
  salesNet: number; pendingReceived: number; verifiedReceived: number;
  itemCount: number; orderCount: number; discount: number; refundAdjustment: number;
  platformOrderCount: number; platformReceived: number;
};

export function BatchInfoSection({ batch, revenue, loading, error, onRetry, onEdit, onProcurement }: {
  batch: PurchaseBatch;
  revenue: Revenue | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onEdit?: () => void;
  onProcurement?: () => void;
}) {
  const cost = batchPurchaseTotal(batch);
  const proofs = Array.isArray(batch.lossProof) ? batch.lossProof : [];
  return <section aria-label="批次资料" className="rounded-lg border bg-card px-4 py-3 sm:px-5">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">批次资料</h3>
      {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>编辑资料</Button>}
    </div>
    <dl className="batch-mobile-two-columns grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-4">
      <div><dt className="text-xs text-muted-foreground">采购成本</dt><dd className="mt-1 font-medium tabular-nums">{cost === null ? "待确认" : batchPrice(cost)}</dd>{batch.procurement?.status === "draft" && <p className="mt-1 text-xs text-amber-800">采购资料为草稿{cost !== null ? "，仍按原成本" : ""}</p>}</div>
      <div><dt className="text-xs text-muted-foreground">销售净额</dt><dd className="mt-1 font-medium tabular-nums">{revenue ? batchPrice(revenue.salesNet) : "—"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{revenue && revenue.pendingReceived < 0 ? "待核销退款" : "待核销回款"}</dt>
        <dd className="mt-1 font-medium tabular-nums text-amber-800">{revenue ? batchPrice(revenue.pendingReceived) : "—"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">已核销回款</dt><dd className="mt-1 font-medium tabular-nums text-teal-800">{revenue ? batchPrice(revenue.verifiedReceived) : "—"}</dd></div>
    </dl>
    {error ? <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-red-800">
      <span>{revenue ? "回款刷新失败，金额为上次成功数据" : "回款加载失败，金额暂不展示"}：{error}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>重新加载回款</Button>
    </div> : loading && <p role="status" className="mt-3 text-xs text-muted-foreground">正在更新回款…</p>}
    <div className="mt-4 border-t pt-4">
      {batch.procurement?.status === "confirmed" && batch.procurement.allocation ? <details open><summary className="cursor-pointer text-sm font-medium">采购清单与成本分摊</summary><div className="mt-4"><PurchaseCostAllocationSection procurement={batch.procurement} allocation={batch.procurement.allocation} /></div></details> : <>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-medium">采购与装箱资料</h4><p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{batch.procurement ? `已暂存 ${batch.procurement.lines.length} 行采购、${batch.procurement.boxes.length} 箱。确认分摊后才启用新的采购成本。` : "此批次按原登记总额保留。可补齐实际采购清单、装箱及费用，核对后启用明细成本。"}</p></div>{onProcurement && <Button size="sm" variant="outline" onClick={onProcurement}>{batch.procurement ? "继续填写并分摊" : "补齐采购与装箱资料"}</Button>}</div>
        {batch.procurement && batch.procurement.lines.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer">查看草稿采购清单</summary><div className="mt-2 divide-y">{batch.procurement.lines.map(line => <div key={line.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{purchaseLineLabel(line)}</span><span className="tabular-nums">{line.quantity} 条 × {batchPrice(line.unitPrice)}</span></div>)}</div></details>}
      </>}
    </div>
    <details className="mt-3 border-t pt-3">
      <summary className="cursor-pointer text-sm text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700">费用、数量、凭证与备注</summary>
      <div className="mt-4 space-y-4">
        <dl className="batch-mobile-two-columns grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">生物费用</dt><dd className="mt-1 tabular-nums">{batchPrice(batch.bioFee)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{batch.procurement?.status === "confirmed" ? "国际运费" : "运输费用"}</dt><dd className="mt-1 tabular-nums">{batchPrice(batch.shippingFee)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">批次入库数量</dt><dd className="mt-1">{batch.stockedCount} 条</dd></div>
          <div><dt className="text-xs text-muted-foreground">批次报损数量</dt><dd className="mt-1">{batch.lossCount} 条</dd></div>
        </dl>
        {revenue && <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>销售商品 {revenue.itemCount} 条</span><span>关联订单 {revenue.orderCount} 单</span>
          <span>折扣分摊 {batchPrice(revenue.discount)}</span><span>退款调整 {batchPrice(revenue.refundAdjustment)}</span>
          {revenue.platformOrderCount > 0 && <span>已核销中含平台收入 {batchPrice(revenue.platformReceived)}（{revenue.platformOrderCount} 单，未扣平台费用）</span>}
        </div>}
        <p className="text-xs leading-relaxed text-muted-foreground">销售净额不含运费与包装费；批次登记数量与仍可追溯的单鱼档案数量可能不同。</p>
        <div><h4 className="mb-2 text-xs text-muted-foreground">报损凭证</h4>
          {proofs.length ? <div className="flex flex-wrap gap-2">{proofs.map((url, index) => <MediaPreviewTrigger key={`${url}:${index}`}
            src={url} mediaType="image" title={`${batch.batchNo} 报损凭证 ${index + 1}`}
            filename={`${batch.batchNo}-报损凭证-${index + 1}.jpg`}
            ariaLabel={`预览批次报损凭证 ${index + 1}`} className="size-20 overflow-hidden rounded-md border bg-muted">
            <ImageWithFallback src={url} alt={`报损凭证 ${index + 1}`} loading="lazy" className="size-full object-cover" />
          </MediaPreviewTrigger>)}</div> : <p className="text-sm text-muted-foreground">暂无报损凭证</p>}
        </div>
        <div><h4 className="mb-1 text-xs text-muted-foreground">备注</h4><p className="whitespace-pre-wrap break-words text-sm">{batch.notes || "暂无备注"}</p></div>
      </div>
    </details>
  </section>;
}
