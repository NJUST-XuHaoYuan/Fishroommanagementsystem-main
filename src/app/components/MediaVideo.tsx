import { useState, type VideoHTMLAttributes } from "react";
import { useResolvedMediaUrl } from "../utils/media";
import { shouldUseVideoPlaybackFallback, videoPlaybackFallbackUrl } from "../utils/videoPlaybackFallback.mjs";

type MediaVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & {
  src?: string;
  allowCompatibilityFallback?: boolean;
};

export function MediaVideo({ src, allowCompatibilityFallback = false, onError, onLoadedMetadata, ...props }: MediaVideoProps) {
  const resolvedSrc = useResolvedMediaUrl(src);
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  const [fallbackReadyFor, setFallbackReadyFor] = useState<string | null>(null);
  const fallback = allowCompatibilityFallback && src && fallbackFor === src ? videoPlaybackFallbackUrl(src) : "";
  return <>
    <video {...props} src={fallback || resolvedSrc}
      onLoadedMetadata={event => { if (fallback && src) setFallbackReadyFor(src); onLoadedMetadata?.(event); }}
      onError={event => {
        if (allowCompatibilityFallback && !fallback && src && videoPlaybackFallbackUrl(src) &&
            shouldUseVideoPlaybackFallback(event.currentTarget.error?.code)) { setFallbackFor(src); return; }
        onError?.(event);
      }} />
    {fallback && <p role="status" className="mt-2 text-center text-sm text-muted-foreground">{fallbackReadyFor === src ? "兼容播放 · 原视频仍保留" : "正在准备兼容播放，原视频仍保留…"}</p>}
  </>;
}
