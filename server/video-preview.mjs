import { createHash } from "node:crypto";
import {
  PUBLIC_MEDIA_TOKEN_BUCKET_MS,
  PUBLIC_MEDIA_TOKEN_TTL_MS,
  signPublicMediaUrl,
  verifyPublicMediaUrlToken,
} from "./public-media-token.mjs";

export const VIDEO_DERIVATIVE_DIRECTORY = ".video-derived";
export const VIDEO_DERIVATIVE_KINDS = Object.freeze({
  poster: "poster",
  preview: "preview",
});

const VIDEO_DERIVATIVE_TOKEN_DOMAIN = "fishroom-video-derivative-v1";
const MAX_SOURCE_REFERENCE_LENGTH = 4096;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeVideoDerivativeKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  return kind === VIDEO_DERIVATIVE_KINDS.poster || kind === VIDEO_DERIVATIVE_KINDS.preview
    ? kind
    : "";
}

export function normalizeVideoDerivativeSource(value) {
  const source = String(value ?? "").trim();
  if (!source || source.length > MAX_SOURCE_REFERENCE_LENGTH || source.includes("\0")) return "";
  return source;
}

export function videoDerivativeTokenSubject(sourceValue, kindValue) {
  const source = normalizeVideoDerivativeSource(sourceValue);
  const kind = normalizeVideoDerivativeKind(kindValue);
  if (!source || !kind) return "";
  return `${VIDEO_DERIVATIVE_TOKEN_DOMAIN}\0${kind}\0${source}`;
}

export function publicVideoDerivativeProxyPath(
  sourceValue,
  kindValue,
  {
    secret,
    now = Date.now(),
    ttlMs = PUBLIC_MEDIA_TOKEN_TTL_MS,
    bucketMs = PUBLIC_MEDIA_TOKEN_BUCKET_MS,
  } = {},
) {
  const source = normalizeVideoDerivativeSource(sourceValue);
  const kind = normalizeVideoDerivativeKind(kindValue);
  const subject = videoDerivativeTokenSubject(source, kind);
  if (!subject) throw new Error("公开视频预览签名参数不完整");
  const bucket = Math.max(1, Math.floor(Number(bucketMs) || 1));
  const bucketStart = Math.floor(Number(now) / bucket) * bucket;
  const expiresAt = Math.floor(bucketStart + Number(ttlMs) + bucket);
  const signature = signPublicMediaUrl(subject, expiresAt, secret);
  const params = new URLSearchParams({
    url: source,
    kind,
    expires: String(expiresAt),
    signature,
  });
  return `/api/public/media/video-derivative?${params.toString()}`;
}

export function verifyPublicVideoDerivativeToken({
  source,
  kind,
  expiresAt,
  signature,
  secret,
  now = Date.now(),
} = {}) {
  const subject = videoDerivativeTokenSubject(source, kind);
  return Boolean(subject) && verifyPublicMediaUrlToken({
    mediaUrl: subject,
    expiresAt,
    signature,
    secret,
    now,
  });
}

export function videoDerivativeCacheId(sourceIdentity) {
  const identity = normalizeVideoDerivativeSource(sourceIdentity);
  if (!identity) throw new Error("视频预览来源无效");
  return createHash("sha256").update(identity).digest("hex");
}

export function videoDerivativeRelativePath(cacheIdValue, kindValue) {
  const cacheId = String(cacheIdValue ?? "").trim().toLowerCase();
  const kind = normalizeVideoDerivativeKind(kindValue);
  if (!/^[a-f0-9]{64}$/.test(cacheId) || !kind) throw new Error("视频预览缓存标识无效");
  return kind === VIDEO_DERIVATIVE_KINDS.poster
    ? `${VIDEO_DERIVATIVE_DIRECTORY}/posters/${cacheId}.jpg`
    : `${VIDEO_DERIVATIVE_DIRECTORY}/previews/${cacheId}.mp4`;
}

export function videoDerivativeFfmpegArgs(
  inputPath,
  previewOutputPath,
  posterOutputPath,
  options = {},
) {
  const durationSeconds = boundedInteger(options.durationSeconds, 4, 3, 4);
  const maxEdge = boundedInteger(options.maxEdge, 480, 360, 480);
  const framesPerSecond = boundedInteger(options.framesPerSecond, 12, 12, 15);
  const bitrateKbps = boundedInteger(options.bitrateKbps, 450, 300, 600);
  const maxBitrateKbps = boundedInteger(
    options.maxBitrateKbps,
    Math.max(600, bitrateKbps),
    bitrateKbps,
    800,
  );
  const threads = boundedInteger(options.threads, 1, 1, 2);
  const scale = `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

  // Input/output paths remain individual execFile arguments. They are never
  // interpolated into a shell command, so filenames cannot inject ffmpeg flags.
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-filter_threads",
    String(threads),
    "-ss",
    "0.25",
    "-i",
    String(inputPath),
    "-map",
    "0:v:0",
    "-t",
    String(durationSeconds),
    "-an",
    "-c:v",
    "libx264",
    "-threads:v",
    String(threads),
    "-preset",
    "veryfast",
    "-b:v",
    `${bitrateKbps}k`,
    "-maxrate",
    `${maxBitrateKbps}k`,
    "-bufsize",
    `${maxBitrateKbps * 2}k`,
    "-vf",
    `${scale},fps=${framesPerSecond}`,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main",
    "-level",
    "3.0",
    "-movflags",
    "+faststart",
    String(previewOutputPath),
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-an",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-vf",
    scale,
    String(posterOutputPath),
  ];
}
