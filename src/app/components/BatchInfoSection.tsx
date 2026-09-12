import type { PurchaseBatch } from "../store";
import { Button } from "./ui/button";
import { batchPrice } from "../utils/batchDetailDisplay";
import { ImageWithFallback } from "./figma/ImageWithFallback";

type Revenue = {
  salesNet: number; pendingReceived: number; verifiedReceived: number;
  itemCount: number; orderCount: number; discount: number; refundAdjustment: number;
  platformOrderCount: number; platformReceived: number;
};

export function BatchInfoSection({ batch, revenue, loading, error, onRetry, onEdit, onPreview }: {
  batch: PurchaseBatch;
  revenue: Revenue | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onEdit?: () => void;
  onPreview: (url: string, title: string) => void;
}) {
  const proofs = Array.isArray(batch.lossProof) ? batch.lossProof : [];
  return <section aria-label="批次资料" className="rounded-lg border bg-card px-4 py-3 sm:px-5">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">批次资料</h3>
      {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>编辑资料</Button>}
    </div>
    <dl className="batch-mobile-two-columns grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-4">
      <div><dt className="text-xs text-muted-foreground">采购成本</dt><dd className="mt-1 font-medium tabular-nums">{batchPrice(batch.bioFee + batch.shippingFee)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">销售净额</dt><dd className="mt-1 font-medium tabular-nums">{revenue ? batchPrice(revenue.salesNet) : "—"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{revenue && revenue.pendingReceived < 0 ? "待核销退款" : "待核销回款"}</dt>
        <dd className="mt-1 font-medium tabular-nums text-amber-800">{revenue ? batchPrice(revenue.pendingReceived) : "—"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">已核销回款</dt><dd className="mt-1 font-medium tabular-nums text-teal-800">{revenue ? batchPrice(revenue.verifiedReceived) : "—"}</dd></div>
    </dl>
    {error ? <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-red-800">
      <span>{revenue ? "回款刷新失败，金额为上次成功数据" : "回款加载失败，金额暂不展示"}：{error}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>重新加载回款</Button>
    </div> : loading && <p role="status" className="mt-3 text-xs text-muted-foreground">正在更新回款…</p>}
    <details className="mt-3 border-t pt-3">
      <summary className="cursor-pointer text-sm text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700">费用、数量、凭证与备注</summary>
      <div className="mt-4 space-y-4">
        <dl className="batch-mobile-two-columns grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">生物费用</dt><dd className="mt-1 tabular-nums">{batchPrice(batch.bioFee)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">运输费用</dt><dd className="mt-1 tabular-nums">{batchPrice(batch.shippingFee)}</dd></div>
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
          {proofs.length ? <div className="flex flex-wrap gap-2">{proofs.map((url, index) => <button key={`${url}:${index}`} type="button"
            aria-label={`查看批次报损凭证 ${index + 1}`} className="size-20 overflow-hidden rounded-md border bg-muted"
            onClick={() => onPreview(url, `${batch.batchNo} 报损凭证 ${index + 1}`)}>
            <ImageWithFallback src={url} alt={`报损凭证 ${index + 1}`} loading="lazy" className="size-full object-cover" />
          </button>)}</div> : <p className="text-sm text-muted-foreground">暂无报损凭证</p>}
        </div>
        <div><h4 className="mb-1 text-xs text-muted-foreground">备注</h4><p className="whitespace-pre-wrap break-words text-sm">{batch.notes || "暂无备注"}</p></div>
      </div>
    </details>
  </section>;
}
