import assert from "node:assert/strict";
import { before, test } from "node:test";

let normalizeCaptureRect, stopCaptureTracks, captureDisplayFrame, cropCapturedScreen;
before(async () => {
  ({ normalizeCaptureRect, stopCaptureTracks, captureDisplayFrame, cropCapturedScreen } = await import("./screenCapture.ts"));
});

const bounds = { width: 640, height: 480 };
const chineseError = /[\u3400-\u9fff]/;
const png = () => new Blob(["synthetic PNG pixels"], { type: "image/png" });

test("crop selection normalizes reverse drags without changing the selected pixels", () => {
  assert.deepEqual(normalizeCaptureRect({ x: 240, y: 160 }, { x: 40, y: 20 }, bounds), { x: 40, y: 20, width: 200, height: 140 });
  assert.deepEqual(normalizeCaptureRect({ x: 40, y: 160 }, { x: 240, y: 20 }, bounds), { x: 40, y: 20, width: 200, height: 140 });
});

test("out-of-bounds selections are clipped to the captured image and cover fractional edge pixels", () => {
  assert.deepEqual(normalizeCaptureRect({ x: -20, y: -30 }, { x: 900, y: 800 }, bounds), { x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(normalizeCaptureRect({ x: 10.9, y: 20.2 }, { x: 30.1, y: 40.9 }, bounds), { x: 10, y: 20, width: 21, height: 21 });
  assert.deepEqual(normalizeCaptureRect({ x: 700, y: 500 }, { x: 900, y: 800 }, bounds), { x: 640, y: 480, width: 0, height: 0 });
});

test("a click or a line remains zero-area rather than silently selecting the whole screenshot", () => {
  assert.deepEqual(normalizeCaptureRect({ x: 20, y: 30 }, { x: 20, y: 30 }, bounds), { x: 20, y: 30, width: 0, height: 0 });
  const fractionalClick = normalizeCaptureRect({ x: 20.5, y: 30.5 }, { x: 20.5, y: 30.5 }, bounds);
  assert.equal(fractionalClick.width, 0); assert.equal(fractionalClick.height, 0);
  assert.equal(normalizeCaptureRect({ x: 20, y: 10 }, { x: 20, y: 90 }, bounds).width, 0);
  assert.equal(normalizeCaptureRect({ x: 10, y: 20 }, { x: 90, y: 20 }, bounds).height, 0);
});

test("invalid coordinates and image bounds are rejected before canvas work", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => normalizeCaptureRect({ x: value, y: 1 }, { x: 2, y: 3 }, bounds), chineseError);
    assert.throws(() => normalizeCaptureRect({ x: 1, y: 2 }, { x: 3, y: value }, bounds), chineseError);
  }
  for (const invalid of [{ width: 0, height: 10 }, { width: 10, height: -1 }, { width: NaN, height: 10 }]) {
    assert.throws(() => normalizeCaptureRect({ x: 1, y: 2 }, { x: 3, y: 4 }, invalid), chineseError);
  }
});

function streamFixture({ throwingTrack = false } = {}) {
  const tracks = ["video", "audio"].map((kind, index) => {
    const track = new EventTarget();
    Object.assign(track, { kind, readyState: "live", stops: 0, stop() {
      this.stops += 1; this.readyState = "ended";
      if (throwingTrack && index === 0) throw new Error("track already detached");
    } });
    return track;
  });
  return { tracks, stream: { getTracks: () => tracks, getVideoTracks: () => tracks.filter(track => track.kind === "video") } };
}

test("stopping capture releases every video and audio track even if one stop throws", () => {
  const { tracks, stream } = streamFixture({ throwingTrack: true });
  assert.doesNotThrow(() => stopCaptureTracks(stream));
  assert.ok(tracks.every(track => track.stops > 0 && track.readyState === "ended"));
});

