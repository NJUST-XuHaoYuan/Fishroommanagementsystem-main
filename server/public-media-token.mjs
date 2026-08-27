import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_DOMAIN = "fishroom-public-media-v1";
export const PUBLIC_MEDIA_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PUBLIC_MEDIA_TOKEN_BUCKET_MS = 10 * 60 * 1000;
export const PUBLIC_MEDIA_CACHE_MAX_AGE_SECONDS = 10 * 60;

const SAFE_PUBLIC_MEDIA_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/3gpp",
  "video/3gpp2",
]);

function normalizedExpiry(value) {
  const expiresAt = Number(value);
  return Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : 0;
}

function tokenPayload(mediaUrl, expiresAt) {
  return `${TOKEN_DOMAIN}\0${expiresAt}\0${String(mediaUrl ?? "").trim()}`;
}

export function signPublicMediaUrl(mediaUrl, expiresAt, secret) {
  const url = String(mediaUrl ?? "").trim();
  const expiry = normalizedExpiry(expiresAt);
  const key = String(secret ?? "");
  if (!url || !expiry || !key) throw new Error("公开媒体签名参数不完整");
  return createHmac("sha256", key).update(tokenPayload(url, expiry)).digest("base64url");
}

export function verifyPublicMediaUrlToken({ mediaUrl, expiresAt, signature, secret, now = Date.now() } = {}) {
  const url = String(mediaUrl ?? "").trim();
  const expiry = normalizedExpiry(expiresAt);
  const actual = String(signature ?? "").trim();
  if (!url || !expiry || !actual || expiry <= Number(now)) return false;
  let expected = "";
  try {
    expected = signPublicMediaUrl(url, expiry, secret);
  } catch {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function publicMediaCacheMaxAgeSeconds(
  expiresAt,
  { now = Date.now(), maximumSeconds = PUBLIC_MEDIA_CACHE_MAX_AGE_SECONDS } = {}
) {
  const expiry = normalizedExpiry(expiresAt);
  const remainingSeconds = Math.floor((expiry - Number(now)) / 1000);
  return Math.max(0, Math.min(Number(maximumSeconds) || 0, remainingSeconds));
}

export function isSafePublicMediaMime(value) {
  const mime = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return SAFE_PUBLIC_MEDIA_MIMES.has(mime);
}

export function publicMediaProxyPath(
  mediaUrl,
  {
    secret,
    now = Date.now(),
    ttlMs = PUBLIC_MEDIA_TOKEN_TTL_MS,
    bucketMs = PUBLIC_MEDIA_TOKEN_BUCKET_MS,
  } = {}
) {
  const url = String(mediaUrl ?? "").trim();
  const bucket = Math.max(1, Math.floor(Number(bucketMs) || 1));
  const bucketStart = Math.floor(Number(now) / bucket) * bucket;
  const expiresAt = Math.floor(bucketStart + Number(ttlMs) + bucket);
  const signature = signPublicMediaUrl(url, expiresAt, secret);
  const params = new URLSearchParams({ url, expires: String(expiresAt), signature });
  return `/api/public/media/cos?${params.toString()}`;
}
