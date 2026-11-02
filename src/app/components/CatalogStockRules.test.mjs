import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let CatalogStockTile;
let CatalogStockBoard;
let CatalogStockRules;
let groupCatalogStockItems;
let toggleCatalogStockSelection;
let catalogTankFilterOptions;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ CatalogStockTile, CatalogStockBoard, CatalogStockRules, groupCatalogStockItems, toggleCatalogStockSelection, catalogTankFilterOptions } = await server.ssrLoadModule("/src/app/components/CatalogStockRules.tsx"));
});
after(async () => { await server?.close(); });

const item = { id: "stock-1", code: "189", productId: "product-1", productName: "汤臣神仙鱼", speciesName: "汤臣神仙鱼", productSize: "8-10", productOrigin: "印尼", siteId: "nanjing", siteName: "南京", tankGroupId: "group-a", tankGroupName: "A", subTankId: "tank-a1", subTankName: "A-1", tankName: "A / A-1", status: "healthy", sold: false, inTransit: false, hidden: false };
const tile = (props = {}) => renderToStaticMarkup(createElement(CatalogStockTile, { item, hidden: false, selected: false, disabled: false, onSelect() {}, ...props }));
const board = (props = {}) => renderToStaticMarkup(createElement(CatalogStockBoard, { items: [item], hiddenIds: new Set(), selectedIds: new Set(), productRules: new Map(), disabled: false, onSelect() {}, ...props }));