async function withDom(options, run) {
  const saved = new Map();
  const replace = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const video = new EventTarget();
  Object.assign(video, {
    readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null, style: {}, paused: false,
    setAttribute() {}, removeAttribute() {}, remove() {}, load() {},
    pause() { this.paused = true; },
    play() { return options.play ? options.play(video) : Promise.resolve(); },
  });
  const canvases = [];
  const document = { createElement(tag) {
    if (tag === "video") return video;
    assert.equal(tag, "canvas");
    const canvas = { width: 0, height: 0, calls: [], getContext(type) {
      assert.equal(type, "2d");
      if (options.noContext) return null;
      return { drawImage: (...args) => { if (options.drawError) throw new Error("draw failed"); canvas.calls.push(args); } };
    }, toBlob(callback, type) {
      assert.equal(type, "image/png");
      canvas.encodedWidth = canvas.width; canvas.encodedHeight = canvas.height;
      if (options.encode) { options.encode(callback); return; }
      queueMicrotask(() => callback(options.nullBlob ? null : png()));
    } };
    canvases.push(canvas); return canvas;
  } };
  replace("document", document);
  replace("ImageCapture", options.ImageCapture);
  if (Object.hasOwn(options, "bitmap")) replace("createImageBitmap", options.bitmap);
  if (Object.hasOwn(options, "Image")) replace("Image", options.Image);
  if (Object.hasOwn(options, "URL")) replace("URL", options.URL);
  const ready = (width = 1280, height = 720, event = "loadeddata") => {
    Object.assign(video, { readyState: 2, videoWidth: width, videoHeight: height });
    video.dispatchEvent(new Event(event));
  };
  try { return await run({ video, canvases, ready }); }
  finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function assertReleased(tracks, video) {
  assert.ok(tracks.every(track => track.stops > 0 && track.readyState === "ended"), "every sharing track must stop");
  assert.equal(video.srcObject, null, "video must release its MediaStream reference");
}

test("capture waits for decoded pixels, returns native frame dimensions, and releases sharing", async () => {
  const { tracks, stream } = streamFixture();
  await withDom({}, async ({ video, canvases, ready }) => {
    const pending = captureDisplayFrame(stream, 100);
    video.dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    assert.equal(canvases.flatMap(canvas => canvas.calls).length, 0, "metadata without pixels must not capture a blank frame");
    ready(1280, 720, "canplay");
    const result = await pending;
    assert.equal(result.width, 1280); assert.equal(result.height, 720); assert.equal(result.blob.type, "image/png");
    assert.equal(canvases.length, 1); assert.equal(canvases[0].encodedWidth, 1280); assert.equal(canvases[0].encodedHeight, 720);
    assert.deepEqual(canvases[0].calls, [[video, 0, 0, 1280, 720]]);
    assertReleased(tracks, video);
    ready(1920, 1080);
    assert.equal(canvases[0].calls.length, 1, "late media events must not capture another frame");
  });
});

test("a capture timeout rejects and cannot leave screen sharing active", async () => {
  const { tracks, stream } = streamFixture();
  await withDom({}, async ({ video }) => {
    await assert.rejects(captureDisplayFrame(stream, 10), chineseError);
    assertReleased(tracks, video);
  });
});

test("ending sharing before a frame is available cancels capture and releases all tracks", async () => {
  const { tracks, stream } = streamFixture();
  await withDom({}, async ({ video }) => {
    const pending = captureDisplayFrame(stream, 100);
    tracks[0].readyState = "ended";
    tracks[0].dispatchEvent(new Event("ended"));
    await assert.rejects(pending, chineseError);
    assertReleased(tracks, video);
  });
});

test("video errors and play rejection both release screen sharing", async () => {
  for (const failure of ["video-error", "play-rejection"]) {
    const { tracks, stream } = streamFixture();
    await withDom(failure === "play-rejection" ? { play: () => Promise.reject(new Error("autoplay denied")) } : {}, async ({ video }) => {
      const pending = captureDisplayFrame(stream, 100);
      if (failure === "video-error") video.dispatchEvent(new Event("error"));
      await assert.rejects(pending);
      assertReleased(tracks, video);
    });
  }
});

test("missing canvas, failed drawing and failed PNG encoding release capture tracks", async () => {
  for (const options of [{ noContext: true }, { drawError: true }, { nullBlob: true }]) {
    const { tracks, stream } = streamFixture();
    await withDom(options, async ({ video, ready }) => {
      const pending = captureDisplayFrame(stream, 100);
      ready();
      await assert.rejects(pending);
      assertReleased(tracks, video);
    });
  }
});

test("crop uses clamped source coordinates, emits a PNG File and closes decoded bitmap", async () => {
  const bitmap = { width: 640, height: 480, closes: 0, close() { this.closes += 1; } };
  const capture = { blob: png(), ...bounds };
  await withDom({ bitmap: async blob => { assert.strictEqual(blob, capture.blob); return bitmap; } }, async ({ canvases }) => {
    const file = await cropCapturedScreen(capture, { x: 600, y: 450, width: 100, height: 100 });
    assert.ok(file instanceof File); assert.equal(file.type, "image/png"); assert.match(file.name, /\.png$/i);
    assert.equal(canvases[0].encodedWidth, 40); assert.equal(canvases[0].encodedHeight, 30);
    assert.deepEqual(canvases[0].calls, [[bitmap, 600, 450, 40, 30, 0, 0, 40, 30]]);
    assert.equal(bitmap.closes, 1);
  });
});

test("omitting a selection retains the entire screenshot as a usable PNG File", async () => {
  const bitmap = { width: 640, height: 480, close() {} };
  await withDom({ bitmap: async () => bitmap }, async ({ canvases }) => {
    const file = await cropCapturedScreen({ blob: png(), ...bounds });
    assert.ok(file instanceof File); assert.equal(file.type, "image/png"); assert.match(file.name, /\.png$/i);
    if (canvases.length) {
      assert.equal(canvases[0].encodedWidth, 640); assert.equal(canvases[0].encodedHeight, 480);
      assert.deepEqual(canvases[0].calls, [[bitmap, 0, 0, 640, 480, 0, 0, 640, 480]]);
    } else assert.equal(await file.text(), await png().text());
  });
});

test("empty crop areas are rejected instead of uploading a blank image", async () => {
  for (const rect of [{ x: 10, y: 10, width: 0, height: 20 }, { x: 10, y: 10, width: 20, height: 0 }, { x: 700, y: 500, width: 10, height: 10 }]) {
    await assert.rejects(() => cropCapturedScreen({ blob: png(), ...bounds }, rect), chineseError);
  }
});

test("failed crop encoding still releases the decoded bitmap", async () => {
  const bitmap = { width: 640, height: 480, closes: 0, close() { this.closes += 1; } };
  await withDom({ bitmap: async () => bitmap, nullBlob: true }, async () => {
    await assert.rejects(() => cropCapturedScreen({ blob: png(), ...bounds }, { x: 10, y: 20, width: 30, height: 40 }));
    assert.equal(bitmap.closes, 1);
  });
});

test("ImageCapture uses native pixels without waiting for foreground video rendering and closes the frame", async () => {
  const { tracks, stream } = streamFixture();
  const frame = { width: 1920, height: 1080, closes: 0, close() { this.closes += 1; } };
  class ImageCapture {
    constructor(track) { assert.strictEqual(track, tracks[0]); }
    async grabFrame() { return frame; }
  }
  await withDom({ ImageCapture }, async ({ video, canvases }) => {
    const capture = await captureDisplayFrame(stream, 100);
    assert.deepEqual({ width: capture.width, height: capture.height }, { width: 1920, height: 1080 });
    assert.equal(capture.blob.type, "image/png");
    assert.equal(canvases[0].encodedWidth, 1920); assert.equal(canvases[0].encodedHeight, 1080);
    assert.deepEqual(canvases[0].calls, [[frame, 0, 0, 1920, 1080]]);
    assertReleased(tracks, video); assert.equal(frame.closes, 1);
  });
});

test("a stalled ImageCapture reaches the common deadline and releases sharing", async () => {
  const { tracks, stream } = streamFixture();
  class ImageCapture { grabFrame() { return new Promise(() => {}); } }
  await withDom({ ImageCapture }, async ({ video }) => {
    await assert.rejects(captureDisplayFrame(stream, 10), chineseError);
    assertReleased(tracks, video);
  });
});

test("failed ImageCapture falls back to video while the selected track is still live", async () => {
  const { tracks, stream } = streamFixture();
  class ImageCapture { async grabFrame() { throw new Error("grabFrame unavailable"); } }
  await withDom({ ImageCapture, play: video => {
    queueMicrotask(() => {
      Object.assign(video, { readyState: 2, videoWidth: 800, videoHeight: 600 });
      video.dispatchEvent(new Event("loadeddata"));
    });
    return Promise.resolve();
  } }, async ({ video }) => {
    const capture = await captureDisplayFrame(stream, 100);
    assert.equal(capture.width, 800); assert.equal(capture.height, 600);
    assertReleased(tracks, video);
  });
});

test("sharing stops before PNG encoding, including an encoder that never responds", async () => {
  const { tracks, stream } = streamFixture();
  await withDom({ encode() {
    assert.ok(tracks.every(track => track.readyState === "ended"), "encoding must not extend screen sharing");
  } }, async ({ video, ready }) => {
    const pending = captureDisplayFrame(stream, 10);
    ready();
    await assert.rejects(pending, chineseError);
    assertReleased(tracks, video);
  });
});

test("a frame arriving after timeout is closed without creating a screenshot", async () => {
  const { tracks, stream } = streamFixture();
  let deliverFrame;
  const frame = { width: 100, height: 100, closes: 0, close() { this.closes += 1; } };
  class ImageCapture { grabFrame() { return new Promise(resolve => { deliverFrame = resolve; }); } }
  await withDom({ ImageCapture }, async ({ video, canvases }) => {
    await assert.rejects(captureDisplayFrame(stream, 10), chineseError);
    assertReleased(tracks, video);
    deliverFrame(frame);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frame.closes, 1); assert.equal(canvases.length, 0);
  });
});

