import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let CatalogStockRuleRow;
let CatalogStockRules;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ CatalogStockRuleRow, CatalogStockRules } = await server.ssrLoadModule("/src/app/components/CatalogStockRules.tsx"));
});
after(async () => { await server?.close(); });

const item = { id: "stock-1", code: "189", productId: "product-1", productName: "汤臣神仙鱼", speciesName: "汤臣神仙鱼", siteId: "nanjing", siteName: "南京", tankName: "A / A-1", status: "healthy", sold: false, inTransit: false, hidden: false };
const row = (props = {}) => renderToStaticMarkup(createElement(CatalogStockRuleRow, { item, hidden: false, disabled: false, onHiddenChange() {}, ...props }));

test("single fish rows identify the exact fish and distinguish allowed from single hidden accessibly", () => {
  const visible = row();
  assert.match(visible, /编号 189/);
  assert.match(visible, /南京 · A \/ A-1/);
  assert.match(visible, /role="switch" aria-checked="true"/);
  assert.match(visible, /允许展示，点击单只隐藏/);
  assert.match(visible, /min-h-\[44px\]/);
  const hidden = row({ hidden: true });
  assert.match(hidden, /aria-checked="false"/);
  assert.match(hidden, /单只隐藏，点击允许展示/);
});

test("allowing a single fish does not imply it overrides higher-level hiding or caps", () => {
  for (const [reason, text] of [["major", "随类型隐藏"], ["species", "随物种隐藏"], ["product", "随商品隐藏"]]) {
    assert.match(row({ rule: { hiddenReason: reason, displayCap: 10 } }), new RegExp(text));
  }
  assert.match(row({ rule: { hiddenReason: null, displayCap: 10 } }), /受商品上限 10 条限制/);
});

test("duplicate display codes remain distinguishable by the visible and accessible unique stock ID", () => {
  const first = row({ item: { ...item, id: "stock-duplicate-a" } });
  const second = row({ item: { ...item, id: "stock-duplicate-b" } });
  assert.match(first, />库存 ID stock-duplicate-a<\/p>/);
  assert.match(second, />库存 ID stock-duplicate-b<\/p>/);
  assert.match(first, /aria-label="汤臣神仙鱼 编号 189，库存 ID stock-duplicate-a：/);
  assert.match(second, /aria-label="汤臣神仙鱼 编号 189，库存 ID stock-duplicate-b：/);
  assert.match(first, /break-all text-xs/);
});

test("in transit, sold, sick, lost, and outbound fish show why they are not saleable", () => {
  for (const [changes, reason] of [[{ inTransit: true }, "移缸在途"], [{ sold: true }, "已售"], [{ status: "sick" }, "疾病"], [{ lost: true }, "已损耗"], [{ outStock: true }, "已出库"]]) {
    assert.match(row({ item: { ...item, ...changes } }), new RegExp(`暂不可售 · ${reason}`));
  }
  assert.match(row({ item: { ...item, code: "" } }), /库存 ID stock-1/);
  assert.match(row({ disabled: true }), /disabled=""/);
});

test("single-fish panel labels filters, save requirement, and independent inventory state", () => {
  const markup = renderToStaticMarkup(createElement(CatalogStockRules, { policy: { hiddenStockIds: [] }, productRules: new Map(), disabled: false, onHiddenChange() {} }));
  assert.match(markup, /保存规则/);
  assert.match(markup, /不会改变库存、售价或健康状态/);
  assert.match(markup, /仍遵循类型、物种、商品规则及数量上限/);
  assert.match(markup, /筛选鱼只场地/);
  assert.match(markup, /仅单只隐藏/);
  assert.match(markup, /正在加载单鱼列表/);
});

test("picker uses bounded authenticated requests, draft hidden filtering, cancellation, and never global stock hydration", async () => {
  const source = await readFile(new URL("./CatalogStockRules.tsx", import.meta.url), "utf8");
  assert.match(source, /const PAGE_SIZE = 30/);
  assert.match(source, /fetch\("\/api\/public-catalog\/stock-options"/);
  assert.match(source, /method: "POST", headers: authJsonHeaders\(\), body: requestKey, signal: controller.signal, cache: "no-store"/);
  assert.match(source, /hiddenStockIds: \[\.\.\.hiddenIds\]\.sort\(\)/);
  assert.match(source, /return \(\) => controller.abort\(\)/);
  assert.match(source, /result.key === requestKey && search === debouncedSearch/);
  assert.doesNotMatch(source, /state\.stock|loadStock|saveState|\/api\/state/);
});

test("catalog includes single fish rule count and keeps changes in the shared save draft", async () => {
  const source = await readFile(new URL("./CatalogManagementView.tsx", import.meta.url), "utf8");
  assert.match(source, /type CatalogRuleTab = "major" \| "species" \| "product" \| "stock"/);
  assert.match(source, /uniqueCount\(policy.hiddenStockIds\)/);
  assert.match(source, /onHiddenChange=\{\(stockId, hidden\) => updateHidden\("hiddenStockIds", stockId, hidden\)\}/);
  assert.match(source, /publicCatalogPolicy: nextPolicy/);
  assert.match(source, /publicCatalogPolicyFingerprint\(latest.publicCatalogPolicy\) !== baselinePolicyFingerprint/);
  assert.match(source, /单只隐藏需要先保存规则/);
});
