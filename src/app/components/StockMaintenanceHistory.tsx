import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useStore, type BioRecord } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { batchOrderIdentityKey } from "../utils/batchOrderDialog";
import { formatBioRecordTime } from "../utils/localDateTime";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { readStockMaintenanceHistory } from "../utils/stockMaintenanceHistory";
import { Button } from "./ui/button";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { MediaVideo } from "./MediaVideo";
import { stockTransferRecordLabel } from "./StockTransferDialog";

const PAGE_SIZE = 20;

export function maintenanceHistorySourceLabel(sourceType?: string): string {
  if (sourceType === "stockLoss") return "损耗记录";
  if (sourceType === "dailyLog") return "缸组养护";
  if (sourceType === "shipmentCancellation") return "取消出库回缸核对";
  return stockTransferRecordLabel(sourceType) || (sourceType && sourceType !== "manual" ? `其他记录（${sourceType}）` : "单鱼记录");
}

export function StockMaintenanceHistoryRecords({ records, visibleCount = PAGE_SIZE, onShowMore }: {
  records: BioRecord[];
  visibleCount?: number;
  onShowMore?: () => void;
}) {
  if (records.length === 0) return <p className="py-3 text-sm text-muted-foreground">暂无留存的维护记录。</p>;
  const shown = records.slice(0, visibleCount);
  return <>
    <ol className="space-y-4" aria-label="鱼只维护历史">
      {shown.map(record => <li key={record.id} className="min-w-0 rounded-lg border p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h4 className="break-words text-sm font-semibold">{maintenanceHistorySourceLabel(record.sourceType)}</h4>
          <time dateTime={record.date || undefined} className="text-xs tabular-nums text-muted-foreground">{formatBioRecordTime(record.date, "时间未记录")}</time>
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">操作人：{record.operator || "未记录"}
          {[record.tankGroupName, record.subTankName, record.tankLocation].filter(Boolean).length > 0 && <span> · {[record.tankGroupName, record.subTankName, record.tankLocation].filter(Boolean).join(" / ")}</span>}
        </p>
        {record.text && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{record.text}</p>}
        {record.photos.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {record.photos.map((src, index) => <MediaPreviewTrigger key={`${src}:${index}`} src={src} mediaType="image"
            stockItemId={record.stockItemId} recordId={record.id} title={`维护照片 ${index + 1}`} ariaLabel={`预览维护照片 ${index + 1}`}
            className="size-20 shrink-0 overflow-hidden rounded-md border bg-muted">
            <ImageWithFallback src={src} alt={`维护照片 ${index + 1}`} loading="lazy" className="size-full object-cover" />
          </MediaPreviewTrigger>)}
        </div>}
        {!!record.videos?.length && <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          {record.videos.map((src, index) => <div key={`${src}:${index}`} className="min-w-0 overflow-hidden rounded-md border">
            <MediaVideo src={src} controls playsInline preload="none" aria-label={`维护视频 ${index + 1}`} className="aspect-video w-full bg-black" />
            <MediaPreviewTrigger src={src} mediaType="video" stockItemId={record.stockItemId} recordId={record.id}
              title={`维护视频 ${index + 1}`} ariaLabel={`放大预览维护视频 ${index + 1}`}
              className="flex min-h-11 w-full items-center justify-center border-t px-3 text-sm hover:bg-muted">
              放大预览视频
            </MediaPreviewTrigger>
          </div>)}
        </div>}
      </li>)}
    </ol>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground" role="status">已显示 {shown.length} / {records.length} 条</p>
      {shown.length < records.length && <Button type="button" variant="outline" className="min-h-11" onClick={onShowMore}>
        <ChevronDown className="size-4" aria-hidden="true" />查看更多记录
      </Button>}
    </div>
  </>;
}

type HistoryResult = { key: string; loading: boolean; error: string; records: BioRecord[] | null };

/** A read-only history. Mount it only when the fish's detail is opened. */
export function StockMaintenanceHistory({ stockItemId }: { stockItemId: string }) {
  const { state, activeSiteId } = useStore();
  const identity = batchOrderIdentityKey(state.user);
  const session = captureNewCustomerSession();
  const contextKey = JSON.stringify([stockItemId, activeSiteId, identity, session?.key, state.user?.account]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const [attempt, setAttempt] = useState(0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [result, setResult] = useState<HistoryResult | null>(null);
  const requestKey = JSON.stringify([contextKey, attempt]);
  const current = result?.key === requestKey ? result : { loading: true, error: "", records: null };

  useEffect(() => {
    const controller = new AbortController();
    const openingSession = captureNewCustomerSession();
    const requestIsCurrent = () => !controller.signal.aborted && contextRef.current === contextKey
      && isNewCustomerSessionCurrent(openingSession, state.user);
    setVisibleCount(PAGE_SIZE);
    setResult({ key: requestKey, loading: true, error: "", records: null });
    if (!identity || !openingSession || !isNewCustomerSessionCurrent(openingSession, state.user) || !stockItemId.trim()) {
      setResult({ key: requestKey, loading: false, error: !stockItemId.trim() ? "缺少鱼只编号，请重新打开详情。" : "登录已过期，请重新登录后查看维护记录。", records: null });
      return () => controller.abort();
    }
    void fetch(`/api/bio-records?stockItemId=${encodeURIComponent(stockItemId)}`, {
      headers: authJsonHeaders(), signal: controller.signal, cache: "no-store",
    }).then(async response => {
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) throw new Error(response.status === 401
        ? "登录已过期，请重新登录后查看维护记录。"
        : body?.error || "维护记录加载失败，请重试。");
      const records = readStockMaintenanceHistory(body, stockItemId);
      if (requestIsCurrent()) setResult({ key: requestKey, loading: false, error: "", records });
    }).catch(cause => {
      if (requestIsCurrent()) setResult({ key: requestKey, loading: false,
        error: cause instanceof TypeError ? "网络连接失败，请检查网络后重试。" : cause instanceof Error ? cause.message : "维护记录加载失败，请重试。", records: null });
    });
    return () => controller.abort();
  }, [contextKey, requestKey, identity, stockItemId]);

  return <section className="min-w-0" aria-label="全部维护历史">
    <h3 className="mb-3 text-sm font-semibold">全部维护历史</h3>
    {current.loading && <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在加载维护记录…</p>}
    {current.error && <div role="alert" className="flex flex-wrap items-center gap-3 py-3 text-sm"><p>{current.error}</p><Button type="button" variant="outline" className="min-h-11" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />重试</Button></div>}
    {current.records && <StockMaintenanceHistoryRecords key={contextKey} records={current.records} visibleCount={visibleCount} onShowMore={() => setVisibleCount(value => value + PAGE_SIZE)} />}
  </section>;
}
