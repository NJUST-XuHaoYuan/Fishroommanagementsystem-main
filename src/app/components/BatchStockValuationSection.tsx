import { batchValuationDisplay, type BatchStockValuation, type BatchValuationAmount } from "../utils/batchStockValuation";

export function BatchValuationValue({ value, compact = false }: { value?: BatchValuationAmount; compact?: boolean }) {
  const display = batchValuationDisplay(value);
  return <>
    <span className={`block break-words font-medium tabular-nums ${compact ? "text-sm" : "text-lg"}`}>{display.amount}</span>
    {value && <span className="mt-1 block text-xs text-muted-foreground">{display.quantity}</span>}
    {display.note && <span className="mt-1 block text-xs leading-relaxed text-amber-800">{display.note}</span>}
  </>;
}

export function BatchValuationScopeWarning({ valuation }: { valuation?: BatchStockValuation }) {
  const excluded = [
    valuation?.restrictedCount ? `${valuation.restrictedCount} 条受限` : "",
    valuation?.invalidStockCount ? `${valuation.invalidStockCount} 条档案异常` : "",
  ].filter(Boolean);
  return excluded.length ? <p className="text-xs leading-relaxed text-amber-800">部分档案合计 · 未计入{excluded.join("、")}</p> : null;
}

export function BatchValuationListSummary({ valuation }: { valuation?: BatchStockValuation }) {
  return <div className="min-w-32 space-y-1.5"><dl className="space-y-1.5 text-xs">
    {([{ key: "unsold", label: "未销售" }, { key: "lost", label: "已损耗" }] as const).map(({ key, label }) => {
      const display = batchValuationDisplay(valuation?.[key]);
      return <div key={key}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{display.amount}</dd>
        </div>
        {display.note && <dd className="mt-0.5 text-amber-800">{display.note}</dd>}
      </div>;
    })}
  </dl><BatchValuationScopeWarning valuation={valuation} /></div>;
}

export function BatchStockValuationSection({ valuation, loading, error }: {
  valuation?: BatchStockValuation; loading: boolean; error: string;
}) {
  return <section aria-label="批次预计售价" aria-busy={loading} className="rounded-lg border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-base font-semibold">批次预计售价</h3>
      <span className="text-xs text-muted-foreground">全批次汇总，不随下方鱼只筛选变化</span>
    </div>
    <dl className="batch-mobile-two-columns mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
      <div><dt className="text-sm text-muted-foreground">未销售预计售价</dt>
        <dd className="mt-1"><BatchValuationValue value={valuation?.unsold} /></dd></div>
      <div><dt className="text-sm text-muted-foreground">已损耗预计售价</dt>
        <dd className="mt-1"><BatchValuationValue value={valuation?.lost} /></dd></div>
    </dl>
    {loading && <p role="status" className="mt-3 text-xs text-muted-foreground">{valuation ? "正在刷新估价…" : "正在加载估价…"}</p>}
    {error && <p className="mt-3 text-xs text-red-800">{valuation ? "刷新失败，以上为上次成功加载的估价。" : "估价暂未加载，请使用下方的重新加载按钮重试。"}</p>}
    {!loading && !error && !valuation && <p className="mt-3 text-xs text-muted-foreground">暂未取得批次估价，请刷新记录重试。</p>}
    {valuation && <details className="mt-4 border-t">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700">
        按品种查看<span className="ml-2 font-normal text-muted-foreground">{valuation.bySpecies.length} 个品种</span>
      </summary>
      {valuation.bySpecies.length > 0 ? <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">未销售与已损耗预计售价，按物种汇总数量和金额</caption>
        <thead><tr className="border-b text-left text-xs text-muted-foreground">
          <th scope="col" className="w-[30%] pb-2 pr-2 font-medium">品种（物种）</th>
          <th scope="col" className="w-[35%] px-2 pb-2 text-right font-medium">未销售</th>
          <th scope="col" className="w-[35%] pb-2 pl-2 text-right font-medium">已损耗</th>
        </tr></thead>
        <tbody>{valuation.bySpecies.map((row, index) => <tr key={row.speciesId || `unknown:${index}`} className="border-b last:border-b-0">
          <th scope="row" className="break-words py-3 pr-2 text-left align-top font-medium">{row.speciesName || "品种未记录"}</th>
          <td className="px-2 py-3 text-right align-top"><BatchValuationValue value={row.unsold} compact /></td>
          <td className="py-3 pl-2 text-right align-top"><BatchValuationValue value={row.lost} compact /></td>
        </tr>)}</tbody>
      </table> : <p className="pb-2 text-sm text-muted-foreground">此批次暂无可统计的未销售或已损耗单鱼档案。</p>}
    </details>}
    <div className="mt-4 space-y-1 text-xs leading-relaxed text-muted-foreground">
      <p>未销售按当前商品默认价或单独定价估算，不含已售待发；已损耗按库存损耗鱼的档案留存售价估算，不代表损耗当天的准确售价。</p>
      <p>仅统计当前留存且可查看的单鱼档案。批次登记的报损数量不等于逐鱼档案数量；预计售价不计入实际销售净额，也不是采购成本损失。</p>
      {!!valuation?.restrictedCount && <p className="text-amber-800">有 {valuation.restrictedCount} 条单鱼档案受场地权限限制，未计入上述数量与金额。</p>}
      {!!valuation?.invalidStockCount && <p className="text-amber-800">有 {valuation.invalidStockCount} 条库存档案缺少有效编号或存在冲突，未计入估价，请核对档案。</p>}
    </div>
  </section>;
}
