import { useEffect, useId, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { resolveDashboardDateRange, MAX_DASHBOARD_DAYS } from "../../../server/dashboard-date-range.mjs";
import type { DashboardSalespersonOption } from "../utils/dashboardSalespeople";

export type DashboardDateRange = { startDate: string; endDate: string };

export function DashboardDateFilter({ value, today, onChange }: {
  value: DashboardDateRange; today: string; onChange: (range: DashboardDateRange) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const errorId = useId();
  useEffect(() => { setDraft(value); setError(""); }, [value.startDate, value.endDate]);
  const apply = (range: DashboardDateRange) => {
    try {
      const resolved = resolveDashboardDateRange(range, today);
      onChange({ startDate: resolved.startDate, endDate: resolved.endDate });
      setDraft(range);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "请选择有效的日期范围");
    }
  };
  const changed = draft.startDate !== value.startDate || draft.endDate !== value.endDate;
  return (
    <div className="mb-4 rounded-lg border bg-muted/30 p-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); apply(draft); }}>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          开始日期
          <input type="date" required aria-label="销售开始日期" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
            value={draft.startDate} onChange={(event) => { setDraft({ ...draft, startDate: event.target.value }); setError(""); }}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          结束日期
          <input type="date" required aria-label="销售结束日期" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
            value={draft.endDate} onChange={(event) => { setDraft({ ...draft, endDate: event.target.value }); setError(""); }}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" />
        </label>
        <Button type="submit" size="sm" className="h-9" disabled={!changed}>应用日期</Button>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:ml-auto">
          快捷范围
          <select aria-label="销售快捷范围" value="" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onChange={(event) => { if (event.target.value) apply(resolveDashboardDateRange({ financeDays: Number(event.target.value) }, today)); }}>
            <option value="" disabled>选择近几天</option>
            {[14, 30, 90, 180, 365, 730].map((days) => <option key={days} value={days}>近 {days} 天</option>)}
          </select>
        </label>
      </form>
      {error ? <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">{error}</p>
        : <p className="mt-2 text-xs text-muted-foreground">含开始和结束当天，最多 {MAX_DASHBOARD_DAYS} 天；同步下方人员成交额与损耗趋势。</p>}
    </div>
  );
}

export function DashboardSalespersonFilter({ options, selectedNames, automatic, colors, onChange }: {
  options: DashboardSalespersonOption[]; selectedNames: string[]; automatic: boolean; colors: string[];
  onChange: (value: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = new Set(selectedNames);
  const filtered = options.filter((option) => option.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <Popover open={open} onOpenChange={(value) => { setOpen(value); if (!value) setSearch(""); }}>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-9 gap-2">
            <SlidersHorizontal className="size-4" />选择人员 <span className="rounded bg-muted px-1.5 tabular-nums">{selectedNames.length}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" collisionPadding={12} className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] flex-col p-0">
          <div className="shrink-0 space-y-2 border-b p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">显示哪些人员</span>
              <span className="text-xs text-muted-foreground">已选 {selectedNames.length} 人</span>
            </div>
            <p className="text-xs text-muted-foreground">按所选日期内的成交额排序，勾选即生效。</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <input type="search" aria-label="搜索销售人员" placeholder="搜索人员姓名" value={search} onChange={(event) => setSearch(event.target.value)}
                className="h-9 w-full rounded-md border bg-background pl-8 pr-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" />
            </div>
          </div>
          <div className="min-h-0 max-h-64 overflow-y-auto p-1" role="group" aria-label="可选销售人员">
            {filtered.map((option) => (
              <label key={option.name} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted">
                <input type="checkbox" checked={selected.has(option.name)} onChange={() => {
                  const next = new Set(selectedNames);
                  if (next.has(option.name)) next.delete(option.name); else next.add(option.name);
                  onChange(next);
                }} className="size-4 shrink-0 accent-current" />
                <span className="min-w-0 flex-1 truncate text-sm" title={option.name}>{option.name}</span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <span className="block">¥{option.amount.toFixed(2)}</span>
                  <span className="text-muted-foreground">{option.orderCount} 单</span>
                </span>
              </label>
            ))}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{search ? "没有匹配的人员" : "所选范围暂无人员成交记录"}</p>}
          </div>
          <div className="flex shrink-0 items-center justify-between border-t p-2">
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>恢复前 5 名</Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>清空选择</Button>
            <Button size="sm" onClick={() => { setOpen(false); setSearch(""); }}>完成</Button>
          </div>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">{automatic ? "默认：本时段成交额前 5 名" : `自选 ${selectedNames.length} 人`}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="已选人员图例">
        {selectedNames.slice(0, 5).map((name) => (
          <span key={name} className="inline-flex max-w-36 items-center gap-1.5 text-xs" title={name}>
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors[options.findIndex((option) => option.name === name) % colors.length] }} />
            <span className="truncate">{name}</span>
          </span>
        ))}
        {selectedNames.length > 5 && <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setOpen(true)}>另 {selectedNames.length - 5} 人</button>}
      </div>
    </div>
  );
}
