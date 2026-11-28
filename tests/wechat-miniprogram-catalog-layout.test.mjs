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

test("catalog and products retain the brand, shopping purpose and original slogan", async () => {
  const products = await readFile(new URL("../products/index.wxml", base), "utf8");
  const globalStyles = await readFile(new URL("../../app.wxss", base), "utf8");
  for (const page of [template, products]) {
    assert.match(page, /class="nav-brand-logo"[^>]*mode="aspectFit"[^>]*aria-label="海洋森林 Marine Forest"/);
    assert.match(page, /class="nav-brand-name">海洋森林<\/text>/);
    assert.match(page, /class="nav-brand-purpose">生物选购<\/text>/);
    assert.match(page, /class="nav-brand-slogan-en">Grow an Ocean<\/text>/);
    assert.match(page, /class="nav-brand-slogan-image"[^>]*src="\/assets\/brand-slogan-zh.jpg"[^>]*mode="widthFix"[^>]*aria-label="种一片海"/);
    assert.ok(page.indexOf('class="nav-brand-name"') < page.indexOf('class="nav-brand-purpose"'));
    assert.doesNotMatch(page, /brand-slogan\.png/);
  }
  assert.match(globalStyles, /\.nav-brand-logo\s*\{[^}]*width: 52px;[^}]*height: 52px;/);
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

test("category tap preserves the existing product route and encodes category keys", async () => {
  let definition;
  const routes = [];
  const siteFilter = { module: { exports: {} } };
  const config = { module: { exports: {} } };
  vm.runInNewContext(await readFile(new URL("../../utils/site-filter.js", base), "utf8"), siteFilter);
  vm.runInNewContext(await readFile(new URL("../../utils/config.js", base), "utf8"), config);
  vm.runInNewContext(source, {
    Page(value) { definition = value; },
    require(path) {
      if (path === "../../utils/site-filter") return siteFilter.module.exports;
      if (path === "../../utils/config") return config.module.exports;
      return path === "../../utils/navigation" ? { getNavigationMetrics: () => ({}) } : {};
    },
    wx: { navigateTo: (value) => routes.push(value.url) }
  });
  definition.onMinorCategoryTap({ currentTarget: { dataset: { category: "coral & reef", majorKey: "coral" } } });
  assert.deepEqual(routes, ["/pages/products/index?category=coral%20%26%20reef&majorKey=coral&siteId=all"]);
  definition.onMinorCategoryTap({ currentTarget: { dataset: {} } });
  assert.equal(routes.length, 1);
});

const templateTags = [...template.matchAll(/<[a-z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map((match) => ({
  index: match.index,
  attributes: Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((attribute) => [attribute[1], attribute[2] ?? attribute[3]]))
}));
const expression = (value) => value?.match(/^\{\{([\s\S]+)\}\}$/)?.[1].trim();

test("home search binds typed and confirmed queries, with an accessible clear action", () => {
  const inputs = templateTags.filter(({ attributes }) => attributes.bindinput === "onSearchInput");
  assert.equal(inputs.length, 1);
  const input = inputs[0].attributes;
  assert.equal(expression(input.value), "keyword");
  assert.equal(input.bindconfirm, "onSearchInput");
  assert.equal(input["confirm-type"], "search");
  assert.ok(input["aria-label"]?.trim());
  const clear = templateTags.find(({ attributes }) => attributes.bindtap === "onClearSearch"
    && expression(attributes["wx:if"]) === "keyword");
  assert.ok(clear, "a nonempty query must expose the clear action");
  assert.ok(clear.attributes["aria-label"]?.trim());
});

test("home search results follow loading and errors, precede categories, and expose empty-result recovery", () => {
  const loading = templateTags.find(({ attributes }) => expression(attributes["wx:if"]) === "loading");
  const error = templateTags.find(({ attributes }) => expression(attributes["wx:elif"]) === "error");
  const search = templateTags.find(({ attributes }) => expression(attributes["wx:elif"]) === "searching");
  const categories = templateTags.find(({ attributes }) => expression(attributes["wx:elif"]) === "majorGroups.length");
  assert.ok(loading && error && search && categories, "search must share the existing loading/error/category state chain");
  assert.ok(loading.index < error.index && error.index < search.index && search.index < categories.index);
  const searchTags = templateTags.filter(({ index }) => index > search.index && index < categories.index);
  assert.ok(searchTags.some(({ attributes }) => expression(attributes["wx:if"]) === "searchResults.length"));
  assert.ok(searchTags.some(({ attributes }) => attributes.bindtap === "onClearSearch"),
    "zero results must offer a route back to categories");
  const searchTemplate = template.slice(search.index, categories.index);
  assert.match(searchTemplate, /\{\{\s*searchProductCount\s*\}\}/);
});

test("home search result identity, stock units and image-error bindings reach the real handlers", () => {
  const result = templateTags.find(({ attributes }) => expression(attributes["wx:for"]) === "searchResults");
  assert.ok(result, "results must render the current searchResults array");
  assert.equal(result.attributes["wx:key"], "id");
  assert.equal(expression(result.attributes["data-id"]), "item.id");
  assert.equal(result.attributes.bindtap, "onSearchProductTap");
  assert.equal(result.attributes.role, "button");
  assert.equal(expression(result.attributes["aria-disabled"]), "refreshing");
  assert.match(result.attributes["aria-label"], /\{\{\s*item\.name\s*\}\}/);
  const image = templateTags.find(({ attributes }) => attributes.binderror === "onSearchImageError");
  assert.ok(image, "a failed search image must reach the existing fallback handler");
  assert.equal(expression(image.attributes["data-id"]), "item.id");
  assert.equal(expression(image.attributes.src), "item.image");
  assert.equal(image.attributes["data-src"], image.attributes.src);
  const searchEnd = templateTags.find(({ attributes }) => expression(attributes["wx:elif"]) === "majorGroups.length");
  const resultTemplate = template.slice(result.index, searchEnd.index);
  for (const binding of ["item.name", "item.priceText", "item.specimenCount", "item.unit"]) {
    assert.ok([...resultTemplate.matchAll(/\{\{([\s\S]+?)\}\}/g)].some((match) => match[1].trim() === binding),
      "search results must display " + binding);
  }
});
