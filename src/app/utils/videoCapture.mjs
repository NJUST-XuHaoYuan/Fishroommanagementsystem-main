export const MAX_CAPTURE_SECONDS = 120;
export const MAX_CAPTURE_BYTES = 280 * 1024 * 1024;

const cameraSizes = [[3840, 2160], [1920, 1080], [1280, 720]];
export function stopMediaStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop();
}

function cancelled() { return Object.assign(new Error("拍摄已取消"), { name: "AbortError" }); }

/** Exact requests prevent a nominal 4K request silently becoming a 360p recording. */
export async function openHighResolutionCamera(mediaDevices, isActive = () => true, includeAudio = true, allowOtherCamera = false) {
  if (!mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持网页拍摄，请用 Safari 打开，或从相册选择视频。");
  const supports = mediaDevices.getSupportedConstraints?.() || {};
  let lastError;
  for (const [width, height] of [...cameraSizes, [0, 0]]) {
    if (!isActive()) throw cancelled();
    const video = {
      ...(supports.facingMode && !allowOtherCamera ? { facingMode: { exact: "environment" } } : {}),
      frameRate: { ideal: 30, max: 30 },
      ...(width ? { width: { exact: width }, height: { exact: height } } : { width: { ideal: 1920 }, height: { ideal: 1080 } }),
      ...(supports.resizeMode ? { resizeMode: "none" } : {}),
    };
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ video, audio: includeAudio });
      if (!isActive()) { stopMediaStream(stream); throw cancelled(); }
      const track = stream.getVideoTracks()[0];
      if (!track) { stopMediaStream(stream); throw new Error("未获取到摄像头画面，请重试。"); }
      const settings = track.getSettings?.() || {};
      const capabilities = track.getCapabilities?.() || {};
      if (!allowOtherCamera && settings.facingMode === "user") throw Object.assign(new Error("当前浏览器未提供后置摄像头。可选择使用当前摄像头，或从相册选择。"), { code: "REAR_CAMERA_UNAVAILABLE" });
      return { stream, track, settings, capabilities };
    } catch (error) {
      if (stream) stopMediaStream(stream);
      lastError = error;
      if (!["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError", "DevicesNotFoundError"].includes(error?.name)) throw error;
    }
  }
  if (supports.facingMode && !allowOtherCamera) throw Object.assign(new Error("当前浏览器未提供后置摄像头。可选择使用当前摄像头，或从相册选择。"), { code: "REAR_CAMERA_UNAVAILABLE" });
  throw lastError || new Error("无法打开后置摄像头。");
}

/** Proactively invalidate an open camera even when a request or upload never returns. */
export function watchCaptureSession(initial, readSession, onInvalid, {
  eventTarget = globalThis.window, visibilityTarget = globalThis.document,
  setTimer = setInterval, clearTimer = clearInterval,
} = {}) {
  let invalid = false;
  const check = () => {
    if (invalid) return;
    let current;
    try { current = readSession(); } catch { current = undefined; }
    if (current !== initial) { invalid = true; onInvalid(); }
  };
  const timer = setTimer(check, 1000);
  eventTarget?.addEventListener("storage", check);
  visibilityTarget?.addEventListener("visibilitychange", check);
  check();
  return () => {
    invalid = true; clearTimer(timer);
    eventTarget?.removeEventListener("storage", check);
    visibilityTarget?.removeEventListener("visibilitychange", check);
  };
}

/** Own the actual recording before optional metadata work; a probe must never discard it. */
export function retainRecordedVideo(blob, {
  FileCtor = globalThis.File, createUrl = value => URL.createObjectURL(value), now = Date.now,
} = {}) {
  const mime = blob.type.split(";")[0];
  const stamp = now();
  const file = new FileCtor([blob], `maintenance-${stamp}.${mime.includes("webm") ? "webm" : "mp4"}`, { type: mime, lastModified: stamp });
  return { file, url: createUrl(blob) };
}

export async function inspectRetainedRecording(recording, inspect) {
  try { return { ...recording, quality: await inspect(recording.url), inspectionFailed: false }; }
  catch { return { ...recording, quality: { ...videoQuality(0, 0), label: "画质未检测" }, inspectionFailed: true }; }
}

