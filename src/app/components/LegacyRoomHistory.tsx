import { useEffect, useRef, useState } from "react";
import { History, Loader2, RefreshCw, Video } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { readLegacyRoomHistory, type LegacyRoomHistoryResult } from "../utils/legacyRoomHistory";
import { formatBioRecordTime } from "../utils/localDateTime";
import { mobileWaterDisplayValue } from "../utils/mobileWaterQuality";
import { matchesSite } from "../utils/sites";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";

export function LegacyRoomHistoryButton({ tankGroupId, className }: { tankGroupId: string; className?: string }) {
  const { state, activeSiteId } = useStore();
  const group = state.tankGroups.find(item => item.id === tankGroupId);
  const session = captureNewCustomerSession();
  const context = JSON.stringify([tankGroupId, group?.legacyRoomId, activeSiteId, state.user, session?.key]);
  const [openedContext, setOpenedContext] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [visibleCount, setVisibleCount] = useState(20);
  const [result, setResult] = useState<{ key: string; data?: LegacyRoomHistoryResult; error?: string } | null>(null);
  const contextRef = useRef(context); contextRef.current = context;
  const enabled = Boolean(group?.legacyRoomId && (activeSiteId === "all" || matchesSite(group, activeSiteId)));
  const open = enabled && openedContext === context;
  const requestKey = JSON.stringify([context, attempt]);
  const current = open && result?.key === requestKey ? result : null;

  useEffect(() => {
    if (!open || !group?.legacyRoomId) return;
    const controller = new AbortController();
    const openingSession = captureNewCustomerSession();
    const currentRequest = () => !controller.signal.aborted && contextRef.current === context && isNewCustomerSessionCurrent(openingSession, state.user);
    setResult(null); setVisibleCount(20);
    if (!openingSession || !isNewCustomerSessionCurrent(openingSession, state.user)) {
      setResult({ key: requestKey, error: "登录已过期，请重新登录后查看。" });
      return () => controller.abort();
    }
    const params = new URLSearchParams({ tankGroupId, siteId: activeSiteId === "all" ? group.siteId || "" : activeSiteId });
    void (async () => {
      try {
        const response = await fetch(`/api/tank-groups/legacy-history?${params}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok !== true) throw new Error(response.status === 401 ? "登录已过期，请重新登录后查看。" : payload?.error || "原房间历史加载失败，请重试。");
        const data = readLegacyRoomHistory(payload, group.legacyRoomId!);
        if (currentRequest()) setResult({ key: requestKey, data });
      } catch (cause) {
        if (currentRequest()) setResult({ key: requestKey, error: cause instanceof TypeError ? "网络连接失败，请检查网络后重试。" : cause instanceof Error ? cause.message : "记录加载失败，请重试。" });
      }
    })();
    return () => controller.abort();
  }, [open, context, requestKey]);

  if (!enabled) return null;
  const roomName = current?.data?.legacyRoomName || group?.legacyRoomName || "房间";
  const operator = (username: string) => state.personnel.find(item => item.username === username)?.name || username || "未记录";
  return <>
    <Button type="button" variant="outline" className={className} onClick={() => { setResult(null); setAttempt(value => value + 1); setOpenedContext(context); }}><History className="size-4 shrink-0" aria-hidden="true" />原房间历史</Button>
    <Dialog open={open} onOpenChange={next => { if (!next) setOpenedContext(""); }}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl" data-legacy-room-history>
        <DialogHeader className="shrink-0 pr-7 text-left">
          <DialogTitle>原{roomName}历史</DialogTitle>
          <DialogDescription className="leading-6">当时未区分具体缸。这些记录保留在原房间，只供查阅；其中的水质不是当前 {group?.name} 的检测结果。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!current && <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />正在读取原房间历史…</p>}
          {current?.error && <div role="alert" className="space-y-3 py-4 text-sm"><p>{current.error}</p><Button variant="outline" className="min-h-11" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" />重新加载</Button></div>}
          {current?.data && <>
            {!current.data.rows.length && <p className="py-6 text-sm text-muted-foreground">没有留存的原房间历史记录。</p>}
            <ol className="space-y-5" aria-label="原房间历史记录">
              {current.data.rows.slice(0, visibleCount).map(record => <li key={record.id} className="min-w-0 border-b pb-5 last:border-b-0">
                <h3 className="break-words text-sm font-semibold">{record.title}</h3>
                <p className="mt-1 break-words text-xs leading-5 text-muted-foreground"><time>{formatBioRecordTime(record.date, "时间未记录")}</time> · {operator(record.operator)}</p>
                {record.values.length > 0 && <dl className="mt-3 space-y-2 text-sm">{record.values.map((value, index) => <div key={`${value.parameterId}:${index}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><dt>{value.parameterName}</dt><dd className="text-right font-medium">{mobileWaterDisplayValue(value.value, value.precision)} {value.unit}{value.testMethod && <span className="block text-xs font-normal text-muted-foreground">{value.testMethod}</span>}</dd></div>)}</dl>}
                {record.text && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{record.text}</p>}
                {(record.photos.length > 0 || record.videos.length > 0) && <div className="mt-3 flex flex-wrap gap-2">
                  {record.photos.map((src, index) => <MediaPreviewTrigger key={`p:${index}`} src={src} mediaType="image" title={`原房间照片 ${index + 1}`} ariaLabel={`预览原房间照片 ${index + 1}`} allowDownload={false} className="size-20 shrink-0 overflow-hidden rounded-md border"><ImageWithFallback src={src} alt={`原房间照片 ${index + 1}`} loading="lazy" className="size-full object-cover" /></MediaPreviewTrigger>)}
                  {record.videos.map((src, index) => <MediaPreviewTrigger key={`v:${index}`} src={src} mediaType="video" title={`原房间视频 ${index + 1}`} ariaLabel={`预览原房间视频 ${index + 1}`} allowDownload={false} className="flex min-h-20 min-w-20 flex-col items-center justify-center gap-1 rounded-md border px-3 text-xs"><Video className="size-5" />视频 {index + 1}</MediaPreviewTrigger>)}
                </div>}
              </li>)}
            </ol>
            {current.data.rows.length > visibleCount && <Button variant="outline" className="mt-4 min-h-11 w-full" onClick={() => setVisibleCount(value => value + 20)}>查看更多历史</Button>}
            {current.data.truncated && <p className="mt-4 text-xs leading-5 text-muted-foreground">当前最多读取最近 200 条养护及 200 条水质历史。</p>}
          </>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
