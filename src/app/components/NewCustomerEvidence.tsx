import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, RefreshCw, Trash2, ZoomIn } from "lucide-react";
import {
  captureNewCustomerSession,
  deleteNewCustomerEvidence,
  fetchNewCustomerEvidence,
  isNewCustomerSessionCurrent,
  NEW_CUSTOMER_EVIDENCE_LIMIT,
  planNewCustomerEvidenceFiles,
  uploadNewCustomerEvidence,
  type NewCustomerEvidenceAttachment,
} from "../utils/newCustomerEvidence";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

function EvidenceImage({ attachment, orderId, onRemove, disabled }: {
  attachment: NewCustomerEvidenceAttachment; orderId: string; onRemove?: () => void; disabled?: boolean;
}) {
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(false);
  const [originalSize, setOriginalSize] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const session = captureNewCustomerSession();
    let objectUrl = "";
    setImageUrl(""); setError(""); setPreview(false);
    if (!session) { setError("请重新登录后查看凭证。"); return () => controller.abort(); }
    void fetchNewCustomerEvidence(attachment.id, controller.signal).then(blob => {
      if (controller.signal.aborted || !isNewCustomerSessionCurrent(session)) return;
      objectUrl = URL.createObjectURL(blob);
      setImageUrl(objectUrl);
    }).catch(cause => {
      if (!controller.signal.aborted && isNewCustomerSessionCurrent(session)) setError(cause instanceof Error ? cause.message : "图片加载失败，请重试。");
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, orderId, attempt]);

  return <div className="min-w-0 rounded-md border bg-background p-2">
    <button type="button" disabled={!imageUrl} aria-label={`放大凭证：${attachment.originalName}`} onClick={() => setPreview(true)} className="relative flex aspect-[4/3] min-h-20 w-full items-center justify-center overflow-hidden rounded border bg-muted/30 focus-visible:outline-2 focus-visible:outline-offset-2">
      {imageUrl ? <><img src={imageUrl} alt={attachment.originalName} className="h-full w-full object-contain" /><span className="absolute bottom-1 right-1 rounded bg-background/90 p-1"><ZoomIn className="size-4" aria-hidden="true" /></span></> : error ? <span className="px-2 text-xs text-muted-foreground">图片未加载</span> : <Loader2 aria-label="正在加载凭证" className="size-5 animate-spin motion-reduce:animate-none" />}
    </button>
    <p className="mt-1.5 break-all text-xs leading-5" title={attachment.originalName}>{attachment.originalName}</p>
    {error && <div><p role="alert" className="mt-1 break-words text-xs text-destructive">{error}</p><Button type="button" variant="outline" className="mt-1 min-h-11 w-full" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" />重试图片</Button></div>}
    {onRemove && <Button type="button" variant="ghost" disabled={disabled} aria-label={`删除凭证：${attachment.originalName}`} className="mt-1 min-h-11 w-full text-destructive" onClick={onRemove}><Trash2 className="size-4" aria-hidden="true" />删除</Button>}
    <Dialog open={preview && Boolean(imageUrl)} onOpenChange={open => { setPreview(open); setOriginalSize(false); }}>
      <DialogContent className="sm:max-w-4xl [&>button:last-child]:min-h-11 [&>button:last-child]:min-w-11">
        <DialogHeader><DialogTitle className="break-all pr-10">图片凭证</DialogTitle><DialogDescription className="break-all pr-10">{attachment.originalName} · 原尺寸下可滑动查看细节</DialogDescription></DialogHeader>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setOriginalSize(value => !value)}><ZoomIn className="size-4" />{originalSize ? "适应窗口" : "原尺寸查看"}</Button>
        <div className="max-h-[65dvh] overflow-auto rounded border" tabIndex={0} aria-label="凭证图片，可滚动查看"><img src={imageUrl || undefined} alt={attachment.originalName} className={`mx-auto h-auto ${originalSize ? "max-w-none" : "max-w-full"}`} /></div>
        <DialogClose asChild><Button type="button" variant="outline" className="min-h-11">关闭预览</Button></DialogClose>
      </DialogContent>
    </Dialog>
  </div>;
}

export function NewCustomerEvidenceGallery({ orderId, attachments, onRemove, disabled = false }: {
  orderId: string; attachments: NewCustomerEvidenceAttachment[]; onRemove?: (id: string) => void; disabled?: boolean;
}) {
  if (!attachments.length) return <p className="text-xs leading-5 text-muted-foreground">未上传图片凭证。</p>;
  return <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3" aria-label="新客审批图片凭证">
    {attachments.map(attachment => <EvidenceImage key={`${orderId}:${attachment.id}`} orderId={orderId} attachment={attachment} disabled={disabled} onRemove={onRemove ? () => onRemove(attachment.id) : undefined} />)}
  </div>;
}

