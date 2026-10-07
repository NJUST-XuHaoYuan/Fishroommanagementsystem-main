import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeSingleByteRange } from "./media-range.mjs";
import {
  VIDEO_DERIVATIVE_KINDS,
  publicVideoDerivativeProxyPath,
  verifyPublicVideoDerivativeToken,
  videoDerivativeCacheId,
  videoDerivativeFfmpegArgs,
  videoDerivativeRelativePath,
  videoPlaybackFfmpegArgs,
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

test("full playback has an independent private path and cannot reuse a preview authorization", () => {
  assert.equal(VIDEO_DERIVATIVE_KINDS.playback, "playback");
  const id = videoDerivativeCacheId(`cos:fishroom/original/videos/fish.mp4`);
  assert.equal(videoDerivativeRelativePath(id, "playback"), `.video-derived/playbacks/${id}.mp4`);
  assert.notEqual(videoDerivativeRelativePath(id, "playback"), videoDerivativeRelativePath(id, "preview"));
  assert.throws(() => videoDerivativeRelativePath("../escape", "playback"), /缓存标识无效/);
  assert.throws(() => videoDerivativeRelativePath(id, "unknown"), /缓存标识无效/);

  const tokens = {};
  for (const kind of ["playback", "preview"]) {
    const url = new URL(publicVideoDerivativeProxyPath(source, kind, {
      secret, now: 1000, ttlMs: 5000, bucketMs: 1000,
    }), "https://fishroom.example");
    const token = {
      source: url.searchParams.get("url"), kind: url.searchParams.get("kind"),
      expiresAt: url.searchParams.get("expires"), signature: url.searchParams.get("signature"),
      secret, now: 6999,
    };
    assert.equal(url.pathname, "/api/public/media/video-derivative");
    assert.equal(token.kind, kind);
    assert.equal(verifyPublicVideoDerivativeToken(token), true);
    assert.equal(verifyPublicVideoDerivativeToken({ ...token, kind: kind === "preview" ? "playback" : "preview" }), false);
    assert.equal(verifyPublicVideoDerivativeToken({ ...token, source: `${source}?changed=1` }), false);
    assert.equal(verifyPublicVideoDerivativeToken({ ...token, now: 7000 }), false);
    tokens[kind] = token;
  }
  assert.notEqual(tokens.playback.signature, tokens.preview.signature);
});

test("playback encodes the complete video with bounded mobile video and optional audio", () => {
  const input = "/tmp/full source;touch forbidden.mp4";
  const output = "/tmp/full playback.mp4";
  const args = videoPlaybackFfmpegArgs(input, output);
  const flag = (name) => args[args.indexOf(name) + 1];
  const maps = args.flatMap((arg, index) => arg === "-map" ? [args[index + 1]] : []);
  assert.equal(flag("-i"), input);
  assert.equal(args.filter((arg) => arg === input).length, 1);
  assert.equal(args.at(-1), output);
  assert.ok(!args.includes("-ss"), "playback must retain the beginning of the source");
  assert.ok(!args.includes("-t"), "playback must retain the full source duration");
  assert.ok(!args.includes("-an"), "optional source audio is kept by default");
  assert.deepEqual(maps, ["0:v:0", "0:a:0?"]);
  assert.equal(flag("-c:v"), "libx264");
  assert.equal(flag("-profile:v"), "main");
  assert.equal(flag("-pix_fmt"), "yuv420p");
  assert.equal(flag("-b:v"), "750k");
  assert.equal(flag("-maxrate"), "900k");
  assert.equal(flag("-c:a"), "aac");
  assert.equal(flag("-b:a"), "64k");
  assert.ok(flag("-movflags").includes("+faststart"));
  const filter = flag("-vf").replace(/[\\'"]/g, "");
  assert.ok(filter.includes("min(720,iw)") && filter.includes("min(720,ih)"));
  assert.ok(filter.includes("fps=min(30,source_fps)"), "low-frame-rate sources must not be upsampled to 30 fps");
  assert.ok(filter.includes("force_original_aspect_ratio=decrease"));
});

test("playback caps encoder threads and respects probed audio stream identity", () => {
  for (const [threads, expected] of [[-1, "1"], [0, "1"], [1, "1"], [2, "2"], [99, "2"]]) {
    const args = videoPlaybackFfmpegArgs("/tmp/in.mp4", "/tmp/out.mp4", { threads });
    assert.equal(args[args.indexOf("-threads:v") + 1], expected);
  }
  for (const audioStreamIndex of [0, 3]) {
    const args = videoPlaybackFfmpegArgs("/tmp/in.mp4", "/tmp/out.mp4", { audioStreamIndex });
    const maps = args.flatMap((arg, index) => arg === "-map" ? [args[index + 1]] : []);
    assert.deepEqual(maps, ["0:v:0", `0:${audioStreamIndex}`]);
    assert.ok(!args.includes("-an"));
    assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  }
  const silent = videoPlaybackFfmpegArgs("/tmp/in.mp4", "/tmp/out.mp4", { audioStreamIndex: null });
  assert.ok(silent.includes("-an"));
  assert.deepEqual(silent.flatMap((arg, index) => arg === "-map" ? [silent[index + 1]] : []), ["0:v:0"]);
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
  assert.match(payload, /const videoPlaybacks = videos\.map/);
  assert.match(payload, /videos:\s*videos\.map\(publicCatalogMediaUrl\)/);
  assert.match(payload, /videoPosters/);
  assert.match(payload, /videoPreviews/);
  assert.match(payload, /videoPlaybacks/);
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
  assert.match(serverSource, /await pipeline\(createReadStream\(filePath, \{ start, end \}\), res\)/);
  assert.match(publicRoute, /if \(res\.headersSent\)\s*\{\s*res\.destroy\(\)/);
});

test("new uploads detach preview generation and private cache files have no direct static route", () => {
  const uploadRoute = routeBlock("/api/media/upload");
  const responseIndex = uploadRoute.indexOf("sendJson(req, res, 200");
  const scheduleIndex = uploadRoute.indexOf("scheduleVideoDerivativeGeneration");
  assert.ok(responseIndex >= 0 && scheduleIndex > responseIndex, "preview generation must begin after upload response");
  assert.match(uploadRoute, /derivativeStatus/);
  assert.match(uploadRoute, /posterUrl/);
  assert.match(uploadRoute, /previewUrl/);
  assert.match(uploadRoute, /playbackUrl/);
  const staticStart = serverSource.indexOf("async function serveUpload(");
  const staticEnd = serverSource.indexOf("let autoOrderTransitionTimer", staticStart);
  const staticBlock = serverSource.slice(staticStart, staticEnd);
  assert.match(staticBlock, /VIDEO_DERIVATIVE_DIRECTORY/);
  assert.match(staticBlock, /Upload file not found/);
});

function derivativeSender(createSource, size) {
  const start = serverSource.indexOf("async function sendVideoDerivativeFile(");
  const end = serverSource.indexOf("async function externalizeDataUrl(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(`${serverSource.slice(start, end)}\nsendVideoDerivativeFile;`, {
    stat: async () => ({ size }),
    createReadStream: createSource,
    normalizeSingleByteRange,
    VIDEO_DERIVATIVE_KINDS,
    pipeline,
  });
}

function derivativeResponse(write) {
  const response = new Writable({ write });
  response.writeHead = (status, headers) => {
    response.headersSent = true;
    response.statusCode = status;
    response.headers = headers;
  };
  return response;
}

test("derivative delivery streams the requested range and completes its file stream", async () => {
  const contents = Buffer.from("complete-playback");
  let input;
  const chunks = [];
  const send = derivativeSender((path, range) => {
    assert.equal(path, "/private/playback.mp4");
    assert.equal(range.start, 2);
    assert.equal(range.end, 6);
    input = Readable.from([contents.subarray(range.start, range.end + 1)]);
    return input;
  }, contents.length);
  const response = derivativeResponse((chunk, encoding, callback) => { chunks.push(chunk); callback(); });
  await send({ method: "GET", headers: { range: "bytes=2-6" } }, response, "/private/playback.mp4", "playback", "public, max-age=60");
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["Content-Range"], `bytes 2-6/${contents.length}`);
  assert.equal(Buffer.concat(chunks).toString(), contents.subarray(2, 7).toString());
  assert.equal(input.destroyed, true);
  assert.equal(response.writableFinished, true);
});

test("a disconnected playback client destroys the open file stream", async () => {
  let input;
  const send = derivativeSender(() => {
    input = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
    return input;
  }, 64 * 1024 * 1024);
  const response = derivativeResponse(function (chunk, encoding, callback) {
    this.destroy();
    callback();
  });
  await assert.rejects(send({ method: "GET", headers: {} }, response, "/private/playback.mp4", "playback", "no-store"),
    (error) => error.code === "ERR_STREAM_PREMATURE_CLOSE");
  assert.equal(input.destroyed, true, "disconnect must release the source rather than leave a paused read stream");
  assert.equal(response.destroyed, true);
});

test("a playback file read failure rejects through the route instead of emitting an unhandled stream error", async () => {
  let input;
  const send = derivativeSender(() => {
    input = new Readable({ read() { this.destroy(new Error("disk read failed")); } });
    return input;
  }, 1024);
  const response = derivativeResponse((chunk, encoding, callback) => callback());
  await assert.rejects(send({ method: "GET", headers: {} }, response, "/private/playback.mp4", "playback", "no-store"), /disk read failed/);
  assert.equal(input.destroyed, true);
  assert.equal(response.destroyed, true);
});

test("detached generation retains the uploaded source until preview and playback have both settled", async (t) => {
  const start = serverSource.indexOf("function scheduleVideoDerivativeGeneration(");
  const end = serverSource.indexOf("async function sendVideoDerivativeFile(", start);
  assert.ok(start >= 0 && end > start);
  const scheduleSource = serverSource.slice(start, end);
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  for (const [previewFails, playbackFails] of [[false, false], [true, false], [false, true]]) {
    await t.test(`preview ${previewFails ? "fails" : "succeeds"}, playback ${playbackFails ? "fails" : "succeeds"}`, async () => {
      const preview = deferred();
      const playback = deferred();
      const immediateCallbacks = [];
      const calls = [];
      const warnings = [];
      const cleanupCalls = [];
      const sourcePath = "/tmp/upload-job/original.mp4";
      const cleanupDir = "/tmp/upload-job";
      const schedule = runInNewContext(`${scheduleSource}\nscheduleVideoDerivativeGeneration;`, {
        setImmediate: (callback) => immediateCallbacks.push(callback),
        ensureVideoDerivatives: (value, options) => {
          calls.push({ kind: "preview", source: value, sourcePath: options.sourcePath });
          return preview.promise;
        },
        ensureVideoPlayback: (value, options) => {
          calls.push({ kind: "playback", source: value, sourcePath: options.sourcePath });
          return playback.promise;
        },
        rm: async (path, options) => cleanupCalls.push({ path, recursive: options.recursive, force: options.force }),
        console: { warn: (message) => warnings.push(message) },
      });

      schedule(source, sourcePath, cleanupDir);
      assert.equal(immediateCallbacks.length, 1);
      assert.equal(calls.length, 0, "generation stays detached from the upload response");
      immediateCallbacks[0]();
      assert.deepEqual(calls, [{ kind: "preview", source, sourcePath }]);
      assert.equal(cleanupCalls.length, 0);

      if (previewFails) preview.reject(new Error("preview failed"));
      else preview.resolve({});
      await new Promise(setImmediate);
      assert.deepEqual(calls, [
        { kind: "preview", source, sourcePath },
        { kind: "playback", source, sourcePath },
      ], "playback receives the same source after preview settles, including preview failure");
      assert.equal(cleanupCalls.length, 0, "the full playback still owns the upload source");

      if (playbackFails) playback.reject(new Error("playback failed"));
      else playback.resolve({});
      await new Promise(setImmediate);
      assert.deepEqual(cleanupCalls, [{ path: cleanupDir, recursive: true, force: true }]);
      assert.equal(warnings.length, Number(previewFails) + Number(playbackFails));
    });
  }
});
