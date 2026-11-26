/** Build a same-origin authenticated route only for managed original media. */
export function videoPlaybackFallbackUrl(source) {
  if (typeof source !== "string" || source.length > 4096) return "";
  const value = source.trim();
  const local = /^\/uploads\/original\/videos\/[a-f0-9]+\.(?:mp4|mov|webm|m4v|3gp|3g2)$/i.test(value);
  let cos = false;
  try {
    const url = new URL(value);
    cos = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      url.hostname.endsWith(".myqcloud.com") && url.hostname.includes(".cos.") &&
      /\/original\/videos\/[^/]+\.(?:mp4|mov|webm|m4v|3gp|3g2)$/i.test(url.pathname);
  } catch { /* Local paths intentionally have no URL origin. */ }
  return local || cos ? `/api/media/video-playback?${new URLSearchParams({ url: value })}` : "";
}

export function shouldUseVideoPlaybackFallback(errorCode) {
  // Network failure or cancellation must not silently lower quality.
  return errorCode === 3 || errorCode === 4;
}
