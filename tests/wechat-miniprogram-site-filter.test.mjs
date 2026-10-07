import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../wechat-miniprogram/${path}`, import.meta.url), "utf8");
const [catalogSource, pageSource, refreshSource, videoSource, detailSource, navigationSource, contactSource] = await Promise.all([
  read("utils/catalog.js"), read("pages/specimens/index.js"),
  read("utils/public-catalog-refresh.js"), read("utils/card-video-preview.js"),
  read("pages/detail/index.js"), read("utils/navigation.js"), read("utils/contact-card.js"),
]);
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(source, dependencies = {}, globals = {}) {
  const context = {
    module: { exports: {} },
    require(id) {
      assert.ok(id in dependencies, `unexpected dependency ${id}`);
      return dependencies[id];
    },
    ...globals,
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

const catalog = load(catalogSource, { "./api": { getApiBaseUrl: () => "https://fish.example" } }, { Date });

function fixture() {
  const stock = [
    ["a-n1", "product-a", "nanjing"], ["a-n2", "product-a", "nanjing"],
    ["a-j1", "product-a", "jiangyin"], ["a-j2", "product-a", "jiangyin"],
    ["b-n1", "product-b", "nanjing"], ["b-j1", "product-b", "jiangyin"],
    ["c-n1", "product-c", "nanjing"], ["c-j1", "product-c", "jiangyin"],
  ].map(([id, productId, siteId]) => ({
    id, productId, siteId, code: "", notes: "", status: "feeding",
    inDate: "2026-08-01", basePrice: 150, specimenGroupKey: "same-full-history",
    tankGroupName: "A", subTankName: "1",
  }));
  return {
    speciesCategories: ["Fish"], speciesCategoryMajorMap: { Fish: "marineFish" },
    species: ["species-a", "species-b"].map((id) => ({ id, name: id, category: "Fish" })),
    products: [
      { id: "product-a", speciesId: "species-a", name: "Product A", defaultPrice: 200 },
      { id: "product-b", speciesId: "species-a", name: "Product B", defaultPrice: 200 },
      { id: "product-c", speciesId: "species-b", name: "Product C", defaultPrice: 200 },
    ],
    stock,
    bioRecords: stock.map((item) => ({
      id: `bio-${item.id}`, stockItemId: item.id, date: "2026-08-15", text: "Shared care record",
      photos: ["/fish.jpg"], videos: ["/fish.mp4"], videoPreviews: ["/preview.mp4"],
    })),
  };
}

function pageHarness(initialCatalog = fixture()) {
  const app = { globalData: { catalog: null, catalogViewModel: null, loadedAt: 0 } };
  const state = { catalog: initialCatalog, fetchCount: 0, playCount: 0, pauseCount: 0, renders: [] };
  const timers = new Map();
  let timerId = 0;
  const wx = {
    setNavigationBarTitle() {}, stopPullDownRefresh() {}, showToast() {}, navigateTo() {},
    createVideoContext() {
      return { play() { state.playCount += 1; }, pause() { state.pauseCount += 1; } };
    },
  };
  const refresh = load(refreshSource, {}, {
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  let page;
  load(pageSource, {
    "../../utils/api": { async fetchCatalog() {
      state.fetchCount += 1;
      if (state.pendingCatalog) return plain(await state.pendingCatalog);
      if (state.catalog instanceof Error) throw state.catalog;
      return plain(state.catalog);
    } },
    "../../utils/catalog": catalog,
    "../../utils/navigation": { returnToParent() {} },
    "../../utils/public-catalog-refresh": refresh,
    "../../utils/card-video-preview": load(videoSource, {}, { wx }),
  }, { wx, getApp: () => app, Page(value) { page = value; } });
  page.data = plain(page.data);
  page.setData = (value, callback) => {
    Object.assign(page.data, value);
    state.renders.push({ loading: page.data.loading, previews: page.data.specimens.map((item) => item.previewVideo) });
    callback?.();
  };
  const loadSpecimens = page.loadSpecimens;
  page.loadSpecimens = function (...args) {
    this.lastLoad = loadSpecimens.apply(this, args);
    return this.lastLoad;
  };
  return {
    page, app, state, timers,
    async open(options = { productId: "product-a" }) {
      page.route = "pages/specimens/index";
      page.options = plain(options);
      page.onLoad(options);
      page.onShow();
      await page.lastLoad;
    },
    select(siteId) { page.onSiteTap({ currentTarget: { dataset: { siteId } } }); },
    preview() {
      const card = page.data.specimens[0];
      page.onPreviewToggle({ currentTarget: { dataset: { id: card.id, preview: card.previewVideo } } });
    },
  };
}

async function detailBackHarness(parentHarness, stockItemId = "a-j1") {
  const calls = [];
  const pages = [parentHarness.page];
  const getCurrentPages = () => pages;
  const wx = {
    stopPullDownRefresh() {},
    navigateBack({ delta }) { calls.push({ type: "back", delta }); pages.splice(-delta); },
    redirectTo({ url }) { calls.push({ type: "redirect", url }); },
    reLaunch({ url }) { calls.push({ type: "relaunch", url }); },
  };
  let detail;
  load(detailSource, {
    "../../utils/api": {
      fetchCatalog: async () => plain(parentHarness.state.catalog),
      fetchBioRecords: async (id) => plain(parentHarness.state.catalog.bioRecords.filter((item) => item.stockItemId === id)),
    },
    "../../utils/catalog": catalog,
    "../../utils/navigation": load(navigationSource, {}, { wx, getCurrentPages }),
    "../../utils/contact-card": load(contactSource),
    "../../utils/public-catalog-refresh": load(refreshSource),
  }, { wx, getCurrentPages, getApp: () => parentHarness.app, Page(value) { detail = value; } });
  detail.route = "pages/detail/index";
  detail.data = plain(detail.data);
  detail.setData = (value) => Object.assign(detail.data, value);
  pages.push(detail);
  await detail.loadDetail(stockItemId);
  assert.equal(detail.data.error, "");
  assert.equal(detail.data.specimen.id, stockItemId);
  return { detail, calls, pages };
}

const counts = (page) => Object.fromEntries(page.data.siteOptions.map(({ id, count }) => [id, count]));
const fishIds = (page) => plain(page.data.specimens.flatMap((card) => card.members.map((member) => member.id))).sort();

function templateValue(template, pattern, context) {
  const expression = template.match(pattern)?.[1];
  assert.ok(expression, `missing template binding ${pattern}`);
  return vm.runInNewContext(`(${expression})`, context);
}

test("catalog preserves site identity, maps known cities, and never guesses Nanjing from missing fields", () => {
  const data = fixture();
  Object.assign(data.stock[0], { siteId: " nanjing ", siteName: "outdated city label" });
  Object.assign(data.stock[2], { siteName: "" });
  delete data.stock[3].siteId;
  Object.assign(data.stock[4], { siteId: "suzhou", siteName: "苏州" });
  const model = catalog.buildViewModel(data);
  const byId = Object.fromEntries(model.specimens.map((item) => [item.id, item]));
  assert.equal(byId["a-n1"].siteId, "nanjing");
  assert.equal(byId["a-n1"].siteName, "南京");
  assert.equal(byId["a-j1"].siteName, "江阴");
  assert.equal(byId["a-j2"].siteId, "");
  assert.equal(byId["a-j2"].siteName, "所在地待确认");
  assert.equal(byId["b-n1"].siteId, "suzhou");
  assert.equal(byId["b-n1"].siteName, "苏州");
  assert.ok(catalog.filterSpecimens(model, { productId: "product-a", siteId: "all" }, "all")
    .some((item) => item.id === "a-j2"));
  assert.ok(!catalog.filterSpecimens(model, { siteId: "nanjing" }, "all")
    .some((item) => item.id === "a-j2"));
  const legacy = fixture();
  legacy.stock.forEach((item) => { delete item.siteId; delete item.siteName; });
  const legacyModel = catalog.buildViewModel(legacy);
  assert.equal(catalog.filterSpecimens(legacyModel, { siteId: "nanjing" }, "all").length, 0);
  assert.equal(catalog.filterSpecimens(legacyModel, { siteId: "jiangyin" }, "all").length, 0);
  assert.equal(catalog.filterSpecimens(legacyModel, { siteId: "all" }, "all").length, 8);
});

test("fish with otherwise identical history and tank labels never group across cities", () => {
  const model = catalog.buildViewModel(fixture());
  const selected = catalog.filterSpecimens(model, { productId: "product-a" }, "all");
  const groups = catalog.groupSpecimens(selected);
  assert.equal(groups.length, 2);
  assert.deepEqual(plain(groups.map((item) => [item.siteId, item.quantity])), [
    ["nanjing", 2], ["jiangyin", 2],
  ]);
  assert.equal(groups.reduce((total, card) => total + card.quantity, 0), selected.length);
});

test("site filters intersect with both product and species instead of widening the requested inventory", () => {
  const model = catalog.buildViewModel(fixture());
  const selectIds = (selection) => plain(catalog.filterSpecimens(model, selection, "all").map((item) => item.id)).sort();
  assert.deepEqual(selectIds({ productId: "product-a", siteId: "nanjing" }), ["a-n1", "a-n2"]);
  assert.deepEqual(selectIds({ speciesId: "species-a", siteId: "jiangyin" }), ["a-j1", "a-j2", "b-j1"]);
  assert.deepEqual(selectIds({ speciesId: "species-a", productId: "product-a", siteId: "jiangyin" }), ["a-j1", "a-j2"]);
  assert.deepEqual(selectIds({ speciesId: "species-b", productId: "product-a", siteId: "jiangyin" }), []);
  assert.deepEqual(selectIds({ productId: "product-a", siteId: "all" }), selectIds({ productId: "product-a" }));
  assert.deepEqual(selectIds({ productId: "product-a", siteId: "unsupported" }), []);
});

test("the actual page switches city inventory and counts fish before grouping cards", async () => {
  const harness = pageHarness();
  const { page } = harness;
  await harness.open();
  assert.equal(page.data.selectedSiteId, "all");
  assert.equal(page.data.filteredSpecimenCount, 4);
  assert.equal(page.data.siteDataReady, true);
  assert.equal(page.data.specimens.length, 2);
  assert.deepEqual(counts(page), { all: 4, nanjing: 2, jiangyin: 2 });
  harness.select("nanjing");
  assert.equal(page.data.selectedSiteName, "南京");
  assert.equal(page.data.filteredSpecimenCount, 2);
  assert.equal(page.data.specimens.length, 1);
  assert.deepEqual(fishIds(page), ["a-n1", "a-n2"]);
  assert.deepEqual(counts(page), { all: 4, nanjing: 2, jiangyin: 2 });
  harness.select("jiangyin");
  assert.equal(page.data.selectedSiteName, "江阴");
  assert.deepEqual(fishIds(page), ["a-j1", "a-j2"]);
  harness.select("unsupported");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.context.specimenCount, 4, "the overview remains explicitly scoped to all locations");
});

test("species-level counts include that species' products but exclude other species", async () => {
  const harness = pageHarness();
  await harness.open({ speciesId: "species-a", siteId: "jiangyin" });
  assert.equal(harness.page.data.filteredSpecimenCount, 3);
  assert.deepEqual(fishIds(harness.page), ["a-j1", "a-j2", "b-j1"]);
  assert.deepEqual(counts(harness.page), { all: 6, nanjing: 3, jiangyin: 3 });
});

test("a zero-stock city remains selectable and the empty state can return to all locations", async () => {
  const data = fixture();
  data.stock = data.stock.filter((item) => item.productId !== "product-a" || item.siteId === "nanjing");
  const harness = pageHarness(data);
  const { page } = harness;
  await harness.open();
  assert.equal(page.data.siteDataReady, true);
  harness.select("jiangyin");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.error, "");
  assert.equal(page.data.filteredSpecimenCount, 0);
  assert.deepEqual(fishIds(page), []);
  assert.deepEqual(counts(page), { all: 2, nanjing: 2, jiangyin: 0 });
  page.onClearSite();
  assert.equal(page.data.selectedSiteId, "all");
  assert.equal(page.data.selectedSiteName, "全部");
  assert.equal(page.data.filteredSpecimenCount, 2);
  assert.deepEqual(fishIds(page), ["a-n1", "a-n2"]);
});

test("missing or partial site data keeps all fish browseable and shows unavailable cities instead of zero stock", async () => {
  const template = await read("pages/specimens/index.wxml");
  for (const missingMode of ["all", "partial"]) {
    const data = fixture();
    data.stock.forEach((item, index) => {
      if (missingMode === "all" || index === 0) { delete item.siteId; delete item.siteName; }
    });
    const harness = pageHarness(data);
    const { page } = harness;
    await harness.open();
    assert.equal(page.data.siteDataReady, false, missingMode);
    assert.equal(page.data.filteredSpecimenCount, 4);
    assert.deepEqual(fishIds(page), ["a-j1", "a-j2", "a-n1", "a-n2"]);
    for (const item of page.data.siteOptions) {
      const context = { ...plain(page.data), item: plain(item) };
      const displayedCount = templateValue(template, /class="site-filter-count">\{\{(.+?)\}\}/, context);
      const disabled = templateValue(template, /disabled="\{\{(.+?)\}\}"/, context);
      assert.equal(displayedCount, item.id === "all" ? 4 : "—");
      assert.equal(disabled, item.id !== "all");
      if (item.id !== "all") {
        harness.select(item.id);
        assert.equal(page.data.selectedSiteId, "all", "missing data must not be interpreted as an empty city");
        assert.equal(page.data.filteredSpecimenCount, 4);
      }
    }
    assert.match(template, /wx:if="\{\{!siteDataReady\}\}"[^>]*>暂无法按所在地筛选/);
  }
});

test("city deep links with legacy catalog data show unavailable location information and recover to all fish", async () => {
  const data = fixture();
  data.stock.forEach((item) => { delete item.siteId; delete item.siteName; });
  const harness = pageHarness(data);
  const { page } = harness;
  await harness.open({ productId: "product-a", siteId: "jiangyin" });
  assert.equal(page.data.siteDataReady, false);
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.error, "");
  assert.deepEqual(fishIds(page), []);
  const template = await read("pages/specimens/index.wxml");
  assert.equal(templateValue(template, /class="empty-title">\{\{(.+?)\}\}/, plain(page.data)), "所在地信息暂不可用");
  const selectedCity = page.data.siteOptions.find((item) => item.id === page.data.selectedSiteId);
  assert.equal(templateValue(template, /class="site-filter-count">\{\{(.+?)\}\}/,
    { ...plain(page.data), item: plain(selectedCity) }), "—");
  assert.match(template, /wx:if="\{\{selectedSiteId !== 'all'\}\}"[^>]*bindtap="onClearSite">查看全部所在地/);
  page.onClearSite();
  assert.equal(page.data.selectedSiteId, "all");
  assert.equal(page.data.selectedSiteName, "全部");
  assert.equal(page.data.siteDataReady, false);
  assert.equal(page.data.filteredSpecimenCount, 4);
  assert.deepEqual(fishIds(page), ["a-j1", "a-j2", "a-n1", "a-n2"]);
});

test("refresh preserves the chosen city while updating location counts and visible stock", async () => {
  const harness = pageHarness();
  const { page, state } = harness;
  await harness.open({ productId: "product-a", siteId: "jiangyin" });
  state.catalog.stock = state.catalog.stock.filter((item) => item.productId !== "product-a" || item.siteId !== "jiangyin");
  page.onPullDownRefresh();
  assert.equal(page.data.refreshing, true);
  await page.lastLoad;
  assert.equal(page.data.refreshing, false);
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.selectedSiteName, "江阴");
  assert.equal(page.data.filteredSpecimenCount, 0);
  assert.deepEqual(counts(page), { all: 2, nanjing: 2, jiangyin: 0 });
  state.catalog.stock.find((item) => item.id === "a-n2").siteId = "jiangyin";
  const [{ callback }] = harness.timers.values();
  callback();
  await page.lastLoad;
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.deepEqual(fishIds(page), ["a-n2"]);
  assert.deepEqual(counts(page), { all: 2, nanjing: 1, jiangyin: 1 });
});

test("hide and show retain the city selection, stop video, and refresh that city's stock", async () => {
  const harness = pageHarness();
  const { page, state, timers } = harness;
  await harness.open({ productId: "product-a", siteId: "nanjing" });
  harness.preview();
  assert.equal(state.playCount, 1);
  assert.ok(page.data.activePreviewId);
  page.onHide();
  assert.equal(state.pauseCount, 1);
  assert.equal(page.data.activePreviewId, "");
  assert.equal(page.data.selectedSiteId, "nanjing");
  assert.equal(timers.size, 0);
  state.catalog.stock = state.catalog.stock.filter((item) => item.id !== "a-n2");
  page.onShow();
  await page.lastLoad;
  assert.equal(state.fetchCount, 2);
  assert.equal(timers.size, 1);
  assert.equal(page.data.selectedSiteId, "nanjing");
  assert.deepEqual(fishIds(page), ["a-n1"]);
  assert.deepEqual(counts(page), { all: 3, nanjing: 1, jiangyin: 2 });
});

test("city changes do not end a pending refresh or let an old video start", async () => {
  const harness = pageHarness();
  const { page, state, timers } = harness;
  await harness.open();
  let resolveCatalog;
  state.pendingCatalog = new Promise((resolve) => { resolveCatalog = resolve; });
  [...timers.values()][0].callback();
  assert.equal(page.data.refreshing, true);
  assert.equal(page.data.loading, false);
  harness.preview();
  assert.equal(state.playCount, 0);
  harness.select("jiangyin");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.refreshing, true, "filtering the old list must not mark the request complete");
  page.onClearSite();
  assert.equal(page.data.refreshing, true);
  harness.preview();
  assert.equal(state.playCount, 0);
  assert.equal(state.fetchCount, 2);
  resolveCatalog(state.catalog);
  await page.lastLoad;
  assert.equal(page.data.refreshing, false);
  harness.preview();
  assert.equal(state.playCount, 1, "playback is available once current media has arrived");
});

test("returning from background keeps old signed media unmounted until the fresh catalog arrives", async () => {
  const harness = pageHarness();
  const { page, state } = harness;
  await harness.open({ productId: "product-a", siteId: "nanjing" });
  const oldTap = { currentTarget: { dataset: {
    id: page.data.specimens[0].id, preview: page.data.specimens[0].previewVideo
  } } };
  page.onHide();
  assert.equal(page.data.loading, true, "the loading branch unmounts old photos and video posters before resume");
  await page.loadSpecimens({ force: true, refreshing: true });
  assert.equal(state.fetchCount, 1, "a queued timer cannot remount old sources or start work while hidden");
  const rendersBeforeShow = state.renders.length;
  let resolveCatalog;
  state.pendingCatalog = new Promise((resolve) => { resolveCatalog = resolve; });
  page.onShow();
  assert.equal(page.data.loading, true, "the forced foreground refresh cannot remount the stale list");
  assert.equal(page.data.refreshing, false);
  page.onPreviewToggle(oldTap);
  assert.equal(state.playCount, 0);
  const freshCatalog = fixture();
  freshCatalog.bioRecords.forEach((record) => { record.videoPreviews = ["/preview.mp4?signature=fresh"]; });
  resolveCatalog(freshCatalog);
  await page.lastLoad;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.selectedSiteId, "nanjing");
  assert.ok(state.renders.slice(rendersBeforeShow).every((render) => render.loading ||
    render.previews.every((src) => src.endsWith("signature=fresh"))),
  "every visible update after resume must already contain the fresh sources");
  page.onPreviewToggle(oldTap);
  assert.equal(state.playCount, 1);
  assert.equal(page.__cardVideoSource, "https://fish.example/preview.mp4?signature=fresh");
  const template = await read("pages/specimens/index.wxml");
  assert.match(template, /wx:if="\{\{loading\}\}"[\s\S]*wx:elif="\{\{error\}\}"[\s\S]*<view wx:else>/);
});

test("detail back navigates to the existing species or product parent and preserves its selected city", async () => {
  for (const options of [{ speciesId: "species-a" }, { productId: "product-a" }]) {
    const parent = pageHarness();
    await parent.open(options);
    parent.select("jiangyin");
    const expectedFishIds = fishIds(parent.page);
    parent.page.onHide();
    const { detail, calls, pages } = await detailBackHarness(parent);
    detail.onBackTap();
    assert.deepEqual(calls, [{ type: "back", delta: 1 }], "returning to the parent must not redirect and reset its filter");
    assert.equal(pages[pages.length - 1], parent.page);
    assert.equal(parent.page.data.selectedSiteId, "jiangyin");
    assert.deepEqual(fishIds(parent.page), expectedFishIds);
    parent.page.onShow();
    await parent.page.lastLoad;
    assert.equal(parent.page.data.selectedSiteId, "jiangyin");
    assert.deepEqual(fishIds(parent.page), expectedFishIds);
  }
});

test("detail back from an unrelated species or product parent falls back to the fish's own product", async () => {
  for (const options of [{ speciesId: "species-b" }, { productId: "product-c", speciesId: "species-a" }]) {
    const parent = pageHarness();
    await parent.open(options);
    parent.select("jiangyin");
    parent.page.onHide();
    const { detail, calls } = await detailBackHarness(parent);
    detail.onBackTap();
    assert.deepEqual(calls, [{ type: "redirect", url: "/pages/specimens/index?productId=product-a" }]);
    assert.equal(parent.page.data.selectedSiteId, "jiangyin");
  }
});

test("switching city and clearing the filter pause the current card video", async () => {
  const harness = pageHarness();
  const { page, state } = harness;
  await harness.open();
  harness.preview();
  harness.select("jiangyin");
  assert.equal(state.pauseCount, 1);
  assert.equal(page.data.activePreviewId, "");
  harness.preview();
  page.onClearSite();
  assert.equal(state.pauseCount, 2);
  assert.equal(page.data.activePreviewId, "");
});

test("an expired card preview refreshes its source and requires a fresh tap", async () => {
  const staleCatalog = fixture();
  staleCatalog.bioRecords.forEach((record) => {
    record.videoPreviews = ["/api/public/media/video-derivative?kind=preview&url=fish.mp4&expires=1&signature=old"];
  });
  const harness = pageHarness(staleCatalog);
  await harness.open();
  harness.state.catalog = fixture();
  harness.preview();
  assert.equal(harness.state.playCount, 0);
  assert.equal(harness.page.data.refreshing, true);
  await harness.page.lastLoad;
  assert.equal(harness.state.playCount, 0, "refreshing must not autoplay");
  harness.preview();
  assert.equal(harness.state.playCount, 1);
  assert.equal(harness.page.__cardVideoSource, "https://fish.example/preview.mp4");
  harness.page.onUnload();
});

test("shares round-trip the location for product and species links and omit the all-location default", async () => {
  for (const selection of [{ productId: "product-a" }, { speciesId: "species-a" }]) {
    const sender = pageHarness();
    await sender.open({ ...selection, siteId: "%6A%69%61%6E%67%79%69%6E" });
    assert.equal(sender.page.data.selectedSiteId, "jiangyin");
    const share = sender.page.onShareAppMessage();
    assert.match(share.path, /&siteId=jiangyin$/);
    assert.match(share.title, /江阴库存$/);
    const recipient = pageHarness();
    await recipient.open(Object.fromEntries(new URL(share.path, "https://fish.example").searchParams));
    assert.equal(recipient.page.data.selectedSiteId, "jiangyin");
    assert.deepEqual(fishIds(recipient.page), fishIds(sender.page));
    sender.page.onClearSite();
    assert.doesNotMatch(sender.page.onShareAppMessage().path, /siteId=/);
  }
  for (const siteId of ["unsupported", "%E0%A4%A"]) {
    const harness = pageHarness();
    await harness.open({ productId: "product-a", siteId });
    assert.equal(harness.page.data.selectedSiteId, "all");
    assert.equal(harness.page.data.selectedSiteName, "全部");
    assert.equal(harness.page.data.filteredSpecimenCount, 4);
  }
});

test("refresh errors fail closed without allowing city switches to resurrect cached fish", async () => {
  const harness = pageHarness();
  const { page, state, app } = harness;
  await harness.open({ productId: "product-a", siteId: "jiangyin" });
  harness.preview();
  state.catalog = new Error("catalog unavailable");
  await page.loadSpecimens({ force: true, refreshing: true });
  assert.equal(page.data.error, "catalog unavailable");
  assert.equal(page.data.context, null);
  assert.equal(page.viewModel, null);
  assert.equal(app.globalData.catalog, null);
  assert.equal(app.globalData.catalogViewModel, null);
  assert.equal(app.globalData.loadedAt, 0);
  assert.equal(page.data.activePreviewId, "");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.filteredSpecimenCount, 0);
  assert.deepEqual(counts(page), { all: 0, nanjing: 0, jiangyin: 0 });
  assert.deepEqual(fishIds(page), []);
  harness.select("nanjing");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.deepEqual(fishIds(page), []);
  state.catalog = fixture();
  page.onRetry();
  await page.lastLoad;
  assert.equal(page.data.error, "");
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.deepEqual(fishIds(page), ["a-j1", "a-j2"]);
});

test("location labels and empty-state recovery are wired to the user-facing templates", async () => {
  const [specimens, detail, styles] = await Promise.all([
    read("pages/specimens/index.wxml"), read("pages/detail/index.wxml"), read("pages/specimens/index.wxss"),
  ]);
  assert.match(specimens, /data-site-id="\{\{item.id\}\}" bindtap="onSiteTap"/);
  assert.match(specimens, /class="site-filter-row">\s*<text class="site-filter-label">所在地<\/text>/);
  assert.doesNotMatch(specimens, /class="(?:list-heading|section-count)"/);
  assert.match(specimens, /bindtap="onClearSite">查看全部所在地/);
  const harness = pageHarness();
  await harness.open();
  harness.select("jiangyin");
  assert.deepEqual(plain(harness.page.data.siteOptions.map((item) => item.id)), ["all", "nanjing", "jiangyin"]);
  for (const item of harness.page.data.siteOptions) {
    const context = { ...plain(harness.page.data), item: plain(item) };
    assert.equal(templateValue(specimens, /class="site-filter-count">\{\{(.+?)\}\}/, context), item.count);
    assert.equal(templateValue(specimens, /aria-pressed="\{\{(.+?)\}\}"/, context), item.id === "jiangyin");
    assert.equal(templateValue(specimens, /wx:if="\{\{(.+?)\}\}" class="site-selected-line"/, context), item.id === "jiangyin");
    const label = specimens.match(/aria-label="(所在地\{\{item.label\}\}[^"\n]*)"/)?.[1];
    assert.ok(label, "each location button must have a readable label and count");
    const renderedLabel = label.replace(/\{\{(.+?)\}\}/g, (_, expression) => vm.runInNewContext(`(${expression})`, context));
    assert.equal(renderedLabel, `所在地${item.label}，${item.count}条${item.id === "jiangyin" ? "，已选中" : ""}`);
  }
  assert.match(specimens, /class="site-selected-line" aria-hidden="true"/);
  const buttonStyles = styles.match(/\.specimens-page \.site-filter-button\s*\{([^}]+)\}/)?.[1];
  assert.ok(buttonStyles, "location buttons need their own minimum touch dimensions");
  assert.ok(Number(buttonStyles.match(/min-height:\s*([\d.]+)px/)?.[1]) >= 44);
  assert.ok(Number(buttonStyles.match(/min-width:\s*([\d.]+)px/)?.[1]) >= 44);
  assert.match(styles, /\.site-selected-line\s*\{[^}]*height:\s*2px/);
  for (const [stock, expected] of [
    [{ siteId: "nanjing", siteName: "南京" }, "所在地 · 南京"],
    [{ siteId: "jiangyin", siteName: "江阴" }, "所在地 · 江阴"],
    [{ siteId: "", siteName: "所在地待确认" }, "所在地待确认"],
  ]) {
    assert.equal(templateValue(specimens, /class="specimen-site">\{\{(.+?)\}\}/, { item: stock }), expected);
    assert.equal(templateValue(detail, /class="detail-site">\{\{(.+?)\}\}/, { specimen: stock }), expected);
  }
});
