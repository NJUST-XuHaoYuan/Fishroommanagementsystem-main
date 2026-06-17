import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "./authSession";

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

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

type ResolveMediaOptions = {
  thumbnailWidth?: number;
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
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const signedUrl = typeof data?.url === "string" ? data.url : "";
  if (!signedUrl) throw new Error("Missing signed media URL");

  signedUrlCache.set(cacheKey, {
    url: signedUrl,
    expiresAt: Date.now() + Math.max(60, Number(data?.expiresIn ?? 3600) - 60) * 1000,
  });
  return signedUrl;
}

export async function uploadOriginalMedia(file: File): Promise<string> {
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

  const response = await fetch("/api/media/upload", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": mime,
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data?.url !== "string") {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data.url;
}

export function useResolvedMediaUrl(src?: string, options: ResolveMediaOptions = {}) {
  const originalSrc = typeof src === "string" ? src : undefined;
  const proxySrc = useMemo(() => cosProxyUrl(originalSrc), [originalSrc]);
  const thumbnailWidth = Number(options.thumbnailWidth || 0);
  const [displaySrc, setDisplaySrc] = useState<string | undefined>(() =>
    proxySrc ? undefined : originalSrc
  );

  useEffect(() => {
    let cancelled = false;
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
    resolveMediaUrl(originalSrc, { thumbnailWidth })
      .then((url) => {
        if (!cancelled) setDisplaySrc(url);
      })
      .catch(() => {
        if (!cancelled) setDisplaySrc(proxySrc);
      });

    return () => {
      cancelled = true;
    };
  }, [originalSrc, proxySrc, thumbnailWidth]);

  return displaySrc;
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

export async function downloadMedia(src: string | undefined, filename: string) {
  if (!src) throw new Error("Missing media URL");
  if (src.startsWith("data:")) {
    triggerDownload(src, filename);
    return;
  }

  const targetUrl = isCosMediaUrl(src)
    ? `/api/media/cos?url=${encodeURIComponent(src)}`
    : src;
  const response = await fetch(targetUrl, {
    headers: isCosMediaUrl(src) || targetUrl.startsWith("/api/") ? authHeaders() : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
