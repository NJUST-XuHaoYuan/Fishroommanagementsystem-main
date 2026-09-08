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
  assert.match(template, /src="\/assets\/brand-slogan.png"/);
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
