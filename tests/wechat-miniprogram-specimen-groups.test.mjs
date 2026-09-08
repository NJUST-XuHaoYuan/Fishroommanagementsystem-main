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
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    speciesCategories: ["Fish"], speciesCategoryMajorMap: { Fish: "marineFish" },
    species: [{ id: "species", name: "Species", imageUrl: "/species.jpg", category: "Fish" }],
    products: [{ id: "product", speciesId: "species", name: "Product", imageUrl: "/default.jpg", defaultPrice: 200 }],
    stock: ["one", "two", "three"].map((id, index) => ({
      id, productId: "product", code: String(189 + index), status: "feeding",
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

test("group detail switches the real selection code and does not permit copying a stale code while loading", async () => {
  const model = catalog.buildViewModel(fixture());
  const app = { globalData: { catalogViewModel: model, loadedAt: Date.now() } };
  const copied = [];
  const api = { fetchCatalog: async () => fixture(), fetchBioRecords: async (id) => fixture().bioRecords.filter((item) => item.stockItemId === id) };
  const refresh = load(refreshSource, {}, { getApp: () => app, setInterval, clearInterval });
  let page;
  load(detailSource, { "../../utils/api": api, "../../utils/catalog": catalog, "../../utils/public-catalog-refresh": refresh }, {
    getApp: () => app, Page: (value) => { page = value; },
    wx: { stopPullDownRefresh() {}, setClipboardData: ({ data }) => copied.push(data) },
  });
  page.data = { ...page.data, groupMode: true };
  page.setData = (value) => Object.assign(page.data, value);
  await page.loadDetail("one");
  assert.equal(page.data.members.length, 3);
  assert.equal(page.data.memberListHeight, 44);
  assert.equal(page.data.timeline.filter((item) => item.text === "Shared care record").length, 1);
  const request = page.onMemberTap({ currentTarget: { dataset: { id: "two" } } });
  assert.equal(page.data.memberLoading, true);
  page.onCopyCode();
  assert.equal(copied.length, 0);
  await request;
  assert.equal(page.data.specimen.id, "two");
  assert.equal(page.data.stockItemId, "two");
  page.onCopyCode();
  assert.equal(copied[0], model.specimens[1].selectionCode);
  assert.match(page.onShareAppMessage().path, /stockItemId=two&group=1$/);
  page.onMemberTap({ currentTarget: { dataset: { id: "not-public" } } });
  assert.equal(page.data.stockItemId, "two");
});

test("return navigation overrides native sizing and all three levels render wrapping multi-tags", async () => {
  const products = await read("pages/products/index.wxml");
  const styles = await read("pages/products/index.wxss");
  const appStyles = await read("app.wxss");
  assert.match(products, /<button[^>]*class="back-button"[^>]*size="mini"/);
  assert.match(styles, /\.back-button\[size="mini"\][\s\S]*?margin:\s*0 auto 0 0/);
  assert.match(styles, /\.back-button\[size="mini"\][\s\S]*?justify-content:\s*flex-start/);
  assert.match(appStyles, /\.specimen-tags\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(await read("pages/detail/index.wxml"), /height: \{\{memberListHeight\}\}px/);
  for (const page of ["products", "specimens", "detail"]) {
    assert.match(await read(`pages/${page}/index.wxml`), /wx:for="\{\{(?:item|specimen)\.tags\}\}"/);
  }
});

test("a missing compact media summary must not claim that text-only history is absent", () => {
  const data = fixture();
  data.bioRecords = [];
  assert.equal(catalog.buildViewModel(data).specimens[0].latestBioText, "查看维护档案");
});
