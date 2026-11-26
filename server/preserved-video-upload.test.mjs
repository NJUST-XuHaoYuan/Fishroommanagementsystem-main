import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPreservedVideoFile, preserveOriginalVideoRequested, summarizePreservedVideo } from "./preserved-video-upload.mjs";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const probe = (overrides = {}) => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.1" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 3840, height: 2160, ...overrides }] });

test("preservation is explicit and valid only for a video upload", () => {
  assert.equal(preserveOriginalVideoRequested(undefined, true), false);
  assert.equal(preserveOriginalVideoRequested("1", true), true);
  for (const value of ["true", "0", ["1"], "1, 1"]) assert.throws(() => preserveOriginalVideoRequested(value, true));
  assert.throws(() => preserveOriginalVideoRequested("1", false));
});

test("accepts 4K and accounts for display rotation without changing encoded dimensions", () => {
  assert.deepEqual(summarizePreservedVideo(probe({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }), "video/mp4"), {
    width: 2160, height: 3840, encodedWidth: 3840, encodedHeight: 2160, durationSeconds: 2.1, codec: "h264",
  });
  assert.equal(summarizePreservedVideo(probe({ codec_name: "hevc" }), "video/quicktime").codec, "hevc");
});

test("rejects invalid track, format, duration, unknown codecs and excessive dimensions", () => {
  for (const patch of [{ width: 0 }, { height: "N/A" }, { width: 16384 }, { codec_name: "none" }, { disposition: { attached_pic: 1 } }]) {
    assert.throws(() => summarizePreservedVideo(probe(patch), "video/mp4"));
  }
  for (const duration of [0, -1, 7201, "Infinity", "N/A"]) {
    const value = probe(); value.format.duration = duration;
    assert.throws(() => summarizePreservedVideo(value, "video/mp4"));
  }
  const wrong = probe(); wrong.format.format_name = "hls";
  assert.throws(() => summarizePreservedVideo(wrong, "video/mp4"));
  const webm = probe({ codec_name: "vp9" }); webm.format = { format_name: "matroska,webm" };
  assert.equal(summarizePreservedVideo(webm, "video/webm").durationSeconds, null);
});

test("real 4K input validates without any byte changes; corrupt and unavailable-tool errors are safe", async t => {
  try { await run(ffmpeg, ["-version"]); await run(ffprobe, ["-version"]); }
  catch { t.skip("Run this test in the backend image with ffmpeg and ffprobe installed"); return; }
  const dir = await mkdtemp(join(tmpdir(), "original-video-validation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "source.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=3840x2160:r=1", "-t", "1", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", input]);
  const sha = async () => createHash("sha256").update(await readFile(input)).digest("hex");
  const before = await sha();
  const metadata = await inspectPreservedVideoFile(input, "video/mp4", { ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  assert.equal(metadata.width, 3840); assert.equal(metadata.height, 2160); assert.equal(await sha(), before);
  await assert.rejects(inspectPreservedVideoFile(input, "video/mp4", { ffprobePath: "/missing/ffprobe" }), error => error.statusCode === 503 && !error.message.includes(input));
  const corrupt = join(dir, "corrupt.mp4");
  await writeFile(corrupt, "#EXTM3U\nhttp://127.0.0.1/private");
  await assert.rejects(inspectPreservedVideoFile(corrupt, "video/mp4"), error => error.statusCode === 400);
  await writeFile(corrupt, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom000000000000000000")]));
  await assert.rejects(inspectPreservedVideoFile(corrupt, "video/mp4", { ffprobePath: ffprobe }), error => error.statusCode === 400 && !error.message.includes(corrupt));
});

test("real HEVC MOV and duration-less MediaRecorder-style WebM retain their original bytes", async t => {
  try { await run(ffmpeg, ["-version"]); await run(ffprobe, ["-version"]); }
  catch { t.skip("Run this test in the backend image with ffmpeg and ffprobe installed"); return; }
  const dir = await mkdtemp(join(tmpdir(), "original-video-formats-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sample of [
    { name: "iphone.mov", mime: "video/quicktime", codec: "hevc", args: ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=none:frame-threads=1:log-level=error", "-tag:v", "hvc1"] },
    { name: "recorder.webm", mime: "video/webm", codec: "vp8", args: ["-c:v", "libvpx", "-deadline", "realtime", "-live", "1"] },
  ]) {
    const input = join(dir, sample.name);
    await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1920x1080:r=1", "-t", "1", "-threads", "1", ...sample.args, input]);
    const before = await readFile(input);
    const metadata = await inspectPreservedVideoFile(input, sample.mime, { ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    assert.equal(metadata.width, 1920); assert.equal(metadata.height, 1080); assert.equal(metadata.codec, sample.codec);
    if (sample.mime === "video/webm") assert.equal(metadata.durationSeconds, null);
    assert.deepEqual(await readFile(input), before);
  }
});
