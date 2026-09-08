import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const apiSource = await readFile(new URL("../wechat-miniprogram/utils/api.js", import.meta.url), "utf8");
const refreshSource = await readFile(new URL("../wechat-miniprogram/utils/public-catalog-refresh.js", import.meta.url), "utf8");
const pageSources = await Promise.all([
  "../wechat-miniprogram/pages/catalog/index.js",
  "../wechat-miniprogram/pages/products/index.js",
  "../wechat-miniprogram/pages/specimens/index.js",
  "../wechat-miniprogram/pages/detail/index.js"
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

test("production mini-program never imports or reuses a catalog fallback", () => {
  assert.doesNotMatch(apiSource, /require\(["']\.\/fallback-catalog["']\)/);
  assert.doesNotMatch(apiSource, /return\s+fallbackCatalog\b/);
  assert.doesNotMatch(apiSource, /lastCatalog/);
  assert.doesNotMatch(apiSource, /catch\s*\(/);
});

test("real inventory fallback data and its generator are absent from the package", async () => {
  const removedPaths = [
    new URL("../wechat-miniprogram/utils/fallback-catalog.js", import.meta.url),
    new URL("../wechat-miniprogram/assets/fallback-products/", import.meta.url),
    new URL("../scripts/generate-wechat-fallback.mjs", import.meta.url)
  ];
  for (const removedPath of removedPaths) {
    await assert.rejects(access(removedPath), (error) => error && error.code === "ENOENT");
  }
});

test("catalog pages clear cached and rendered inventory after refresh failures", () => {
  for (const pageSource of pageSources) {
    assert.match(pageSource, /catch\s*\(error\)[\s\S]*?globalData\.catalog\s*=\s*null/);
    assert.match(pageSource, /globalData\.catalogViewModel\s*=\s*null/);
    assert.match(pageSource, /beginPublicCatalogRequest\(this\)/);
    assert.match(pageSource, /isCurrentPublicCatalogRequest\(this,\s*requestGeneration\)/);
  }
  assert.match(pageSources[0], /catch\s*\(error\)[\s\S]*?majorGroups:\s*\[\]/);
  assert.match(pageSources[1], /catch\s*\(error\)[\s\S]*?products:\s*\[\]/);
  assert.match(pageSources[2], /catch\s*\(error\)[\s\S]*?specimens:\s*\[\]/);
  assert.match(pageSources[3], /catch\s*\(error\)[\s\S]*?specimen:\s*null/);
});

test("using a shared catalog cache never renews its original freshness timestamp", () => {
  for (const pageSource of pageSources.slice(0, 3)) {
    assert.match(pageSource, /if\s*\(!useCache\)\s*app\.globalData\.loadedAt\s*=\s*Date\.now\(\)/);
    assert.doesNotMatch(pageSource, /app\.globalData\.loadedAt\s*=\s*now/);
  }
});

test("visible catalog pages refresh every minute and refresh immediately when returning stale", () => {
  const timers = new Map();
  let nextTimerId = 0;
  const app = { globalData: { loadedAt: Date.now() } };
  const context = {
    module: { exports: {} },
    exports: {},
    getApp: () => app,
    setInterval: (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  };
  vm.runInNewContext(refreshSource, context);
  const {
    PUBLIC_CATALOG_REFRESH_MS,
    beginPublicCatalogRequest,
    isCurrentPublicCatalogRequest,
    startPublicCatalogRefresh,
    stopPublicCatalogRefresh
  } = context.module.exports;
  const page = {};
  let refreshCount = 0;

  startPublicCatalogRefresh(page, () => { refreshCount += 1; });
  assert.equal(refreshCount, 0, "first onShow must not duplicate the initial request");
  assert.equal(timers.get(page.__publicCatalogRefreshTimer).delay, PUBLIC_CATALOG_REFRESH_MS);

  startPublicCatalogRefresh(page, () => { refreshCount += 1; });
  assert.equal(refreshCount, 1, "every later onShow must refresh even if another page updated the shared cache");
  timers.get(page.__publicCatalogRefreshTimer).callback();
  assert.equal(refreshCount, 2, "the visible-page timer must refresh automatically");

  const generation = beginPublicCatalogRequest(page);
  assert.equal(isCurrentPublicCatalogRequest(page, generation), true);
  stopPublicCatalogRefresh(page);
  assert.equal(isCurrentPublicCatalogRequest(page, generation), false, "onHide must invalidate late responses");
  assert.equal(timers.size, 0);
});
