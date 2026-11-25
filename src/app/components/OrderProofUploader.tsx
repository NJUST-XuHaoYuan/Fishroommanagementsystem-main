import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { uploadOriginalMedia } from "../utils/media";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { IMAGE_PASTE_HELP, imageFilesFromTransfer, readClipboardImages } from "../utils/imageClipboard";

export function OrderProofUploader({ images, onChange, disabled = false, onUploadingChange }: {
  images: string[]; onChange: (images: string[]) => void; disabled?: boolean;
  onUploadingChange?: (loading: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const callbacksRef = useRef({ onChange, onUploadingChange });
  callbacksRef.current = { onChange, onUploadingChange };
  const operationRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; operationRef.current?.abort(); callbacksRef.current.onUploadingChange?.(false); };
  }, []);

  const handleFiles = async (input: File[] | (() => Promise<File[]>)) => {
    if (disabled || operationRef.current) return;
    const session = captureNewCustomerSession();
    if (!session) { setError("请重新登录后上传凭证。"); return; }
    const operation = new AbortController();
    operationRef.current = operation;
    const current = () => mountedRef.current && !operation.signal.aborted && isNewCustomerSessionCurrent(session);
    setLoading(true); setError(""); callbacksRef.current.onUploadingChange?.(true);
    try {
      const files = typeof input === "function" ? await input() : input;
      if (!current()) return;
      const accepted = files.filter(file => file.type.startsWith("image/"));
      if (!accepted.length) throw new Error("请选择图片文件。");
      for (const file of accepted) {
        if (!current()) break;
        try {
          const url = await uploadOriginalMedia(file);
          if (!current()) break;
          const next = [...imagesRef.current, url];
          imagesRef.current = next;
          callbacksRef.current.onChange(next);
        } catch (cause) {
          if (current()) setError(cause instanceof Error ? cause.message : "凭证上传失败，请重试。");
        }
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : IMAGE_PASTE_HELP);
        pasteRef.current?.focus();
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        if (mountedRef.current) { setLoading(false); callbacksRef.current.onUploadingChange?.(false); }
      }
    }
  };

  return <div ref={pasteRef} tabIndex={0} aria-label="上传凭证图片" aria-busy={loading}
    className="space-y-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    onPaste={event => {
      const files = imageFilesFromTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      void handleFiles(files);
    }}>
    {images.length > 0 && <div className="flex flex-wrap gap-2">{images.map((img, index) => <div key={`${img}:${index}`} className="relative shrink-0">
      <MediaPreviewTrigger src={img} mediaType="image" title={`凭证 ${index + 1}`} ariaLabel={`预览凭证 ${index + 1}`} className="size-20 overflow-hidden rounded border hover:opacity-80">
        <ImageWithFallback src={img} alt="凭证" className="size-full object-cover" />
      </MediaPreviewTrigger>
      <button type="button" aria-label={`删除凭证 ${index + 1}`} className="absolute -right-1 -top-1 flex size-7 items-center justify-center rounded-full border bg-background text-destructive"
        disabled={disabled || loading} onClick={() => { const next = imagesRef.current.filter((_, i) => i !== index); imagesRef.current = next; onChange(next); }}>
        <Trash2 className="size-3.5" />
      </button>
    </div>)}</div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11" disabled={disabled || loading} onClick={() => fileRef.current?.click()}>
        {loading ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <ImagePlus className="size-4" />}{loading ? "正在处理图片…" : "添加图片凭证"}
      </Button>
      <Button type="button" variant="outline" className="min-h-11" disabled={disabled || loading} onClick={() => void handleFiles(() => readClipboardImages())}><ClipboardPaste className="size-4" />粘贴截图</Button>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">截图复制后，点「粘贴截图」；也可点击本区域按 Ctrl+V / ⌘V，无需保存文件。</p>
    <input ref={fileRef} type="file" accept="image/*" multiple disabled={disabled || loading} className="hidden" aria-label="选择图片凭证"
      onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void handleFiles(files); }} />
    {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
  </div>;
}
