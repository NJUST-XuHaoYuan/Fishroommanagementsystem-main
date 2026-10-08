import { ChevronDown, ReceiptText } from "lucide-react";
import type { StockItem } from "../store";
import type { buildSpeciesStockGroups } from "../utils/speciesStockGroups";
import { ImageWithFallback } from "./figma/ImageWithFallback";

type ProductRow = ReturnType<typeof buildSpeciesStockGroups>[number]["productRows"][number];
const healthLabels = { healthy: "正常", feeding: "开口", sick: "疾病" };

export function SpeciesStockProductRow({ row, imageUrl, tankLabel, onOpenOrders }: {
  row: ProductRow;
  imageUrl?: string;
  tankLabel: (item: StockItem) => string;
  onOpenOrders: (item: StockItem) => void;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted/30 px-2 py-2 text-sm">
      <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(7rem,1fr)_auto_minmax(10rem,1.5fr)] lg:items-start">
        <div className="min-w-0">
          <div className="break-words font-medium">{row.name}</div>
          {(row.size || row.origin) && <div className="mt-0.5 text-xs text-muted-foreground">{[row.size, row.origin].filter(Boolean).join(" · ")}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums lg:justify-end">
          <span className="font-medium">在缸 {row.count} 条</span>
          <span className="text-muted-foreground">未售 {row.unsoldCount} 条</span>
        </div>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {row.tankRows.map((tank) => (
            <span key={tank.tankId} className="max-w-full break-words rounded-md border bg-background px-2 py-1 text-xs leading-5">
              {tank.label} · {tank.count} 条
              {tank.soldCount > 0 && <span className="ml-1 font-medium text-amber-800">（已售 {tank.soldCount}）</span>}
            </span>
          ))}
        </div>
      </div>
      {row.soldCount > 0 ? (
        <details className="group mt-2 border-t pt-1">
          <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2 rounded px-1 text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
            aria-label={`查看${row.name}${row.size ? ` ${row.size}` : ""}的已售待出库鱼，共 ${row.soldCount} 条`}>
            <span className="rounded bg-amber-100 px-2 py-1 text-xs font-semibold tabular-nums">已售待出库 {row.soldCount} 条</span>
            <span className="text-xs group-open:hidden">查看单鱼</span>
            <span className="hidden text-xs group-open:inline">收起单鱼</span>
            <ChevronDown className="ml-auto size-4 shrink-0 group-open:rotate-180" aria-hidden="true" />
          </summary>
          <p className="px-1 pb-2 pt-1 text-xs text-muted-foreground">仍在缸内，点击单鱼查看关联订单。</p>
          <ul className="grid min-w-0 gap-1 sm:grid-cols-2">
            {row.soldItems.map((item) => (
              <li key={item.id} className="min-w-0">
                <button type="button" onClick={() => onOpenOrders(item)}
                  aria-label={`查看${row.name}（${item.code ? `编号 ${item.code}` : `库存号 ${item.id}`}）的关联订单`}
                  className="flex min-h-14 w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="size-8 shrink-0 overflow-hidden rounded bg-background ring-2 ring-yellow-400 ring-offset-1">
                    {imageUrl ? <ImageWithFallback src={imageUrl} alt="" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-[10px]">已售</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold" title={item.code || item.id}>{item.code ? `编号 ${item.code}` : `库存号 ${item.id}`}</span>
                    <span className="block truncate text-xs text-muted-foreground" title={tankLabel(item)}>{tankLabel(item)} · {healthLabels[item.status] || "状态待确认"}</span>
                  </span>
                  <ReceiptText className="size-4 shrink-0 text-amber-800" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : <div className="pt-2 text-xs text-muted-foreground">已售待出库 0 条</div>}
    </div>
  );
}
