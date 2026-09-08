import assert from "node:assert/strict";
import test from "node:test";
import {
  canFastRemuxWechatVideo,
  normalizeVideoTranscodePreset,
  selectWechatAudioStream,
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

test("selects the default usable audio stream before an earlier usable stream", () => {
  assert.deepEqual(selectWechatAudioStream({
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "opus", disposition: { default: 0 } },
      { index: 2, codec_type: "audio", codec_name: " AAC ", disposition: { default: 1 } },
    ],
  }), {
    index: 2,
    codecName: "aac",
    isDefault: true,
  });
});

test("selects the first usable audio stream and skips empty or unknown codecs", () => {
  assert.deepEqual(selectWechatAudioStream({
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "" },
      { index: 2, codec_type: "audio", codec_name: "NONE", disposition: { default: 1 } },
      { index: 3, codec_type: "audio", codec_name: " unknown " },
      { index: 4, codec_type: "audio", codec_name: "empty" },
      { index: 5, codec_type: "audio", codec_name: "aac" },
      { index: 6, codec_type: "audio", codec_name: "opus" },
    ],
  }), {
    index: 5,
    codecName: "aac",
    isDefault: false,
  });
});

test("returns no selected audio stream when the video is silent or all audio codecs are unusable", () => {
  assert.equal(selectWechatAudioStream({
    streams: [{ index: 0, codec_type: "video", codec_name: "h264" }],
  }), null);
  assert.equal(selectWechatAudioStream({
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "none" },
      { index: 2, codec_type: "audio" },
    ],
  }), null);
});

test("fast remux only evaluates the selected audio stream", () => {
  const compatible = probe();
  compatible.streams[1] = {
    index: 1,
    codec_type: "audio",
    codec_name: "aac",
    disposition: { default: 1 },
  };
  compatible.streams.push(
    { index: 2, codec_type: "audio", codec_name: "none" },
    { index: 3, codec_type: "audio", codec_name: "opus" },
  );
  assert.equal(canFastRemuxWechatVideo(compatible, 1920), true);

  const unsupportedDefault = probe();
  unsupportedDefault.streams[1] = {
    index: 1,
    codec_type: "audio",
    codec_name: "aac",
    disposition: { default: 0 },
  };
  unsupportedDefault.streams.push({
    index: 2,
    codec_type: "audio",
    codec_name: "opus",
    disposition: { default: 1 },
  });
  assert.equal(canFastRemuxWechatVideo(unsupportedDefault, 1920), false);

  const unusableOnly = probe();
  unusableOnly.streams[1] = { index: 1, codec_type: "audio", codec_name: "unknown" };
  assert.equal(canFastRemuxWechatVideo(unusableOnly, 1920), true);
});

test("uses only an allowlisted ffmpeg preset", () => {
  assert.equal(normalizeVideoTranscodePreset("veryfast"), "veryfast");
  assert.equal(normalizeVideoTranscodePreset(" SUPERFAST "), "superfast");
  assert.equal(normalizeVideoTranscodePreset("; rm -rf /"), "superfast");
});
