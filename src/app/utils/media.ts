import { useEffect, useMemo, useState } from "react";
import { authHeaders, getValidAuthSession } from "./authSession";

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
let signedUrlSessionKey = "";

export function mediaAuthSessionKey() {
  if (typeof window === "undefined") return "anonymous";
  const session = getValidAuthSession();
  return session?.token ? JSON.stringify([session.username, session.role, session.token, session.expiresAt, [...new Set(session.visibleSiteIds || [])].sort()]) : "anonymous";
}

export function clearResolvedMediaCache() {
  signedUrlCache.clear();
}

/** Only inert image/video sources may enter the media-only preview. Never render documents or SVG data. */
export function isSafeMediaPreviewSrc(src?: string) {
  if (typeof src !== "string" || !src.trim()) return false;
  const value = src.trim();
  if (/^data:/i.test(value)) return /^data:(?:image\/(?:png|jpeg|jpg|webp|gif|bmp|avif|heic|heif)|video\/(?:mp4|webm|quicktime|x-m4v|3gpp|3gpp2))(?:;[^,]*)?,/i.test(value);
  if (/^blob:/i.test(value)) return /^blob:(?:https?:\/\/|null\/)[^\s]+$/i.test(value);
  try {
    const url = new URL(value, typeof window !== "undefined" ? window.location?.href || "http://localhost/" : "http://localhost/");
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}

export const MAX_ORIGINAL_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_ORIGINAL_VIDEO_BYTES = 300 * 1024 * 1024;
export const ORIGINAL_VIDEO_ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/3gpp,video/3gpp2,video/*";

function extensionFromName(name: string) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

function mediaMimeFromFile(file: File): string {
  const mime = String(file.type || "").split(";", 1)[0].trim().toLowerCase();
  if (mime) return mime;
  const ext = extensionFromName(file.name);
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".m4v") return "video/x-m4v";
  if (ext === ".3gp") return "video/3gpp";
  if (ext === ".3g2") return "video/3gpp2";
  if (ext === ".webm") return "video/webm";
  return "";
}

export function originalMediaKind(file: File): "image" | "video" | null {
  const mime = mediaMimeFromFile(file);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

type ResolveMediaOptions = {
  thumbnailWidth?: number;
  signal?: AbortSignal;
  refreshKey?: number;
};

export function cosProxyUrl(src?: string) {
  if (typeof src !== "string") return undefined;
  try {
    const url = new URL(src);
    if (url.hostname.endsWith(".myqcloud.com") && url.hostname.includes(".cos.")) {
      return `/api/media/cos?url=${encodeURIComponent(src)}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function isCosMediaUrl(src?: string) {
  return Boolean(cosProxyUrl(src));
}

export async function resolveMediaUrl(src?: string, options: ResolveMediaOptions = {}) {
  if (!src) return undefined;
  if (!isCosMediaUrl(src)) return src;

  const sessionKey = mediaAuthSessionKey();
  if (signedUrlSessionKey !== sessionKey) {
    signedUrlCache.clear();
    signedUrlSessionKey = sessionKey;
  }

  const thumbnailWidth = Number(options.thumbnailWidth || 0);
  const cacheKey = thumbnailWidth > 0 ? `${src}#thumbnail=${thumbnailWidth}` : src;
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;

  const query = new URLSearchParams({ url: src });
  if (thumbnailWidth > 0) {
    query.set("preview", "image");
    query.set("width", String(thumbnailWidth));
  }
  const response = await fetch(`/api/media/cos-url?${query.toString()}`, {
    headers: authHeaders(),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (options.signal?.aborted || mediaAuthSessionKey() !== sessionKey) throw new DOMException("登录状态已变化", "AbortError");
  const signedUrl = typeof data?.url === "string" ? data.url : "";
  if (!signedUrl) throw new Error("Missing signed media URL");

  signedUrlCache.set(cacheKey, {
    url: signedUrl,
    expiresAt: Date.now() + Math.max(60, Number(data?.expiresIn ?? 3600) - 60) * 1000,
  });
  return signedUrl;
}

type MediaUploadProgress = {
  phase: "uploading" | "processing";
  loaded: number;
  total: number;
  percent: number;
};

type MediaUploadOptions = {
  onProgress?: (progress: MediaUploadProgress) => void;
};

export async function uploadOriginalMedia(file: File, options: MediaUploadOptions = {}): Promise<string> {
  const mime = mediaMimeFromFile(file);
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
    throw new Error("只支持上传图片或视频文件");
  }
  const maxBytes = mime.startsWith("video/") ? MAX_ORIGINAL_VIDEO_BYTES : MAX_ORIGINAL_IMAGE_BYTES;
  if (file.size > maxBytes) {
    throw new Error(
      `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制，请压缩或剪短后重试`
    );
  }

  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/media/upload");
    for (const [key, value] of Object.entries(authHeaders())) request.setRequestHeader(key, value);
    request.setRequestHeader("Content-Type", mime);
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.timeout = mime.startsWith("video/") ? 10 * 60 * 1000 : 2 * 60 * 1000;
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const loaded = Math.min(event.loaded, total);
      options.onProgress?.({
        phase: "uploading",
        loaded,
        total,
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      });
    };
    request.upload.onload = () => {
      options.onProgress?.({
        phase: "processing",
        loaded: file.size,
        total: file.size,
        percent: 100,
      });
    };
    request.onerror = () => reject(new Error("网络连接失败，请检查网络后重试"));
    request.ontimeout = () => reject(new Error("上传或视频处理超时，请剪短后重试"));
    request.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(request.responseText || "{}");
      } catch {
        data = {};
      }
      if (request.status < 200 || request.status >= 300 || typeof data?.url !== "string") {
        reject(new Error(data?.error || `HTTP ${request.status}`));
        return;
      }
      resolve(data.url);
    };
    request.send(file);
  });
}

export function useResolvedMediaUrl(src?: string, options: ResolveMediaOptions = {}) {
  const originalSrc = typeof src === "string" ? src : undefined;
  const proxySrc = useMemo(() => cosProxyUrl(originalSrc), [originalSrc]);
  const thumbnailWidth = Number(options.thumbnailWidth || 0);
  const refreshKey = Number(options.refreshKey || 0);
  const sourceKey = `${originalSrc || ""}:${thumbnailWidth}:${refreshKey}:${mediaAuthSessionKey()}`;
  const [resolved, setResolved] = useState<{ key: string; src?: string }>(() => ({ key: sourceKey, src: proxySrc ? undefined : originalSrc }));

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const setDisplaySrc = (value?: string) => setResolved({ key: sourceKey, src: value });
    if (!originalSrc) {
      setDisplaySrc(undefined);
      return () => {
        cancelled = true;
      };
    }
    if (!proxySrc) {
      setDisplaySrc(originalSrc);
      return () => {
        cancelled = true;
      };
    }

    setDisplaySrc(undefined);
    resolveMediaUrl(originalSrc, { thumbnailWidth, signal: controller.signal })
      .then((url) => {
        if (!cancelled) setDisplaySrc(url);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== "AbortError") setDisplaySrc(proxySrc);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [originalSrc, proxySrc, thumbnailWidth, refreshKey, sourceKey]);

  return resolved.key === sourceKey ? resolved.src : proxySrc ? undefined : originalSrc;
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export type DownloadMediaOptions = {
  mediaType?: "image" | "video";
  stockItemId?: string;
  recordId?: string;
};

export type MediaDownloadResult = {
  mode: "download" | "mobile-open";
};

function prefersMobileVideoOpen() {
  const userAgent = String(window.navigator?.userAgent ?? "");
  const isDesktopModeIPad = window.navigator?.platform === "MacIntel" &&
    Number(window.navigator?.maxTouchPoints ?? 0) > 1;
  return /MicroMessenger|iPhone|iPad|iPod/i.test(userAgent) || isDesktopModeIPad;
}

function openMobileDownloadWindow() {
  const downloadWindow = window.open("about:blank", "_blank");
  if (!downloadWindow) return null;
  downloadWindow.opener = null;
  try {
    downloadWindow.document.title = "正在准备视频";
    downloadWindow.document.body.textContent = "正在准备视频，请稍候…";
    downloadWindow.document.body.style.cssText = "font:16px/1.5 system-ui,sans-serif;padding:24px;color:#334155";
  } catch {
    // Some embedded browsers deny access to the provisional page; navigation still works.
  }
  return downloadWindow;
}

async function authorizedBioMediaDownloadUrl(
  src: string,
  filename: string,
  options: DownloadMediaOptions,
) {
  const query = new URLSearchParams({
    url: src,
    filename,
    mediaType: options.mediaType === "image" ? "image" : "video",
    stockItemId: String(options.stockItemId ?? ""),
    recordId: String(options.recordId ?? ""),
  });
  const response = await fetch(`/api/bio-records/media-download-url?${query.toString()}`, {
    headers: authHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data?.url !== "string" || !data.url) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data.url as string;
}

export async function downloadMedia(
  src: string | undefined,
  filename: string,
  options: DownloadMediaOptions = {},
): Promise<MediaDownloadResult> {
  if (!src) throw new Error("Missing media URL");
  const sessionKey = mediaAuthSessionKey();
  const assertCurrentSession = () => {
    if (mediaAuthSessionKey() !== sessionKey) throw new Error("登录状态已变化，请重新打开后下载。");
  };
  if (src.startsWith("data:")) {
    triggerDownload(src, filename);
    return { mode: "download" };
  }

  if (options.stockItemId && options.recordId) {
    const useMobileWindow = options.mediaType === "video" && prefersMobileVideoOpen();
    const mobileWindow = useMobileWindow ? openMobileDownloadWindow() : null;
    if (useMobileWindow && !mobileWindow) {
      throw new Error("当前浏览器阻止打开下载页，请允许弹窗或在默认浏览器中打开后重试");
    }
    try {
      const downloadUrl = await authorizedBioMediaDownloadUrl(src, filename, options);
      assertCurrentSession();
      if (mobileWindow && !mobileWindow.closed) {
        mobileWindow.location.replace(downloadUrl);
        return { mode: "mobile-open" };
      }
      triggerDownload(downloadUrl, filename);
      return { mode: "download" };
    } catch (error) {
      mobileWindow?.close();
      throw error;
    }
  }

  const targetUrl = (() => {
    if (!isCosMediaUrl(src)) {
      if (options.mediaType === "video" && src.startsWith("/uploads/")) {
        const query = new URLSearchParams({ wechatVideo: "1" });
        return `${src}?${query.toString()}`;
      }
      return src;
    }
    const query = new URLSearchParams({ url: src });
    if (options.mediaType === "video") query.set("wechatVideo", "1");
    return `/api/media/cos?${query.toString()}`;
  })();
  const response = await fetch(targetUrl, {
    headers: isCosMediaUrl(src) || targetUrl.startsWith("/api/") ? authHeaders() : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  assertCurrentSession();
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return { mode: "download" };
}
