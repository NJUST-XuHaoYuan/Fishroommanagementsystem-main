import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, Images, Loader2, Play, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_ORIGINAL_IMAGE_BYTES,
  MAX_ORIGINAL_VIDEO_BYTES,
  mediaAuthSessionKey,
  originalMediaKind,
  uploadOriginalMedia,
} from "../utils/media";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { MobileVideoCaptureDialog } from "./MobileVideoCaptureDialog";
import { Button } from "./ui/button";

export type MobileMaintenanceMediaValue = { photos: string[]; videos: string[] };

type Props = MobileMaintenanceMediaValue & {
  onChange: (value: MobileMaintenanceMediaValue) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
  photosOnly?: boolean;
};

const MAX_ATTACHMENTS = 8;

/** Keep this component mounted and keyed to its record draft while an upload is in progress. */
export function MobileMaintenanceMedia({ photos, videos, onChange, onBusyChange, disabled = false, photosOnly = false }: Props) {
  const photoInput = useRef<HTMLInputElement>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const latest = useRef({ photos, videos, onChange, onBusyChange });
  latest.current = { photos, videos, onChange, onBusyChange };
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const count = photos.length + (photosOnly ? 0 : videos.length);
  const unavailable = disabled || busy || cameraOpen;

  useEffect(() => { latest.current.onBusyChange(busy || cameraOpen); }, [busy, cameraOpen]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // The shared uploader cannot abort its request; discard late results after unmount.
      latest.current.onBusyChange(false);
    };
  }, []);

  const upload = async (files: File[], expected?: "image" | "video") => {
    if (disabled || pending.current || files.length === 0) return false;
    if (photosOnly) expected = "image";
    const room = MAX_ATTACHMENTS - latest.current.photos.length - latest.current.videos.length;
    if (files.length > room) {
      const message = room > 0 ? `本次还可以添加 ${room} 个附件，请重新选择。` : "每条记录最多添加 8 个附件。";
      setError(message); toast.error(message); return false;
    }
    // Validate the entire selection before uploading, so a rejected selection changes nothing.
    for (const file of files) {
      const kind = originalMediaKind(file);
      const limit = kind === "video" ? MAX_ORIGINAL_VIDEO_BYTES : MAX_ORIGINAL_IMAGE_BYTES;
      const message = !kind || (expected && kind !== expected)
        ? `“${file.name}”不是支持的${expected === "image" ? "照片" : expected === "video" ? "视频" : "照片或视频"}。`
        : file.size === 0 ? `“${file.name}”是空文件，请重新拍摄或选择。`
          : file.size > limit ? `“${file.name}”超过${kind === "video" ? "视频 300MB" : "照片 50MB"}上限，请选择较短的视频或较小的文件。` : "";
      if (message) { setError(message); toast.error(message); return false; }
    }

    const sessionKey = mediaAuthSessionKey();
    const isCurrent = () => mounted.current && mediaAuthSessionKey() === sessionKey;
    pending.current = true;
    setBusy(true); setError("");
    const failures: string[] = [];
    let added = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        if (!isCurrent()) break;
        const file = files[index];
        const kind = originalMediaKind(file)!;
        const label = kind === "video" ? "视频" : "照片";
        try {
          // Send the browser-provided File directly. Do not canvas-resize, compress, or re-encode it.
          const url = await uploadOriginalMedia(file, {
            preserveOriginal: kind === "video",
            onProgress: ({ phase, percent }) => {
              if (!isCurrent()) return;
              setStatus(`${index + 1}/${files.length} · ${phase === "processing" ? `${label}处理中，请稍候…` : `${label}上传 ${percent}%`}`);
            },
          });
          if (!isCurrent()) break;
          const next = {
            photos: kind === "image" ? [...latest.current.photos, url] : latest.current.photos,
            videos: kind === "video" ? [...latest.current.videos, url] : latest.current.videos,
          };
          latest.current = { ...latest.current, ...next };
          latest.current.onChange(next);
          added += 1;
        } catch (uploadError) {
          failures.push(`“${file.name}”：${uploadError instanceof Error ? uploadError.message : "上传失败，请重试"}`);
        }
      }
      if (isCurrent()) {
        if (failures.length) {
          const message = failures.join("\n");
          setError(message); toast.error(`有 ${failures.length} 个附件未上传成功，请重新选择失败的文件。`);
        }
        if (added) toast.success(`已添加 ${added} 个附件，保存记录后生效。`);
      }
      return isCurrent() && added === files.length;
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false); setStatus("");
      }
    }
  };

  const picked = (event: ChangeEvent<HTMLInputElement>, expected?: "image" | "video") => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    void upload(files, expected);
  };

  const remove = (kind: "image" | "video", index: number) => {
    if (disabled || pending.current) return;
    const next = {
      photos: kind === "image" ? latest.current.photos.filter((_, i) => i !== index) : latest.current.photos,
      videos: kind === "video" ? latest.current.videos.filter((_, i) => i !== index) : latest.current.videos,
    };
    latest.current = { ...latest.current, ...next };
    latest.current.onChange(next);
    setError("");
  };

  return <section className="space-y-3" aria-label={photosOnly ? "报损照片" : "照片和视频"}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-base font-medium">{photosOnly ? "报损照片（必填）" : "照片和视频"}</h3>
      <span className="text-sm text-muted-foreground">{count}/{MAX_ATTACHMENTS}</span>
    </div>
    <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" disabled={unavailable} onChange={event => picked(event, "image")} aria-label="使用手机相机拍照" />
    <input ref={albumInput} type="file" accept={photosOnly ? "image/*" : "image/*,video/*"} multiple className="hidden" disabled={disabled || busy} onChange={event => picked(event)} aria-label={photosOnly ? "从相册选择照片" : "从相册选择照片或视频"} />
    <div className={photosOnly ? "grid gap-3" : "grid grid-cols-2 gap-3"}>
      <Button type="button" variant={photosOnly ? "default" : "outline"} className="min-h-14 gap-2 text-base" disabled={unavailable || count >= MAX_ATTACHMENTS} onClick={() => photoInput.current?.click()}><Camera className="size-5" />拍照片</Button>
      {!photosOnly && <Button type="button" variant="outline" className="min-h-14 gap-2 text-base" disabled={unavailable || count >= MAX_ATTACHMENTS} onClick={() => setCameraOpen(true)}><Video className="size-5" />拍视频</Button>}
    </div>
    <Button type="button" variant="ghost" className="min-h-11 w-full gap-2" disabled={unavailable || count >= MAX_ATTACHMENTS} onClick={() => albumInput.current?.click()}><Images className="size-4" />从相册选择</Button>
    <p className="text-sm leading-6 text-muted-foreground">{photosOnly ? "请拍清楚本次报损的鱼；照片保存后可在报损记录中查看。" : "直接打开后摄录制，自动检测可用画质；视频按原文件上传。"}</p>
    {!photosOnly && cameraOpen && <MobileVideoCaptureDialog onClose={() => setCameraOpen(false)} onChooseAlbum={() => { setCameraOpen(false); albumInput.current?.click(); }} onUse={file => upload([file], "video")} uploadStatus={status} />}
    {busy && <div role="status" className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm"><Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />{status || "正在上传，请稍候…"}</div>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm leading-6 text-destructive">{error}</p>}
    {count > 0 && <div className="grid grid-cols-2 gap-3">
      {photos.map((src, index) => <div key={`image:${index}:${src}`} className="overflow-hidden rounded-lg border">
        <MediaPreviewTrigger src={src} title={`照片 ${index + 1}`} allowDownload={false} ariaLabel={`预览照片 ${index + 1}`} className="block h-28 w-full rounded-none">
          <ImageWithFallback src={src} alt={`照片 ${index + 1}`} className="h-full w-full object-cover" />
        </MediaPreviewTrigger>
        <Button type="button" variant="ghost" className="min-h-11 w-full gap-1 rounded-none text-destructive" disabled={unavailable} onClick={() => remove("image", index)} aria-label={`移除照片 ${index + 1}`}><Trash2 className="size-4" />移除</Button>
      </div>)}
      {!photosOnly && videos.map((src, index) => <div key={`video:${index}:${src}`} className="overflow-hidden rounded-lg border">
        <MediaPreviewTrigger src={src} mediaType="video" title={`视频 ${index + 1}`} allowDownload={false} ariaLabel={`预览视频 ${index + 1}`} className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-none bg-muted">
          <Play className="size-6" /><span className="text-sm">视频 {index + 1}</span>
        </MediaPreviewTrigger>
        <Button type="button" variant="ghost" className="min-h-11 w-full gap-1 rounded-none text-destructive" disabled={unavailable} onClick={() => remove("video", index)} aria-label={`移除视频 ${index + 1}`}><Trash2 className="size-4" />移除</Button>
      </div>)}
    </div>}
  </section>;
}
