export type CapturePoint = { x: number; y: number };
export type CaptureRect = CapturePoint & { width: number; height: number };
export type CapturedScreen = { blob: Blob; width: number; height: number };

export function normalizeCaptureRect(start: CapturePoint, end: CapturePoint, bounds: { width: number; height: number }): CaptureRect {
  if (![start.x, start.y, end.x, end.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("截图选区无效，请重新框选。");
  }
  const width = Math.floor(bounds.width), height = Math.floor(bounds.height);
  const clampX = (x: number) => Math.min(width, Math.max(0, x));
  const clampY = (y: number) => Math.min(height, Math.max(0, y));
  const left = Math.floor(clampX(Math.min(start.x, end.x))), top = Math.floor(clampY(Math.min(start.y, end.y)));
  const right = start.x === end.x ? left : Math.ceil(clampX(Math.max(start.x, end.x)));
  const bottom = start.y === end.y ? top : Math.ceil(clampY(Math.max(start.y, end.y)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function stopCaptureTracks(stream?: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* Stop other tracks even if one has already failed. */ }
  }
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob?.size ? resolve(blob) : reject(new Error("截图生成失败，请重试。")), "image/png"); }
    catch { reject(new Error("截图生成失败，请重新选择窗口。")); }
  });
}

type FrameGrabber = { grabFrame(): Promise<ImageBitmap> };
type CaptureGlobals = typeof globalThis & { ImageCapture?: new (track: MediaStreamTrack) => FrameGrabber };

/** Capture one frame only. Every path stops the stream, including encoding errors. */
export async function captureDisplayFrame(stream: MediaStream, timeoutMs = 12000): Promise<CapturedScreen> {
  let video: HTMLVideoElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let bitmap: ImageBitmap | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanups: Array<() => void> = [];
  let finished = false;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("截图等待超时，请重新选择窗口，或使用粘贴截图。")), Math.max(1, timeoutMs));
  });
  const withinDeadline = <T,>(promise: Promise<T>) => Promise.race([promise, deadline]);
  try {
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("屏幕共享已结束，请重新截图。");
    const ended = new Promise<never>((_, reject) => {
      const listener = () => reject(new Error("屏幕共享已结束，请重新截图。"));
      track.addEventListener("ended", listener);
      cleanups.push(() => track.removeEventListener("ended", listener));
    });
    // A stopped, background video element can delay frame events in some browsers.
    const Grabber = (globalThis as CaptureGlobals).ImageCapture;
    if (Grabber) {
      try {
        const grabbed = new Grabber(track).grabFrame().then(frame => {
          if (finished) { frame.close(); throw new Error("截图已取消。"); }
          return frame;
        });
        bitmap = await withinDeadline(Promise.race([grabbed, ended]));
      } catch (cause) {
        if (track.readyState === "ended" || String((cause as Error)?.message).includes("超时")) throw cause;
      }
    }
    if (!bitmap) {
      video = document.createElement("video");
      video.muted = true; video.playsInline = true;
      const videoElement = video;
      const ready = new Promise<void>((resolve, reject) => {
        const check = () => { if (videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) resolve(); };
        const fail = () => reject(new Error("无法读取选中的屏幕，请重新选择窗口。"));
        for (const name of ["loadeddata", "canplay"]) {
          videoElement.addEventListener(name, check);
          cleanups.push(() => videoElement.removeEventListener(name, check));
        }
        videoElement.addEventListener("error", fail);
        cleanups.push(() => videoElement.removeEventListener("error", fail));
        videoElement.srcObject = stream;
        try { Promise.resolve(videoElement.play()).then(check, fail); } catch { fail(); }
        check();
      });
      await withinDeadline(Promise.race([ready, ended]));
    }
    const width = bitmap?.width ?? video!.videoWidth, height = bitmap?.height ?? video!.videoHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("截图尺寸无效，请重新截图。");
    canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理截图，请使用粘贴截图。");
    context.drawImage(bitmap || video!, 0, 0, width, height);
    // Sharing ends as soon as pixels are copied; PNG encoding never keeps it live.
    stopCaptureTracks(stream);
    const blob = await withinDeadline(pngBlob(canvas));
    return { blob, width, height };
  } finally {
    finished = true;
    if (timeout) clearTimeout(timeout);
    stopCaptureTracks(stream);
    for (const cleanup of cleanups) cleanup();
    bitmap?.close();
    if (video) { video.pause(); video.srcObject = null; }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** Cropping happens entirely in memory. This function does not perform uploads. */
export async function cropCapturedScreen(capture: CapturedScreen, rect?: CaptureRect): Promise<File> {
  const selection = rect ? normalizeCaptureRect({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, capture)
    : normalizeCaptureRect({ x: 0, y: 0 }, { x: capture.width, y: capture.height }, capture);
  if (selection.width <= 0 || selection.height <= 0) throw new Error("选区太小，请重新框选或选择整张图片。");
  let bitmap: ImageBitmap | undefined, image: HTMLImageElement | undefined, objectUrl = "";
  let canvas: HTMLCanvasElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("截图处理超时，请重新截图。")), 12000); });
  const withinDeadline = <T,>(promise: Promise<T>) => Promise.race([promise, deadline]);
  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await withinDeadline(createImageBitmap(capture.blob).then(value => {
        if (finished) { value.close(); throw new Error("截图已取消。"); }
        return value;
      }));
    } else {
      objectUrl = URL.createObjectURL(capture.blob);
      image = new Image();
      const element = image;
      await withinDeadline(new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error("无法打开截图，请重新截图。"));
        element.src = objectUrl;
      }));
    }
    canvas = document.createElement("canvas"); canvas.width = selection.width; canvas.height = selection.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法裁剪截图，请使用粘贴截图。");
    context.drawImage(bitmap || image!, selection.x, selection.y, selection.width, selection.height, 0, 0, selection.width, selection.height);
    const blob = await withinDeadline(pngBlob(canvas));
    return new File([blob], `截图-${Date.now()}.png`, { type: "image/png" });
  } finally {
    finished = true;
    if (timeout) clearTimeout(timeout);
    bitmap?.close();
    if (image) { image.onload = null; image.onerror = null; image.src = ""; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
