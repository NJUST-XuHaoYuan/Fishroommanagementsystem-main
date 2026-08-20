import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isSafePublicMediaMime,
  publicMediaCacheMaxAgeSeconds,
  publicMediaProxyPath,
  signPublicMediaUrl,
  verifyPublicMediaUrlToken,
} from "./public-media-token.mjs";

const secret = "test-secret-with-enough-entropy";
const mediaUrl = "https://example.cos.ap-shanghai.myqcloud.com/catalog/fish.jpg";
const localServerSource = readFileSync(new URL("./local-server.mjs", import.meta.url), "utf8");

test("valid public media tokens authorize exactly the signed URL before expiry", () => {
  const expiresAt = 10_000;
  const signature = signPublicMediaUrl(mediaUrl, expiresAt, secret);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl, expiresAt, signature, secret, now: 9_999 }), true);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl: `${mediaUrl}?other=1`, expiresAt, signature, secret, now: 9_999 }), false);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl, expiresAt, signature, secret: "wrong", now: 9_999 }), false);
});

test("expired, malformed, and missing public media tokens fail closed", () => {
  const expiresAt = 10_000;
  const signature = signPublicMediaUrl(mediaUrl, expiresAt, secret);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl, expiresAt, signature, secret, now: 10_000 }), false);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl, expiresAt: "tomorrow", signature, secret, now: 1 }), false);
  assert.equal(verifyPublicMediaUrlToken({ mediaUrl, expiresAt, signature: "", secret, now: 1 }), false);
});

test("proxy paths carry a verifiable bounded token", () => {
  const path = publicMediaProxyPath(mediaUrl, {
    secret,
    now: 1_000,
    ttlMs: 5_000,
    bucketMs: 1_000,
  });
  const url = new URL(path, "https://fishroom.example");
  assert.equal(url.searchParams.get("url"), mediaUrl);
  assert.equal(url.searchParams.get("expires"), "7000");
  assert.equal(verifyPublicMediaUrlToken({
    mediaUrl: url.searchParams.get("url"),
    expiresAt: url.searchParams.get("expires"),
    signature: url.searchParams.get("signature"),
    secret,
    now: 6_999,
  }), true);
});

test("proxy paths remain stable within a cache bucket and renew in the next bucket", () => {
  const first = publicMediaProxyPath(mediaUrl, {
    secret,
    now: 1_000,
    ttlMs: 15_000,
    bucketMs: 10_000,
  });
  const sameBucket = publicMediaProxyPath(mediaUrl, {
    secret,
    now: 9_999,
    ttlMs: 15_000,
    bucketMs: 10_000,
  });
  const renewed = publicMediaProxyPath(mediaUrl, {
    secret,
    now: 10_001,
    ttlMs: 15_000,
    bucketMs: 10_000,
  });
  assert.equal(first, sameBucket);
  assert.notEqual(first, renewed);
});

test("public cache lifetime never exceeds the signed token lifetime", () => {
  assert.equal(publicMediaCacheMaxAgeSeconds(20_000, { now: 10_000, maximumSeconds: 600 }), 10);
  assert.equal(publicMediaCacheMaxAgeSeconds(610_000, { now: 10_000, maximumSeconds: 600 }), 600);
  assert.equal(publicMediaCacheMaxAgeSeconds(10_000, { now: 10_000, maximumSeconds: 600 }), 0);
});

test("only passive image and supported video MIME types are public-inline safe", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]) {
    assert.equal(isSafePublicMediaMime(mime), true);
  }
  for (const mime of ["image/svg+xml", "text/html", "application/javascript", "video/html", "application/octet-stream"]) {
    assert.equal(isSafePublicMediaMime(mime), false);
  }
});

test("COS media downloads have a bounded timeout and a limiter lease failsafe", () => {
  assert.match(localServerSource, /COS_REQUEST_TIMEOUT_MS[\s\S]*?120_000[\s\S]*?5_000[\s\S]*?30_000/);
  assert.match(localServerSource, /Timeout:\s*COS_REQUEST_TIMEOUT_MS/);
  assert.match(localServerSource, /getCosClient\("download"\)/);
  assert.match(localServerSource, /leaseTimeoutMs:\s*PUBLIC_MEDIA_LEASE_TIMEOUT_MS/);
  assert.match(localServerSource, /onLeaseExpired:\s*expireMediaOperation/);
});

test("large COS uploads use a separate finite timeout instead of the 30 second download deadline", () => {
  assert.match(localServerSource, /COS_UPLOAD_TIMEOUT_MS[\s\S]*?15 \* 60 \* 1000[\s\S]*?30_000[\s\S]*?5 \* 60 \* 1000/);
  assert.match(localServerSource, /Timeout:\s*COS_UPLOAD_TIMEOUT_MS/);
  assert.match(localServerSource, /getCosClient\("upload"\)/);
});
