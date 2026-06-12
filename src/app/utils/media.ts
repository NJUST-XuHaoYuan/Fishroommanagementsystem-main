import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "./authSession";

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

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

export async function resolveMediaUrl(src?: string) {
  if (!src) return undefined;
  if (!isCosMediaUrl(src)) return src;

  const cached = signedUrlCache.get(src);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;

  const response = await fetch(`/api/media/cos-url?url=${encodeURIComponent(src)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const signedUrl = typeof data?.url === "string" ? data.url : "";
  if (!signedUrl) throw new Error("Missing signed media URL");

  signedUrlCache.set(src, {
    url: signedUrl,
    expiresAt: Date.now() + Math.max(60, Number(data?.expiresIn ?? 3600) - 60) * 1000,
  });
  return signedUrl;
}

export function useResolvedMediaUrl(src?: string) {
  const originalSrc = typeof src === "string" ? src : undefined;
  const proxySrc = useMemo(() => cosProxyUrl(originalSrc), [originalSrc]);
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
    resolveMediaUrl(originalSrc)
      .then((url) => {
        if (!cancelled) setDisplaySrc(url);
      })
      .catch(() => {
        if (!cancelled) setDisplaySrc(proxySrc);
      });

    return () => {
      cancelled = true;
    };
  }, [originalSrc, proxySrc]);

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
