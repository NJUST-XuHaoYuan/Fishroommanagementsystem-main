import { authHeaders, getValidAuthSession } from "./authSession";

export function privateMediaSessionKey(user?: { username: string; role: string; visibleSiteIds?: string[] } | null) {
  const session = getValidAuthSession();
  if (!session?.token || (user !== undefined && (!user || user.username !== session.username || user.role !== session.role))) return "";
  return JSON.stringify([session.username, session.role, session.token, session.expiresAt,
    [...(session.visibleSiteIds || [])].sort(), user ? [...(user.visibleSiteIds || [])].sort() : null]);
}

export async function fetchPersonnelAttachmentImage(id: string, signal: AbortSignal, download = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("附件编号不正确");
  const response = await fetch(`/api/personnel/attachments/${encodeURIComponent(id)}${download ? "?download=1" : ""}`, {
    headers: authHeaders(), cache: "no-store", signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || (download ? "附件下载失败" : "附件预览失败"));
  }
  const blob = await response.blob();
  if (!/^image\/(jpeg|png|webp|gif|bmp|heic|heif)$/i.test(blob.type) || !blob.size) throw new Error("附件不是可预览的图片");
  return blob;
}
