import type { VideoHTMLAttributes } from "react";
import { useResolvedMediaUrl } from "../utils/media";

type MediaVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & {
  src?: string;
};

export function MediaVideo({ src, ...props }: MediaVideoProps) {
  const resolvedSrc = useResolvedMediaUrl(src);
  return <video src={resolvedSrc} {...props} />;
}
