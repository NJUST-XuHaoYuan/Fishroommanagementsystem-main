import test from "node:test";
import assert from "node:assert/strict";
import { cameraErrorMessage, createBoundedRecording, inspectRetainedRecording, MAX_CAPTURE_BYTES, MAX_CAPTURE_SECONDS, openHighResolutionCamera, recorderOptions, retainRecordedVideo, videoQuality, waitForVideoDimensions, watchCaptureSession } from "./videoCapture.mjs";

function fakeStream(settings = { width: 3840, height: 2160 }, audio = true) {
  const track = { stops: 0, stop() { this.stops++; }, getSettings: () => settings, getCapabilities: () => ({ width: { max: 3840 }, height: { max: 2160 } }) };
  const audioTrack = { stops: 0, stop() { this.stops++; } };
  return { track, audioTrack, getVideoTracks: () => [track], getAudioTracks: () => audio ? [audioTrack] : [], getTracks: () => audio ? [track, audioTrack] : [track] };
}
class FakeRecorder {
  static instances = [];
  static isTypeSupported(type) { return type === "video/mp4"; }
  constructor(stream, options) { this.stream = stream; this.options = options; this.state = "inactive"; this.mimeType = options.mimeType; FakeRecorder.instances.push(this); }
  start(slice) { this.slice = slice; this.state = "recording"; }
  stop() { this.state = "inactive"; this.stopCalls = (this.stopCalls || 0) + 1; }
  data(value) { this.ondataavailable?.({ data: new Blob([value]) }); }
  complete() { this.state = "inactive"; this.onstop?.(); }
}
function recordingFixture(callbacks = {}) {
  let timer, clears = 0;
  const stream = fakeStream();
  const control = createBoundedRecording(stream, { width: 3840, height: 2160 }, { Recorder: FakeRecorder, setTimer: (fn, ms) => { timer = { fn, ms }; return 42; }, clearTimer: () => clears++, ...callbacks });
  return { stream, control, recorder: FakeRecorder.instances.at(-1), get timer() { return timer; }, get clears() { return clears; } };
}

test("camera requests real 4K first, retains audio and exposes actual capabilities", async () => {
  const stream = fakeStream(); let requested;
  const opened = await openHighResolutionCamera({ getSupportedConstraints: () => ({ resizeMode: true, facingMode: true }), getUserMedia: async constraints => { requested = constraints; return stream; } });
  assert.deepEqual(requested.video.width, { exact: 3840 });
  assert.deepEqual(requested.video.height, { exact: 2160 });
  assert.equal(requested.video.resizeMode, "none"); assert.equal(requested.audio, true);
  assert.deepEqual(requested.video.facingMode, { exact: "environment" });
  assert.equal(opened.settings.width, 3840); assert.equal(opened.capabilities.width.max, 3840);
});

test("rear-camera requirement stays exact through every resolution fallback", async () => {
  const attempts = [];
  await assert.rejects(openHighResolutionCamera({ getSupportedConstraints: () => ({ facingMode: true }), getUserMedia: async constraints => {
    attempts.push(constraints); throw Object.assign(new Error("no rear camera"), { name: "OverconstrainedError", constraint: "facingMode" });
  } }), { code: "REAR_CAMERA_UNAVAILABLE" });
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(value => value.video.facingMode.exact === "environment"));
});

test("a front camera can only be accepted after explicit fallback choice", async () => {
  const stream = fakeStream({ width: 3840, height: 2160, facingMode: "user" });
  const media = { getSupportedConstraints: () => ({ facingMode: true }), getUserMedia: async () => stream };
  await assert.rejects(openHighResolutionCamera(media), { code: "REAR_CAMERA_UNAVAILABLE" });
  assert.ok(stream.track.stops);
  const chosen = await openHighResolutionCamera(media, () => true, true, true);
  assert.equal(chosen.settings.facingMode, "user");
});

test("unsupported camera direction is left unknown rather than labelled rear", async () => {
  let requested;
  const result = await openHighResolutionCamera({ getSupportedConstraints: () => ({ facingMode: false }), getUserMedia: async constraints => { requested = constraints; return fakeStream(); } });
  assert.equal(requested.video.facingMode, undefined);
  assert.equal(result.settings.facingMode, undefined);
});

test("recorded file survives metadata timeout and remains the same file on retry", async () => {
  const source = new Blob(["recorded pixels"], { type: "video/mp4" });
  const retained = retainRecordedVideo(source, { createUrl: () => "blob:test/clip", now: () => 123 });
  const failure = await inspectRetainedRecording(retained, async () => { throw new Error("metadata timeout"); });
  assert.equal(failure.file, retained.file); assert.equal(failure.url, retained.url);
  assert.equal(await failure.file.text(), "recorded pixels");
  assert.equal(failure.quality.label, "画质未检测"); assert.equal(failure.inspectionFailed, true);
  const success = await inspectRetainedRecording(retained, async () => videoQuality(3840, 2160));
  assert.equal(success.file, retained.file); assert.equal(success.inspectionFailed, false); assert.equal(success.quality.label, "4K");
});

test("cross-tab session invalidation closes once and unsubscribes all checks", () => {
  const target = new EventTarget(), visibility = new EventTarget();
  let value = "account-a", closed = 0, poll, intervalMs, cleared = false;
  const dispose = watchCaptureSession("account-a", () => value, () => closed++, {
    eventTarget: target, visibilityTarget: visibility,
    setTimer: (fn, ms) => { poll = fn; intervalMs = ms; return 10; }, clearTimer: () => cleared = true,
  });
  assert.equal(intervalMs, 1000); assert.equal(closed, 0);
  value = "account-b"; target.dispatchEvent(new Event("storage"));
  assert.equal(closed, 1);
  visibility.dispatchEvent(new Event("visibilitychange")); poll(); assert.equal(closed, 1);
  dispose(); assert.equal(cleared, true);
});

