import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Crop, Image, Loader2, ScanLine } from "lucide-react";
import { captureDisplayFrame, cropCapturedScreen, normalizeCaptureRect, stopCaptureTracks, type CapturedScreen, type CapturePoint, type CaptureRect } from "../utils/screenCapture";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type CaptureFocusController = { setFocusBehavior(behavior: "focus-captured-surface"): void };
type CaptureWindow = Window & { CaptureController?: new () => CaptureFocusController };
type Props = {
  disabled?: boolean;
  onCaptureStart?: () => boolean;
  onCapture: (file: File) => Promise<boolean | void> | boolean | void;
};

const captureError = (cause: unknown) => {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") return "未获准截图。可重试并允许屏幕共享，或使用粘贴截图。";
  if (cause instanceof DOMException && cause.name === "NotReadableError") return "系统无法读取该窗口，请检查屏幕录制权限，或使用粘贴截图。";
  return cause instanceof Error ? cause.message : "截图失败，请重试或使用粘贴截图。";
};

export function ScreenshotCaptureButton({ disabled = false, onCaptureStart, onCapture }: Props) {
  const [phase, setPhase] = useState<"idle" | "selecting" | "countdown" | "capturing">("idle");
  const [seconds, setSeconds] = useState(5);
  const [capture, setCapture] = useState<CapturedScreen | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [selection, setSelection] = useState<CaptureRect | null>(null);
  const [cropping, setCropping] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownCancel = useRef<(() => void) | null>(null);
  const acquisitionLock = useRef(false), saveLock = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const startPoint = useRef<{ point: CapturePoint; pointerId: number } | null>(null);
  const selectionRef = useRef<CaptureRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ disabled, onCaptureStart, onCapture }); callbacks.current = { disabled, onCaptureStart, onCapture };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; countdownCancel.current?.(); stopCaptureTracks(streamRef.current); streamRef.current = null; };
  }, []);
  useEffect(() => {
    if (!capture) { setImageUrl(""); return; }
    const url = URL.createObjectURL(capture.blob); setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [capture]);

  const cancelAcquisition = () => {
    generation.current += 1; countdownCancel.current?.(); countdownCancel.current = null;
    stopCaptureTracks(streamRef.current); streamRef.current = null; acquisitionLock.current = false;
    if (mounted.current) setPhase("idle");
  };
  const closeCapture = () => {
    if (saveLock.current) return;
    cancelAcquisition(); setCapture(null); setSelection(null); selectionRef.current = null; setCropping(false); setPreview(false); setError(""); startPoint.current = null;
  };

  const begin = async () => {
    if (callbacks.current.disabled || acquisitionLock.current || saveLock.current || capture) return;
    setError("");
    if (typeof window === "undefined" || !window.isSecureContext) { setError("当前网址不是安全连接，浏览器无法直接截图。请使用粘贴截图。"); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setError("当前浏览器不支持直接截图。请使用粘贴截图，或换电脑浏览器重试。"); return; }
    try {
      if (callbacks.current.onCaptureStart?.() === false) { setError("当前订单或登录状态已变化，请重新打开后截图。"); return; }
    } catch { setError("当前订单暂时无法截图，请重新打开后重试。"); return; }
    acquisitionLock.current = true;
    const request = ++generation.current;
    const current = () => mounted.current && generation.current === request;
    setPhase("selecting");
    let stream: MediaStream | null = null;
    try {
      const Controller = (window as CaptureWindow).CaptureController;
      let controller: CaptureFocusController | undefined;
      if (Controller) { try { controller = new Controller(); } catch { /* Optional browser enhancement. */ } }
      const options: DisplayMediaStreamOptions & { selfBrowserSurface: "exclude"; controller?: CaptureFocusController } = {
        video: { displaySurface: "window" } as MediaTrackConstraints, audio: false, selfBrowserSurface: "exclude", ...(controller ? { controller } : {}),
      };
      // No awaited work precedes this call: retain the click's user activation.
      stream = await navigator.mediaDevices.getDisplayMedia(options);
      if (!current()) { stopCaptureTracks(stream); return; }
      try { controller?.setFocusBehavior("focus-captured-surface"); } catch { /* Unsupported surface or browser; capture still works. */ }
      streamRef.current = stream;
      const selectedStream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") throw new Error("屏幕共享已结束，请重新截图。");
      setSeconds(5); setPhase("countdown");
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        let settled = false;
        const finish = (failure?: Error) => {
          if (settled) return; settled = true; clearInterval(timer);
          track.removeEventListener("ended", ended);
          countdownCancel.current = null;
          if (failure) reject(failure); else resolve();
        };
        const ended = () => finish(new Error("屏幕共享已结束，请重新截图。"));
        const timer = setInterval(() => {
          if (!current()) { finish(new Error("截图已取消。")); return; }
          const remaining = Math.max(0, deadline - Date.now()); setSeconds(Math.ceil(remaining / 1000));
          if (!remaining) finish();
        }, 200);
        track.addEventListener("ended", ended);
        countdownCancel.current = () => finish(new Error("截图已取消。"));
      });
      if (!current()) return;
      setPhase("capturing");
      const image = await captureDisplayFrame(selectedStream);
      if (!current()) return;
      setSelection(null); selectionRef.current = null; setCropping(false); setPreview(false); setCapture(image);
    } catch (cause) {
      if (current()) setError(captureError(cause));
    } finally {
      stopCaptureTracks(stream);
      if (streamRef.current === stream) streamRef.current = null;
      if (current()) { acquisitionLock.current = false; setPhase("idle"); }
    }
  };

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>): CapturePoint | null => {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box || !capture || !box.width || !box.height) return null;
    return { x: (event.clientX - box.left) / box.width * capture.width, y: (event.clientY - box.top) / box.height * capture.height };
  };
  const updateSelection = (event: PointerEvent<HTMLDivElement>) => {
    const start = startPoint.current, end = pointFromEvent(event);
    if (!start || start.pointerId !== event.pointerId || !end || !capture) return;
    const rect = normalizeCaptureRect(start.point, end, capture);
    selectionRef.current = rect; setSelection(rect);
  };
  const confirmCapture = async () => {
    if (!capture || saveLock.current || callbacks.current.disabled) return;
    if (selection && (!selection.width || !selection.height)) { setError("选区太小，请重新框选或选择整张图片。"); return; }
    saveLock.current = true; setSaving(true); setError("");
    const request = generation.current;
    try {
      const file = await cropCapturedScreen(capture, selection || undefined);
      if (!mounted.current || request !== generation.current || callbacks.current.disabled) return;
      if (file.size > 10 * 1024 * 1024) { setError("图片超过10MB，请缩小框选范围后重试。"); return; }
      const result = await callbacks.current.onCapture(file);
      if (!mounted.current || request !== generation.current) return;
      if (result === false) { setError("上传未完成，截图已保留，请重试。"); return; }
      saveLock.current = false; closeCapture();
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(cause instanceof Error ? cause.message : "上传未完成，截图已保留，请重试。");
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const validSelection = Boolean(selection && selection.width > 0 && selection.height > 0);
  return <>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button ref={triggerRef} type="button" variant="outline" className="min-h-[44px]" disabled={disabled || phase !== "idle" || Boolean(capture)} onClick={() => void begin()}>
        {phase !== "idle" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanLine className="size-4" aria-hidden="true" />}{phase === "selecting" ? "选择截图窗口…" : phase === "countdown" ? `${seconds} 秒后截图` : phase === "capturing" ? "正在截图…" : "截图上传"}
      </Button>
      {phase !== "idle" && <Button type="button" variant="ghost" className="min-h-[44px]" onClick={cancelAcquisition}>取消截图</Button>}
    </div>
    {phase !== "idle" && <p role="status" className="basis-full text-xs leading-5 text-muted-foreground">{phase === "selecting" ? "请选择付款记录或微信窗口。选好后有 5 秒时间切换画面。" : phase === "countdown" ? `请切到付款记录，可手动最小化浏览器；约 ${seconds} 秒后截图，回来确认上传。` : "正在获取静态截图，屏幕共享随后立即停止。"}</p>}
    {!capture && error && <p role="alert" className="basis-full text-xs leading-5 text-destructive">{error}</p>}
    <Dialog open={Boolean(capture)} onOpenChange={open => { if (!open) closeCapture(); }}>
      <DialogContent onPaste={event => event.stopPropagation()} onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
        onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}
        className={`flex max-h-[92dvh] w-[calc(100%-1.5rem)] min-w-0 flex-col gap-3 overflow-hidden sm:max-w-4xl [&>button:last-child]:min-h-[44px] [&>button:last-child]:min-w-[44px] ${saving ? "[&>button:last-child]:pointer-events-none [&>button:last-child]:opacity-40" : ""}`}>
        <DialogHeader>
          <DialogTitle className="pr-8">{preview ? "确认截图" : "选择截图范围"}</DialogTitle>
          <DialogDescription>屏幕共享已停止。图片仅在本机处理，确认后才上传所选范围。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={!selection && !cropping ? "secondary" : "outline"} className="min-h-[44px]" disabled={saving} aria-pressed={!selection && !cropping} onClick={() => { setSelection(null); selectionRef.current = null; setCropping(false); setPreview(false); setError(""); }}><Image className="size-4" aria-hidden="true" />使用整张</Button>
          <Button type="button" variant={cropping ? "secondary" : "outline"} className="min-h-[44px]" disabled={saving} aria-pressed={cropping} onClick={() => { setCropping(true); setPreview(false); setError(""); }}><Crop className="size-4" aria-hidden="true" />框选范围</Button>
          <span role="status" className="text-xs text-muted-foreground">{selection ? `${selection.width} × ${selection.height} 像素` : capture ? `整张 ${capture.width} × ${capture.height} 像素` : ""}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-2" tabIndex={0} aria-label={preview ? "截图预览，可滚动查看" : "截图框选区域"}>
          {capture && imageUrl && (preview && validSelection ? <div className="relative mx-auto w-full overflow-hidden" style={{ aspectRatio: `${selection!.width} / ${selection!.height}` }}>
            <img src={imageUrl} alt="将上传的截图范围" draggable={false} className="absolute max-w-none select-none" style={{ width: `${capture.width / selection!.width * 100}%`, height: `${capture.height / selection!.height * 100}%`, left: `${-selection!.x / selection!.width * 100}%`, top: `${-selection!.y / selection!.height * 100}%` }} />
          </div> : <div ref={surfaceRef} className={`relative mx-auto w-full select-none overflow-hidden ${cropping ? "cursor-crosshair touch-none" : ""}`} style={{ aspectRatio: `${capture.width} / ${capture.height}` }}
            onPointerDown={event => {
              if (!cropping || saving || event.button !== 0 || !event.isPrimary) return;
              const point = pointFromEvent(event); if (!point) return;
              event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
              startPoint.current = { point, pointerId: event.pointerId }; setError(""); setSelection(null); selectionRef.current = null;
            }} onPointerMove={event => { if (startPoint.current) { event.preventDefault(); updateSelection(event); } }}
            onPointerUp={event => {
              if (startPoint.current?.pointerId !== event.pointerId) return;
              updateSelection(event); startPoint.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              const rect = selectionRef.current;
              if (!rect?.width || !rect.height) { setSelection(null); selectionRef.current = null; setError("请拖动框选范围，也可直接选择整张图片。"); }
            }} onPointerCancel={() => { startPoint.current = null; setSelection(null); selectionRef.current = null; }}>
            <img src={imageUrl} alt="本地截图，选择框选范围后可拖动裁剪" draggable={false} className="block h-auto w-full select-none" />
            {validSelection && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-white outline outline-1 outline-black/70" style={{ left: `${selection!.x / capture.width * 100}%`, top: `${selection!.y / capture.height * 100}%`, width: `${selection!.width / capture.width * 100}%`, height: `${selection!.height / capture.height * 100}%`, boxShadow: "0 0 0 9999px rgb(0 0 0 / 45%)" }} />}
          </div>)}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{cropping && !preview ? "用鼠标或手指拖动框选。键盘用户可选择“使用整张”，再确认上传。" : "请检查付款金额、时间和账户是否清楚，并避免包含无关信息。"}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-[44px]" disabled={saving} onClick={closeCapture}>取消</Button>
          {!preview && <Button type="button" variant="outline" className="min-h-[44px]" disabled={saving || (cropping && !validSelection)} onClick={() => setPreview(true)}>预览选区</Button>}
          <Button type="button" className="min-h-[44px]" disabled={disabled || saving || (cropping && !validSelection)} onClick={() => void confirmCapture()}>{saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? "上传中…" : "确认并上传"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
