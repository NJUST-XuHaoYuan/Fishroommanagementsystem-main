import type { PurchaseCostAllocation, PurchaseProcurement, PurchaseAllocatedAmounts } from "../utils/purchaseBatchTypes";
import { purchaseLineLabel } from "../utils/purchaseBatchDisplay";

const amount = (cents: number) => `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const unitAmount = (cents: number, quantity: number) => quantity > 0 ? `¥${(cents / 100 / quantity).toFixed(4)}` : "—";
const columns: [keyof PurchaseAllocatedAmounts, string][] = [
  ["purchaseCents", "采购金额"], ["internationalFreightCents", "运费"], ["documentFeeCents", "文件费"],
  ["domesticFreightCents", "国内运费"], ["miscFeeCents", "杂费"], ["importTaxCents", "进口税"], ["totalCents", "总成本"],
];

export function PurchaseCostAllocationSection({ procurement, allocation, preview = false }: {
  procurement: PurchaseProcurement; allocation: PurchaseCostAllocation; preview?: boolean;
}) {
  const lineMap = new Map(procurement.lines.map(line => [line.id, line]));
  return <section aria-label={preview ? "成本分摊预览" : "已确认采购成本"} className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-3">
      <div><h4 className="font-semibold">{preview ? "确认本次分摊" : "已确认采购成本"}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{allocation.totals.productCount} 个采购品种（按商品/规格） · {allocation.totals.lineCount} 行明细 · {allocation.totals.quantity} 条 · {allocation.totals.boxCount} 箱</p></div>
      <div className="text-right"><div className="text-xs text-muted-foreground">{preview ? "本次总成本" : "批次总成本"}</div><div className="mt-1 text-xl font-semibold tabular-nums">{amount(allocation.totals.totalCents)}</div></div>
    </div>
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[980px] text-sm"><thead className="bg-muted/40"><tr>
        <th className="p-2 text-left font-medium">采购商品</th><th className="p-2 text-right font-medium">数量</th>
        {columns.map(([key, label]) => <th key={key} className="whitespace-nowrap p-2 text-right font-medium">{label}</th>)}
        <th className="p-2 text-right font-medium">跨箱平均单条成本</th>
      </tr></thead><tbody>{allocation.lines.map(row => <tr key={row.lineId} className="border-b">
        <td className="max-w-64 p-2"><div className="font-medium">{lineMap.get(row.lineId)?.productName || "原采购商品"}</div><div className="mt-1 text-xs text-muted-foreground">{[lineMap.get(row.lineId)?.size, lineMap.get(row.lineId)?.origin].filter(Boolean).join(" · ")}</div><div className="mt-1 text-xs text-muted-foreground">采购单价 ¥{lineMap.get(row.lineId)?.unitPrice.toFixed(2)}</div></td>
        <td className="p-2 text-right tabular-nums">{row.quantity}</td>{columns.map(([key]) => <td key={key} className={`whitespace-nowrap p-2 text-right tabular-nums ${key === "totalCents" ? "font-semibold" : ""}`}>{amount(row[key])}</td>)}
        <td className="whitespace-nowrap p-2 text-right tabular-nums">{unitAmount(row.totalCents, row.quantity)}</td>
      </tr>)}</tbody><tfoot><tr className="font-semibold"><td className="p-2">合计</td><td className="p-2 text-right">{allocation.totals.quantity}</td>{columns.map(([key]) => <td key={key} className="whitespace-nowrap p-2 text-right tabular-nums">{amount(allocation.totals[key])}</td>)}<td /></tr></tfoot></table>
    </div>
    <div className="divide-y sm:hidden">{allocation.lines.map(row => {
      const line = lineMap.get(row.lineId);
      return <div key={row.lineId} className="py-3 first:pt-0"><div className="flex justify-between gap-3"><div className="min-w-0 text-sm font-medium">{line ? purchaseLineLabel(line) : "原采购商品"}<span className="ml-2 font-normal">{row.quantity} 条</span></div><span className="shrink-0 text-sm font-semibold tabular-nums">{amount(row.totalCents)}</span></div>
        <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">采购单价 ¥{line?.unitPrice.toFixed(2)} · 跨箱平均单条 {unitAmount(row.totalCents, row.quantity)} · 查看构成</summary><dl className="mt-3 grid grid-cols-2 gap-2">{columns.slice(0, -1).map(([key, label]) => <div key={key} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{amount(row[key])}</dd></div>)}</dl></details>
      </div>;
    })}</div>
    <details className="border-t pt-3"><summary className="cursor-pointer text-sm">查看每箱分摊</summary><div className="mt-3 space-y-3">{allocation.boxes.map(box => <div key={box.boxId} className="border-b pb-3 last:border-0"><div className="mb-2 flex justify-between gap-3 text-sm font-medium"><span>{box.boxNo}</span><span>分摊运费 {amount(box.freightCents)}</span></div>{box.items.map(item => {
      const line = lineMap.get(item.lineId);
      return <div key={item.itemId} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1 text-xs"><span>{line ? purchaseLineLabel(line) : "原采购商品"} · {item.quantity} 条</span><span className="tabular-nums">采购单价 ¥{line?.unitPrice.toFixed(2)} · 重量占比 {item.weightPercent}% · 运费 {amount(item.internationalFreightCents)} · 总成本 {amount(item.totalCents)} · 本箱平均单条 {unitAmount(item.totalCents, item.quantity)}</span></div>;
    })}</div>)}</div></details>
    <p className="text-xs leading-relaxed text-muted-foreground">跨箱平均单条成本用于查看采购分摊；库存明细仍按实际入库鱼只追溯。采购记录不会自动入库、登记付款或调整销售价格。</p>
  </section>;
}
