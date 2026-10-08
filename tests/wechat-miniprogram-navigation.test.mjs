import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../wechat-miniprogram/${path}`, import.meta.url), "utf8");
const navigationSource = await read("utils/navigation.js");
function navigation(pages, wx) {
  const context = { module: { exports: {} }, getCurrentPages: () => pages, wx };
  vm.runInNewContext(navigationSource, context);
  return context.module.exports;
}

test("brand header reserves room for the larger logo and keeps the native capsule clear", () => {
  for (const windowWidth of [320, 350, 360, 370, 371, 375, 390, 430, 768]) {
    const metrics = navigation([], {
      getWindowInfo: () => ({ windowWidth, statusBarHeight: 20 }),
      getMenuButtonBoundingClientRect: () => ({ top: 26, height: 32, left: windowWidth - 88 }),
    }).getNavigationMetrics();
    assert.equal(metrics.navBarHeight, 64);
    assert.equal(metrics.navigationHeight, 84);
    // Both text rows share one fixed-width column next to the logo.
    const brandWidth = windowWidth <= 370
      ? 42 + 8 + 146
      : 52 + 10 + 176;
    const leftGutter = 32 * windowWidth / 750;
    assert.ok(brandWidth + leftGutter + metrics.menuRightPadding <= windowWidth);
    const noCapsule = navigation([], {
      getWindowInfo: () => ({ windowWidth, statusBarHeight: 20 }),
    }).getNavigationMetrics();
    assert.ok(brandWidth + leftGutter + noCapsule.menuRightPadding <= windowWidth);
  }
  const fallback = navigation([], {}).getNavigationMetrics();
  assert.equal(fallback.navBarHeight, 64);
  assert.ok(Number.isFinite(fallback.menuRightPadding));
});

test("back uses the matching parent instance so scroll position and filters survive", () => {
  let delta;
  const parent = { route: "pages/products/index", options: { category: "%E9%9A%86%E5%A4%B4%E9%B1%BC%E7%A7%91" }, scrollTop: 560, keyword: "龙" };
  const pages = [{ route: "pages/catalog/index" }, parent, { route: "pages/specimens/index" }];
  navigation(pages, { navigateBack(options) { delta = options.delta; } }).returnToParent("pages/products/index", { category: "隆头鱼科" });
  assert.equal(delta, 1);
  assert.equal(parent.scrollTop, 560);
  assert.equal(parent.keyword, "龙");
});

test("direct entry and an unrelated previous product still lead to the correct parent", () => {
  for (const pages of [
    [{ route: "pages/detail/index" }],
    [{ route: "pages/specimens/index", options: { productId: "wrong" } }, { route: "pages/detail/index" }],
  ]) {
    let url;
    navigation(pages, { redirectTo(options) { url = options.url; } }).returnToParent("pages/specimens/index", { productId: "product & 1" });
    assert.equal(url, "/pages/specimens/index?productId=product%20%26%201");
  }
});

test("failed back falls through to redirect and catalog without leaving a dead control", () => {
  const urls = [];
  const wx = {
    navigateBack(options) { options.fail(); },
    redirectTo(options) { urls.push(options.url); options.fail(); },
    reLaunch(options) { urls.push(options.url); },
  };
  navigation([{ route: "pages/catalog/index" }, { route: "pages/products/index" }], wx).returnToParent("pages/catalog/index");
  assert.deepEqual(urls, ["/pages/catalog/index", "/pages/catalog/index"]);
});

test("all non-root pages provide a visible back control even while loading or failed", async () => {
  for (const name of ["products", "specimens", "detail"]) {
    const template = await read(`pages/${name}/index.wxml`);
    assert.ok(template.indexOf('bindtap="onBackTap"') < template.indexOf('wx:if="{{loading}}"'));
    assert.match(await read(`pages/${name}/index.js`), /onBackTap\(\)\s*\{[\s\S]*?returnToParent\(/);
  }
  const styles = await read("app.wxss");
  assert.match(styles, /\.page-back-row\s*\{[^}]*position: sticky/);
  assert.match(styles, /\.page-back-button\[size="mini"\]\s*\{[^}]*min-height: 44px/);
  assert.match(await read("pages/products/index.wxml"), /class="back-row" style="top: \{\{navigationHeight\}\}px;"/);
  assert.match(await read("pages/products/index.wxss"), /\.products-page \.custom-nav\s*\{[^}]*position: sticky/);
});
