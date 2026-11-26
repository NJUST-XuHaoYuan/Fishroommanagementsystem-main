import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const run = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const cloudEnv = { FISHROOM_CLOUD_TEST: "true", PGHOST: "database", PGDATABASE: "fishroom_test", PGUSER: "fishroom_test", PGPORT: "5432", DATABASE_URL: "", PGHOSTADDR: "" };
const digest = value => createHash("sha256").update(value).digest("hex");

test("preserved upload requires auth and rejects invalid flags or forged video before storage", async t => {
  const s = await startMutableRouteServer(structuredClone(stockPricingFixture), { env: cloudEnv }); t.after(() => s.stop());
  const token = await s.login("pricing-admin", PRICING_TEST_PASSWORD);
  const send = (headers = {}) => fetch(s.baseUrl + "/api/media/upload", { method: "POST", headers: { "Content-Type": "video/mp4", "X-Preserve-Original": "1", ...headers }, body: "not a video" });
  assert.equal((await send()).status, 401);
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await send(auth)).status, 400);
  assert.equal((await send({ ...auth, "X-Preserve-Original": "true" })).status, 400);
  assert.equal((await send({ ...auth, "Content-Type": "image/png" })).status, 400);
  assert.equal((await fetch(s.baseUrl + "/api/media/video-playback?url=%2Fuploads%2Foriginal%2Fvideos%2Fa.mp4")).status, 401);
  for (const url of ["https://outside.invalid/video.mp4", "/uploads/.personnel-private/file.mp4", "/uploads/../private.mp4"]) {
    const r = await fetch(s.baseUrl + "/api/media/video-playback?" + new URLSearchParams({ url }), { headers: auth });
    assert.equal(r.status, 400);
  }
});

test("4K original survives upload and reopen byte-for-byte while compatibility copy remains separate", async t => {
  try { await run(ffmpeg, ["-version"]); await run(ffprobe, ["-version"]); }
  catch { t.skip("Run this test in the backend image with ffmpeg and ffprobe installed"); return; }
  const dir = await mkdtemp(join(tmpdir(), "original-video-route-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "source.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=3840x2160:r=1", "-t", "1", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", input]);
  const bytes = await readFile(input);
  const s = await startMutableRouteServer(structuredClone(stockPricingFixture), { env: { ...cloudEnv, TRANSCODE_VIDEO_UPLOADS: "true", FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe } }); t.after(() => s.stop());
  const login = await s.request("/api/auth/login", { body: { username: "pricing-admin", password: PRICING_TEST_PASSWORD } });
  const headers = { Cookie: login.response.headers.get("set-cookie").split(";", 1)[0] };
  const r = await fetch(s.baseUrl + "/api/media/upload", { method: "POST", headers: { ...headers, "Content-Type": "video/mp4", "X-File-Name": "4k.mp4", "X-Preserve-Original": "1" }, body: bytes });
  const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result));
  assert.equal(result.originalPreserved, true); assert.equal(result.processingMode, "original-preserved");
  assert.equal(result.videoMetadata.width, 3840); assert.equal(result.videoMetadata.height, 2160);
  assert.equal(result.size, bytes.length); assert.equal(result.storedSize, bytes.length);
  const original = await fetch(s.baseUrl + result.url, { headers }); assert.equal(original.status, 200);
  assert.equal(digest(Buffer.from(await original.arrayBuffer())), digest(bytes));
  const playback = await fetch(s.baseUrl + "/api/media/video-playback?" + new URLSearchParams({ url: result.url }), { headers: { ...headers, Range: "bytes=0-127" } });
  assert.equal(playback.status, 206); assert.equal(playback.headers.get("cache-control"), "no-store, private");
  const after = await fetch(s.baseUrl + result.url, { headers }); assert.equal(digest(Buffer.from(await after.arrayBuffer())), digest(bytes));
  const historical = await fetch(s.baseUrl + "/api/media/upload", { method: "POST", headers: { ...headers, "Content-Type": "video/mp4", "X-File-Name": "legacy.mp4" }, body: bytes });
  const oldResult = await historical.json(); assert.equal(historical.status, 200, JSON.stringify(oldResult));
  assert.equal(oldResult.originalPreserved, false); assert.equal(oldResult.processingMode, "transcode");
  assert.notEqual(oldResult.url, result.url);
});
