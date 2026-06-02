import { StockStatus } from "../store";

/** 状态 → ring 类（套在缩略图容器上） */
export function statusRingClass(status: StockStatus, sold = false): string {
  if (sold) return "ring-4 ring-yellow-400 ring-offset-2 ring-offset-yellow-50";

  const map: Record<StockStatus, string> = {
    healthy: "ring-2 ring-white ring-offset-1 ring-offset-slate-300",
    feeding: "ring-2 ring-sky-400",
    sick:    "ring-2 ring-red-500",
  };
  return map[status] ?? "";
}

/** 状态 → border-color 类（折叠行汇总小方框） */
export function statusFrameClass(status: StockStatus): string {
  const map: Record<StockStatus, string> = {
    healthy: "border-white bg-white shadow-[0_0_0_1px_rgba(148,163,184,0.9)]",
    feeding: "border-sky-400",
    sick:    "border-red-500",
  };
  return map[status] ?? "";
}

/** 已售状态已改为缩略图黄色外环，这里保留空组件兼容旧调用。 */
export function StatusBadge({ sold }: { sold?: boolean }) {
  void sold;
  return null;
}

/** 图例 */
export function StatusLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-3 rounded border-2 border-white bg-white shadow-[0_0_0_1px_rgba(148,163,184,0.9)] shrink-0" />
        正常
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3 rounded border-2 border-sky-400 shrink-0" />
        开口
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3 rounded border-2 border-red-500 shrink-0" />
        疾病
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3 rounded border-2 border-yellow-400 ring-2 ring-yellow-200 shrink-0" />
        已售
      </span>
    </div>
  );
}
