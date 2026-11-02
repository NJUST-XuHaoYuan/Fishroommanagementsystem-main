import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Fish, RefreshCw, Search, X } from "lucide-react";
import { authJsonHeaders } from "../utils/authSession";
import type { PublicCatalogPolicy } from "../utils/publicCatalogPolicy";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

export type CatalogStockOption = {
  id: string; code: string; productId: string; productName: string; speciesName: string;
  siteId: string; siteName: string; tankName: string; status: string;
  tankGroupId?: string; tankGroupName?: string; subTankId?: string; subTankName?: string;
  productSize?: string; productOrigin?: string; imageUrl?: string;
  sold: boolean; inTransit: boolean; hidden: boolean; lost?: boolean; outStock?: boolean;
};
type ProductRule = { hiddenReason: "major" | "species" | "product" | null; displayCap?: number };
type TankOption = {
  siteId: string; siteName: string; tankGroupId: string; tankGroupName: string;
  subTankId: string; subTankName: string; count: number;
};
type StockOptions = {
  items: CatalogStockOption[]; total: number; page: number; pageSize: number;
  sites: { id: string; name: string }[]; tanks: TankOption[];
};
type ProductGroup = { key: string; item: CatalogStockOption; items: CatalogStockOption[] };
type TankGroup = { key: string; name: string; products: ProductGroup[] };
type BoardGroup = { key: string; name: string; tanks: TankGroup[] };
const PAGE_SIZE = 50;
const statusLabels: Record<string, string> = { healthy: "正常", feeding: "开口", sick: "疾病" };

// Group only the loaded page, by exact site/tank/product IDs. Never join fish by species or display code.
export function groupCatalogStockItems(items: CatalogStockOption[]): BoardGroup[] {
  const boards = new Map<string, BoardGroup>();
  const tanks = new Map<string, TankGroup>();
  const products = new Map<string, ProductGroup>();
  const seenIds = new Set<string>();
  for (const item of items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const boardKey = JSON.stringify([item.siteId, item.tankGroupId || ""]);
    const tankKey = JSON.stringify([item.siteId, item.tankGroupId || "", item.subTankId || item.tankName || ""]);
    const productKey = JSON.stringify([tankKey, item.productId]);
    if (!boards.has(boardKey)) boards.set(boardKey, {
      key: boardKey,
      name: [item.siteName || "场地未记录", item.tankGroupName || "缸组未记录"].join(" · "),
      tanks: [],
    });
    if (!tanks.has(tankKey)) {
      const tank: TankGroup = { key: tankKey, name: item.subTankName || item.tankName || "缸位未记录", products: [] };
      tanks.set(tankKey, tank);
      boards.get(boardKey)!.tanks.push(tank);
    }
    if (!products.has(productKey)) {
      const product: ProductGroup = { key: productKey, item, items: [] };
      products.set(productKey, product);
      tanks.get(tankKey)!.products.push(product);
    }
    products.get(productKey)!.items.push(item);
  }
  return [...boards.values()];
}

export function toggleCatalogStockSelection(selected: Set<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  const remove = ids.length > 0 && ids.every(id => next.has(id));
  ids.forEach(id => remove ? next.delete(id) : next.add(id));
  return next;
}

export function catalogTankFilterOptions(tanks: TankOption[], siteId: string) {
  const options = new Map<string, { value: string; label: string; count: number }>();
  for (const tank of tanks) {
    if (siteId !== "all" && tank.siteId !== siteId) continue;
    const sharedSpecial = siteId === "all" && ["__in_transit__", "__unassigned__"].includes(tank.subTankId);
    const previous = options.get(tank.subTankId);
    if (sharedSpecial && previous) {
      previous.count += tank.count;
      continue;
    }
    options.set(tank.subTankId, {
      value: tank.subTankId,
      label: sharedSpecial ? `全部场地 / ${tank.subTankName}`
        : [siteId === "all" ? tank.siteName : "", tank.tankGroupName, tank.subTankName].filter(Boolean).join(" / "),
      count: tank.count,
    });
  }
  return [...options.values()];
}

