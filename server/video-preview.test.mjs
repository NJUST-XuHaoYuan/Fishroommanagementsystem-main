import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  VIDEO_DERIVATIVE_KINDS,
  publicVideoDerivativeProxyPath,
  verifyPublicVideoDerivativeToken,
  videoDerivativeCacheId,
  videoDerivativeFfmpegArgs,
  videoDerivativeRelativePath,
} from "./video-preview.mjs";

const serverSource = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
const rootDockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const backendDockerfile = await readFile(new URL("../deploy/backend.Dockerfile", import.meta.url), "utf8");
const secret = "video-preview-test-secret";
const source = "https://bucket.cos.ap-shanghai.myqcloud.com/fishroom/original/videos/fish.mp4";

function routeBlock(path) {
  const marker = `if (url.pathname === "${path}"`;
  const start = serverSource.lastIndexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const remaining = serverSource.slice(start + marker.length);
  const nextMatch = /\n\s+if \(url\.pathname === /.exec(remaining);
  const end = nextMatch ? start + marker.length + nextMatch.index : serverSource.length;
  return serverSource.slice(start, end);
}

test("video derivative links are bounded, stable, and bind both source and kind", () => {
  const first = publicVideoDerivativeProxyPath(source, VIDEO_DERIVATIVE_KINDS.preview, {
    secret,
    now: 1_000,
    ttlMs: 5_000,
    bucketMs: 1_000,
  });
  const sameBucket = publicVideoDerivativeProxyPath(source, VIDEO_DERIVATIVE_KINDS.preview, {
    secret,
    now: 1_999,
    ttlMs: 5_000,
    bucketMs: 1_000,
  });
  assert.equal(first, sameBucket);

  const parsed = new URL(first, "https://fishroom.example");
  const token = {
    source: parsed.searchParams.get("url"),
    kind: parsed.searchParams.get("kind"),
    expiresAt: parsed.searchParams.get("expires"),
    signature: parsed.searchParams.get("signature"),
    secret,
    now: 6_999,
  };
  assert.equal(parsed.pathname, "/api/public/media/video-derivative");
  assert.equal(verifyPublicVideoDerivativeToken(token), true);
  assert.equal(verifyPublicVideoDerivativeToken({ ...token, kind: "poster" }), false);
  assert.equal(verifyPublicVideoDerivativeToken({ ...token, source: `${source}?changed=1` }), false);
  assert.equal(verifyPublicVideoDerivativeToken({ ...token, now: 7_000 }), false);
});

test("derived filenames are content-addressed and cannot escape the private cache", () => {
  const id = videoDerivativeCacheId(`cos:fishroom/original/videos/fish.mp4`);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, videoDerivativeCacheId(`cos:fishroom/original/videos/fish.mp4`));
  assert.match(videoDerivativeRelativePath(id, "poster"), /^\.video-derived\/posters\/[a-f0-9]{64}\.jpg$/);
  assert.match(videoDerivativeRelativePath(id, "preview"), /^\.video-derived\/previews\/[a-f0-9]{64}\.mp4$/);
  assert.throws(() => videoDerivativeRelativePath("../escape", "preview"), /缓存标识无效/);
});

test("preview encoding is a short, silent, low-rate mobile MP4 plus a JPEG poster", () => {
  const input = "/tmp/source;touch hacked.mp4";
  const preview = "/tmp/preview.mp4";
  const poster = "/tmp/poster.jpg";
  const args = videoDerivativeFfmpegArgs(input, preview, poster, {
    durationSeconds: 999,
    maxEdge: 9999,
    framesPerSecond: 999,
    bitrateKbps: 9999,
    threads: 99,
  });
  assert.equal(args[args.indexOf("-i") + 1], input, "the path stays one execFile argument");
  assert.equal(args[args.indexOf("-t") + 1], "4");
  assert.equal(args[args.indexOf("-b:v") + 1], "600k");
  assert.equal(args[args.indexOf("-maxrate") + 1], "600k");
  assert.equal(args[args.indexOf("-threads:v") + 1], "2");
  assert.ok(args.includes("+faststart"));
  assert.ok(args.includes("-an"));
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("mjpeg"));
  assert.ok(args.some((value) => value.includes("min(480,iw)") && value.includes("fps=15")));
  assert.equal(args.filter((value) => value === input).length, 1);
  assert.equal(args.at(-1), poster);
  assert.ok(args.indexOf(preview) > args.indexOf("+faststart"));
});

