import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const base = new URL("../wechat-miniprogram/pages/catalog/", import.meta.url);
const template = await readFile(new URL("index.wxml", base), "utf8");
const styles = await readFile(new URL("index.wxss", base), "utf8");
const source = await readFile(new URL("index.js", base), "utf8");

test("catalog keeps real category counts, brand assets and accessible navigation", () => {
  for (const binding of ["major.categoryCount", "major.specimenCount", "minor.productCount", "minor.specimenCount"]) {
    assert.ok(template.includes(`{{${binding}}}`));
  }
  assert.match(template, /src="\/assets\/brand-logo.jpg"/);
  assert.match(template, /class="nav-brand-purpose">生物选购<\/text>/);
  assert.match(template, /class="nav-brand-name">海洋森林<\/text>/);
  assert.match(template, /aria-label="查看\{\{minor.label\}\}/);
  assert.match(template, /class="minor-link"\s+size="mini"/);
  assert.match(template, /bindtap="onMinorCategoryTap"/);
});

test("catalog uses unframed two-column rows with stable touch targets", () => {
  assert.match(styles, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.minor-grid\.single \.minor-link\s*\{\s*grid-column: 1 \/ -1;/);
  const buttonRule = styles.match(/\.minor-link\[size="mini"\]\s*\{([^}]+)\}/)[1];
  assert.match(buttonRule, /width: 100%/);
  assert.match(buttonRule, /min-height: 56px/);
  assert.match(buttonRule, /margin: 0/);
  assert.match(buttonRule, /border-bottom: 1px solid var\(--catalog-rule\)/);
  assert.doesNotMatch(styles, /border-right:|box-shadow:/);
  assert.doesNotMatch(styles, /font-size:\s*[^;]*(?:rpx|vw)/);
  for (const tone of ["coral", "invertebrate", "consumable"]) {
    assert.ok(styles.includes(`.major-section.${tone}`));
  }
});

test("catalog and products show the Chinese brand and the livestock shopping purpose", async () => {
  const products = await readFile(new URL("../products/index.wxml", base), "utf8");
  const globalStyles = await readFile(new URL("../../app.wxss", base), "utf8");
  for (const page of [template, products]) {
    assert.match(page, /class="nav-brand-logo"[^>]*mode="aspectFit"[^>]*aria-label="海洋森林 Marine Forest"/);
    assert.match(page, /class="nav-brand-name">海洋森林<\/text>/);
    assert.match(page, /class="nav-brand-purpose">生物选购<\/text>/);
    assert.ok(page.indexOf('class="nav-brand-name"') < page.indexOf('class="nav-brand-purpose"'));
    assert.doesNotMatch(page, /brand-slogan\.png/);
  }
  assert.match(globalStyles, /\.nav-brand-logo\s*\{[^}]*width: 60px;[^}]*height: 60px;/);
  assert.match(globalStyles, /\.nav-brand-copy\s*\{[^}]*min-width: 0;[^}]*flex-direction: column;/);
  assert.match(globalStyles, /\.nav-brand-name\s*\{[^}]*white-space: nowrap;/);
  let total = 0;
  for (const name of ["brand-logo.jpg", "brand-slogan-zh.jpg", "brand-slogan-en.jpg"]) {
    const asset = await readFile(new URL(`../../assets/${name}`, base));
    assert.equal(asset.readUInt16BE(0), 0xffd8, `${name} must be a JPEG`);
    assert.ok(asset.length < 200 * 1024, `${name} exceeds the image budget`);
    total += asset.length;
  }
  assert.ok(total < 100 * 1024, "brand artwork should remain lightweight as a set");
});

test("category tap preserves the existing product route and encodes category keys", () => {
  let definition;
  const routes = [];
  vm.runInNewContext(source, {
    Page(value) { definition = value; },
    require(path) {
      return path === "../../utils/navigation" ? { getNavigationMetrics: () => ({}) } : {};
    },
    wx: { navigateTo: (value) => routes.push(value.url) }
  });
  definition.onMinorCategoryTap({ currentTarget: { dataset: { category: "coral & reef", majorKey: "coral" } } });
  assert.deepEqual(routes, ["/pages/products/index?category=coral%20%26%20reef&majorKey=coral"]);
  definition.onMinorCategoryTap({ currentTarget: { dataset: {} } });
  assert.equal(routes.length, 1);
});