function unavailableReason(item: CatalogStockOption) {
  return item.lost ? "已损耗" : item.outStock ? "已出库" : item.sold ? "已售" : item.inTransit ? "移缸在途" : item.status === "sick" ? "疾病" : "";
}

export function CatalogStockTile({ item, hidden, selected, disabled, onSelect }: {
  item: CatalogStockOption; hidden: boolean; selected: boolean; disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const unavailable = unavailableReason(item);
  const status = statusLabels[item.status] || "状态未记录";
  const identity = item.code ? `编号 ${item.code}` : `ID ${item.id.slice(-8)}`;
  const description = `${item.productName || "鱼只"}，${item.code ? `编号 ${item.code}` : "未填写编号"}，库存 ID ${item.id}，${item.siteName}，${item.tankName}，${status}${unavailable ? `，暂不可售：${unavailable}` : ""}，${hidden ? "单只隐藏" : "未单独隐藏"}`;
  return <button
    type="button"
    data-catalog-stock-id={item.id}
    aria-pressed={selected}
    aria-label={`${selected ? "取消选择" : "选择"}${description}`}
    title={description}
    disabled={disabled}
    onClick={() => onSelect(item.id)}
    className={`relative flex w-24 min-w-0 flex-col overflow-hidden rounded-md border-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${selected ? "border-primary bg-primary/10 ring-2 ring-primary ring-offset-1" : "border-border bg-background hover:border-primary/60"}`}
  >
    <span className="relative block h-20 w-full overflow-hidden bg-muted">
      {item.imageUrl ? <ImageWithFallback src={item.imageUrl} alt="" className="size-full object-cover" loading="lazy" decoding="async" />
        : <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground"><Fish className="size-6" aria-hidden="true" /><span className="text-xs">暂无图片</span></span>}
      <span className={`absolute right-1 top-1 flex size-6 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-slate-600 bg-white text-transparent"}`} aria-hidden="true"><Check className="size-4" /></span>
    </span>
    <span className="block w-full truncate px-1.5 pt-1 text-xs font-semibold tabular-nums">{identity}</span>
    <span className="block w-full truncate px-1.5 text-xs leading-5 text-muted-foreground">{status}{unavailable && unavailable !== status ? ` · ${unavailable}` : ""}</span>
    <span className="flex w-full items-center gap-1 px-1.5 pb-1.5 text-xs leading-5">{hidden && <EyeOff className="size-3 shrink-0" aria-hidden="true" />}{hidden ? "单只隐藏" : "未单独隐藏"}</span>
  </button>;
}

export function CatalogStockBoard({ items, hiddenIds, productRules, selectedIds, disabled, onSelect }: {
  items: CatalogStockOption[]; hiddenIds: Set<string>; productRules: Map<string, ProductRule>;
  selectedIds: Set<string>; disabled: boolean; onSelect: (ids: string[]) => void;
}) {
  const boards = useMemo(() => groupCatalogStockItems(items), [items]);
  return <div className="space-y-4 p-3 sm:p-4">{boards.map(board => <section key={board.key} aria-label={board.name} className="min-w-0 overflow-hidden rounded-md border">
    <h3 className="border-b bg-muted/60 px-3 py-3 text-sm font-semibold">{board.name}</h3>
    <div className="divide-y">{board.tanks.map(tank => <section key={tank.key} className="min-w-0" aria-label={tank.name}>
      <h4 className="flex flex-wrap items-center gap-2 bg-muted/25 px-3 py-2 text-sm font-medium">{tank.name}<span className="text-xs font-normal text-muted-foreground">本页 {tank.products.reduce((sum, group) => sum + group.items.length, 0)} 条</span></h4>
      <div className="divide-y">{tank.products.map(group => {
        const rule = productRules.get(group.item.productId);
        const inheritedReason = rule?.hiddenReason === "major" ? "随类型隐藏" : rule?.hiddenReason === "species" ? "随物种隐藏" : rule?.hiddenReason === "product" ? "随商品隐藏" : "";
        const allSelected = group.items.every(item => selectedIds.has(item.id));
        return <div key={group.key} className="min-w-0 px-3 py-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="break-words text-sm font-medium">{group.item.productName || "未关联商品"}</span><Badge variant="secondary">{group.items.length} 条</Badge>{inheritedReason && <Badge variant="outline">{inheritedReason}</Badge>}{!inheritedReason && !!rule?.displayCap && <Badge variant="outline">商品上限 {rule.displayCap} 条</Badge>}</div>
              <p className="mt-1 break-words text-xs text-muted-foreground">{[group.item.productSize, group.item.productOrigin, group.item.speciesName].filter(Boolean).join(" · ")}</p>
            </div>
            <Button type="button" variant="outline" className="!min-h-[44px]" aria-pressed={allSelected} disabled={disabled} title={`仅${allSelected ? "取消选择" : "选择"}「${tank.name}」内「${group.item.productName}」本页的 ${group.items.length} 条`} onClick={() => onSelect(group.items.map(item => item.id))}>{allSelected ? "取消本组" : "选本组"}</Button>
          </div>
          <div className="flex flex-wrap gap-2 pb-1">{group.items.map(item => <CatalogStockTile key={item.id} item={item} hidden={hiddenIds.has(item.id)} selected={selectedIds.has(item.id)} disabled={disabled} onSelect={id => onSelect([id])} />)}</div>
        </div>;
      })}</div>
    </section>)}</div>
  </section>)}</div>;
}

export function CatalogStockRules({ policy, productRules, disabled, initialSiteId, onApplySelection }: {
  policy: PublicCatalogPolicy; productRules: Map<string, ProductRule>; disabled: boolean; initialSiteId?: string;
  onApplySelection: (ids: string[], hidden: boolean) => Promise<boolean>;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [siteId, setSiteId] = useState(initialSiteId || "all");
  const [subTankId, setSubTankId] = useState("all");
  const [selectedTankLabel, setSelectedTankLabel] = useState("");
  const [filter, setFilter] = useState<"all" | "hidden">("all");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [sites, setSites] = useState<StockOptions["sites"]>([]);
  const [tanks, setTanks] = useState<TankOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [result, setResult] = useState<{ key: string; loading: boolean; error: string; data: StockOptions | null }>({ key: "", loading: true, error: "", data: null });
  const hiddenIds = useMemo(() => new Set(policy.hiddenStockIds), [policy.hiddenStockIds]);
  const requestKey = JSON.stringify({ search: debouncedSearch.trim(), siteId, subTankId, filter, page, pageSize: PAGE_SIZE, hiddenStockIds: [...hiddenIds].sort() });
  const previousInitialSiteId = useRef(initialSiteId);

  useEffect(() => {
    if (previousInitialSiteId.current === initialSiteId) return;
    previousInitialSiteId.current = initialSiteId;
    setSiteId(initialSiteId || "all"); setSubTankId("all"); setSelectedTankLabel(""); setPage(1);
    setSelectedIds(new Set()); setActionMessage(""); setActionError("");
  }, [initialSiteId]);

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
      if (!Array.isArray(body.items) || !Array.isArray(body.sites) || !Array.isArray(body.tanks) || !Number.isSafeInteger(body.total) || body.total < 0 || body.items.length > PAGE_SIZE) {
        throw new Error("单鱼列表返回异常，请刷新后重试");
      }
      if (controller.signal.aborted) return;
      setSites(body.sites);
      setTanks(body.tanks);
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
  const controlsDisabled = disabled || submitting;
  const pageIds = data?.items.map(item => item.id) || [];
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const selectedOnPage = pageIds.filter(id => selectedIds.has(id)).length;
  const tankOptions = catalogTankFilterOptions(tanks, siteId);
  const clearSelection = () => { setSelectedIds(new Set()); setActionMessage(""); setActionError(""); };
  const changeFilter = () => { clearSelection(); setPage(1); };
  const refresh = () => { clearSelection(); setAttempt(value => value + 1); };
  const select = (ids: string[]) => {
    if (controlsDisabled) return;
    setActionMessage(""); setActionError("");
    setSelectedIds(previous => toggleCatalogStockSelection(previous, ids));
  };
  const applySelection = async (hidden: boolean) => {
    if (controlsDisabled || submittingRef.current || selectedIds.size === 0 || current.loading || current.error) return;
    submittingRef.current = true;
    setSubmitting(true); setActionError(""); setActionMessage("");
    const ids = [...selectedIds];
    try {
      if (await onApplySelection(ids, hidden)) {
        setSelectedIds(new Set());
        setActionMessage(`已保存：${ids.length} 条鱼${hidden ? "设为单只隐藏" : "已解除单只隐藏"}。`);
        setAttempt(value => value + 1);
      }
    } catch {
      setActionError("保存失败，已保留选择，请重试。若页面提示规则已更新，请先刷新规则。");
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  return <section className="min-w-0 rounded-md border bg-card" aria-label="按单鱼设置鱼单展示">
    <div className="px-4 py-3">
      <h2 className="font-semibold">看图选鱼，批量设置展示</h2>
      <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">按缸位找到鱼只，点击图片选中，再点「隐藏选中」或「恢复选中」。确认后直接保存，不会改变库存、售价或健康状态。</p>
      <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground">恢复仅解除单只隐藏，仍遵循类型、物种、商品规则及数量上限；已售、疾病和移缸在途等不可售鱼不会对外展示。</p>
      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0 sm:col-span-2 xl:col-span-1">
          <label htmlFor="catalog-stock-search" className="mb-1 block text-xs text-muted-foreground">查找鱼只</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id="catalog-stock-search" value={search} disabled={submitting} maxLength={120} placeholder="编号、商品名或缸位" className="!h-[44px] !min-h-[44px] pl-9 pr-[44px]" onChange={event => { setSearch(event.target.value); changeFilter(); }} />
            {search && <Button type="button" variant="ghost" disabled={submitting} className="absolute right-0 top-0 !size-[44px]" aria-label="清空鱼只搜索" onClick={() => { setSearch(""); changeFilter(); }}><X className="size-4" aria-hidden="true" /></Button>}
          </div>
        </div>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted-foreground">库存场地</span>
          <select className="fishroom-control h-[44px] w-full min-w-0 rounded-md border bg-background px-3 text-sm" aria-label="筛选鱼只场地" value={siteId} disabled={submitting} onChange={event => { setSiteId(event.target.value); setSubTankId("all"); setSelectedTankLabel(""); changeFilter(); }}>
            <option value="all">全部场地</option>
            {siteId !== "all" && !sites.some(site => site.id === siteId) && <option value={siteId}>{current.loading ? "正在加载当前场地…" : "当前场地不可用"}</option>}
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted-foreground">缸位</span>
          <select className="fishroom-control h-[44px] w-full min-w-0 rounded-md border bg-background px-3 text-sm" aria-label="筛选鱼只缸位" value={subTankId} disabled={submitting} onChange={event => { setSubTankId(event.target.value); setSelectedTankLabel(tankOptions.find(option => option.value === event.target.value)?.label || ""); changeFilter(); }}>
            <option value="all">全部缸位</option>
            {subTankId !== "all" && !tankOptions.some(option => option.value === subTankId) && <option value={subTankId}>{selectedTankLabel || "已选缸位"}（当前条件无匹配）</option>}
            {tankOptions.map(option => <option key={option.value} value={option.value}>{option.label}（{option.count} 条）</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted-foreground">单鱼规则</span>
          <select className="fishroom-control h-[44px] w-full min-w-0 rounded-md border bg-background px-3 text-sm" aria-label="筛选单鱼规则" value={filter} disabled={submitting} onChange={event => { setFilter(event.target.value as "all" | "hidden"); changeFilter(); }}>
            <option value="all">全部鱼只</option>
            <option value="hidden">仅单只隐藏</option>
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">翻页保留选择；更换搜索、场地、缸位、单鱼规则或刷新列表会清空选择。</p>
    </div>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y bg-background px-3 py-2" aria-label="选鱼展示操作">
      <span className="mr-auto text-sm font-medium tabular-nums" aria-live="polite">已选 {selectedIds.size} 条{selectedIds.size > selectedOnPage && <span className="ml-1 text-xs font-normal text-muted-foreground">（其他页 {selectedIds.size - selectedOnPage} 条）</span>}</span>
      <Button type="button" variant="ghost" className="!min-h-[44px] px-2" disabled={!selectedIds.size || submitting} onClick={clearSelection}>清空选择</Button>
      <div className="flex w-full gap-2 sm:w-auto">
        <Button type="button" className="!min-h-[44px] flex-1 sm:flex-none" disabled={controlsDisabled || !selectedIds.size || current.loading || !!current.error} onClick={() => void applySelection(true)}><EyeOff className="size-4" aria-hidden="true" />{submitting ? "正在保存…" : "隐藏选中"}</Button>
        <Button type="button" variant="outline" className="!min-h-[44px] flex-1 sm:flex-none" disabled={controlsDisabled || !selectedIds.size || current.loading || !!current.error} onClick={() => void applySelection(false)}><Eye className="size-4" aria-hidden="true" />恢复选中</Button>
      </div>
    </div>
    {actionMessage && <p role="status" className="border-b px-4 py-3 text-sm">{actionMessage}</p>}
    {actionError && <p role="alert" className="border-b px-4 py-3 text-sm text-destructive">{actionError}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <Button type="button" variant="outline" className="!min-h-[44px]" disabled={controlsDisabled || current.loading || !pageIds.length} aria-pressed={allPageSelected} onClick={() => select(pageIds)}>{allPageSelected ? "取消本页" : "本页全选"}</Button>
      <Button type="button" variant="ghost" className="!min-h-[44px]" onClick={refresh} disabled={current.loading || submitting}><RefreshCw className="size-4" aria-hidden="true" />刷新列表</Button>
    </div>
    {current.loading && <div role="status" className="space-y-4 p-4"><span className="sr-only">正在加载单鱼列表</span>{[0, 1, 2].map(index => <Skeleton key={index} className="h-24 motion-reduce:animate-none" />)}</div>}
    {current.error && <div role="alert" className="space-y-3 p-4 text-sm"><p>{current.error}</p><Button type="button" variant="outline" className="!min-h-[44px]" onClick={refresh}>重新加载</Button></div>}
    {data && <>
      <div className="px-4 pt-3 text-xs leading-5 text-muted-foreground" aria-live="polite">找到 {data.total} 条 · 第 {page} / {totalPages} 页 · 每页最多 {PAGE_SIZE} 条。分组数量仅为本页；列表包含当前库存、移缸在途及已设单只隐藏的历史鱼只，不代表小程序实际展示数量。</div>
      {data.items.length ? <CatalogStockBoard items={data.items} hiddenIds={hiddenIds} productRules={productRules} selectedIds={selectedIds} disabled={controlsDisabled} onSelect={select} />
        : <p className="px-4 py-10 text-center text-sm text-muted-foreground">{filter === "hidden" ? "当前条件下没有单只隐藏的鱼。可切换「全部鱼只」查找并设置。" : "没有找到鱼只，请核对编号或调整场地、缸位、搜索条件。"}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
        <span>第 {page} / {totalPages} 页</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" className="!min-h-[44px]" disabled={page <= 1 || submitting} onClick={() => setPage(value => value - 1)}>上一页</Button>
          <Button type="button" variant="outline" className="!min-h-[44px]" disabled={page >= totalPages || submitting} onClick={() => setPage(value => value + 1)}>下一页</Button>
        </div>
      </div>
    </>}
  </section>;
}