test("both supported backend container paths install ffmpeg", () => {
  assert.match(rootDockerfile, /apk add --no-cache[^\n]*ffmpeg/);
  assert.match(backendDockerfile, /apk add --no-cache[^\n]*ffmpeg/);
});

test("public payload exposes index-aligned derivatives without replacing original detail videos", () => {
  const payloadStart = serverSource.indexOf("function publicBioRecordPayload(");
  const payloadEnd = serverSource.indexOf("function cachedPublicProjection(", payloadStart);
  const payload = serverSource.slice(payloadStart, payloadEnd);
  assert.match(payload, /const videoPosters = videos\.map/);
  assert.match(payload, /const videoPreviews = videos\.map/);
  assert.match(payload, /videos:\s*videos\.map\(publicCatalogMediaUrl\)/);
  assert.match(payload, /videoPosters/);
  assert.match(payload, /videoPreviews/);
});

test("lazy derivative delivery verifies authorization, deduplicates work, streams COS input and supports Range", () => {
  const publicRoute = routeBlock("/api/public/media/video-derivative");
  assert.ok(
    publicRoute.indexOf("verifyPublicVideoDerivativeToken") < publicRoute.indexOf("ensureVideoDerivatives"),
    "authorization must happen before any generation work",
  );
  assert.match(publicRoute, /publicMediaCacheMaxAgeSeconds/);
  assert.match(serverSource, /const videoDerivativeJobs = new Map\(\)/);
  assert.match(serverSource, /const existingJob = videoDerivativeJobs\.get\(paths\.cacheId\)/);
  assert.match(serverSource, /videoPreviewLimiter\.acquire\(\)/);
  assert.match(serverSource, /videoDerivativeFailures\.get\(paths\.cacheId\)/);
  assert.match(serverSource, /VIDEO_DERIVATIVE_FAILURE_BACKOFF_MS/);
  assert.match(serverSource, /client\.headObject\([\s\S]*?contentLength > MAX_VIDEO_UPLOAD_BYTES/);
  assert.match(serverSource, /client\.getObject\([\s\S]*?Output:\s*output/);
  assert.match(serverSource, /createWriteStream\(filePath/);
  assert.match(serverSource, /normalizeSingleByteRange\(req\.headers\.range\)/);
  assert.match(serverSource, /"Accept-Ranges": "bytes"/);
  assert.match(serverSource, /createReadStream\(filePath, \{ start, end \}\)\.pipe\(res\)/);
});

test("new uploads detach preview generation and private cache files have no direct static route", () => {
  const uploadRoute = routeBlock("/api/media/upload");
  const responseIndex = uploadRoute.indexOf("sendJson(req, res, 200");
  const scheduleIndex = uploadRoute.indexOf("scheduleVideoDerivativeGeneration");
  assert.ok(responseIndex >= 0 && scheduleIndex > responseIndex, "preview generation must begin after upload response");
  assert.match(uploadRoute, /derivativeStatus/);
  assert.match(uploadRoute, /posterUrl/);
  assert.match(uploadRoute, /previewUrl/);
  const staticStart = serverSource.indexOf("async function serveUpload(");
  const staticEnd = serverSource.indexOf("let autoOrderTransitionTimer", staticStart);
  const staticBlock = serverSource.slice(staticStart, staticEnd);
  assert.match(staticBlock, /VIDEO_DERIVATIVE_DIRECTORY/);
  assert.match(staticBlock, /Upload file not found/);
});
