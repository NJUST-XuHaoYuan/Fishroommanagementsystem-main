import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseVideoPlaybackFallback, videoPlaybackFallbackUrl } from "./videoPlaybackFallback.mjs";

test("only decoding and unsupported-source errors can select the compatibility copy", () => {
  for (const code of [undefined, 0, 1, 2]) assert.equal(shouldUseVideoPlaybackFallback(code), false);
  for (const code of [3, 4]) assert.equal(shouldUseVideoPlaybackFallback(code), true);
});

test("fallback stays on the authenticated managed-media route", () => {
  for (const source of ["/uploads/original/videos/abcd1234.mov", "https://bucket.cos.ap-nanjing.myqcloud.com/media/original/videos/abc.mp4"]) {
    assert.equal(new URLSearchParams(videoPlaybackFallbackUrl(source).split("?")[1]).get("url"), source);
    assert.ok(videoPlaybackFallbackUrl(source).startsWith("/api/media/video-playback?"));
  }
  for (const source of ["javascript:alert(1)", "blob:https://test.local/123", "https://other.test/original/videos/a.mp4", "/uploads/.personnel-private/a.mp4", "/uploads/original/videos/../../secret.mp4", "/api/public/media/video-derivative?url=a", "https://bucket.cos.ap.myqcloud.com@evil.test/original/videos/a.mp4"]) assert.equal(videoPlaybackFallbackUrl(source), "");
});