test("session expiry during a hanging upload is caught by polling without a DOM event", () => {
  let value = "account-a", closed = false, poll;
  const dispose = watchCaptureSession("account-a", () => value, () => closed = true, {
    setTimer: fn => { poll = fn; return 1; }, clearTimer: () => {}, eventTarget: new EventTarget(), visibilityTarget: new EventTarget(),
  });
  value = "anonymous"; poll(); assert.equal(closed, true); dispose();
});

test("unsupported 4K falls back to exact 1080, not a silent default 360p", async () => {
  const attempts = [], stream = fakeStream({ width: 1920, height: 1080 });
  const opened = await openHighResolutionCamera({ getUserMedia: async constraints => {
    attempts.push(constraints);
    if (constraints.video.width.exact === 3840) throw Object.assign(new Error(), { name: "OverconstrainedError" });
    return stream;
  } });
  assert.deepEqual(attempts.map(x => x.video.width.exact), [3840, 1920]);
  assert.equal(opened.stream, stream);
});

test("permission denial is not repeatedly prompted or silently changed to no sound", async () => {
  let calls = 0;
  await assert.rejects(openHighResolutionCamera({ getUserMedia: async () => { calls++; throw Object.assign(new Error(), { name: "NotAllowedError" }); } }), { name: "NotAllowedError" });
  assert.equal(calls, 1);
});

test("explicit camera-only retry does not request microphone", async () => {
  let constraints;
  await openHighResolutionCamera({ getUserMedia: async value => { constraints = value; return fakeStream({}, false); } }, () => true, false);
  assert.equal(constraints.audio, false);
});

test("permission resolving after close stops every granted track", async () => {
  let active = true; const stream = fakeStream();
  await assert.rejects(openHighResolutionCamera({ getUserMedia: async () => { active = false; return stream; } }, () => active), { name: "AbortError" });
  assert.ok(stream.track.stops > 0); assert.ok(stream.audioTrack.stops > 0);
});

test("quality follows actual pixels and handles portrait orientation", () => {
  assert.equal(videoQuality(2160, 3840).label, "4K");
  assert.equal(videoQuality(1080, 1920).label, "1080P");
  assert.equal(videoQuality(360, 480).low, true);
  assert.equal(videoQuality(0, 0).label, "正在检测画质");
  assert.equal(videoQuality(720, 1280).low, false);
});

test("recording selects supported format and higher bitrates for 4K", () => {
  assert.deepEqual(recorderOptions(FakeRecorder, { width: 3840, height: 2160 }), { mimeType: "video/mp4", videoBitsPerSecond: 20_000_000 });
  assert.equal(recorderOptions(FakeRecorder, { width: 1080, height: 1920 }).videoBitsPerSecond, 8_000_000);
  assert.throws(() => recorderOptions({ isTypeSupported: () => false }, {}), /没有可用的录像格式/);
});

test("recording includes final data and stops camera and audio before completing", async () => {
  let result;
  const f = recordingFixture({ onComplete: blob => { result = blob; assert.ok(f.stream.track.stops); assert.ok(f.stream.audioTrack.stops); } });
  f.recorder.data("first"); f.control.stop(); f.recorder.data("last"); f.recorder.complete();
  assert.equal(await result.text(), "firstlast"); assert.equal(result.type, "video/mp4");
  assert.equal(f.recorder.stopCalls, 1); assert.equal(f.clears, 1);
});

test("cancelled or unmounted capture ignores all late recorder events", () => {
  let callback = false;
  const f = recordingFixture({ onComplete: () => callback = true, onError: () => callback = true });
  f.recorder.data("before"); f.control.cancel(); f.recorder.data("after"); f.recorder.complete();
  f.recorder.onerror({ error: new Error("late") });
  assert.equal(callback, false); assert.ok(f.stream.track.stops); assert.ok(f.stream.audioTrack.stops); assert.equal(f.clears, 1);
});

test("empty recordings fail instead of attaching empty maintenance media", () => {
  let error, completed = false;
  const f = recordingFixture({ onComplete: () => completed = true, onError: value => error = value });
  f.control.stop(); f.recorder.complete();
  assert.equal(completed, false); assert.match(error.message, /没有录到视频/);
});

test("size and time limits stop once and flush instead of losing the recording", () => {
  const notices = [];
  const f = recordingFixture({ onLimit: message => notices.push(message) });
  assert.equal(f.timer.ms, MAX_CAPTURE_SECONDS * 1000);
  f.recorder.ondataavailable({ data: { size: MAX_CAPTURE_BYTES } });
  f.timer.fn();
  assert.equal(f.recorder.stopCalls, 1); assert.equal(notices.length, 1); assert.match(notices[0], /大小上限/);
  f.control.cancel();
});

test("actual video dimensions are read from first frame and cancelled reads reject", async () => {
  assert.equal((await waitForVideoDimensions({ videoWidth: 1080, videoHeight: 1920, readyState: 2 })).label, "1080P");
  assert.equal((await waitForVideoDimensions({ videoWidth: 1080, videoHeight: 1920, readyState: 1 }, () => true, 12000, 1)).label, "1080P");
  await assert.rejects(waitForVideoDimensions({ videoWidth: 0, videoHeight: 0, readyState: 0 }, () => false), { name: "AbortError" });
  assert.match(cameraErrorMessage({ name: "NotAllowedError" }), /权限/);
});
