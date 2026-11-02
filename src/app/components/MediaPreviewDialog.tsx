import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, ImageIcon, Loader2, RefreshCw, ZoomIn } from "lucide-react";
import { clearResolvedMediaCache, downloadMedia, isSafeMediaPreviewSrc, mediaAuthSessionKey, useResolvedMediaUrl, type MediaDownloadResult } from "../utils/media";
import { MediaVideo } from "./MediaVideo";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export type MediaPreviewItem = {
  src: string;
  type: "image" | "video";
  title?: string;
  filename?: string;
  stockItemId?: string;
  recordId?: string;
  /** Private attachments can supply their existing authenticated download action. */
  onDownload?: () => Promise<void | MediaDownloadResult>;
  allowDownload?: boolean;
};

export type MediaPreviewOptions = { items: MediaPreviewItem[]; initialIndex?: number; title?: string };
export type MediaPreviewDialogProps = MediaPreviewOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used by MediaPreviewTrigger so Radix restores focus to the exact opener. */
  trigger?: ReactNode;
};

export function clampMediaPreviewIndex(index: number | undefined, count: number) {
  return Math.min(Math.max(0, Math.trunc(Number(index) || 0)), Math.max(0, count - 1));
}

export function mediaPreviewFilename(item: MediaPreviewItem, index = 0) {
  if (item.filename?.trim()) return item.filename.trim();
  const suffix = item.src.split(/[?#]/, 1)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const allowed = item.type === "video" ? ["mp4", "mov", "webm", "m4v", "3gp"] : ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"];
  return `${item.type === "video" ? "video" : "photo"}-${index + 1}.${suffix && allowed.includes(suffix) ? suffix : item.type === "video" ? "mp4" : "jpg"}`;
}

function PreviewMedia({ item, originalSize, onReady, onError }: {
  item: MediaPreviewItem; originalSize: boolean; onReady: () => void; onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedImage = useResolvedMediaUrl(item.type === "image" ? item.src : undefined);
  useEffect(() => {
    const video = containerRef.current?.querySelector("video");
    return () => {
      // Unmounting alone can leave a detached media element playing in some WebViews.
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    };
  }, []);
  return <div ref={containerRef} className="min-w-0">
    {item.type === "video" ? <MediaVideo src={item.src} controls playsInline preload="metadata" autoPlay={false} onLoadedMetadata={onReady} onCanPlay={onReady} onError={onError} className="mx-auto max-h-[62dvh] w-full bg-black object-contain" aria-label={item.title || "视频预览"} /> :
      <div tabIndex={0} aria-label={originalSize ? "原尺寸图片，可滚动查看" : "图片预览"} className="max-h-[62dvh] overflow-auto overscroll-contain">
        <img src={resolvedImage} alt={item.title || "照片预览"} onLoad={onReady} onError={onError} className={originalSize ? "mx-auto h-auto max-w-none" : "mx-auto block max-h-[62dvh] max-w-full object-contain"} />
      </div>}
  </div>;
}

function MediaPreviewContent({ items, initialIndex = 0, title = "照片和视频预览", onOpenChange }: MediaPreviewOptions & { onOpenChange: (open: boolean) => void }) {
  const [selected, setSelected] = useState(() => clampMediaPreviewIndex(initialIndex, items.length));
  const index = clampMediaPreviewIndex(selected, items.length);
  const item = items[index];
  const safeSource = item ? isSafeMediaPreviewSrc(item.src) : false;
  const [originalSize, setOriginalSize] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const ownerSessionRef = useRef(mediaAuthSessionKey());
  const itemKey = `${index}:${item?.type || ""}:${item?.src || ""}`;
  const itemKeyRef = useRef(itemKey);
  itemKeyRef.current = itemKey;
  useEffect(() => {
    setOriginalSize(false); setLoading(true); setLoadError(false); setDownloadError(""); setDownloadMessage("");
  }, [itemKey]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    const checkSession = () => { if (mediaAuthSessionKey() !== ownerSessionRef.current) onOpenChange(false); };
    const timer = window.setInterval(checkSession, 1000);
    window.addEventListener("storage", checkSession);
    document.addEventListener("visibilitychange", checkSession);
    checkSession();
    return () => { window.clearInterval(timer); window.removeEventListener("storage", checkSession); document.removeEventListener("visibilitychange", checkSession); };
  }, [onOpenChange]);
  const onReady = useCallback(() => { setLoading(false); setLoadError(false); }, []);
  const onError = useCallback(() => { setLoading(false); setLoadError(true); }, []);
  const retry = () => { clearResolvedMediaCache(); setLoadError(false); setLoading(true); setAttempt(value => value + 1); };

  const save = async () => {
    if (!item || !safeSource || item.allowDownload === false || pendingRef.current) return;
    if (mediaAuthSessionKey() !== ownerSessionRef.current) { onOpenChange(false); return; }
    pendingRef.current = true; setDownloading(true); setDownloadError(""); setDownloadMessage("");
    const currentItemKey = itemKey;
    try {
      const result = item.onDownload ? await item.onDownload() : await downloadMedia(item.src, mediaPreviewFilename(item, index), { mediaType: item.type, stockItemId: item.stockItemId, recordId: item.recordId });
      if (mountedRef.current && currentItemKey === itemKeyRef.current && mediaAuthSessionKey() === ownerSessionRef.current) setDownloadMessage(result?.mode === "mobile-open" ? "已打开保存页面，请按浏览器提示保存视频。" : "已发起下载，请查看浏览器下载列表。");
    } catch (error) {
      if (mountedRef.current && currentItemKey === itemKeyRef.current) setDownloadError(error instanceof Error ? error.message : "下载失败，请重试。");
    } finally { pendingRef.current = false; if (mountedRef.current) setDownloading(false); }
  };

  return <DialogContent className="min-w-0 overflow-x-hidden sm:max-w-5xl [&>button:last-child]:min-h-11 [&>button:last-child]:min-w-11"
    onClick={event => event.stopPropagation()}
    onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => { if (returnFocusRef.current?.isConnected) { event.preventDefault(); returnFocusRef.current.focus(); } }}>
    <DialogHeader>
      <DialogTitle className="break-words pr-10">{title}</DialogTitle>
      <DialogDescription className="break-words pr-10">{item ? `${item.title || (item.type === "video" ? "视频" : "照片")}${items.length > 1 ? ` · ${index + 1}/${items.length}` : ""}。在本页查看；需要保存时再点击下载。` : "没有可预览的照片或视频。"}</DialogDescription>
    </DialogHeader>
    {item && <>
      {safeSource ? <div className="relative min-h-40 min-w-0 overflow-hidden rounded-md border bg-muted/20">
        {loading && !loadError && <div role="status" className="pointer-events-none absolute inset-0 flex min-h-40 items-center justify-center gap-2 bg-background/95 text-sm"><Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{item.type === "video" ? "正在加载视频信息…" : "正在加载照片…"}</div>}
        <PreviewMedia key={`${itemKey}:${attempt}`} item={item} originalSize={originalSize} onReady={onReady} onError={onError} />
        {loadError && <div role="alert" className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-5 text-center text-sm"><ImageIcon className="size-7 text-muted-foreground" aria-hidden="true" /><p>{item.type === "video" ? "视频暂时无法播放。请检查网络，或确认浏览器支持该视频格式。" : "照片暂时无法加载，请检查网络后重试。"}</p><Button type="button" variant="outline" className="min-h-11" onClick={retry}><RefreshCw className="size-4" />重新加载</Button></div>}
      </div> : <p role="alert" className="rounded-md border px-4 py-5 text-sm text-destructive">此文件链接不支持安全预览，请联系管理员核对。</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {items.length > 1 && <><Button type="button" variant="outline" className="min-h-11" disabled={index <= 0} onClick={() => setSelected(index - 1)} aria-label="上一项"><ChevronLeft className="size-4" />上一项</Button><Button type="button" variant="outline" className="min-h-11" disabled={index >= items.length - 1} onClick={() => setSelected(index + 1)} aria-label="下一项">下一项<ChevronRight className="size-4" /></Button></>}
          {item.type === "image" && safeSource && <Button type="button" variant="outline" className="min-h-11" disabled={loading || loadError} onClick={() => setOriginalSize(value => !value)}><ZoomIn className="size-4" />{originalSize ? "适应窗口" : "原尺寸查看"}</Button>}
        </div>
        <div className="flex flex-wrap gap-2">
          {safeSource && item.allowDownload !== false && <Button type="button" variant="outline" className="min-h-11" disabled={downloading} onClick={() => void save()}>{downloading ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Download className="size-4" />}{downloading ? "正在准备下载…" : item.type === "video" ? "下载视频" : "下载照片"}</Button>}
          <DialogClose asChild><Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>关闭预览</Button></DialogClose>
        </div>
      </div>
      {originalSize && item.type === "image" && <p className="text-xs text-muted-foreground">已按原尺寸显示，可滑动图片区域查看细节。</p>}
      {downloadError && <p role="alert" className="break-words text-sm text-destructive">{downloadError}</p>}
      {downloadMessage && <p role="status" className="text-sm">{downloadMessage}</p>}
    </>}
  </DialogContent>;
}

export function MediaPreviewDialog({ open, onOpenChange, trigger, ...options }: MediaPreviewDialogProps) {
  useEffect(() => {
    if (open) document.querySelectorAll("video").forEach(video => video.pause());
  }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
    {open && <MediaPreviewContent {...options} onOpenChange={onOpenChange} />}
  </Dialog>;
}

export function MediaPreviewTrigger({ src, mediaType = "image", title, filename, stockItemId, recordId, onDownload, allowDownload, children, className = "", ariaLabel, disabled = false }: {
  src: string; mediaType?: "image" | "video"; title?: string; filename?: string; stockItemId?: string; recordId?: string;
  onDownload?: MediaPreviewItem["onDownload"]; allowDownload?: boolean; children: ReactNode; className?: string; ariaLabel?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <MediaPreviewDialog open={open} onOpenChange={setOpen} items={[{ src, type: mediaType, title, filename, stockItemId, recordId, onDownload, allowDownload }]} title={mediaType === "video" ? "视频预览" : "照片预览"}
    trigger={<button type="button" disabled={disabled || !src} aria-label={ariaLabel || `预览${title || (mediaType === "video" ? "视频" : "照片")}`} className={`min-h-11 min-w-11 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${className}`} onClick={event => event.stopPropagation()}>{children}</button>} />;
}

export function useMediaPreview() {
  const [options, setOptions] = useState<MediaPreviewOptions | null>(null);
  const openPreview = useCallback((next: MediaPreviewOptions) => setOptions(next), []);
  const closePreview = useCallback(() => setOptions(null), []);
  return { openPreview, closePreview, previewDialog: <MediaPreviewDialog open={options !== null} onOpenChange={open => { if (!open) closePreview(); }} items={options?.items || []} initialIndex={options?.initialIndex} title={options?.title} /> };
}