test("fish thumbnail is an accessible selection button, with exact ID and visible checked state", () => {
  const visible = tile();
  assert.match(visible, /编号 189/);
  assert.match(visible, /data-catalog-stock-id="stock-1"/);
  assert.match(visible, /aria-pressed="false"/);
  assert.match(visible, /aria-label="选择汤臣神仙鱼，编号 189，库存 ID stock-1/);
  assert.match(visible, /未单独隐藏/);
  assert.match(visible, /w-24/);
  assert.match(visible, /h-20/);
  const selected = tile({ selected: true, hidden: true });
  assert.match(selected, /aria-pressed="true"/);
  assert.match(selected, /取消选择汤臣神仙鱼/);
  assert.match(selected, /单只隐藏/);
  assert.match(selected, /ring-2 ring-primary/);
  assert.doesNotMatch(visible, /role="switch"/);
});

test("tiles use lightweight lazy images or an explicit no-image fallback, never video playback", () => {
  assert.match(tile({ item: { ...item, imageUrl: "/uploads/fish-poster.jpg" } }), /src="\/uploads\/fish-poster.jpg"/);
  assert.match(tile({ item: { ...item, imageUrl: "/uploads/fish-poster.jpg" } }), /loading="lazy" decoding="async"/);
  assert.match(tile(), /暂无图片/);
  assert.doesNotMatch(tile(), /<video/);
});

test("duplicate display codes remain distinguishable by full ID in title and accessible label", () => {
  const first = tile({ item: { ...item, id: "stock-duplicate-a" } });
  const second = tile({ item: { ...item, id: "stock-duplicate-b" } });
  assert.match(first, /库存 ID stock-duplicate-a/);
  assert.match(second, /库存 ID stock-duplicate-b/);
  assert.match(tile({ item: { ...item, id: "stock-long-12345678", code: "" } }), />ID 12345678</);
  assert.match(tile({ item: { ...item, id: "stock-long-12345678", code: "" } }), /未填写编号，库存 ID stock-long-12345678/);
});

test("in transit, sold, sick, lost, and outbound fish retain unambiguous status without operations", () => {
  for (const [changes, reason] of [[{ inTransit: true }, "移缸在途"], [{ sold: true }, "已售"], [{ status: "sick" }, "疾病"], [{ lost: true }, "已损耗"], [{ outStock: true }, "已出库"]]) {
    assert.match(tile({ item: { ...item, ...changes } }), new RegExp(`暂不可售：${reason}`));
  }
  assert.match(tile({ disabled: true }), /disabled=""/);
  assert.doesNotMatch(board(), /批量维护|签发移缸|批量报损|保存信息|售价/);
});

test("board follows site, tank group, sub tank, then exact product IDs, never species or code", () => {
  const groups = groupCatalogStockItems([
    item,
    { ...item, id: "stock-2" },
    { ...item, id: "stock-other-size", productId: "product-2", productSize: "15+" },
    { ...item, id: "stock-other-tank", subTankId: "tank-a2", subTankName: "A-2" },
    { ...item, id: "stock-other-group", tankGroupId: "group-b", tankGroupName: "B" },
    { ...item, id: "stock-other-site", siteId: "jiangyin", siteName: "江阴" },
    item,
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].tanks.length, 2);
  assert.equal(groups[0].tanks[0].products.length, 2);
  assert.deepEqual(groups[0].tanks[0].products[0].items.map(fish => fish.id), ["stock-1", "stock-2"]);
  assert.equal(groups[0].tanks[0].products[1].items[0].id, "stock-other-size");
  assert.equal(groups[0].tanks[1].products[0].items[0].id, "stock-other-tank");
  assert.match(board(), /南京 · A/);
  assert.match(board(), /aria-label="A-1"/);
  assert.match(board(), /8-10 · 印尼 · 汤臣神仙鱼/);
  assert.match(board(), /仅选择「A-1」内「汤臣神仙鱼」本页的 1 条/);
  assert.match(board(), /选本组/);
});

test("selection toggles only supplied exact IDs and preserves other-page selections", () => {
  const original = new Set(["other-page", "stock-1"]);
  const selected = toggleCatalogStockSelection(original, ["stock-1", "stock-2"]);
  assert.deepEqual([...selected], ["other-page", "stock-1", "stock-2"]);
  assert.deepEqual([...original], ["other-page", "stock-1"]);
  assert.deepEqual([...toggleCatalogStockSelection(selected, ["stock-1", "stock-2"])], ["other-page"]);
  assert.deepEqual([...toggleCatalogStockSelection(original, [])], [...original]);
  assert.match(board({ selectedIds: new Set(["stock-1"]) }), /取消本组/);
});

test("special tank filters aggregate across sites only when the site filter is all", () => {
  const tanks = [
    { ...item, subTankId: "__in_transit__", subTankName: "移缸在途", count: 2 },
    { ...item, siteId: "jiangyin", siteName: "江阴", subTankId: "__in_transit__", subTankName: "移缸在途", count: 3 },
    { ...item, count: 5 },
  ];
  assert.deepEqual(catalogTankFilterOptions(tanks, "all"), [
    { value: "__in_transit__", label: "全部场地 / 移缸在途", count: 5 },
    { value: "tank-a1", label: "南京 / A / A-1", count: 5 },
  ]);
  assert.equal(catalogTankFilterOptions(tanks, "nanjing")[0].count, 2);
});

test("board explains inherited rules and caps separately from single-fish visibility", () => {
  for (const [reason, label] of [["major", "随类型隐藏"], ["species", "随物种隐藏"], ["product", "随商品隐藏"]]) {
    assert.match(board({ productRules: new Map([["product-1", { hiddenReason: reason, displayCap: 10 }]]) }), new RegExp(label));
  }
  assert.match(board({ productRules: new Map([["product-1", { hiddenReason: null, displayCap: 10 }]]) }), /商品上限 10 条/);
});

test("panel labels filters, direct-confirm save, selection reset and independent inventory state", () => {
  const markup = renderToStaticMarkup(createElement(CatalogStockRules, { policy: { hiddenStockIds: [] }, productRules: new Map(), disabled: false, initialSiteId: "nanjing", onApplySelection: async () => true }));
  assert.match(markup, /确认后直接保存/);
  assert.match(markup, /不会改变库存、售价或健康状态/);
  assert.match(markup, /仍遵循类型、物种、商品规则及数量上限/);
  assert.match(markup, /筛选鱼只场地/);
  assert.match(markup, /筛选鱼只缸位/);
  assert.match(markup, /仅单只隐藏/);
  assert.match(markup, /翻页保留选择/);
  assert.match(markup, /刷新列表会清空选择/);
  assert.match(markup, /本页全选/);
  assert.match(markup, /隐藏选中/);
  assert.match(markup, /恢复选中/);
  assert.match(markup, /正在加载单鱼列表/);
  assert.doesNotMatch(markup, /顶部「保存规则」/);
});

test("picker uses bounded authenticated requests, cancellation and no global stock hydration", async () => {
  const source = await readFile(new URL("./CatalogStockRules.tsx", import.meta.url), "utf8");
  assert.match(source, /const PAGE_SIZE = 50/);
  assert.match(source, /fetch\("\/api\/public-catalog\/stock-options"/);
  assert.match(source, /method: "POST", headers: authJsonHeaders\(\), body: requestKey, signal: controller.signal, cache: "no-store"/);
  assert.match(source, /siteId, subTankId, filter, page/);
  assert.match(source, /hiddenStockIds: \[\.\.\.hiddenIds\]\.sort\(\)/);
  assert.match(source, /return \(\) => controller.abort\(\)/);
  assert.match(source, /result.key === requestKey && search === debouncedSearch/);
  assert.match(source, /ImageWithFallback/);
  assert.doesNotMatch(source, /state\.stock|loadStock|saveState|\/api\/state|<video/);
});

test("async action guards repeated submits and only clears after confirmed success", async () => {
  const source = await readFile(new URL("./CatalogStockRules.tsx", import.meta.url), "utf8");
  assert.match(source, /submittingRef.current \|\| selectedIds.size === 0/);
  assert.match(source, /if \(await onApplySelection\(ids, hidden\)\) \{\s*setSelectedIds\(new Set\(\)\)/);
  assert.match(source, /保存失败，已保留选择/);
  assert.match(source, /const changeFilter = \(\) => \{ clearSelection\(\); setPage\(1\); \}/);
  assert.match(source, /const refresh = \(\) => \{ clearSelection\(\); setAttempt/);
  assert.match(source, /previousInitialSiteId.current === initialSiteId/);
  assert.match(source, /setSiteId\(initialSiteId \|\| "all"\); setSubTankId\("all"\)/);
  assert.match(source, /!tankOptions.some\(option => option.value === subTankId\)/);
  assert.match(source, /当前条件无匹配/);
});

test("catalog connects immediate selection saves without losing policy conflict checks", async () => {
  const source = await readFile(new URL("./CatalogManagementView.tsx", import.meta.url), "utf8");
  const pickerSource = await readFile(new URL("./CatalogStockRules.tsx", import.meta.url), "utf8");
  const catalogRoot = source.match(/return \(\s*<div className="([^"]+)">\s*<div className="mx-auto/);
  assert.ok(catalogRoot, "catalog page root remains identifiable for its scrolling contract");
  assert.doesNotMatch(catalogRoot[1], /\boverflow(?:-[xy])?-(?:auto|scroll|hidden|clip)\b/, "app content must remain the scroll parent so mobile sticky actions are not trapped by a nested scroll container");
  assert.doesNotMatch(catalogRoot[1], /\bh-full\b/, "catalog height must grow with its cards inside the app scroll region");
  assert.match(pickerSource, /className="sticky top-0 [^"]*" aria-label="选鱼展示操作"/, "selection actions remain sticky while scrolling the app content");
  assert.match(source, /type CatalogRuleTab = "major" \| "species" \| "product" \| "stock"/);
  assert.match(source, /uniqueCount\(policy.hiddenStockIds\)/);
  assert.match(source, /initialSiteId=\{state.activeSiteId\}/);
  assert.match(source, /onApplySelection=\{\(ids, hidden\) => save\(\{ ids, hidden \}\)\}/);
  assert.match(source, /publicCatalogPolicy: nextPolicy/);
  assert.match(source, /publicCatalogPolicyFingerprint\(latest.publicCatalogPolicy\) !== baselinePolicyFingerprint/);
  assert.doesNotMatch(source, /单只隐藏需要先保存规则/);
});
