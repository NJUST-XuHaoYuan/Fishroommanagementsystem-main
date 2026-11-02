import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "../store";
import { privateMediaSessionKey, fetchPersonnelAttachmentImage } from "../utils/privateAttachmentMedia";
import { MediaPreviewDialog } from "./MediaPreviewDialog";

type Attachment = { id: string; originalName?: string };
type Selection = { attachment: Attachment; src: string; scope: string; session: string; allowDownload: boolean };

/** Private personnel media stays authenticated, never routed through public/COS media. */
export function usePrivatePersonnelAttachmentPreview(scope: string) {
  const { state } = useStore();
  const user = state.user;
  const session = privateMediaSessionKey(user);
  const context = useRef({ scope, session, user });
  context.current = { scope, session, user };
  const pending = useRef<AbortController | null>(null);
  const urlRef = useRef("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadingId, setLoadingId] = useState("");

  const dispose = () => {
    pending.current?.abort();
    pending.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
  };
  const closePreview = () => { dispose(); setSelection(null); setLoadingId(""); };
  useEffect(() => { closePreview(); return dispose; }, [scope, session]);

  const current = (request: AbortController, expectedScope: string, expectedSession: string) =>
    !request.signal.aborted && pending.current === request && context.current.scope === expectedScope &&
    context.current.session === expectedSession && privateMediaSessionKey(context.current.user) === expectedSession;

  const openPreview = async (attachment: Attachment, allowDownload = false) => {
    closePreview();
    const expectedScope = context.current.scope, expectedSession = context.current.session;
    if (!expectedScope || !expectedSession) { toast.error("登录已失效，请重新登录后查看"); return; }
    const request = new AbortController();
    pending.current = request;
    setLoadingId(attachment.id);
    try {
      const blob = await fetchPersonnelAttachmentImage(attachment.id, request.signal);
      if (!current(request, expectedScope, expectedSession)) return;
      const src = URL.createObjectURL(blob);
      urlRef.current = src;
      setSelection({ attachment, src, scope: expectedScope, session: expectedSession, allowDownload: allowDownload && context.current.user?.role === "admin" });
    } catch (error) {
      if (current(request, expectedScope, expectedSession)) toast.error(error instanceof Error ? error.message : "附件预览失败");
    } finally { if (current(request, expectedScope, expectedSession)) setLoadingId(""); }
  };

  const download = async (selected: Selection) => {
    if (!selected.allowDownload || context.current.user?.role !== "admin" || privateMediaSessionKey(context.current.user) !== selected.session || context.current.scope !== selected.scope) throw new Error("登录或查看对象已改变，请重新打开附件");
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    const blob = await fetchPersonnelAttachmentImage(selected.attachment.id, request.signal, true);
    if (!current(request, selected.scope, selected.session)) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = selected.attachment.originalName || "人员资料图片"; link.rel = "noopener";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const active = selection?.scope === scope && selection?.session === session ? selection : null;
  return {
    openPreview, closePreview, loadingId,
    previewDialog: <MediaPreviewDialog open={Boolean(active)} onOpenChange={(open) => !open && closePreview()} title="人员资料图片预览"
      items={active ? [{ src: active.src, type: "image", title: active.attachment.originalName || "人员资料图片", filename: active.attachment.originalName,
        allowDownload: active.allowDownload, onDownload: () => download(active) }] : []} />,
  };
}
