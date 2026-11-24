import { useRef, useState } from "react";
import { ChevronDown, CircleDollarSign, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { OrderWholesaleFilterValue } from "./OrderWholesaleTag";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "./ui/sheet";
import { Switch } from "./ui/switch";

export type OrdersToolbarProps = {
  scope: "mine" | "all";
  onScopeChange: (value: OrdersToolbarProps["scope"]) => void;
  status: "all" | "active" | "completed";
  onStatusChange: (value: OrdersToolbarProps["status"]) => void;
  search: string;
  onSearchChange: (value: string) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  onClearOrderDates: () => void;
  today: string;
  quickShip: "" | "today" | "tomorrow";
  onQuickShipChange: (value: OrdersToolbarProps["quickShip"]) => void;
  plannedFrom: string;
  plannedTo: string;
  onPlannedFromChange: (value: string) => void;
  onPlannedToChange: (value: string) => void;
  onClearPlannedDates: () => void;
  wholesale: OrderWholesaleFilterValue;
  onWholesaleChange: (value: OrderWholesaleFilterValue) => void;
  pendingTrackingOnly: boolean;
  onPendingTrackingChange: (value: boolean) => void;
  onClear: () => void;
  resultCount: number;
  todayCount: number;
  tomorrowCount: number;
  pendingCount: number;
  canCreate: boolean;
  onCreate: () => void;
  canClaim: boolean;
  pendingClaims: number;
  onClaim: () => void;
};

function dateRangeLabel(from: string, to: string) {
  if (from && from === to) return from;
  if (from && to) return `${from} 至 ${to}`;
  return from ? `${from} 起` : `${to} 及以前`;
}

function FilterChip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`移除筛选：${children}`}
      title="点击移除此条件"
    >
      <span className="min-w-0 truncate">{children}</span>
      <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export function OrdersToolbar(props: OrdersToolbarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [focusPlannedDate, setFocusPlannedDate] = useState(false);
  const plannedDateRef = useRef<HTMLInputElement>(null);
  const hasOrderDates = Boolean(props.dateFrom || props.dateTo);
  const hasPlannedDates = Boolean(props.quickShip || props.plannedFrom || props.plannedTo);
  const customPlannedDates = !props.quickShip && hasPlannedDates;
  const filterCount = [hasOrderDates, hasPlannedDates, props.wholesale !== "all", props.pendingTrackingOnly].filter(Boolean).length;
  const hasFilters = filterCount > 0 || props.scope !== "all" || props.status !== "all" || Boolean(props.search.trim());
  const dateFromMax = props.dateTo && props.dateTo < props.today ? props.dateTo : props.today;

  const openFilters = (focusDates = false) => {
    setFocusPlannedDate(focusDates);
    setFilterOpen(true);
  };

  const planChoices = (
    <div className="flex items-center gap-1.5" role="group" aria-label="发货计划快捷筛选">
      <Button type="button" size="sm" className="h-9 px-3" variant={!hasPlannedDates ? "default" : "outline"} aria-pressed={!hasPlannedDates} onClick={props.onClearPlannedDates}>不限</Button>
      <Button type="button" size="sm" className="h-9 px-3" variant={props.quickShip === "today" ? "default" : "outline"} aria-pressed={props.quickShip === "today"} onClick={() => props.onQuickShipChange(props.quickShip === "today" ? "" : "today")} title={`当前场地预计今天发货 ${props.todayCount} 单，包含已发货订单`}>
        今天 <span className="tabular-nums opacity-70">{props.todayCount}</span>
      </Button>
      <Button type="button" size="sm" className="h-9 px-3" variant={props.quickShip === "tomorrow" ? "default" : "outline"} aria-pressed={props.quickShip === "tomorrow"} onClick={() => props.onQuickShipChange(props.quickShip === "tomorrow" ? "" : "tomorrow")} title={`当前场地预计明天发货 ${props.tomorrowCount} 单，包含已发货订单`}>
        明天 <span className="tabular-nums opacity-70">{props.tomorrowCount}</span>
      </Button>
      <Button type="button" size="sm" className="h-9 px-3" variant={customPlannedDates ? "default" : "outline"} aria-pressed={customPlannedDates} onClick={() => openFilters(true)}>
        自定义 <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );

  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label="订单查找与筛选">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">订单管理</h1>
        <div className="flex flex-wrap items-center gap-2">
          {props.canClaim && (
            <Button type="button" variant="outline" onClick={props.onClaim} className="h-10 gap-2 px-3" title="查看并处理待认领收款，不改变订单筛选">
              <CircleDollarSign className={`size-4 ${props.pendingClaims > 0 ? "text-amber-600" : "text-muted-foreground"}`} aria-hidden="true" />
              待认领收款
              {props.pendingClaims > 0 && <span className="font-semibold tabular-nums">{props.pendingClaims}</span>}
            </Button>
          )}
          {props.canCreate && <Button type="button" onClick={props.onCreate} className="h-10 px-4"><Plus className="size-4" aria-hidden="true" />新建订单</Button>}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <nav className="flex gap-6 border-b" aria-label="订单范围">
          {([["mine", "我的"], ["all", "全部"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={props.scope === value}
              title={value === "mine" ? "由我负责的订单" : "当前场地内有权限查看的全部订单"}
              onClick={() => props.onScopeChange(value)}
              className={`-mb-px min-h-11 border-b-2 px-3 pb-3 pt-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${props.scope === value ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="订单状态">
          <span className="mr-1 text-sm text-muted-foreground">状态</span>
          {([["all", "全部状态"], ["active", "未完成"], ["completed", "已完成"]] as const).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={props.status === value ? "default" : "outline"}
              className="h-9 px-3"
              aria-pressed={props.status === value}
              title={value === "all" ? "包含已取消订单" : undefined}
              onClick={() => props.onStatusChange(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
        <div className="relative min-w-0 flex-1 md:min-w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={props.search} onChange={event => props.onSearchChange(event.target.value)} placeholder="搜索订单号、客户、鱼码或商品" aria-label="搜索订单" className="fishroom-control h-10 pl-9 pr-9" />
          {props.search && <button type="button" aria-label="清除搜索关键词" onClick={() => props.onSearchChange("")} className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" aria-hidden="true" /></button>}
        </div>
        <Button type="button" variant="outline" className="h-10 gap-2 px-3" onClick={() => openFilters()} aria-expanded={filterOpen} aria-label={filterCount ? `筛选，已选 ${filterCount} 个条件` : "筛选"}>
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          筛选 {filterCount > 0 && <span className="flex size-5 items-center justify-center rounded bg-primary text-xs text-primary-foreground">{filterCount}</span>}
        </Button>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 border-t pt-3 xl:w-auto xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <span className="shrink-0 text-sm text-muted-foreground">发货计划</span>
          {planChoices}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground" aria-live="polite">共 <strong className="font-medium tabular-nums text-foreground">{props.resultCount.toLocaleString("zh-CN")}</strong> 个订单</span>
          {hasOrderDates && <FilterChip onRemove={props.onClearOrderDates}>{`下单：${dateRangeLabel(props.dateFrom, props.dateTo)}`}</FilterChip>}
          {hasPlannedDates && <FilterChip onRemove={props.onClearPlannedDates}>{`预计发货：${props.quickShip === "today" ? "今天" : props.quickShip === "tomorrow" ? "明天" : dateRangeLabel(props.plannedFrom, props.plannedTo)}`}</FilterChip>}
          {props.wholesale !== "all" && <FilterChip onRemove={() => props.onWholesaleChange("all")}>{props.wholesale === "wholesale" ? "批发订单" : "未标记批发"}</FilterChip>}
          {props.pendingTrackingOnly && <FilterChip onRemove={() => props.onPendingTrackingChange(false)}>已出库待发货</FilterChip>}
        </div>
        {hasFilters && <Button type="button" variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={props.onClear}>清除全部筛选</Button>}
      </div>

      <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
        <SheetContent className="w-full gap-0 sm:max-w-md" onOpenAutoFocus={event => {
          if (focusPlannedDate && plannedDateRef.current) {
            event.preventDefault();
            plannedDateRef.current.focus();
          }
        }}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>筛选订单</SheetTitle>
            <SheetDescription>条件可组合，修改后立即生效。</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">下单日期筛选</legend>
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0 space-y-1.5 text-xs text-muted-foreground">开始日期<Input type="date" value={props.dateFrom} max={dateFromMax} onChange={event => props.onDateFromChange(event.target.value)} aria-label="下单开始日期" className="mt-1.5 h-10 min-w-0 w-full text-sm" /></label>
                <label className="min-w-0 space-y-1.5 text-xs text-muted-foreground">结束日期<Input type="date" value={props.dateTo} min={props.dateFrom || undefined} max={props.today} onChange={event => props.onDateToChange(event.target.value)} aria-label="下单结束日期" className="mt-1.5 h-10 min-w-0 w-full text-sm" /></label>
              </div>
              {hasOrderDates && <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" onClick={props.onClearOrderDates}>清除下单日期</button>}
            </fieldset>

            <fieldset className="space-y-3 border-t pt-5">
              <legend className="pt-5 text-sm font-semibold">预计发货日期筛选</legend>
              <div className="flex flex-wrap gap-2" role="group" aria-label="抽屉内发货日期快捷筛选">
                <Button type="button" size="sm" variant={!hasPlannedDates ? "default" : "outline"} onClick={props.onClearPlannedDates} aria-pressed={!hasPlannedDates}>不限</Button>
                <Button type="button" size="sm" variant={props.quickShip === "today" ? "default" : "outline"} onClick={() => props.onQuickShipChange(props.quickShip === "today" ? "" : "today")} aria-pressed={props.quickShip === "today"}>今天</Button>
                <Button type="button" size="sm" variant={props.quickShip === "tomorrow" ? "default" : "outline"} onClick={() => props.onQuickShipChange(props.quickShip === "tomorrow" ? "" : "tomorrow")} aria-pressed={props.quickShip === "tomorrow"}>明天</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0 text-xs text-muted-foreground">开始日期<Input ref={plannedDateRef} type="date" value={props.plannedFrom} max={props.plannedTo || undefined} onChange={event => props.onPlannedFromChange(event.target.value)} aria-label="预计发货开始日期" className="mt-1.5 h-10 min-w-0 w-full text-sm" /></label>
                <label className="min-w-0 text-xs text-muted-foreground">结束日期<Input type="date" value={props.plannedTo} min={props.plannedFrom || undefined} onChange={event => props.onPlannedToChange(event.target.value)} aria-label="预计发货结束日期" className="mt-1.5 h-10 min-w-0 w-full text-sm" /></label>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">按预计发货日期筛选，包含已发货订单。只查待发货任务时，可同时开启下方“已出库待发货”。</p>
            </fieldset>

            <fieldset className="space-y-3 border-t pt-5">
              <legend className="pt-5 text-sm font-semibold">批发标记</legend>
              <div className="flex flex-wrap gap-2" role="group" aria-label="筛选订单批发标记">
                {([["all", "全部"], ["wholesale", "批发订单"], ["unmarked", "未标记批发"]] as const).map(([value, label]) => <Button key={value} type="button" size="sm" variant={props.wholesale === value ? "default" : "outline"} aria-pressed={props.wholesale === value} onClick={() => props.onWholesaleChange(value)}>{label}</Button>)}
              </div>
            </fieldset>

            <fieldset className="space-y-3 border-t pt-5">
              <legend className="pt-5 text-sm font-semibold">发货进度</legend>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border p-3">
                <span className="text-sm">已出库待发货<span className="mt-1 block text-xs text-muted-foreground">当前场地 {props.pendingCount} 单，不含自提</span></span>
                <Switch checked={props.pendingTrackingOnly} onCheckedChange={props.onPendingTrackingChange} aria-label="只看已出库待发货订单" />
              </label>
            </fieldset>
          </div>
          <SheetFooter className="flex-row items-center justify-between border-t px-6 py-4">
            <Button type="button" variant="outline" disabled={!hasFilters} onClick={props.onClear}>清除全部</Button>
            <Button type="button" onClick={() => setFilterOpen(false)}>查看 {props.resultCount.toLocaleString("zh-CN")} 个订单</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  );
}
