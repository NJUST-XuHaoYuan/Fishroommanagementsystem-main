import type { User } from "../store";
import { authHeaders, getValidAuthSession } from "./authSession.ts";

export const NEW_CUSTOMER_EVIDENCE_LIMIT = 6;
export const NEW_CUSTOMER_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const NEW_CUSTOMER_EVIDENCE_MIMES = ["image/jpeg", "image/png", "image/webp"];

export type NewCustomerEvidenceAttachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  createdAt: string;
};
export type NewCustomerSession = { key: string; viewerKey: string };

function viewerKey(user: { username: string; role: string; visibleSiteIds?: string[] }) {
  return JSON.stringify([user.username, user.role, [...new Set(user.visibleSiteIds || [])].sort()]);
}

export function captureNewCustomerSession(): NewCustomerSession | null {
  if (typeof window === "undefined") return null;
  const session = getValidAuthSession();
  return session?.token ? {
    key: JSON.stringify([session.token, session.expiresAt, viewerKey(session)]),
    viewerKey: viewerKey(session),
  } : null;
}

/** Also call inside React store updaters, which may run after the response handler. */
export function isNewCustomerSessionCurrent(session: NewCustomerSession | null | undefined, user?: User) {
  return Boolean(session?.key) && captureNewCustomerSession()?.key === session!.key
    && (user === undefined || Boolean(user && viewerKey(user) === session!.viewerKey));
}

export function normalizeNewCustomerEvidence(value: unknown): NewCustomerEvidenceAttachment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim() || seen.has(record.id)
      || typeof record.originalName !== "string" || !NEW_CUSTOMER_EVIDENCE_MIMES.includes(String(record.mime))
      || typeof record.size !== "number" || !Number.isFinite(record.size) || record.size <= 0
      || typeof record.createdAt !== "string") return [];
    seen.add(record.id);
    return [{ id: record.id, originalName: record.originalName, mime: String(record.mime), size: record.size, createdAt: record.createdAt }];
  }).slice(0, NEW_CUSTOMER_EVIDENCE_LIMIT);
}

export function planNewCustomerEvidenceFiles<T extends { name: string; type: string; size: number }>(files: T[], existingCount: number) {
  const accepted: T[] = [];
  const errors: string[] = [];
  const slots = Math.max(0, NEW_CUSTOMER_EVIDENCE_LIMIT - existingCount);
  for (const file of files) {
    if (!NEW_CUSTOMER_EVIDENCE_MIMES.includes(file.type)) {
      errors.push(`${file.name}：仅支持 JPG、PNG、WebP；HEIC 等格式请先转为图片。`);
    } else if (file.size <= 0 || file.size > NEW_CUSTOMER_EVIDENCE_MAX_BYTES) {
      errors.push(`${file.name}：${file.size <= 0 ? "文件为空，请重新选择" : "超过 10 MB，请先裁剪或压缩，确保文字仍清晰"}。`);
    } else if (accepted.length >= slots) {
      errors.push(`${file.name}：每次申请最多 6 张，本次未上传此图片。`);
    } else accepted.push(file);
  }
  return { accepted, errors };
}

export function newCustomerEvidenceEndpoint(id: string) {
  return `/api/orders/new-customer/evidence/${encodeURIComponent(id)}`;
}

function requestError(status: number, payload: unknown, fallback: string) {
  if (status === 401) return "登录已过期，请重新登录后操作。";
  if (status === 403) return "当前账号没有访问该凭证的权限。";
  const message = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/** The private raw-body endpoint is deliberately separate from public media uploads. */
export function uploadNewCustomerEvidence(orderId: string, file: File, signal: AbortSignal, onProgress: (percent: number) => void): Promise<NewCustomerEvidenceAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: Error, attachment?: NewCustomerEvidenceAttachment) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(attachment!);
    };
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    xhr.open("POST", `/api/orders/new-customer/evidence?orderId=${encodeURIComponent(orderId)}`);
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.timeout = 120_000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      let payload: { ok?: boolean; attachment?: unknown } = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* Non-JSON gateway errors use the fallback. */ }
      const attachment = normalizeNewCustomerEvidence([payload.attachment])[0];
      if (xhr.status < 200 || xhr.status >= 300 || payload.ok !== true) {
        finish(new Error(requestError(xhr.status, payload, "图片上传失败，请重试。")));
      } else if (!attachment) finish(new Error("服务器未返回有效的凭证信息，请重新上传。"));
      else finish(undefined, attachment);
    };
    xhr.onerror = () => finish(new Error("网络连接失败，已成功上传的图片仍保留，请重试失败的图片。"));
    xhr.ontimeout = () => finish(new Error("图片上传超时，请检查网络后重试。"));
    xhr.onabort = () => finish(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

export async function deleteNewCustomerEvidence(id: string, signal: AbortSignal) {
  const response = await fetch(newCustomerEvidenceEndpoint(id), { method: "DELETE", headers: authHeaders(), signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(requestError(response.status, payload, "图片删除失败，已保留该图片，请重试。"));
}

export async function fetchNewCustomerEvidence(id: string, signal: AbortSignal) {
  const response = await fetch(newCustomerEvidenceEndpoint(id), { headers: authHeaders(), signal, cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(requestError(response.status, payload, "凭证图片加载失败，请重试。"));
  }
  const blob = await response.blob();
  if (!NEW_CUSTOMER_EVIDENCE_MIMES.includes(blob.type) || blob.size <= 0) throw new Error("凭证文件格式异常，请联系管理员核对。");
  return blob;
}
