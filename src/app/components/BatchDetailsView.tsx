import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, PanelsTopLeft, LayoutGrid, List, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { authJsonHeaders } from "../utils/authSession";
import { batchPrice, batchRecordDate, batchSaleLabel, type BatchSale } from "../utils/batchDetailDisplay";
import { BatchOrderDialog } from "./BatchOrderDialog";

type FishStatus = "all" | "inStock" | "sold" | "lost" | "removed" | "restricted";
type FishSummary = {
  stockItemId: string;
  code?: string;
  productName?: string;
  speciesName?: string;
  size?: string;
  origin?: string;
  status: string;
  statusLabel: string;
  inDate?: string;
  initialTankName?: string;
  currentTankName?: string;
  currentSiteName?: string;
  sales: BatchSale[];
  lossDate?: string;
  recordCount: number;
  warnings: string[];
};
type BatchDetailResponse = {
  ok: boolean;
  batch: { id: string; batchNo: string; supplier: string; arrivalDate: string; siteName: string };
  summary: { total: number; inStock: number; sold: number; lost: number; removed: number; restricted?: number };
  items: FishSummary[];
  tanks: BatchTank[];
  page: number;
  pageSize: number;
  total: number;
};
type BatchTank = {
  key: string;
  siteName: string;
  tankName: string;
  total: number;
  inStock: number;
  sold: number;
  lost: number;
  removed: number;
  restricted: number;
};
type FishEvent = {
  id: string;
  type: string;
  date?: string;
  title: string;
  text?: string;
  siteName?: string;
  tankName?: string;
  operator?: string;
  orderId?: string;
  orderNo?: string;
  orderSiteId?: string;
  price?: number | null;
  photos?: string[];
  videos?: string[];
};
type HistoryResponse = { ok: boolean; stockItemId: string; events: FishEvent[]; page: number; pageSize: number; total: number };
type OpenOrder = (orderId: string, siteId?: string) => void;

async function readBatchApi<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: authJsonHeaders(), signal, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "记录加载失败，请重试");
  }
  return body as T;
}

function OrderLink({ id, number, siteId, onOpenOrder }: { id: string; number?: string; siteId?: string; onOpenOrder?: OpenOrder }) {
  return onOpenOrder ? <button type="button" onClick={() => onOpenOrder(id, siteId)}
    className="inline-flex min-h-9 items-center gap-1 break-all text-left font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-4 hover:decoration-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
    aria-label={`查看订单 ${number || id}`}>
    {number || id}<PanelsTopLeft aria-hidden="true" className="size-3.5 shrink-0" />
  </button> : <span className="break-all font-medium">{number || id}</span>;
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
    <span>{error}</span><Button variant="outline" size="sm" onClick={onRetry}>重新加载</Button>
  </div>;
}

function FishHistory({ batchId, siteId, stockItemId, onOpenOrder }: {
  batchId: string; siteId: string; stockItemId: string; onOpenOrder?: OpenOrder;
}) {
  const [events, setEvents] = useState<FishEvent[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ batchId, siteId, stockItemId, page: String(page), pageSize: "100" });
    readBatchApi<HistoryResponse>(`/api/batches/fish-history?${params}`, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setTotal(result.total);
        setEvents(previous => page === 1 ? result.events : [...new Map([...previous, ...result.events].map(event => [event.id, event])).values()]);
      })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "记录加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [batchId, siteId, stockItemId, page, retry]);
  return <div className="border-t px-4 py-4 sm:px-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">留存记录</h4>
      {!loading && !error && <span className="text-xs text-muted-foreground">已显示 {events.length} / {total} 条</span>}
    </div>
    <ol className="space-y-5">
      {events.map(event => <li key={event.id} className="relative border-l border-teal-200 pl-4">
        <span aria-hidden="true" className="absolute -left-[5px] top-1.5 size-2 rounded-full bg-teal-700" />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h5 className="text-sm font-semibold">{event.title}</h5>
          <time className="text-xs tabular-nums text-muted-foreground">{batchRecordDate(event.date)}</time>
        </div>
        {(event.siteName || event.tankName || event.operator) && <p className="mt-1 text-xs text-muted-foreground">
          {[event.siteName, event.tankName, event.operator && `操作人：${event.operator}`].filter(Boolean).join(" · ")}
        </p>}
        {event.text && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{event.text}</p>}
        {event.orderId && <div className="mt-1 flex flex-wrap items-center gap-x-4 text-sm">
          <OrderLink id={event.orderId} number={event.orderNo} siteId={event.orderSiteId} onOpenOrder={onOpenOrder} />
          {"price" in event && <span>订单行价：{batchPrice(event.price)}</span>}
        </div>}
        {!!event.photos?.length && <div className="mt-3 flex flex-wrap gap-2">
          {event.photos.map((src, index) => <a key={`${src}:${index}`} href={src} target="_blank" rel="noopener noreferrer" aria-label={`查看${event.title}照片 ${index + 1}`}>
            <img src={src} alt={`${event.title}照片 ${index + 1}`} loading="lazy" className="size-20 rounded-md border bg-muted object-cover" />
          </a>)}
        </div>}
        {!!event.videos?.length && <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
          {event.videos.map((src, index) => <video key={`${src}:${index}`} src={src} controls preload="none" playsInline
            aria-label={`${event.title}视频 ${index + 1}`} className="aspect-video w-full rounded-md border bg-black" />)}
        </div>}
      </li>)}
    </ol>
    {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />正在加载记录…</p>}
    {error && <div className="mt-4"><LoadError error={error} onRetry={() => setRetry(value => value + 1)} /></div>}
    {!loading && !error && events.length === 0 && <p className="text-sm text-muted-foreground">没有可查看的留存记录。</p>}
    {!loading && !error && events.length < total && <Button className="mt-4" variant="outline" onClick={() => setPage(value => value + 1)}>加载更多记录</Button>}
  </div>;
}

