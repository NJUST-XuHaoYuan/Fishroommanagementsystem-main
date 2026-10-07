import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../wechat-miniprogram/${path}`, import.meta.url), "utf8");
const [catalogSource, detailSource, refreshSource, contactSource, template, styles] = await Promise.all([
  read("utils/catalog.js"),
  read("pages/detail/index.js"),
  read("utils/public-catalog-refresh.js"),
  read("utils/contact-card.js"),
  read("pages/detail/index.wxml"),
  read("pages/detail/index.wxss")
]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const origin = "https://fish.example";
const original = "/api/public/media/cos?url=fish%2Foriginal.mp4&expires=1800000000000&signature=original-signed";
const freshOriginal = original.replace("original-signed", "fresh-signed");
const poster = "/api/public/media/video-derivative?url=fish%2Foriginal.mp4&kind=poster&expires=1800000000000&signature=poster-signed";

function load(source, dependencies = {}, globals = {}) {
  const context = {
    module: { exports: {} },
    require(id) {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    ...globals
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

const catalog = load(catalogSource, { "./api": { getApiBaseUrl: () => origin } }, { Date });
const contact = load(contactSource);

function records(src = original) {
  return [{
    id: "observation-1", stockItemId: "fish-1", sourceType: "bioRecord",
    date: "2026-09-25T10:00:00Z", text: "观察记录正文", operator: "店员",
    photos: ["/photo.jpg"], videos: ["", src],
    videoPosters: ["/wrong-poster.jpg", poster],
    videoPreviews: ["", "/short-preview.mp4"]
  }, {
    id: "care-2", stockItemId: "fish-1", sourceType: "dailyLog",
    date: "2026-09-26T10:00:00Z", text: "缸组养护正文",
    photos: [], videos: ["https://cdn.example/second-original.mp4"],
    videoPreviews: ["/second-short-preview.mp4"]
  }];
}

function fixture(bioRecords) {
  return {
    speciesCategories: ["Fish"], speciesCategoryMajorMap: { Fish: "marineFish" },
    species: [{ id: "species-1", name: "Species", category: "Fish" }],
    products: [{ id: "product-1", speciesId: "species-1", name: "Product", defaultPrice: 100 }],
    stock: [{ id: "fish-1", productId: "product-1", code: "1", notes: "", status: "healthy",
      inDate: "2026-09-01", tankGroupName: "A", subTankName: "1" }],
    bioRecords
  };
}

async function harness({ previewMode = "normal" } = {}) {
  let currentRecords = records();
  let deferCatalog = null;
  const app = { globalData: {} };
  const calls = { previews: [], images: [], catalog: 0, records: 0, toasts: [], updates: [] };
  const timers = new Map();
  let timerId = 0;
  const refresh = load(refreshSource, {}, {
    setInterval(callback, interval) {
      const id = ++timerId;
      timers.set(id, { callback, interval });
      return id;
    },
    clearInterval(id) { timers.delete(id); }
  });
  const api = {
    async fetchCatalog() {
      calls.catalog += 1;
      if (deferCatalog) return deferCatalog;
      return fixture(currentRecords);
    },
    async fetchBioRecords() {
      calls.records += 1;
      return currentRecords;
    }
  };
  const wx = {
    stopPullDownRefresh() {},
    previewImage(options) { calls.images.push(options); },
    showToast(options) { calls.toasts.push(options); }
  };
  if (previewMode !== "missing") wx.previewMedia = (options) => {
    calls.previews.push(options);
    if (previewMode === "throw") throw new Error("native viewer unavailable");
  };
  let page;
  load(detailSource, {
    "../../utils/api": api,
    "../../utils/catalog": catalog,
    "../../utils/public-catalog-refresh": refresh,
    "../../utils/contact-card": contact,
    "../../utils/navigation": { returnToParent() {} }
  }, { Date, wx, getApp: () => app, Page(value) { page = value; } });
  page.data = plain(page.data);
  page.setData = (update) => {
    calls.updates.push(plain(update));
    Object.assign(page.data, update);
  };
  page.onShow();
  await page.loadDetail("fish-1");
  return {
    page, calls, timers,
    setRecords(value) { currentRecords = value; },
    deferNextCatalog(promise) { deferCatalog = promise; }
  };
}

const tap = (recordId = "observation-1", videoIndex = "1") => ({
  currentTarget: { dataset: { recordId, videoIndex, src: "https://stale.example/ignored.mp4" } }
});

function failPreview(call, errMsg = "previewMedia:fail network error") {
  call.fail({ errMsg });
  call.complete({ errMsg });
}

const imageEvent = (page, src, imageGeneration = page.data.imageGeneration) => ({
  currentTarget: { dataset: { src, imageGeneration } }
});

test("timeline retains every record and original video, pairing posters before removing empty slots", () => {
  const timeline = catalog.normalizeTimeline(records(), {
    id: "fish-1", inDate: "2026-09-01", location: "A / 1"
  });
  assert.equal(timeline.length, 3, "arrival and both maintenance records remain visible");
  const observation = timeline.find((item) => item.id === "observation-1");
  assert.equal(observation.text, "观察记录正文");
  assert.equal(observation.operator, "店员");
  assert.deepEqual(plain(observation.videos), [origin + original]);
  assert.equal(observation.videoItems.length, 1);
  assert.equal(observation.videoItems[0].index, 1);
  assert.equal(observation.videoItems[0].src, origin + original);
  assert.equal(observation.videoItems[0].poster, origin + poster);
  assert.ok(!JSON.stringify(observation.videoItems).includes("short-preview"));
  const care = timeline.find((item) => item.id === "care-2");
  assert.equal(care.text, "缸组养护正文");
  assert.equal(care.videoItems[0].src, "https://cdn.example/second-original.mp4");
  assert.equal(care.videoItems[0].poster, "", "a video without a cover must still be playable");
  const photoFallback = catalog.normalizeTimeline([{ ...records()[0], videoPosters: [] }]);
  assert.equal(photoFallback[0].videoItems[0].poster, origin + "/photo.jpg");
});

test("a tap immediately opens only the selected original; pending duplicate taps cannot open extra viewers", async () => {
  const { page, calls } = await harness();
  page.onPlayTimelineVideo(tap());
  assert.equal(calls.previews.length, 1, "the native call must occur before the tap handler returns");
  assert.equal(calls.catalog, 1, "opening a video must not await a fresh catalog request");
  assert.equal(calls.records, 1);
  assert.equal(calls.previews[0].current, 0);
  assert.deepEqual(plain(calls.previews[0].sources), [{ url: origin + original, type: "video", poster: origin + poster }]);
  page.onPlayTimelineVideo(tap());
  page.onPlayTimelineVideo(tap("care-2", "0"));
  assert.equal(calls.previews.length, 1);
  calls.previews[0].complete({ errMsg: "previewMedia:ok" });
  page.onPlayTimelineVideo(tap("care-2", "0"));
  assert.equal(calls.previews.length, 2);
  assert.deepEqual(plain(calls.previews[1].sources), [{ url: "https://cdn.example/second-original.mp4", type: "video" }]);
  page.onUnload();
});

test("detail uses the full-length mobile playback rendition when available, retaining aligned original fallback", () => {
  const media = records();
  media[0].videoPlaybacks = ["/unpaired.mp4", "/api/public/media/video-derivative?kind=playback&url=original.mp4"];
  const timeline = catalog.normalizeTimeline(media);
  const selected = timeline.find((item) => item.id === "observation-1");
  assert.equal(selected.videoItems.length, 1);
  assert.equal(selected.videoItems[0].index, 1);
  assert.equal(selected.videoItems[0].src, origin + media[0].videoPlaybacks[1]);
  assert.ok(!selected.videoItems[0].src.includes("short-preview"));
  const other = timeline.find((item) => item.id === "care-2");
  assert.equal(other.videoItems[0].src, "https://cdn.example/second-original.mp4");
});

test("a button reads the refreshed timeline URL instead of retaining an earlier signed URL", async () => {
  const { page, calls, setRecords } = await harness();
  const originalButtonEvent = tap();
  setRecords(records(freshOriginal));
  await page.loadDetail("fish-1", { force: true, refreshing: true });
  assert.equal(calls.previews.length, 0, "refreshing content must not launch playback");
  page.onPlayTimelineVideo(originalButtonEvent);
  assert.equal(calls.previews[0].sources[0].url, origin + freshOriginal);
  calls.previews[0].complete({});
  setRecords([]);
  await page.loadDetail("fish-1", { force: true, refreshing: true });
  page.onPlayTimelineVideo(originalButtonEvent);
  assert.equal(calls.previews.length, 1, "a removed record cannot play a previously captured URL");
  assert.ok(calls.toasts.some((item) => /更新|加载/.test(item.title)));
  page.onUnload();
});

test("returning from background cannot open stale media while the foreground refresh is pending", async () => {
  const { page, calls, deferNextCatalog, setRecords } = await harness();
  let resolveCatalog;
  deferNextCatalog(new Promise((resolve) => { resolveCatalog = resolve; }));
  page.onHide();
  assert.equal(page.data.loading, true, "hidden media nodes must be unmounted before iOS resumes them");
  page.onShow();
  assert.equal(page.data.refreshing, true);
  assert.equal(page.data.loading, true, "the foreground refresh cannot remount expired media");
  const oldImageTap = { currentTarget: { dataset: { src: origin + "/photo.jpg" } } };
  page.onPlayTimelineVideo(tap());
  page.onPreviewImage(oldImageTap);
  assert.equal(calls.previews.length, 0);
  assert.equal(calls.images.length, 0);

  const freshRecords = records(freshOriginal);
  freshRecords[0].photos = ["/fresh-photo.jpg"];
  setRecords(freshRecords);
  resolveCatalog(fixture(freshRecords));
  await flush();
  assert.equal(page.data.refreshing, false);
  assert.equal(calls.previews.length, 0, "a completed refresh must not autoplay");
  page.onPlayTimelineVideo(tap());
  assert.equal(calls.previews[0].sources[0].url, origin + freshOriginal);
  page.onPreviewImage(oldImageTap);
  assert.equal(calls.images.length, 0, "a late tap with a stale image URL is ignored");
  page.onPreviewImage({ currentTarget: { dataset: { src: origin + "/fresh-photo.jpg" } } });
  assert.equal(calls.images[0].current, origin + "/fresh-photo.jpg");
  page.onUnload();
});

test("a delayed refresh timer cannot open an expired or nearly expired video", async () => {
  for (const expiresAt of [Date.now() - 1000, Date.now() + 60 * 1000]) {
    const { page, calls, setRecords } = await harness();
    const stale = original.replace("1800000000000", String(expiresAt));
    setRecords(records(stale));
    await page.loadDetail("fish-1", { force: true, refreshing: true });
    setRecords(records(freshOriginal));
    page.onPlayTimelineVideo(tap());
    assert.equal(calls.previews.length, 0, "do not open stale native media while refreshing");
    assert.equal(page.data.refreshing, true);
    assert.match(calls.toasts.at(-1).title, /正在更新视频/);
    await flush();
    assert.equal(calls.previews.length, 0, "refresh completion must not launch a viewer outside a tap");
    page.onPlayTimelineVideo(tap());
    assert.equal(calls.previews[0].sources[0].url, origin + freshOriginal);
    page.onUnload();
  }
});

test("expired media in an image gallery is refreshed before native preview opens", async () => {
  const { page, calls, setRecords } = await harness();
  const staleImage = "/api/public/media/cos?url=fish.jpg&expires=1&signature=old";
  const withImage = records();
  withImage[0].photos = [staleImage];
  setRecords(withImage);
  await page.loadDetail("fish-1", { force: true, refreshing: true });
  setRecords(records());
  page.onPreviewImage({ currentTarget: { dataset: { src: origin + staleImage } } });
  assert.equal(calls.images.length, 0);
  assert.match(calls.toasts.at(-1).title, /正在更新图片/);
  await flush();
  page.onPreviewImage({ currentTarget: { dataset: { src: origin + "/photo.jpg" } } });
  assert.equal(calls.images.length, 1);
  page.onUnload();
});

test("current image failures offer one manual recovery without changing records or starting automatic requests", async () => {
  const { page, calls } = await harness();
  const before = plain(page.data.timeline);
  const hero = imageEvent(page, page.data.specimen.image);
  const posterEvent = imageEvent(page, origin + poster);
  for (let index = 0; index < 5; index += 1) {
    page.onDetailImageError(hero);
    page.onDetailImageError(posterEvent);
  }
  assert.equal(page.data.imageErrorCount, 2);
  assert.equal(calls.catalog, 1, "image errors must not trigger request storms");
  assert.equal(calls.records, 1);
  assert.deepEqual(plain(page.data.timeline), before, "failed images must not remove maintenance records or media");
  page.onDetailImageLoad(hero);
  assert.equal(page.data.imageErrorCount, 1);
  page.onDetailImageLoad(posterEvent);
  assert.equal(page.data.imageErrorCount, 0, "a later successful image load clears its warning");
  page.onUnload();
});

test("periodic refresh keeps failed unchanged images recoverable until a manual remount", async () => {
  const { page, calls, timers } = await harness();
  const imageUrl = page.data.specimen.image;
  page.onDetailImageError(imageEvent(page, imageUrl));
  page.onDetailImageError(imageEvent(page, origin + poster));
  const timer = [...timers.values()][0];
  assert.equal(timer.interval, 60000);
  timer.callback();
  await flush();
  assert.equal(page.data.specimen.image, imageUrl);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.refreshing, false);
  assert.equal(page.data.imageErrorCount, 2, "unchanged failed nodes must keep the manual recovery entry");
  assert.equal(calls.catalog, 2);
  assert.equal(calls.records, 2);
  await page.onReloadDetailImages();
  assert.equal(calls.catalog, 3, "the preserved warning still allows an explicit retry");
  assert.equal(page.data.imageErrorCount, 0, "manual remount resets the image failure state");
  page.onUnload();
});

test("automatic refresh removes failures only for image URLs that leave the current detail", async () => {
  const { page, timers, setRecords } = await harness();
  page.onDetailImageError(imageEvent(page, origin + "/photo.jpg"));
  page.onDetailImageError(imageEvent(page, origin + poster));
  const freshRecords = records();
  freshRecords[0].photos = ["/fresh-photo.jpg"];
  setRecords(freshRecords);
  [...timers.values()][0].callback();
  await flush();
  assert.equal(page.data.specimen.image, origin + "/fresh-photo.jpg");
  assert.equal(page.data.imageErrorCount, 1, "the unchanged failed poster survives while the old photo is discarded");
  page.onDetailImageLoad(imageEvent(page, origin + "/photo.jpg"));
  assert.equal(page.data.imageErrorCount, 1);
  page.onDetailImageLoad(imageEvent(page, origin + poster));
  assert.equal(page.data.imageErrorCount, 0);
  page.onUnload();
});

test("valid image events during a pending background refresh are recorded without additional requests", async () => {
  const { page, calls, timers, deferNextCatalog } = await harness();
  const currentImage = imageEvent(page, page.data.specimen.image);
  const currentPoster = imageEvent(page, origin + poster);
  let resolveCatalog;
  deferNextCatalog(new Promise((resolve) => { resolveCatalog = resolve; }));
  [...timers.values()][0].callback();
  assert.equal(page.data.refreshing, true);
  assert.equal(page.data.loading, false, "current image nodes remain mounted during background refresh");
  page.onDetailImageError(currentImage);
  page.onDetailImageError(currentPoster);
  assert.equal(page.data.imageErrorCount, 2);
  page.onDetailImageLoad(currentPoster);
  assert.equal(page.data.imageErrorCount, 1, "a valid load can clear a current failure during refresh");
  page.onReloadDetailImages();
  assert.equal(calls.catalog, 2, "events and manual taps cannot duplicate the pending refresh");
  resolveCatalog(fixture(records()));
  await flush();
  assert.equal(page.data.refreshing, false);
  assert.equal(page.data.imageErrorCount, 1, "the refresh must preserve failures reported while it was pending");
  page.onDetailImageLoad(currentImage);
  assert.equal(page.data.imageErrorCount, 1, "an obsolete render event cannot clear the retained failure");
  page.onDetailImageLoad(imageEvent(page, page.data.specimen.image));
  assert.equal(page.data.imageErrorCount, 0);
  page.onUnload();
});

test("obsolete image URLs, render generations and unloaded-page events cannot change current failures", async () => {
  const { page, calls, setRecords } = await harness();
  const oldEvent = imageEvent(page, origin + "/photo.jpg");
  const previousGeneration = page.data.imageGeneration;
  page.onDetailImageError(oldEvent);
  assert.equal(page.data.imageErrorCount, 1);
  const freshRecords = records();
  freshRecords[0].photos = ["/fresh-photo.jpg"];
  setRecords(freshRecords);
  await page.loadDetail("fish-1", { force: true, refreshing: true });
  assert.equal(page.data.imageErrorCount, 0);
  assert.ok(page.data.imageGeneration > previousGeneration);
  page.onDetailImageError(oldEvent);
  page.onDetailImageError(imageEvent(page, origin + "/photo.jpg"));
  page.onDetailImageError(imageEvent(page, origin + "/unrelated.jpg"));
  assert.equal(page.data.imageErrorCount, 0);
  const freshEvent = imageEvent(page, origin + "/fresh-photo.jpg");
  page.onDetailImageError(freshEvent);
  assert.equal(page.data.imageErrorCount, 1);
  page.onDetailImageLoad(imageEvent(page, origin + "/fresh-photo.jpg", previousGeneration));
  assert.equal(page.data.imageErrorCount, 1, "a previous render's load event cannot clear a current error");
  page.onUnload();
  const updatesBeforeLateEvents = calls.updates.length;
  page.onDetailImageLoad(freshEvent);
  page.onDetailImageError(imageEvent(page, origin + poster));
  page.onReloadDetailImages();
  assert.equal(calls.updates.length, updatesBeforeLateEvents);
});

test("manual image reload unmounts the detail content and remounts identical URLs without autoplay", async () => {
  const { page, calls, deferNextCatalog } = await harness();
  const imageUrl = page.data.specimen.image;
  const oldEvent = imageEvent(page, imageUrl);
  const beforeTimeline = plain(page.data.timeline);
  page.onDetailImageError(oldEvent);
  let resolveCatalog;
  deferNextCatalog(new Promise((resolve) => { resolveCatalog = resolve; }));
  const pending = page.onReloadDetailImages();
  assert.equal(page.data.loading, true, "loading must select the branch that removes failed image nodes");
  assert.equal(page.data.refreshing, false, "background refresh alone does not recreate unchanged image URLs");
  assert.equal(calls.catalog, 2, "manual retry bypasses the catalog cache");
  page.onReloadDetailImages();
  page.onDetailImageError(oldEvent);
  assert.equal(calls.catalog, 2, "pending reload and late errors cannot duplicate requests");
  resolveCatalog(fixture(records()));
  await pending;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.imageErrorCount, 0);
  assert.equal(page.data.specimen.image, imageUrl);
  assert.deepEqual(plain(page.data.timeline), beforeTimeline);
  assert.equal(calls.records, 2);
  assert.equal(calls.previews.length, 0);
  assert.equal(calls.images.length, 0);
  page.onDetailImageError(oldEvent);
  assert.equal(page.data.imageErrorCount, 0, "an unmounted node's error cannot affect the same URL in the new render");
  page.onDetailImageError(imageEvent(page, imageUrl));
  assert.equal(page.data.imageErrorCount, 1, "a real failure from the new node still offers manual recovery");
  assert.match(template, /wx:if="\{\{loading\}\}"[\s\S]*wx:elif="\{\{error\}\}"[\s\S]*wx:else class="detail-content"/);
  assert.equal((template.match(/bindtap="onReloadDetailImages"/g) || []).length, 1);
  for (const imageClass of ["hero-image", "timeline-photo", "timeline-video-poster"]) {
    const tag = template.match(new RegExp(`<image\\b[^>]*class="${imageClass}"[^>]*>`))?.[0];
    assert.ok(tag);
    assert.match(tag, /data-src="\{\{/);
    assert.match(tag, /data-image-generation="\{\{imageGeneration\}\}"/);
    assert.match(tag, /binderror="onDetailImageError"/);
    assert.match(tag, /bindload="onDetailImageLoad"/);
  }
  page.onUnload();
});

test("unavailable and throwing native APIs show recoverable feedback without leaving playback disabled", async () => {
  for (const previewMode of ["missing", "throw"]) {
    const { page, calls } = await harness({ previewMode });
    assert.doesNotThrow(() => page.onPlayTimelineVideo(tap()));
    assert.ok(page.data.videoErrorId);
    assert.ok(page.data.videoErrorText);
    assert.equal(page.data.videoOpeningId, "");
    page.onPlayTimelineVideo(tap("care-2", "0"));
    assert.equal(page.data.videoErrorId, page.data.timeline.find((item) => item.id === "care-2").videoItems[0].id);
    assert.equal(calls.previews.length, previewMode === "throw" ? 2 : 0);
    page.onUnload();
  }
});

test("failed playback can reload current media and retry, while cancellation does not report an error", async () => {
  const { page, calls, setRecords } = await harness();
  page.onPlayTimelineVideo(tap());
  failPreview(calls.previews[0]);
  assert.ok(page.data.videoErrorId);
  assert.match(page.data.videoErrorText, /重新加载/);
  assert.equal(page.data.videoOpeningId, "");
  setRecords(records(freshOriginal));
  page.onReloadTimelineVideos();
  assert.equal(page.data.refreshing, true);
  await flush();
  assert.equal(calls.catalog, 2, "reload bypasses the fresh in-memory catalog");
  assert.equal(calls.records, 2);
  assert.equal(calls.previews.length, 1, "reload requires a new user tap to play");
  assert.equal(page.data.videoErrorText, "");
  page.onPlayTimelineVideo(tap());
  assert.equal(calls.previews[1].sources[0].url, origin + freshOriginal);
  failPreview(calls.previews[1], "previewMedia:fail cancel");
  assert.equal(page.data.videoErrorText, "");
  assert.equal(page.data.videoOpeningId, "");
  page.onPlayTimelineVideo(tap());
  assert.equal(calls.previews.length, 3, "normal dismissal leaves the next video available");
  page.onUnload();
});

test("native viewer failures still reach the page after onHide; onUnload prevents late writes", async () => {
  const { page, calls, timers } = await harness();
  page.onPlayTimelineVideo(tap());
  page.onHide();
  assert.equal(timers.size, 0);
  failPreview(calls.previews[0]);
  assert.ok(page.data.videoErrorText, "opening the native viewer must not suppress an ensuing failure");
  page.onShow();
  await flush();
  page.onPlayTimelineVideo(tap("care-2", "0"));
  const pending = calls.previews.at(-1);
  page.onUnload();
  const updatesBeforeLateCallback = calls.updates.length;
  const stateBeforeLateCallback = plain(page.data);
  failPreview(pending);
  assert.equal(calls.updates.length, updatesBeforeLateCallback);
  assert.deepEqual(plain(page.data), stateBeforeLateCallback);
  assert.equal(timers.size, 0);
});

test("an earlier viewer callback cannot overwrite or unlock a newer attempt", async () => {
  const { page, calls } = await harness();
  page.onPlayTimelineVideo(tap());
  const oldCall = calls.previews[0];
  oldCall.complete({});
  page.onPlayTimelineVideo(tap("care-2", "0"));
  const currentOpeningId = page.data.videoOpeningId;
  failPreview(oldCall);
  assert.equal(page.data.videoErrorText, "");
  assert.equal(page.data.videoOpeningId, currentOpeningId);
  page.onPlayTimelineVideo(tap());
  assert.equal(calls.previews.length, 2, "an old complete callback cannot release the current opening lock");
  calls.previews[1].complete({});
  page.onUnload();
});

test("leaving during a refresh discards its result and returning keeps one periodic refresh without autoplay", async () => {
  const { page, calls, timers, deferNextCatalog } = await harness();
  let resolveCatalog;
  deferNextCatalog(new Promise((resolve) => { resolveCatalog = resolve; }));
  const pending = page.loadDetail("fish-1", { force: true, refreshing: true });
  page.onHide();
  const updatesBeforeResolution = calls.updates.length;
  resolveCatalog(fixture(records(freshOriginal)));
  await pending;
  assert.equal(calls.updates.length, updatesBeforeResolution, "a hidden page cannot receive the old request");
  page.onShow();
  await flush();
  assert.equal(timers.size, 1);
  page.onShow();
  await flush();
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.interval, 60000);
  const requestsBeforeTick = calls.catalog;
  timer.callback();
  await flush();
  assert.equal(calls.catalog, requestsBeforeTick + 1);
  assert.equal(calls.previews.length, 0);
  page.onUnload();
  assert.equal(timers.size, 0);
});

test("each timeline video has a labeled play button even without its optional poster, with visible reload feedback", () => {
  assert.doesNotMatch(template, /<video\b/i, "the timeline must not mount a native player for every record");
  const button = template.match(/<button\b[^>]*bindtap="onPlayTimelineVideo"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(button, "a normal tap button must invoke playback");
  assert.match(button[0], /aria-label="[^"]*播放/);
  assert.doesNotMatch(button[0].split(">")[0], /wx:if=/, "poster availability must not hide the play button");
  assert.match(button[1], /播放视频/);
  assert.match(button[1], /点击全屏观看/);
  assert.match(template, /role="alert"/);
  assert.match(template, /bindtap="onReloadTimelineVideos"[^>]*>[\s\S]*?重新加载视频/);
});

test("video controls override native mini-button sizing so the full card remains tappable", () => {
  for (const name of ["timeline-video-button", "timeline-video-retry"]) {
    const rule = styles.match(new RegExp(`\\.detail-page\\s+\\.${name}\\s*\\{([^}]+)`));
    assert.ok(rule, `${name} must override the native size selector`);
    assert.match(rule[1], /width:\s*100%/);
    assert.match(rule[1], /display:\s*(flex|block)/);
  }
});
