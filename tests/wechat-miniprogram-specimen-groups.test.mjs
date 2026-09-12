import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../wechat-miniprogram/${path}`, import.meta.url), "utf8");
const source = await read("utils/catalog.js");
const detailSource = await read("pages/detail/index.js");
const refreshSource = await read("utils/public-catalog-refresh.js");
function load(sourceText, dependencies = {}, globals = {}) {
  const context = { module: { exports: {} }, require: (id) => {
    assert.ok(id in dependencies, `unexpected dependency ${id}`);
    return dependencies[id];
  }, ...globals };
  vm.runInNewContext(sourceText, context);
  return context.module.exports;
}
const catalog = load(source, { "./api": { getApiBaseUrl: () => "https://fish.example" } }, { Date });
const contact = load(await read("utils/contact-card.js"));
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    speciesCategories: ["Fish"], speciesCategoryMajorMap: { Fish: "marineFish" },
    species: [{ id: "species", name: "Species", imageUrl: "/species.jpg", category: "Fish" }],
    products: [{ id: "product", speciesId: "species", name: "Product", imageUrl: "/default.jpg", defaultPrice: 200 }],
    stock: ["one", "two", "three"].map((id) => ({
      id, productId: "product", code: "", notes: "", status: "feeding",
      inDate: "2026-08-01", basePrice: 150, specimenGroupKey: "full-history-a",
      tankGroupName: "A", subTankName: "1",
    })),
    bioRecords: ["one", "two", "three"].map((stockItemId) => ({
      id: `bio-${stockItemId}`, stockItemId, date: "2026-08-15", text: "Shared care record",
      photos: ["/real-photo.jpg"], videos: ["/video.mp4"], videoPreviews: ["/preview.mp4"],
    })),
  };
}

test("default product pictures stay separate from specimen maintenance media", () => {
  const data = fixture();
  let model = catalog.buildViewModel(data);
  assert.equal(model.productCards[0].image, "https://fish.example/default.jpg");
  assert.equal(model.productCards[0].previewVideo, "");
  assert.equal(model.specimens[0].image, "https://fish.example/real-photo.jpg");
  data.products[0].imageUrl = "";
  model = catalog.buildViewModel(data);
  assert.equal(model.productCards[0].image, "https://fish.example/species.jpg");
  data.species[0].imageUrl = "";
  assert.equal(catalog.buildViewModel(data).productCards[0].image, "");
});

test("grouping preserves every unique stock ID and selection code without changing catalog counts", () => {
  const model = catalog.buildViewModel(fixture());
  const before = JSON.stringify(model);
  const groups = catalog.groupSpecimens(model.specimens);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quantity, 3);
  assert.equal(groups[0].grouped, true);
  assert.deepEqual(plain(groups[0].members.map((item) => item.id)), ["one", "two", "three"]);
  assert.equal(new Set(groups[0].members.map((item) => item.selectionCode)).size, 3);
  assert.equal(model.productCards[0].specimenCount, 3);
  assert.equal(JSON.stringify(model), before);
});

test("legacy keys and differences in full history or visible fields never collapse", () => {
  const model = catalog.buildViewModel(fixture());
  assert.equal(catalog.groupSpecimens(model.specimens.map((item) => ({ ...item, specimenGroupKey: "" }))).length, 3);
  for (const change of [
    { specimenGroupKey: "different-full-history" }, { price: 160 }, { status: "healthy" },
    { inDate: "2026-08-02" }, { location: "B / 2" }, { previewVideo: "/different.mp4" },
  ]) {
    const specimens = model.specimens.map((item, index) => index === 0 ? { ...item, ...change } : item);
    assert.equal(catalog.groupSpecimens(specimens).length, 2, JSON.stringify(change));
  }
});

test("arrival, feeding and special-price tags appear together and partial product tags carry counts", () => {
  const data = fixture();
  let model = catalog.buildViewModel(data);
  assert.deepEqual(plain(model.specimens[0].tags.map((tag) => tag.key)), ["arrival", "feeding", "special"]);
  assert.deepEqual(plain(model.productCards[0].tags.map((tag) => tag.label)), ["到货14天+", "已开口", "特价"]);
  data.stock[2].status = "healthy";
  data.stock[2].basePrice = 200;
  model = catalog.buildViewModel(data);
  assert.deepEqual(plain(model.specimens[2].tags.map((tag) => tag.key)), ["arrival", "healthy"]);
  const labels = model.productCards[0].tags.map((tag) => tag.label);
  assert.ok(labels.includes("已开口 2条"));
  assert.ok(labels.includes("状态稳定 1条"));
  assert.ok(labels.includes("特价 2条"));
  assert.equal(catalog.filterSpecimens(model, { productId: "product" }, "healthy").length, 1);
  assert.equal(catalog.groupSpecimens(catalog.filterSpecimens(model, { productId: "product" }, "feeding"))[0].quantity, 2);
});

test("group inquiries keep group identity and direct links locate the exact fish without a selection code step", async () => {
  const model = catalog.buildViewModel(fixture());
  const app = { globalData: { catalogViewModel: model, loadedAt: Date.now() } };
  const api = { fetchCatalog: async () => fixture(), fetchBioRecords: async (id) => fixture().bioRecords.filter((item) => item.stockItemId === id) };
  const refresh = load(refreshSource, {}, { getApp: () => app, setInterval, clearInterval });
  let page;
  load(detailSource, { "../../utils/api": api, "../../utils/catalog": catalog, "../../utils/public-catalog-refresh": refresh,
    "../../utils/navigation": { returnToParent() {} }, "../../utils/contact-card": contact }, {
    getApp: () => app, Page: (value) => { page = value; },
    wx: { stopPullDownRefresh() {} },
  });
  page.data = { ...page.data, groupMode: true };
  page.setData = (value) => Object.assign(page.data, value);
  await page.loadDetail("one");
  assert.equal(page.data.members.length, 3);
  assert.match(page.data.contactCard.title, /同款可选 3/);
  assert.match(page.data.contactCard.path, /stockItemId=one&group=1$/);
  assert.equal(page.onCopyCode, undefined);
  assert.equal(page.onMemberTap, undefined);
  assert.equal(page.data.timeline.filter((item) => item.text === "Shared care record").length, 1);
  page.data.groupMode = false;
  const request = page.loadDetail("two", { refreshing: true });
  assert.equal(page.data.refreshing, true);
  await request;
  assert.equal(page.data.specimen.id, "two");
  assert.equal(page.data.stockItemId, "two");
  assert.equal(page.data.refreshing, false);
  assert.ok(!page.data.contactCard.title.includes(model.specimens[1].selectionCode));
  assert.match(page.data.contactCard.path, /stockItemId=two$/);
  assert.match(page.onShareAppMessage().path, /stockItemId=two$/);
  await page.loadDetail("not-public", { refreshing: true });
  assert.equal(page.data.contactCard, null);
  assert.equal(page.data.specimen, null);
});

test("stock cards use product names and quantities, never internal IDs as headings", async () => {
  const data = fixture();
  data.stock.forEach((item) => { item.code = ""; });
  const group = catalog.groupSpecimens(catalog.buildViewModel(data).specimens)[0];
  assert.equal(group.cardTitle, "Product");
  assert.equal(group.unit, "条");
  assert.deepEqual(plain(group.members.map((item) => item.label)), ["第 1 条", "第 2 条", "第 3 条"]);
  const template = await read("pages/specimens/index.wxml");
  assert.match(template, /同款可选.*\{\{item.quantity\}\} \{\{item.unit\}\}/);
  assert.doesNotMatch(template, /item\.displayCode|item\.cardTitle|共同维护| 组/);
  const detail = await read("pages/detail/index.wxml");
  assert.doesNotMatch(detail, /codesExpanded|selectionCode|选鱼码|onCopyCode/);
  assert.doesNotMatch(detail, /item\.displayCode|共 .* 个|共同维护档案/);
  assert.match(await read("pages/specimens/index.wxss"), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("numbered or individually noted fish remain separate even when the full history matches", () => {
  for (const change of [{ code: "304" }, { notes: "单侧腹鳍短\n已开口" }]) {
    const data = fixture();
    Object.assign(data.stock[0], change);
    const model = catalog.buildViewModel(data);
    const cards = catalog.groupSpecimens(model.specimens);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].quantity, 1);
    assert.equal(cards[1].quantity, 2);
    assert.equal(cards.reduce((sum, card) => sum + card.quantity, 0), 3);
    assert.equal(cards[0].notes, change.notes || "");
  }
  const data = fixture();
  data.stock.forEach((item) => { item.notes = "same individual note"; });
  assert.equal(catalog.groupSpecimens(catalog.buildViewModel(data).specimens).length, 3);
  data.stock.forEach((item) => { delete item.notes; });
  assert.equal(catalog.groupSpecimens(catalog.buildViewModel(data).specimens).length, 3, "legacy APIs without notes cannot prove there is no individual note");
});

test("stock cards show blue identifiers and red notes but no tank position or filter buttons", async () => {
  const template = await read("pages/specimens/index.wxml");
  const page = await read("pages/specimens/index.js");
  const styles = await read("app.wxss");
  assert.match(template, /class="specimen-number">编号/);
  assert.match(template, /wx:if="\{\{item.notes\}\}" class="specimen-note">备注：\{\{item.notes\}\}/);
  assert.ok(template.indexOf('class="specimen-number"') < template.indexOf('class="specimen-note"'));
  assert.doesNotMatch(template, /item\.location|filter-row|onFilterTap|鱼码/);
  assert.doesNotMatch(page, /filterOptions|activeFilter|onFilterTap/);
  assert.match(page, /\}, "all"\)/);
  assert.match(template, /class="price-unit"> \/ \{\{item.unit\}\}/);
  assert.match(styles, /\.specimen-number\s*\{[^}]*color: #183d72/);
  assert.match(styles, /\.specimen-note\s*\{[^}]*color: #b43232/);
  const detail = await read("pages/detail/index.wxml");
  assert.match(detail, /detail-number specimen-number/);
  assert.match(detail, /备注：\{\{specimen.notes\}\}/);
});

test("return navigation overrides native sizing and all three levels render wrapping multi-tags", async () => {
  const products = await read("pages/products/index.wxml");
  const styles = await read("pages/products/index.wxss");
  const appStyles = await read("app.wxss");
  assert.match(products, /<button[^>]*class="back-button"[^>]*size="mini"/);
  assert.match(styles, /\.back-button\.back-button[\s\S]*?margin:\s*0 auto 0 0/);
  assert.match(styles, /\.back-button\.back-button[\s\S]*?justify-content:\s*flex-start/);
  assert.match(appStyles, /\.specimen-tags\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(await read("pages/detail/index.wxml"), /class="detail-contact-button\b/);
  assert.doesNotMatch(await read("pages/detail/index.wxml"), /memberListHeight|onMemberTap/);
  for (const page of ["products", "specimens", "detail"]) {
    assert.match(await read(`pages/${page}/index.wxml`), /wx:for="\{\{(?:item|specimen)\.tags\}\}"/);
  }
});

test("a missing compact media summary must not claim that text-only history is absent", () => {
  const data = fixture();
  data.bioRecords = [];
  assert.equal(catalog.buildViewModel(data).specimens[0].latestBioText, "查看维护档案");
});