export function videoQuality(width, height) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const long = Math.max(w, h), short = Math.min(w, h);
  return { width: w, height: h, label: !w || !h ? "正在检测画质" : short >= 2160 && long >= 3840 ? "4K" : short >= 1080 && long >= 1920 ? "1080P" : short >= 720 && long >= 1280 ? "720P" : "较低画质", low: w > 0 && h > 0 && short < 720, pixels: w * h };
}

export function recorderOptions(Recorder, dimensions) {
  if (!Recorder) throw new Error("当前浏览器不支持视频录制，请用 Safari 打开，或从相册选择视频。");
  const types = ["video/mp4;codecs=avc1.640033", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = types.find(type => Recorder.isTypeSupported?.(type));
  if (!mimeType) throw new Error("当前浏览器没有可用的录像格式，请用 Safari 打开，或从相册选择视频。");
  const pixels = videoQuality(dimensions.width, dimensions.height).pixels;
  return { mimeType, videoBitsPerSecond: pixels >= 3840 * 2160 ? 20_000_000 : pixels >= 1920 * 1080 ? 8_000_000 : 5_000_000 };
}

/** Bounded recorder: late events after cancel can never attach a file to another draft. */
export function createBoundedRecording(stream, dimensions, {
  Recorder = globalThis.MediaRecorder, onComplete, onError, onLimit = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const options = recorderOptions(Recorder, dimensions);
  const recorder = new Recorder(stream, options);
  const chunks = [];
  let bytes = 0, disposed = false, stopped = false, timer;
  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const stop = (reason) => {
    if (disposed || stopped) return;
    stopped = true; clear();
    if (reason) onLimit(reason);
    try { if (recorder.state !== "inactive") recorder.stop(); }
    catch (error) { fail(error); }
  };
  const fail = error => {
    if (disposed) return;
    disposed = true; clear(); stopMediaStream(stream);
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already ended */ }
    chunks.length = 0; onError?.(error);
  };
  recorder.ondataavailable = event => {
    if (disposed || !event.data?.size) return;
    chunks.push(event.data); bytes += event.data.size;
    if (bytes >= MAX_CAPTURE_BYTES) stop("已达到本次拍摄大小上限，录制已停止。");
  };
  recorder.onerror = event => fail(event.error || new Error("录像中断，请重拍。"));
  recorder.onstop = () => {
    if (disposed) return;
    disposed = true; clear(); stopMediaStream(stream);
    const blob = new Blob(chunks, { type: recorder.mimeType || options.mimeType });
    chunks.length = 0;
    if (!blob.size) { onError?.(new Error("没有录到视频，请重拍。")); return; }
    if (blob.size > 300 * 1024 * 1024) { onError?.(new Error("本次视频超过 300MB，请拍摄较短的视频。")); return; }
    onComplete?.(blob);
  };
  try {
    recorder.start(1000);
    timer = setTimer(() => stop("已拍摄 2 分钟，录制已停止。"), MAX_CAPTURE_SECONDS * 1000);
  } catch (error) { fail(error); }
  return { stop, cancel() {
    if (disposed) return;
    disposed = true; clear(); chunks.length = 0;
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already ended */ }
    stopMediaStream(stream);
  }, get state() { return recorder.state; } };
}

export function cameraErrorMessage(error) {
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name)) return "相机权限未开启。请在浏览器或微信的权限设置中允许使用相机，再重试。";
  if (["NotReadableError", "TrackStartError"].includes(error?.name)) return "相机正被其他应用占用，请关闭其他拍摄页面后重试。";
  if (error?.name === "AbortError") return "相机启动已取消，请重试。";
  return error instanceof Error ? error.message : "无法打开相机，请重试或从相册选择。";
}

/** Read actual first-frame dimensions, not just requested constraints or stale iOS settings. */
export async function waitForVideoDimensions(video, isActive = () => true, timeoutMs = 12000, minimumReadyState = 2) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isActive()) throw cancelled();
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= minimumReadyState) {
      return videoQuality(video.videoWidth, video.videoHeight);
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error("未能读取视频画面，请重试。");
}
