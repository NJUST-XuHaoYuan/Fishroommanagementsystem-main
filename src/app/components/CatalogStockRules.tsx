import { useEffect, useMemo, useState } from "react";
import { Check, EyeOff, RefreshCw, Search, X } from "lucide-react";
import { authJsonHeaders } from "../utils/authSession";
import type { PublicCatalogPolicy } from "../utils/publicCatalogPolicy";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

export type CatalogStockOption = {
  id: string; code: string; productId: string; productName: string; speciesName: string;
  siteId: string; siteName: string; tankName: string; status: string;
  sold: boolean; inTransit: boolean; hidden: boolean; lost?: boolean; outStock?: boolean;
};
type ProductRule = { hiddenReason: "major" | "species" | "product" | null; displayCap?: number };
type StockOptions = {
  items: CatalogStockOption[]; total: number; page: number; pageSize: number;
  sites: { id: string; name: string }[];
};
const PAGE_SIZE = 30;
const statusLabels: Record<string, string> = { healthy: "正常", feeding: "开口", sick: "疾病" };

export function CatalogStockRuleRow({ item, hidden, rule, disabled, onHiddenChange }: {
  item: CatalogStockOption; hidden: boolean; rule?: ProductRule; disabled: boolean;
  onHiddenChange: (id: string, hidden: boolean) => void;
}) {
  const inheritedReason = rule?.hiddenReason === "major" ? "随类型隐藏"
    : rule?.hiddenReason === "species" ? "随物种隐藏"
      : rule?.hiddenReason === "product" ? "随商品隐藏" : "";
  const unavailable = item.lost ? "已损耗" : item.outStock ? "已出库" : item.sold ? "已售" : item.inTransit ? "移缸在途" : item.status === "sick" ? "疾病" : "";
  return <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.productName || "未关联商品"}</span>
        <span className="break-all text-sm tabular-nums">{item.code ? `编号 ${item.code}` : "未填写编号"}</span>
      </div>
      <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">库存 ID {item.id}</p>
      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
        {[item.speciesName, item.siteName || "场地未记录", item.tankName || "缸位未记录"].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{statusLabels[item.status] || "状态未记录"}</Badge>
        {unavailable && <Badge variant="secondary">暂不可售 · {unavailable}</Badge>}
        {inheritedReason && <Badge variant="secondary">{inheritedReason}</Badge>}
        {!inheritedReason && rule?.displayCap && <Badge variant="outline">受商品上限 {rule.displayCap} 条限制</Badge>}
      </div>
    </div>
    <Button
      type="button"
      variant={hidden ? "outline" : "default"}
      role="switch"
      aria-checked={!hidden}
      aria-label={`${item.productName || "鱼只"} ${item.code ? `编号 ${item.code}` : "未填写编号"}，库存 ID ${item.id}：${hidden ? "单只隐藏，点击允许展示" : "允许展示，点击单只隐藏"}`}
      className="!min-h-[44px] w-full shrink-0 sm:w-36"
      disabled={disabled}
      onClick={() => onHiddenChange(item.id, !hidden)}
    >
      {hidden ? <EyeOff className="size-4" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
      {hidden ? "单只隐藏" : "允许展示"}
    </Button>
  </li>;
}

export function CatalogStockRules({ policy, productRules, disabled, onHiddenChange }: {
  policy: PublicCatalogPolicy; productRules: Map<string, ProductRule>; disabled: boolean;
  onHiddenChange: (id: string, hidden: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [siteId, setSiteId] = useState("all");
  const [filter, setFilter] = useState<"all" | "hidden">("all");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [sites, setSites] = useState<StockOptions["sites"]>([]);
  const [result, setResult] = useState<{ key: string; loading: boolean; error: string; data: StockOptions | null }>({ key: "", loading: true, error: "", data: null });
  const hiddenIds = useMemo(() => new Set(policy.hiddenStockIds), [policy.hiddenStockIds]);
  const requestKey = JSON.stringify({ search: debouncedSearch.trim(), siteId, filter, page, pageSize: PAGE_SIZE, hiddenStockIds: [...hiddenIds].sort() });

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setResult({ key: requestKey, loading: true, error: "", data: null });
    void fetch("/api/public-catalog/stock-options", {
      method: "POST", headers: authJsonHeaders(), body: requestKey, signal: controller.signal, cache: "no-store",
    }).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "单鱼列表加载失败，请重试");
      if (!Array.isArray(body.items) || !Array.isArray(body.sites) || !Number.isSafeInteger(body.total) || body.total < 0 || body.items.length > PAGE_SIZE) {
        throw new Error("单鱼列表返回异常，请刷新后重试");
      }
      if (controller.signal.aborted) return;
      setSites(body.sites);
      if (body.page !== page && Number.isSafeInteger(body.page) && body.page > 0) { setPage(body.page); return; }
      setResult({ key: requestKey, loading: false, error: "", data: body });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key: requestKey, loading: false, error: error instanceof TypeError ? "网络连接失败，请检查网络后重试" : error.message || "单鱼列表加载失败", data: null });
    });
    return () => controller.abort();
  }, [requestKey, attempt]);

  const current = result.key === requestKey && search === debouncedSearch ? result : { loading: true, error: "", data: null };
  const data = current.data;
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));
  return <section className="overflow-hidden rounded-md border bg-card" aria-label="按单鱼设置鱼单展示">
    <div className="border-b px-4 py-3">
      <h2 className="font-semibold">单只鱼展示</h2>
      <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
        按编号找到具体鱼只，关闭「允许展示」即可单只隐藏。修改后点击页面顶部「保存规则」生效，不会改变库存、售价或健康状态。
      </p>
      <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground">恢复允许展示后，仍遵循类型、物种、商品规则及数量上限；已售、疾病和移缸在途等不可售鱼不会对外展示。</p>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="catalog-stock-search" className="mb-1 block text-xs text-muted-foreground">查找鱼只</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id="catalog-stock-search" value={search} maxLength={120} placeholder="输入编号、商品名或缸位" className="!h-[44px] !min-h-[44px] pl-9 pr-[44px]" onChange={event => setSearch(event.target.value)} />
            {search && <Button type="button" variant="ghost" className="absolute right-0 top-0 !size-[44px]" aria-label="清空鱼只搜索" onClick={() => setSearch("")}><X className="size-4" aria-hidden="true" /></Button>}
          </div>
        </div>
        <label className="min-w-0 lg:w-36">
          <span className="mb-1 block text-xs text-muted-foreground">库存场地</span>
          <select className="fishroom-control h-[44px] w-full rounded-md border bg-background px-3 text-sm" aria-label="筛选鱼只场地" value={siteId} onChange={event => { setSiteId(event.target.value); setPage(1); }}>
            <option value="all">全部场地</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 lg:w-40">
          <span className="mb-1 block text-xs text-muted-foreground">单鱼规则</span>
          <select className="fishroom-control h-[44px] w-full rounded-md border bg-background px-3 text-sm" aria-label="筛选单鱼规则" value={filter} onChange={event => { setFilter(event.target.value as "all" | "hidden"); setPage(1); }}>
            <option value="all">全部鱼只</option>
            <option value="hidden">仅单只隐藏</option>
          </select>
        </label>
        <Button type="button" variant="outline" className="!min-h-[44px]" onClick={() => setAttempt(value => value + 1)} disabled={current.loading}><RefreshCw className="size-4" aria-hidden="true" />刷新</Button>
      </div>
    </div>
    {current.loading && <div role="status" className="space-y-4 p-4"><span className="sr-only">正在加载单鱼列表</span>{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 motion-reduce:animate-none" />)}</div>}
    {current.error && <div role="alert" className="space-y-3 p-4 text-sm"><p>{current.error}</p><Button type="button" variant="outline" className="!min-h-[44px]" onClick={() => setAttempt(value => value + 1)}>重新加载</Button></div>}
    {data && <>
      <div className="border-b px-4 py-2 text-xs leading-5 text-muted-foreground" aria-live="polite">找到 {data.total} 条 · 每页最多 {PAGE_SIZE} 条。列表包含当前库存、移缸在途及已设单只隐藏的历史鱼只，不代表当前小程序实际展示数量。</div>
      {data.items.length ? <ul className="divide-y">{data.items.map(item => <CatalogStockRuleRow key={item.id} item={item} hidden={hiddenIds.has(item.id)} rule={productRules.get(item.productId)} disabled={disabled} onHiddenChange={onHiddenChange} />)}</ul>
        : <p className="px-4 py-10 text-center text-sm text-muted-foreground">{filter === "hidden" ? "当前条件下没有单只隐藏的鱼。可切换「全部鱼只」查找并设置。" : "没有找到鱼只，请核对编号或调整场地、搜索条件。"}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
        <span>第 {page} / {totalPages} 页</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" className="!min-h-[44px]" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button>
          <Button type="button" variant="outline" className="!min-h-[44px]" disabled={page >= totalPages} onClick={() => setPage(value => value + 1)}>下一页</Button>
        </div>
      </div>
    </>}
  </section>;
}