test("a stream without a live video track fails and releases any remaining audio track", async () => {
  const { tracks, stream } = streamFixture();
  stream.getVideoTracks = () => [];
  await withDom({}, async ({ video }) => {
    await assert.rejects(captureDisplayFrame(stream, 100), chineseError);
    assertReleased(tracks, video);
  });
});

test("image fallback revokes its object URL and releases image handlers on success and decode failure", async () => {
  for (const failDecode of [false, true]) {
    const revocations = [], images = [];
    class Image {
      constructor() { images.push(this); }
      set src(value) {
        this.currentSource = value;
        if (value) queueMicrotask(() => failDecode ? this.onerror?.() : this.onload?.());
      }
      get src() { return this.currentSource; }
    }
    await withDom({ bitmap: undefined, Image, URL: {
      createObjectURL: () => "blob:synthetic-crop", revokeObjectURL: value => revocations.push(value),
    } }, async ({ canvases }) => {
      const result = cropCapturedScreen({ blob: png(), ...bounds }, { x: 10, y: 20, width: 30, height: 40 });
      if (failDecode) await assert.rejects(result, chineseError);
      else {
        assert.equal((await result).type, "image/png");
        assert.deepEqual(canvases[0].calls, [[images[0], 10, 20, 30, 40, 0, 0, 30, 40]]);
      }
      assert.deepEqual(revocations, ["blob:synthetic-crop"]);
      assert.equal(images[0].src, ""); assert.equal(images[0].onload, null); assert.equal(images[0].onerror, null);
    });
  }
});
