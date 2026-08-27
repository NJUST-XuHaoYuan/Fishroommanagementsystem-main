import assert from "node:assert/strict";
import test from "node:test";
import {
  canFastRemuxWechatVideo,
  normalizeVideoTranscodePreset,
} from "./video-upload-rules.mjs";

function probe(overrides = {}) {
  return {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        pix_fmt: "yuv420p",
        width: 1280,
        height: 720,
        ...overrides,
      },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };
}

test("fast-remuxes an already WeChat-compatible H.264/AAC video", () => {
  assert.equal(canFastRemuxWechatVideo(probe(), 1920), true);
});

test("transcodes incompatible codecs, pixel formats and oversized videos", () => {
  assert.equal(canFastRemuxWechatVideo(probe({ codec_name: "hevc" }), 1920), false);
  assert.equal(canFastRemuxWechatVideo(probe({ pix_fmt: "yuv422p" }), 1920), false);
  assert.equal(canFastRemuxWechatVideo(probe({ width: 2160, height: 3840 }), 1920), false);
  assert.equal(canFastRemuxWechatVideo({
    streams: [...probe().streams, { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 320, height: 240 }],
  }, 1920), false);
});

test("transcodes when an audio stream cannot be copied into the target MP4", () => {
  const value = probe();
  value.streams[1].codec_name = "opus";
  assert.equal(canFastRemuxWechatVideo(value, 1920), false);
});

test("uses only an allowlisted ffmpeg preset", () => {
  assert.equal(normalizeVideoTranscodePreset("veryfast"), "veryfast");
  assert.equal(normalizeVideoTranscodePreset(" SUPERFAST "), "superfast");
  assert.equal(normalizeVideoTranscodePreset("; rm -rf /"), "superfast");
});