export function NewCustomerEvidenceUploader({ orderId, attachments, disabled = false, onChange, onBusyChange }: {
  orderId: string; attachments: NewCustomerEvidenceAttachment[]; disabled?: boolean;
  onChange: (attachments: NewCustomerEvidenceAttachment[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ name: string; index: number; total: number; percent: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<AbortController | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const orderRef = useRef(orderId);
  orderRef.current = orderId;
  const mountedRef = useRef(true);
  const ownerSessionRef = useRef(captureNewCustomerSession());
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; pendingRef.current?.abort(); onBusyChange(false); };
  }, [onBusyChange, orderId]);

  const startOperation = () => {
    const session = captureNewCustomerSession();
    if (disabled || pendingRef.current) return null;
    if (!session || session.key !== ownerSessionRef.current?.key) { setErrors(["登录状态已变化，请重新打开申请后上传凭证。"]); return null; }
    const controller = new AbortController();
    pendingRef.current = controller;
    setBusy(true); onBusyChange(true);
    const current = () => mountedRef.current && orderRef.current === orderId && !controller.signal.aborted && isNewCustomerSessionCurrent(session);
    const finish = () => {
      if (pendingRef.current !== controller) return;
      pendingRef.current = null;
      if (mountedRef.current && orderRef.current === orderId) { setBusy(false); setProgress(null); onBusyChange(false); }
    };
    return { controller, current, finish };
  };

  const upload = async (files: File[]) => {
    const operation = startOperation();
    if (!operation) return;
    const { accepted, errors: validationErrors } = planNewCustomerEvidenceFiles(files, attachmentsRef.current.length);
    setErrors(validationErrors);
    try {
      for (let index = 0; index < accepted.length; index += 1) {
        if (!operation.current()) break;
        const file = accepted[index];
        setProgress({ name: file.name, index: index + 1, total: accepted.length, percent: 0 });
        try {
          const attachment = await uploadNewCustomerEvidence(orderId, file, operation.controller.signal, percent => {
            if (operation.current()) setProgress({ name: file.name, index: index + 1, total: accepted.length, percent });
          });
          if (!operation.current()) break;
          const next = [...attachmentsRef.current, attachment];
          attachmentsRef.current = next;
          onChange(next);
        } catch (cause) {
          if (!operation.current()) break;
          setErrors(current => [...current, `${file.name}：${cause instanceof Error ? cause.message : "上传失败，请重试。"}`]);
        }
      }
    } finally { operation.finish(); }
  };

  const remove = async (id: string) => {
    const operation = startOperation();
    if (!operation) return;
    setErrors([]);
    try {
      await deleteNewCustomerEvidence(id, operation.controller.signal);
      if (!operation.current()) return;
      const next = attachmentsRef.current.filter(attachment => attachment.id !== id);
      attachmentsRef.current = next; onChange(next);
    } catch (cause) {
      if (operation.current()) setErrors([cause instanceof Error ? cause.message : "删除失败，图片仍保留，请重试。"]);
    } finally { operation.finish(); }
  };

  return <section className="space-y-2" aria-label="上传新客审批图片凭证" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">图片凭证 <span className="font-normal text-muted-foreground">（选填）</span></h4><span className="text-xs text-muted-foreground">{attachments.length}/{NEW_CUSTOMER_EVIDENCE_LIMIT} 张</span></div>
    <p className="text-xs leading-5 text-muted-foreground">可多选聊天截图、首次成交依据等；最多 6 张，单张不超过 10 MB，仅支持 JPG、PNG、WebP。HEIC 请先转格式，确保关键文字清晰。图片仅供有权限的账号查看。</p>
    <p className="text-xs leading-5 text-muted-foreground">上传后需提交申请才会绑定；本人本单未提交的图片草稿 24 小时内可恢复，过期后需重新上传。</p>
    <NewCustomerEvidenceGallery orderId={orderId} attachments={attachments} onRemove={id => void remove(id)} disabled={disabled || busy} />
    <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple className="hidden" aria-label="选择图片凭证" disabled={disabled || busy || attachments.length >= NEW_CUSTOMER_EVIDENCE_LIMIT} onChange={event => {
      const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void upload(files);
    }} />
    <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={disabled || busy || attachments.length >= NEW_CUSTOMER_EVIDENCE_LIMIT} onClick={() => inputRef.current?.click()}>{busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <ImagePlus className="size-4" />}{busy ? "正在处理图片…" : "添加图片凭证"}</Button>
    {progress && <div role="status" className="text-xs leading-5"><p className="break-all">正在上传 {progress.index}/{progress.total}：{progress.name} · {progress.percent === 100 ? "服务器校验中…" : `${progress.percent}%`}</p><progress max={100} value={progress.percent} className="mt-1 h-2 w-full" aria-label="图片上传进度" /></div>}
    {busy && <p className="text-xs text-muted-foreground">图片处理完成后才能提交申请。</p>}
    {errors.length > 0 && <ul role="alert" className="space-y-1 text-xs leading-5 text-destructive">{errors.map((error, index) => <li key={index} className="break-words">{error}</li>)}</ul>}
  </section>;
}
