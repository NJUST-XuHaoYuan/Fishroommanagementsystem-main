import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../wechat-miniprogram/${path}`, import.meta.url), "utf8");
const paths = ["utils/site-filter.js", "utils/config.js", "utils/catalog.js", "utils/public-catalog-refresh.js", "utils/navigation.js",
  "utils/card-video-preview.js", "pages/catalog/index.js", "pages/products/index.js", "pages/specimens/index.js"];
const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await read(path)])));
const plain = (value) => JSON.parse(JSON.stringify(value));
const storageKey = "marineForest.catalogSiteId";

function load(source, dependencies = {}, globals = {}) {
  const context = { module: { exports: {} }, require(id) {
    assert.ok(id in dependencies, `unexpected dependency ${id}`);
    return dependencies[id];
  }, ...globals };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

const catalog = load(sources["utils/catalog.js"], { "./api": { getApiBaseUrl: () => "https://fish.example" } });

function fixture() {
  return {
    speciesCategories: ["Reef & fish", "Coral"],
    speciesCategoryMajorMap: { "Reef & fish": "marineFish", Coral: "coral" },
    species: [
      { id: "reef", name: "Tang", category: "Reef & fish", commonNames: ["surgeonfish"] },
      { id: "coral", name: "Coral", category: "Coral" },
    ],
    products: [
      { id: "shared", speciesId: "reef", name: "Blue tang", size: "M", origin: "Indonesia", defaultPrice: 200 },
      { id: "n-only", speciesId: "reef", name: "Yellow tang", size: "L", defaultPrice: 300 },
      { id: "j-only", speciesId: "coral", name: "Red coral", defaultPrice: 100 },
    ],
    stock: [
      { id: "n-blue-1", productId: "shared", siteId: "nanjing", basePrice: 180, status: "feeding" },
      { id: "n-blue-2", productId: "shared", siteId: "nanjing", basePrice: 200, status: "feeding" },
      { id: "j-blue", productId: "shared", siteId: "jiangyin", basePrice: 260, status: "healthy" },
      { id: "n-yellow", productId: "n-only", siteId: "nanjing", basePrice: 300, status: "healthy" },
      { id: "j-coral", productId: "j-only", siteId: "jiangyin", basePrice: 90, status: "feeding" },
    ].map((item) => ({ ...item, notes: "", code: "", inDate: "2020-01-01" })),
    bioRecords: [],
  };
}

function environment(initialCatalog = fixture(), preferredSite) {
  const app = { globalData: { siteId: "all", catalog: null, catalogViewModel: null, loadedAt: 0 } };
  const storage = new Map(preferredSite ? [[storageKey, preferredSite]] : []);
  const state = { catalog: initialCatalog, requests: [], navigations: [], timers: new Map(), pages: [] };
  let timerId = 0;
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    getWindowInfo: () => ({ windowWidth: 375, statusBarHeight: 20 }),
    stopPullDownRefresh() {}, setNavigationBarTitle() {}, showToast() {},
    createVideoContext: () => ({ play() {}, pause() {} }),
    navigateTo: ({ url }) => state.navigations.push(url),
    navigateBack({ delta }) { state.navigations.push({ back: delta }); state.pages.splice(-delta); },
    redirectTo: ({ url }) => state.navigations.push(url),
    reLaunch: ({ url }) => state.navigations.push(url),
  };
  const globals = { wx, getApp: () => app, getCurrentPages: () => state.pages,
    setInterval(callback) { const id = ++timerId; state.timers.set(id, callback); return id; },
    clearInterval(id) { state.timers.delete(id); },
  };
  const site = load(sources["utils/site-filter.js"], {}, globals);
  const dependencies = {
    "../../utils/api": { async fetchCatalog(...args) {
      state.requests.push(args);
      return state.pending ? await state.pending : state.catalog;
    } },
    "../../utils/catalog": catalog,
    "../../utils/config": load(sources["utils/config.js"]),
    "../../utils/site-filter": site,
    "../../utils/navigation": load(sources["utils/navigation.js"], {}, globals),
    "../../utils/public-catalog-refresh": load(sources["utils/public-catalog-refresh.js"], {}, globals),
    "../../utils/card-video-preview": load(sources["utils/card-video-preview.js"], {}, globals),
  };
  const createPage = (name) => {
    let page;
    load(sources[`pages/${name}/index.js`], dependencies, { ...globals, Page(value) { page = value; } });
    page.data = plain(page.data);
    page.setData = (patch, callback) => { Object.assign(page.data, patch); callback?.(); };
    page.route = `pages/${name}/index`;
    const loadName = { catalog: "loadCatalog", products: "loadProducts", specimens: "loadSpecimens" }[name];
    const originalLoad = page[loadName];
    page[loadName] = function (...args) { this.lastLoad = originalLoad.apply(this, args); return this.lastLoad; };
    return page;
  };
  return { app, storage, state, site, wx, createPage,
    async open(name, options = {}) {
      const page = createPage(name);
      page.options = plain(options);
      state.pages.push(page);
      page.onLoad(options);
      page.onShow();
      await page.lastLoad;
      return page;
    },
  };
}

const select = (page, siteId) => page.onSiteTap({ currentTarget: { dataset: { siteId } } });
async function resumeInCity(harness, page, siteId) {
  page.onHide();
  harness.site.setSiteSelection(siteId);
  page.onShow();
  await page.lastLoad;
}
const ids = (items) => plain(items.map((item) => item.id)).sort();
const product = (model, id = "shared") => model.productCards.find((item) => item.id === id);
const productOptions = { category: "Reef%20%26%20fish", majorKey: "marineFish" };
function pending() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("city preference accepts explicit all, persists across sessions and never changes the API scope or caches", () => {
  const h = environment(fixture(), "jiangyin");
  h.app.globalData.siteId = "api-scope-must-survive";
  const cache = {};
  h.app.globalData.catalogViewModel = cache;
  assert.deepEqual(plain(h.site.SITE_OPTIONS), [
    { id: "all", label: "全部" }, { id: "nanjing", label: "南京" }, { id: "jiangyin", label: "江阴" },
  ]);
  assert.deepEqual(plain(h.site.getSiteSelection()), { id: "jiangyin", label: "江阴" });
  assert.deepEqual(plain(h.site.getSiteSelection("all")), { id: "all", label: "全部" });
  assert.equal(h.storage.get(storageKey), "all");
  assert.equal(h.site.setSiteSelection("nanjing").id, "nanjing");
  assert.equal(h.site.setSiteSelection("unsupported"), null);
  assert.equal(h.site.getSiteSelection("unsupported").id, "nanjing");
  assert.equal(h.storage.get(storageKey), "nanjing");
  assert.equal(h.app.globalData.catalogSiteFilterId, "nanjing");
  assert.equal(h.app.globalData.siteId, "api-scope-must-survive");
  assert.equal(h.app.globalData.catalogViewModel, cache);
  assert.deepEqual([...h.storage.keys()], [storageKey]);
  const nextApp = { globalData: { siteId: "all" } };
  const nextSession = load(sources["utils/site-filter.js"], {}, { wx: h.wx, getApp: () => nextApp });
  assert.equal(nextSession.getSiteSelection().id, "nanjing");
});

test("invalid stored preferences and unavailable storage remain browseable with an in-memory selection", () => {
  const h = environment(fixture(), "wrong-city");
  assert.equal(h.site.getSiteSelection().id, "all");
  const app = { globalData: { siteId: "all" } };
  const site = load(sources["utils/site-filter.js"], {}, { getApp: () => app, wx: {
    getStorageSync() { throw new Error("storage unavailable"); },
    setStorageSync() { throw new Error("storage unavailable"); },
  } });
  assert.equal(site.getSiteSelection().id, "all");
  assert.equal(site.setSiteSelection("jiangyin").id, "jiangyin");
  assert.equal(site.getSiteSelection().id, "jiangyin");
  assert.equal(app.globalData.siteId, "all");
});

test("city view models recalculate category, product, price and tag counts from that city's fish", () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const all = catalog.buildViewModel(data);
  const cachedBefore = JSON.stringify(all);
  const nanjing = catalog.buildViewModel(data, "nanjing");
  const jiangyin = catalog.buildViewModel(data, "jiangyin");
  assert.equal(all.totalProducts, 3);
  assert.equal(all.totalSpecimens, 5);
  assert.deepEqual(ids(nanjing.productCards), ["n-only", "shared"]);
  assert.deepEqual(ids(jiangyin.productCards), ["j-only", "shared"]);
  assert.equal(nanjing.totalSpecimens, 3);
  assert.equal(jiangyin.totalSpecimens, 2);
  assert.equal(nanjing.categories.length, 1);
  assert.equal(jiangyin.categories.length, 2);
  assert.equal(nanjing.categories[0].productCount, 2);
  assert.equal(nanjing.categories[0].specimenCount, 3);
  assert.equal(product(nanjing).price, 180);
  assert.equal(product(nanjing).specimenCount, 2);
  assert.equal(product(jiangyin).price, 260);
  assert.equal(product(jiangyin).specimenCount, 1);
  const nTags = Object.fromEntries(product(nanjing).tags.map((tag) => [tag.key, { count: tag.count, label: tag.label }]));
  const jTags = Object.fromEntries(product(jiangyin).tags.map((tag) => [tag.key, tag.count]));
  assert.deepEqual(nTags.feeding, { count: 2, label: "已开口" });
  assert.deepEqual(nTags.special, { count: 1, label: "特价 1条" });
  assert.equal(nTags.healthy, undefined);
  assert.equal(jTags.healthy, 1);
  assert.equal(jTags.feeding, undefined);
  assert.equal(jTags.special, undefined);
  assert.equal(jiangyin.speciesCards.find((item) => item.id === "reef").productCount, 1);
  assert.equal(JSON.stringify(data), before, "the API response remains complete and unchanged");
  assert.equal(JSON.stringify(all), cachedBefore, "a previously cached all-city model is unchanged");
  assert.deepEqual(plain(catalog.buildViewModel(data, "all")), plain(all));
});

test("zero-stock cities have no phantom cards and unknown locations appear only under all", () => {
  const data = fixture();
  data.stock = data.stock.filter((item) => item.siteId === "nanjing");
  data.stock.push({ id: "unknown", productId: "shared", basePrice: 1 });
  const empty = catalog.buildViewModel(data, "jiangyin");
  assert.equal(empty.totalProducts, 0);
  assert.equal(empty.totalSpecimens, 0);
  assert.deepEqual(plain(empty.majorGroups), []);
  assert.deepEqual(plain(empty.productCards), []);
  assert.equal(catalog.buildViewModel(data, "all").totalSpecimens, 4);
  assert.equal(catalog.buildViewModel(data, "nanjing").totalSpecimens, 3);
});

test("home switches locally without requests or full-cache pollution and shares an explicit city", async () => {
  const h = environment();
  const page = await h.open("catalog", { siteId: "nanjing" });
  assert.equal(page.data.totalSpecimens, 3);
  const full = h.app.globalData.catalogViewModel;
  const cacheBefore = JSON.stringify(full);
  assert.equal(full.totalSpecimens, 5);
  select(page, "jiangyin");
  assert.equal(page.data.selectedSiteName, "江阴");
  assert.equal(page.data.totalSpecimens, 2);
  assert.equal(page.data.majorGroups.length, 2);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.app.globalData.catalogViewModel, full);
  assert.equal(JSON.stringify(full), cacheBefore);
  assert.equal(h.app.globalData.siteId, "all");
  page.onMinorCategoryTap({ currentTarget: { dataset: { category: "Reef & fish", majorKey: "marineFish" } } });
  const route = new URL(h.state.navigations.at(-1), "https://fish.example");
  assert.equal(route.searchParams.get("category"), "Reef & fish");
  assert.equal(route.searchParams.get("siteId"), "jiangyin");
  assert.equal(new URL(page.onShareAppMessage().path, "https://fish.example").searchParams.get("siteId"), "jiangyin");
  page.onClearSite();
  assert.equal(page.data.totalSpecimens, 5);
  assert.equal(new URL(page.onShareAppMessage().path, "https://fish.example").searchParams.get("siteId"), "all");
});

test("a late home refresh keeps the latest city selection and refreshes the full cache", async () => {
  const h = environment();
  const page = await h.open("catalog", { siteId: "nanjing" });
  const delayed = pending();
  h.state.pending = delayed.promise;
  const loading = page.loadCatalog({ force: true, refreshing: true });
  select(page, "jiangyin");
  select(page, "all");
  select(page, "jiangyin");
  assert.equal(page.data.totalSpecimens, 2, "switches render immediately using the current full snapshot");
  assert.equal(page.data.refreshing, true);
  const fresh = fixture();
  fresh.stock = fresh.stock.filter((item) => item.id !== "j-blue");
  delayed.resolve(fresh);
  await loading;
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.totalSpecimens, 1);
  assert.equal(h.app.globalData.catalogViewModel.totalSpecimens, 4);
  assert.equal(page.data.refreshing, false);
});

test("a home city with no stock stays an empty result and can return to all", async () => {
  const data = fixture();
  data.stock = data.stock.filter((item) => item.siteId === "nanjing");
  const h = environment(data);
  const page = await h.open("catalog", { siteId: "jiangyin" });
  assert.equal(page.data.error, "");
  assert.equal(page.data.totalSpecimens, 0);
  assert.deepEqual(plain(page.data.majorGroups), []);
  page.onClearSite();
  assert.equal(page.data.selectedSiteId, "all");
  assert.equal(page.data.totalSpecimens, 3);
  assert.equal(h.state.requests.length, 1);
});

test("product search intersects city stock and resuming with a home preference recalculates price and tags", async () => {
  const h = environment();
  const page = await h.open("products", { ...productOptions, siteId: "nanjing" });
  assert.deepEqual(ids(page.data.products), ["n-only", "shared"]);
  page.onSearchInput({ detail: { value: "blue" } });
  assert.deepEqual(ids(page.data.products), ["shared"]);
  assert.equal(page.data.filteredSpecimenCount, 2);
  assert.equal(page.data.products[0].price, 180);
  await resumeInCity(h, page, "jiangyin");
  assert.equal(page.data.keyword, "blue");
  assert.equal(page.data.filteredSpecimenCount, 1);
  assert.equal(page.data.products[0].price, 260);
  assert.ok(page.data.products[0].tags.every((tag) => !["special", "feeding"].includes(tag.key)));
  page.onSearchInput({ detail: { value: "yellow" } });
  assert.deepEqual(plain(page.data.products), []);
  assert.equal(page.data.error, "");
  await resumeInCity(h, page, "nanjing");
  assert.deepEqual(ids(page.data.products), ["n-only"]);
  page.onClearSearch();
  assert.deepEqual(ids(page.data.products), ["n-only", "shared"]);
  assert.equal(h.state.requests.length, 3, "each foreground return refreshes while search stays local");
  assert.equal(h.app.globalData.catalogViewModel.totalSpecimens, 5);
  page.onProductTap({ currentTarget: { dataset: { id: "shared" } } });
  assert.equal(new URL(h.state.navigations.at(-1), "https://fish.example").searchParams.get("siteId"), "nanjing");
});

test("late product refresh preserves the latest city and search while replacing full cached data", async () => {
  const h = environment();
  const page = await h.open("products", { ...productOptions, siteId: "nanjing" });
  const delayed = pending();
  h.state.pending = delayed.promise;
  const loading = page.loadProducts({ force: true, refreshing: true });
  const current = pending();
  h.state.pending = current.promise;
  const resumed = resumeInCity(h, page, "jiangyin");
  page.onSearchInput({ detail: { value: "blue" } });
  assert.equal(page.data.refreshing, true);
  assert.equal(page.data.products[0].price, 260);
  const fresh = fixture();
  fresh.stock.find((item) => item.id === "j-blue").basePrice = 275;
  current.resolve(fresh);
  await resumed;
  delayed.resolve(fixture());
  await loading;
  assert.equal(page.data.selectedSiteId, "jiangyin");
  assert.equal(page.data.keyword, "blue");
  assert.equal(page.data.products[0].price, 275);
  assert.equal(page.data.filteredSpecimenCount, 1);
  assert.equal(page.data.refreshing, false);
  assert.equal(h.app.globalData.catalogViewModel.totalSpecimens, 5);
  assert.equal(h.app.globalData.catalog.stock.find((item) => item.id === "j-blue").basePrice, 275,
    "a response from the visit before returning home cannot overwrite the new snapshot");
});

test("a product category absent from the selected city is an empty result, not an API error", async () => {
  const h = environment();
  const page = await h.open("products", { category: "Coral", majorKey: "coral", siteId: "nanjing" });
  assert.equal(page.data.error, "");
  assert.equal(page.data.categoryInfo.label, "Coral");
  assert.equal(page.data.filteredSpecimenCount, 0);
  assert.deepEqual(plain(page.data.products), []);
  page.onChangeSiteTap();
  assert.equal(h.state.navigations.at(-1), "/pages/catalog/index");
  assert.equal(page.data.selectedSiteId, "nanjing");
  assert.equal(h.site.getSiteSelection().id, "nanjing", "recovery navigates without widening the selected city");
  assert.deepEqual(plain(page.data.products), []);
  assert.equal(h.state.requests.length, 1);
  const home = await h.open("catalog");
  assert.equal(home.data.selectedSiteId, "nanjing");
  select(home, "all");
  const recovered = await h.open("products", { category: "Coral", majorKey: "coral" });
  assert.deepEqual(ids(recovered.data.products), ["j-only"]);
});

test("explicit all-city shares override a recipient's saved city on every filterable page", async () => {
  for (const [name, options] of [["catalog", {}], ["products", productOptions], ["specimens", { productId: "shared" }]]) {
    const sender = environment();
    const page = await sender.open(name, { ...options, siteId: "all" });
    const share = new URL(page.onShareAppMessage().path, "https://fish.example");
    assert.equal(share.searchParams.get("siteId"), "all", name);
    const recipient = environment(fixture(), "jiangyin");
    const received = await recipient.open(name, Object.fromEntries(share.searchParams));
    assert.equal(received.data.selectedSiteId, "all", name);
    assert.equal(recipient.site.getSiteSelection().id, "all", name);
  }
});

test("the inherited specimen city survives normal back navigation to both existing parents", async () => {
  const h = environment(fixture(), "nanjing");
  const home = await h.open("catalog");
  home.onHide();
  const products = await h.open("products", productOptions);
  assert.equal(products.data.selectedSiteId, "nanjing");
  products.onHide();
  const specimens = await h.open("specimens", { productId: "shared" });
  assert.equal(specimens.data.filteredSpecimenCount, 2);
  assert.equal(specimens.data.context.priceRange, "¥180");
  assert.equal(specimens.data.context.specimenCount, 2);
  specimens.onBackTap();
  assert.deepEqual(h.state.navigations.at(-1), { back: 1 });
  assert.equal(h.state.pages.at(-1), products);
  products.onShow();
  await products.lastLoad;
  assert.equal(products.data.selectedSiteId, "nanjing");
  assert.equal(products.data.products.find((item) => item.id === "shared").price, 180);
  products.onBackTap();
  assert.deepEqual(h.state.navigations.at(-1), { back: 1 });
  assert.equal(h.state.pages.at(-1), home);
  home.onShow();
  await home.lastLoad;
  assert.equal(home.data.selectedSiteId, "nanjing");
  assert.equal(home.data.totalSpecimens, 3);
  assert.equal(h.app.globalData.catalogViewModel.totalSpecimens, 5);
  assert.equal(h.app.globalData.siteId, "all");
});

test("inner empty-state recovery reuses home without changing city, including deep-link fallback", async () => {
  for (const [name, options] of [
    ["products", { category: "Coral", majorKey: "coral" }],
    ["specimens", { productId: "j-only" }],
  ]) {
    for (const hasHome of [true, false]) {
      const h = environment(fixture(), "nanjing");
      const home = hasHome ? await h.open("catalog") : null;
      home?.onHide();
      if (hasHome && name === "specimens") {
        const products = await h.open("products", { category: "Coral", majorKey: "coral" });
        products.onHide();
      }
      const page = await h.open(name, options);
      assert.equal(page.data.error, "");
      assert.equal(page.data.filteredSpecimenCount, 0);
      const cache = h.app.globalData.catalogViewModel;
      const requestCount = h.state.requests.length;
      assert.equal(page.onSiteTap, undefined, "inner pages cannot directly switch city");
      assert.equal(page.onClearSite, undefined, "inner pages cannot clear the city");
      page.onChangeSiteTap();
      assert.equal(h.site.getSiteSelection().id, "nanjing");
      assert.equal(h.storage.get(storageKey), "nanjing");
      assert.equal(page.data.selectedSiteId, "nanjing");
      assert.equal(h.app.globalData.catalogViewModel, cache);
      assert.equal(h.state.requests.length, requestCount);
      if (hasHome) {
        assert.deepEqual(h.state.navigations.at(-1), { back: name === "specimens" ? 2 : 1 });
        assert.equal(h.state.pages.at(-1), home);
        home.onShow();
        await home.lastLoad;
        assert.equal(home.data.selectedSiteId, "nanjing");
      } else {
        assert.equal(h.state.navigations.at(-1), "/pages/catalog/index");
      }
    }
  }
});
