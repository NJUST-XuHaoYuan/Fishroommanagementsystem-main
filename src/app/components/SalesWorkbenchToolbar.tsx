import { CircleDollarSign, MessageSquare, RefreshCw, Search, Truck } from "lucide-react";
import type { SalesTodoKind } from "../utils/salesWorkbench";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const SALES_TODO_LABELS = { collection: "待收款", shipment: "待发货", followup: "待回访" } as const;
export function SalesWorkbenchToolbar({ tab, onTabChange, counts, search, onSearchChange, onRefresh }: {
  tab: SalesTodoKind; onTabChange: (tab: SalesTodoKind) => void;
  counts: Record<SalesTodoKind, number | null>;
  search: string; onSearchChange: (value: string) => void; onRefresh: () => void;
}) {
  return <div className="space-y-4">
    <nav aria-label="我的销售待办" className="workbench-three-columns grid grid-cols-3 gap-2 sm:gap-3">
      {([["collection", CircleDollarSign], ["shipment", Truck], ["followup", MessageSquare]] as const).map(([value, Icon]) => <button
        key={value} type="button" aria-pressed={tab === value} aria-controls="sales-workbench-list"
        onClick={() => onTabChange(value)}
        className={`flex min-h-20 min-w-0 flex-col items-start justify-center gap-2 rounded-lg border px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5 ${tab === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted/60"}`}>
        <span className="flex items-center gap-1.5 text-sm"><Icon className="size-4 shrink-0" aria-hidden="true" />{SALES_TODO_LABELS[value]}</span>
        <span className="text-xl font-semibold tabular-nums">{counts[value] === null ? "—" : counts[value]}<span className="ml-1 text-xs font-normal">单</span></span>
      </button>)}
    </nav>
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input value={search} onChange={event => onSearchChange(event.target.value)} aria-label="搜索我的待办订单" placeholder="搜索订单号、客户、鱼码或商品" className="h-11 pl-9" /></div>
      {tab === "followup" && <Button type="button" variant="outline" className="min-h-11" onClick={onRefresh}><RefreshCw className="size-4" aria-hidden="true" />刷新回访</Button>}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">只显示当前场地由我负责的订单。收款按已登记金额计算；已完成订单首次填写回访后移出待回访。</p>
  </div>;
}

export type SalesWorkbenchOrderRow = {
  id: string; orderNo: string; customer: string; productSummary: string; date: string; plannedDate: string;
  remaining: number | null; shippingLabel: string;
};
export function SalesWorkbenchOrderList({ rows, tab, loading, error, onRetry, onOpen, onDetails }: {
  rows: SalesWorkbenchOrderRow[]; tab: SalesTodoKind; loading?: boolean; error?: string;
  onRetry: () => void; onOpen: (id: string) => void; onDetails: (id: string) => void;
}) {
  return <section id="sales-workbench-list" aria-label={`我的${SALES_TODO_LABELS[tab]}订单`} className="min-w-0">
    {loading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">正在加载回访待办…</p>
      : error ? <div role="alert" className="flex flex-wrap items-center gap-3 py-6 text-sm"><p>{error}</p><Button type="button" variant="outline" onClick={onRetry}>重试</Button></div>
      : rows.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">没有符合条件的{SALES_TODO_LABELS[tab]}订单。</p>
      : <ul className="divide-y rounded-lg border bg-card">{rows.map(row => <li key={row.id} className="grid min-w-0 gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,auto)_auto] sm:items-center">
        <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="font-semibold tabular-nums">{row.orderNo}</span><span className="text-sm">{row.customer}</span></div><p className="mt-1 break-words text-sm text-muted-foreground">{row.productSummary}</p><p className="mt-1 text-xs text-muted-foreground">下单 {row.date}{tab === "shipment" && row.plannedDate ? ` · 计划发货 ${row.plannedDate}` : ""}</p></div>
        <div className="text-sm font-medium">{tab === "collection" ? row.remaining === null ? "收款金额需核对" : <>待收 ¥{row.remaining.toFixed(2)}</> : tab === "shipment" ? row.shippingLabel : "已完成，尚未回访"}</div>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={() => onDetails(row.id)}>详情</Button><Button type="button" className="min-h-11" onClick={() => onOpen(row.id)}>{tab === "collection" ? "去收银台" : tab === "shipment" ? "处理发货" : "登记回访"}</Button></div>
      </li>)}</ul>}
  </section>;
}
