import { useEffect, useRef, useState } from "react";
import { Camera, Check, Images, Loader2, MicOff, RotateCcw, Square, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { mediaAuthSessionKey } from "../utils/media";
import { cameraErrorMessage, createBoundedRecording, inspectRetainedRecording, MAX_CAPTURE_SECONDS, openHighResolutionCamera, recorderOptions, retainRecordedVideo, stopMediaStream, videoQuality, waitForVideoDimensions, watchCaptureSession } from "../utils/videoCapture.mjs";
import "./mobile-video-capture.css";

type Props = { onClose: () => void; onChooseAlbum: () => void; onUse: (file: File) => Promise<boolean>; uploadStatus?: string };
type Phase = "opening" | "ready" | "recording" | "processing" | "review" | "uploading" | "error";
type Quality = ReturnType<typeof videoQuality>;

export function MobileVideoCaptureDialog({ onClose, onChooseAlbum, onUse, uploadStatus }: Props) {
  const [phase, setPhase] = useState<Phase>("opening");
  const [attempt, setAttempt] = useState(0);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [hasAudio, setHasAudio] = useState(true);
  const [allowOtherCamera, setAllowOtherCamera] = useState(false);
  const [canTryOtherCamera, setCanTryOtherCamera] = useState(false);
  const [cameraFacing, setCameraFacing] = useState("");
  const [inspectionFailed, setInspectionFailed] = useState(false);
  const [quality, setQuality] = useState<Quality>(videoQuality(0, 0));
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [canTrySilent, setCanTrySilent] = useState(false);
  const [notice, setNotice] = useState("");
  const [recorded, setRecorded] = useState<{ file: File; url: string } | null>(null);
  const [discard, setDiscard] = useState(false);
  const liveVideo = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<ReturnType<typeof createBoundedRecording> | null>(null);
  const metadataVideo = useRef<HTMLVideoElement | null>(null);
  const recordedUrl = useRef("");
  const epoch = useRef(0);
  const alive = useRef(true);
  const phaseRef = useRef<Phase>(phase);
  const session = useRef(mediaAuthSessionKey());
  const latest = useRef({ onClose, onUse });
  latest.current = { onClose, onUse }; phaseRef.current = phase;
  const current = (ticket: number) => alive.current && epoch.current === ticket && mediaAuthSessionKey() === session.current;

  const releaseRecorded = () => {
    const probe = metadataVideo.current;
    if (probe) { probe.pause(); probe.removeAttribute("src"); probe.load(); metadataVideo.current = null; }
    if (recordedUrl.current) URL.revokeObjectURL(recordedUrl.current);
    recordedUrl.current = "";
  };
  const releaseCamera = () => {
    recorderRef.current?.cancel(); recorderRef.current = null;
    stopMediaStream(streamRef.current); streamRef.current = null;
    if (liveVideo.current) liveVideo.current.srcObject = null;
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; epoch.current += 1; releaseCamera(); releaseRecorded(); };
  }, []);

  useEffect(() => watchCaptureSession(session.current, mediaAuthSessionKey, () => {
    epoch.current += 1; releaseCamera(); releaseRecorded();
    // Bypass the normal uploading/unsaved-confirmation guard: a changed login
    // must immediately close the camera and discard this account's local data.
    latest.current.onClose();
  }), []);

  useEffect(() => {
    const ticket = ++epoch.current;
    setPhase("opening"); setError(""); setNotice(""); setCanTrySilent(false); setCanTryOtherCamera(false); setInspectionFailed(false); setCameraFacing(""); setSeconds(0);
    setQuality(videoQuality(0, 0)); setRecorded(null); releaseRecorded(); releaseCamera();
    void (async () => {
      try {
        if (!window.isSecureContext) throw new Error("高清拍摄需要安全连接，请从 HTTPS 测试网址重新打开。");
        // Fail before permission prompts when recording itself is unavailable.
        recorderOptions(window.MediaRecorder, { width: 1920, height: 1080 });
        const camera = await openHighResolutionCamera(navigator.mediaDevices, () => current(ticket), includeAudio, allowOtherCamera);
        if (!current(ticket)) { stopMediaStream(camera.stream); return; }
        streamRef.current = camera.stream;
        setHasAudio(camera.stream.getAudioTracks().length > 0);
        setCameraFacing(camera.settings.facingMode === "environment" ? "后置摄像头" : camera.settings.facingMode === "user" ? "前置摄像头" : "摄像头方向未提供");
        const video = liveVideo.current;
        if (!video) { stopMediaStream(camera.stream); return; }
        video.srcObject = camera.stream;
        await video.play();
        const actual = await waitForVideoDimensions(video, () => current(ticket));
        if (!current(ticket)) return;
        setQuality(actual); setPhase("ready");
        camera.track.addEventListener("ended", () => {
          if (!current(ticket)) return;
          if (phaseRef.current === "recording") recorderRef.current?.stop("相机已中断，已结束本次录制。");
          else if (phaseRef.current === "ready") { releaseCamera(); setError("相机已中断，请重新打开相机。"); setPhase("error"); }
        }, { once: true });
      } catch (cause) {
        if (!current(ticket)) return;
        releaseCamera(); setError(cameraErrorMessage(cause)); setPhase("error");
        setCanTrySilent(includeAudio && ["NotAllowedError", "PermissionDeniedError", "NotFoundError"].includes((cause as Error)?.name));
        setCanTryOtherCamera((cause as Error & { code?: string })?.code === "REAR_CAMERA_UNAVAILABLE");
      }
    })();
    return () => { epoch.current += 1; releaseCamera(); };
  }, [attempt, includeAudio, allowOtherCamera]);

  useEffect(() => {
    if (phase !== "recording") return;
    const start = Date.now();
    const interval = window.setInterval(() => setSeconds(Math.min(MAX_CAPTURE_SECONDS, Math.floor((Date.now() - start) / 1000))), 250);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (phaseRef.current === "recording") recorderRef.current?.stop("离开拍摄页面，录制已停止。请检查后使用视频。");
      else if (phaseRef.current === "ready" || phaseRef.current === "opening") {
        epoch.current += 1; releaseCamera(); setError("已暂停相机，点击重新打开即可继续。"); setPhase("error");
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  const inspectRecording = async (recording: { file: File; url: string }, ticket: number) => {
    if (!current(ticket)) return;
    setPhase("processing"); setError(""); setInspectionFailed(false);
    const result = await inspectRetainedRecording(recording, async (url: string) => {
      const probe = document.createElement("video"); metadataVideo.current = probe;
      probe.muted = true; probe.playsInline = true; probe.preload = "auto"; probe.src = url;
      try {
        // File metadata carries encoded dimensions. iOS may suspend off-screen
        // media in the background; inspection failure must not discard the file.
        probe.load();
        return await waitForVideoDimensions(probe, () => current(ticket), 12000, 1);
      } finally {
        probe.pause(); probe.removeAttribute("src"); probe.load();
        if (metadataVideo.current === probe) metadataVideo.current = null;
      }
    });
    if (!current(ticket)) return;
    setQuality(result.quality); setInspectionFailed(result.inspectionFailed);
    if (result.inspectionFailed) setError("画质暂未检测，视频已保留。可先预览后使用，也可以重新检测。");
    setPhase("review");
  };

  const startRecording = () => {
    if (phaseRef.current !== "ready" || !streamRef.current) return;
    const ticket = epoch.current;
    if (!current(ticket)) { latest.current.onClose(); return; }
    setNotice(""); setError("");
    const actual = videoQuality(liveVideo.current?.videoWidth, liveVideo.current?.videoHeight);
    if (!actual.width || !actual.height) { setError("相机画面尚未就绪，请稍候重试。"); return; }
    setQuality(actual);
    try {
      const recorder = createBoundedRecording(streamRef.current, actual, {
        onLimit: (message: string) => { if (current(ticket)) setNotice(message); },
        onError: (cause: Error) => { if (current(ticket)) { releaseCamera(); setError(cameraErrorMessage(cause)); setPhase("error"); } },
        onComplete: (blob: Blob) => {
          if (!current(ticket)) return;
          streamRef.current = null; recorderRef.current = null;
          if (liveVideo.current) liveVideo.current.srcObject = null;
          const retained = retainRecordedVideo(blob);
          recordedUrl.current = retained.url;
          setRecorded(retained);
          void inspectRecording(retained, ticket);
        },
      });
      recorderRef.current = recorder;
      if (recorder.state === "recording") setPhase("recording");
    } catch (cause) { releaseCamera(); setError(cameraErrorMessage(cause)); setPhase("error"); }
  };

  const stopRecording = () => {
    if (phaseRef.current !== "recording") return;
    setPhase("processing"); recorderRef.current?.stop();
  };
  const requestClose = () => {
    if (phaseRef.current === "uploading") return;
    if (["recording", "processing", "review"].includes(phaseRef.current)) {
      if (phaseRef.current === "recording") stopRecording();
      setDiscard(true);
    } else latest.current.onClose();
  };
  const useRecording = async () => {
    if (phaseRef.current !== "review" || !recorded) return;
    const ticket = epoch.current;
    if (!current(ticket)) { latest.current.onClose(); return; }
    setPhase("uploading"); setError("");
    try {
      const success = await latest.current.onUse(recorded.file);
      if (!current(ticket)) return;
      if (success) latest.current.onClose();
      else { setError("上传未完成，视频仍保留在这里，可再次点击使用视频。"); setPhase("review"); }
    } catch { if (current(ticket)) { setError("上传失败，请重试。"); setPhase("review"); } }
  };
  const retry = () => { setDiscard(false); setAttempt(value => value + 1); };
  const opening = phase === "opening";
  const isReview = phase === "review" || phase === "uploading";
  const stamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent className="mobile-video-capture" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { event.preventDefault(); requestClose(); }}>
      <header className="mvc-head">
        <div><DialogTitle>{isReview ? "检查视频" : "拍视频"}</DialogTitle><DialogDescription>{isReview ? "确认清晰后，使用视频" : cameraFacing ? `${cameraFacing} · 自动检测画质` : "优先使用后摄最高可用画质"}</DialogDescription></div>
        <button type="button" aria-label="关闭拍摄" onClick={requestClose} disabled={phase === "uploading"}><X /></button>
      </header>
      {discard ? <div className="mvc-discard"><Camera /><h2>放弃这段视频？</h2><p>关闭后，本次未上传的视频不会保存。</p><Button onClick={() => setDiscard(false)}>继续检查</Button><Button variant="outline" onClick={() => latest.current.onClose()}>放弃并关闭</Button></div> : <>
        <div className="mvc-viewfinder">
          <video ref={liveVideo} className={isReview || phase === "error" ? "mvc-hidden" : ""} autoPlay muted playsInline onResize={() => {
            if (["ready", "recording"].includes(phaseRef.current) && liveVideo.current) setQuality(videoQuality(liveVideo.current.videoWidth, liveVideo.current.videoHeight));
          }} />
          {isReview && recorded && <video key={recorded.url} src={recorded.url} controls playsInline preload="metadata" aria-label="录制视频预览" />}
          {(opening || phase === "processing") && <div className="mvc-loading" role="status"><Loader2 className="animate-spin motion-reduce:animate-none" /><strong>{opening ? "正在打开高清相机" : "正在检查成片"}</strong><span>{opening ? "首次使用请允许相机和麦克风权限" : "请稍候，视频不会自动压缩"}</span></div>}
          {phase === "error" && <div className="mvc-loading"><Camera /><strong>暂时无法拍摄</strong><span>{error}</span></div>}
          {["ready", "recording", "review", "uploading"].includes(phase) && <div className="mvc-quality"><span>{quality.label}{quality.width > 0 && quality.height > 0 ? ` · ${quality.width} × ${quality.height}` : ""}</span>{!hasAudio && <span><MicOff />未启用声音</span>}{phase === "recording" && <strong className="mvc-timer"><i />{stamp}</strong>}</div>}
        </div>
        <footer className="mvc-controls">
          {quality.low && <p className="mvc-warning" role="status">当前仅有 {quality.width} × {quality.height}，细节可能不清晰。可尝试在 Safari 中打开本页。</p>}
          {notice && <p role="status">{notice}</p>}
          {error && phase !== "error" && <p className="mvc-warning" role="alert">{error}</p>}
          {opening && <p>画质取决于当前浏览器开放的相机能力</p>}
          {phase === "ready" && <><button className="mvc-record" type="button" aria-label="开始录制" onClick={startRecording}><span /></button><p>点击开始 · 最长 2 分钟</p></>}
          {phase === "recording" && <><button className="mvc-record recording" type="button" aria-label="停止录制" onClick={stopRecording}><Square fill="currentColor" /></button><p>点击停止 · {stamp} / 2:00</p></>}
          {phase === "processing" && <p>录制完成，正在准备预览…</p>}
          {isReview && <div className="mvc-review-actions"><Button variant="outline" disabled={phase === "uploading"} onClick={retry}><RotateCcw />重拍</Button><Button disabled={phase === "uploading"} onClick={() => void useRecording()}>{phase === "uploading" ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Check />}{phase === "uploading" ? "上传中" : quality.low ? "仍使用此视频" : "使用视频"}</Button></div>}
          {phase === "review" && inspectionFailed && recorded && <Button variant="ghost" className="mt-2 min-h-11" onClick={() => void inspectRecording(recorded, epoch.current)}>重新检测画质</Button>}
          {phase === "uploading" && <p role="status">{uploadStatus || "正在上传原文件，请保持页面打开…"}</p>}
          {phase === "error" && <div className="mvc-error-actions"><Button onClick={retry}>重新打开相机</Button>{canTryOtherCamera && <Button variant="outline" onClick={() => { setAllowOtherCamera(true); setAttempt(value => value + 1); }}>使用当前摄像头</Button>}{canTrySilent && <Button variant="outline" onClick={() => { setIncludeAudio(false); setAttempt(value => value + 1); }}>仅拍画面</Button>}<Button variant="ghost" onClick={onChooseAlbum}><Images />从相册选择</Button></div>}
        </footer>
      </>}
    </DialogContent>
  </Dialog>;
}