function FishRow({ fish, batchId, siteId, onOpenOrder }: { fish: FishSummary; batchId: string; siteId: string; onOpenOrder?: OpenOrder }) {
  const [expanded, setExpanded] = useState(false);
  const tone = fish.status === "lost" ? "border-red-200 bg-red-50 text-red-800"
    : fish.status === "sold" ? "border-amber-200 bg-amber-50 text-amber-900"
    : fish.status === "inStock" ? "border-teal-200 bg-teal-50 text-teal-900" : "border-border bg-muted text-muted-foreground";
  return <article className="overflow-hidden rounded-lg border bg-card" aria-label={`${fish.code || "未编号"} ${fish.productName || "未记录商品"}`}>
    <div className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold"><span className="mr-2 text-muted-foreground">#{fish.code || "未编号"}</span>{fish.productName || "商品未记录"}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{[fish.speciesName, fish.size, fish.origin].filter(Boolean).join(" · ") || "规格未记录"}</p>
        </div>
        <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${tone}`}>{fish.statusLabel}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">入库时间</dt><dd className="mt-1 tabular-nums">{batchRecordDate(fish.inDate)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">初始入缸</dt><dd className="mt-1 break-words">{fish.initialTankName || "未记录"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{fish.status === "inStock" ? "当前缸位" : "档案缸位"}</dt>
          <dd className="mt-1 break-words">{[fish.currentSiteName, fish.currentTankName].filter(Boolean).join(" · ") || (fish.status === "restricted" ? "无权查看" : "未记录")}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{fish.status === "lost" ? "死亡 / 损耗时间" : "关联订单"}</dt>
          <dd className="mt-1 tabular-nums">{fish.status === "lost" ? batchRecordDate(fish.lossDate) : fish.sales.length ? `${fish.sales.length} 条` : fish.status === "restricted" ? "无可查看的关联" : "暂无关联"}</dd></div>
      </dl>
      {!!fish.sales.length && <ul className="mt-4 space-y-2 border-t pt-3 text-sm">
        {fish.sales.map((sale, index) => <li key={`${sale.orderId}:${sale.kind}:${index}`} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-xs text-muted-foreground">{batchSaleLabel(sale)}</span>
          <OrderLink id={sale.orderId} number={sale.orderNo} siteId={sale.siteId} onOpenOrder={onOpenOrder} />
          <span className="text-xs text-muted-foreground">{sale.kind === "replacement" ? "补发关联时间：" : "下单时间："}<time className="tabular-nums">{batchRecordDate(sale.date)}</time></span>
          <span className="tabular-nums">{sale.kind === "replacement" ? "补发，不另算成交" : `订单行价：${batchPrice(sale.price)}`}</span>
          {sale.note && <span className="w-full text-xs text-muted-foreground">{sale.note}</span>}
        </li>)}
      </ul>}
      {!!fish.warnings.length && <ul className="mt-3 space-y-1 text-xs leading-relaxed text-amber-800">
        {fish.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}
      <Button variant="ghost" size="sm" className="mt-3 -ml-2 text-teal-800" aria-expanded={expanded}
        aria-controls={`fish-history-${fish.stockItemId}`} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        {expanded ? "收起记录" : "查看全部记录"}
      </Button>
    </div>
    {expanded && <div id={`fish-history-${fish.stockItemId}`}><FishHistory batchId={batchId} siteId={siteId} stockItemId={fish.stockItemId} onOpenOrder={onOpenOrder} /></div>}
  </article>;
}

export function BatchDetailsView({ batchId, siteId, onBack, batchInfo, batchIdentity }: {
  batchId: string; siteId: string; onBack: () => void; batchInfo?: ReactNode;
  batchIdentity?: { batchNo: string; supplier: string; arrivalDate: string };
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FishStatus>("all");
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<"fish" | "tanks">("fish");
  const [tankKey, setTankKey] = useState("");
  const [orderRequest, setOrderRequest] = useState<{ batchId: string; siteId: string; orderId: string } | null>(null);
  const onOpenOrder: OpenOrder = orderId => setOrderRequest({ batchId, siteId, orderId });
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data: BatchDetailResponse } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const query = new URLSearchParams({ batchId, siteId, search, status, tankKey, page: String(page), pageSize: "50" }).toString();
  const queryKey = `${query}:${retry}`;
  const data = result?.key === queryKey ? result.data : null;
  const batch = result?.data.batch;
  const summary = result?.data.summary;
  const tanks = data?.tanks ?? [];
  const selectedTank = tanks.find(tank => tank.key === tankKey);
  const identity = batchIdentity || batch;
  const tankOverview = viewMode === "tanks" && !tankKey;
  const changeView = (mode: "fish" | "tanks") => { setViewMode(mode); setTankKey(""); setPage(1); };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    readBatchApi<BatchDetailResponse>(`/api/batches/detail?${query}`, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResult({ key: queryKey, data: value }); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "批次明细加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, queryKey]);
  const filters: { value: FishStatus; label: string; count?: number }[] = [
    { value: "all", label: "全部", count: summary?.total },
    { value: "inStock", label: "在库", count: summary?.inStock },
    { value: "sold", label: "已售", count: summary?.sold },
    { value: "lost", label: "损耗", count: summary?.lost },
    { value: "removed", label: "已移除", count: summary?.removed },
    ...(summary?.restricted ? [{ value: "restricted" as const, label: "记录受限", count: summary.restricted }] : []),
  ];
  return <section className="flex flex-col gap-5 pb-20">
    <div>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" />返回采购批次</Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xl font-semibold">批次详情{identity?.batchNo && <span className="ml-3 font-normal text-muted-foreground">{identity.batchNo}</span>}</h2>
          {identity && <p className="mt-2 text-sm text-muted-foreground">{[batch?.siteName, identity.supplier, `到货 ${batchRecordDate(identity.arrivalDate)}`].filter(Boolean).join(" · ")}</p>}
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />刷新记录</Button>
      </div>
    </div>
    {batchInfo}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-base font-semibold">鱼只记录</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">点订单号可在本页查看订单。历史缺失信息不做推断；单鱼订单行价未分摊整单优惠或退款。</p>
      </div>
      <div role="group" aria-label="明细查看方式" className="inline-flex shrink-0 gap-1 rounded-lg border bg-card p-1">
        <Button size="sm" variant={viewMode === "fish" ? "default" : "ghost"} aria-pressed={viewMode === "fish"} onClick={() => changeView("fish")}><List aria-hidden="true" className="size-4" />按鱼只</Button>
        <Button size="sm" variant={viewMode === "tanks" ? "default" : "ghost"} aria-pressed={viewMode === "tanks"} onClick={() => changeView("tanks")}><LayoutGrid aria-hidden="true" className="size-4" />按缸位</Button>
      </div>
    </div>
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:p-4">
      <div role="group" aria-label="按鱼只状态筛选" className="flex flex-wrap gap-2">
        <span className="flex items-center pr-1 text-xs text-muted-foreground">全批次状态</span>
        {filters.map(filter => <Button key={filter.value} size="sm" variant={status === filter.value ? "default" : "outline"}
          aria-pressed={status === filter.value} onClick={() => { setStatus(filter.value); setPage(1); }}>
          {filter.label}<span className="ml-1 tabular-nums">{filter.count ?? "—"}</span>
        </Button>)}
      </div>
      <form className="flex gap-2" role="search" onSubmit={event => { event.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
        <Input aria-label="搜索鱼编号、商品或订单" placeholder="搜索鱼编号、商品或订单…" maxLength={100} value={searchInput} onChange={event => setSearchInput(event.target.value)} className="min-w-0 bg-background" />
        <Button type="submit" variant="outline"><Search aria-hidden="true" className="size-4" />搜索</Button>
        {search && <Button type="button" variant="ghost" onClick={() => { setSearchInput(""); setSearch(""); setPage(1); }}>清除</Button>}
      </form>
    </div>
    {error && <LoadError error={error} onRetry={() => setRetry(value => value + 1)} />}
    {(loading || (!error && !data)) && <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />正在加载批次明细…</div>}
    {!loading && !error && data && <>
      {viewMode === "tanks" && <p className="text-xs leading-relaxed text-muted-foreground">按档案当前缸位分组；已售、损耗鱼显示最后留存缸位，不代表出库或死亡发生地。具体地点请展开历史记录核对。</p>}
      {tankOverview ? <>
        <p role="status" className="text-xs text-muted-foreground">{tanks.length} 个缸位分组 · {data.total} 条鱼{search && ` · “${search}”`} · 点击缸位查看鱼只</p>
        {tanks.length ? <div className="batch-tank-grid grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="批次缸位分布">
          {tanks.map(tank => <button key={tank.key} type="button" onClick={() => { setTankKey(tank.key); setPage(1); }}
            aria-label={`查看缸位 ${[tank.siteName, tank.tankName].filter(Boolean).join(" ")}，${tank.total} 条鱼`}
            className="min-w-0 rounded-lg border bg-card p-4 text-left transition-colors hover:border-teal-600 hover:bg-teal-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700">
            <span className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="block text-xs text-muted-foreground">{tank.siteName || "其他记录"}</span>
              <span className="mt-1 block break-words text-base font-semibold">{tank.tankName || "缸位未记录"}</span></span><span className="shrink-0 text-sm tabular-nums">{tank.total} 条</span></span>
            <span className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {!!tank.inStock && <span className="text-teal-800">在库 {tank.inStock}</span>}{!!tank.sold && <span>已售 {tank.sold}</span>}
              {!!tank.lost && <span className="text-red-800">损耗 {tank.lost}</span>}{!!tank.removed && <span>已移除 {tank.removed}</span>}{!!tank.restricted && <span>受限 {tank.restricted}</span>}
            </span>
          </button>)}
        </div> : <div className="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">没有符合条件的缸位记录，可以清除搜索或切换状态。</div>}
      </> : <>
      {viewMode === "tanks" && <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Button variant="outline" size="sm" onClick={() => { setTankKey(""); setPage(1); }}><ArrowLeft aria-hidden="true" className="size-4" />全部缸位</Button>
        <h4 className="text-sm font-semibold">{selectedTank ? [selectedTank.siteName, selectedTank.tankName].filter(Boolean).join(" · ") : "所选缸位"}</h4>
      </div>}
      <p role="status" className="text-xs text-muted-foreground">{search || status !== "all" || tankKey ? "筛选结果" : "可追溯鱼只"} {data.total} 条{search && ` · “${search}”`}</p>
      {data.items.length ? <div className="space-y-3">{data.items.map(fish => <FishRow key={`${queryKey}:${fish.stockItemId}`} fish={fish} batchId={batchId} siteId={siteId} onOpenOrder={onOpenOrder} />)}</div>
        : <div className="rounded-lg border border-dashed px-5 py-12 text-center"><h3 className="text-base font-medium">{search || status !== "all" ? "没有符合条件的鱼" : "暂无可追溯的鱼只"}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{search || status !== "all" ? "可以清除搜索或切换状态查看。" : "此批次尚无单鱼关联记录；批次填写的入库数量不等于系统留存的鱼只档案数量。"}</p></div>}
      {data.total > data.pageSize && <nav aria-label="鱼只明细分页" className="flex flex-wrap items-center justify-between gap-3 pr-16">
        <span className="text-sm text-muted-foreground">第 {page} / {Math.ceil(data.total / data.pageSize)} 页 · 每页 {data.pageSize} 条</span>
        <div className="flex gap-2"><Button variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button>
          <Button variant="outline" disabled={page * data.pageSize >= data.total} onClick={() => setPage(value => value + 1)}>下一页</Button></div>
      </nav>}
      </>}
    </>}
    <BatchOrderDialog request={orderRequest} onClose={() => setOrderRequest(null)} />
  </section>;
}
