import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { buildSpeciesStockGroups } from "../utils/speciesStockGroups.ts";

let server, SpeciesStockProductRow;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ SpeciesStockProductRow } = await server.ssrLoadModule("/src/app/components/SpeciesStockProductRow.tsx"));
});
after(async () => { await server?.close(); });
const fish = (id, sold, status = "healthy") => ({ id, code: id, productId: "p", subTankId: "t", sold, status, basePrice: 100 });
const render = (stock) => {
  const [group] = buildSpeciesStockGroups({ stock,
    products: [{ id: "p", speciesId: "s", name: "黄金吊", size: "5-7cm", origin: "印尼" }],
    tankGroups: [{ id: "g", name: "测试缸", subTanks: [{ id: "t", name: "N1" }] }],
  });
  return renderToStaticMarkup(createElement(SpeciesStockProductRow, {
    row: group.productRows[0], tankLabel: () => "测试缸 / N1", onOpenOrders() {},
  }));
};

test("sold fish have explicit counts, an accessible inline expander and individually identifiable order actions", () => {
  const markup = render([fish("188", false), fish("189", true), fish("190", true, "sick")]);
  assert.match(markup, /在缸 3 条/);
  assert.match(markup, /未售 1 条/);
  assert.match(markup, /已售待出库 2 条/);
  assert.match(markup, /（已售 2）/);
  assert.match(markup, /<details/);
  assert.match(markup, /<summary[^>]*aria-label="查看黄金吊 5-7cm的已售待出库鱼，共 2 条"/);
  assert.match(markup, /查看黄金吊（编号 189）的关联订单/);
  assert.match(markup, /查看黄金吊（编号 190）的关联订单/);
  assert.match(markup, /测试缸 \/ N1 · 疾病/);
  assert.doesNotMatch(markup, /编号 188/);
  assert.doesNotMatch(markup, /<a |role="dialog"/);
});

test("a product without sold fish has a clear zero state and no empty action", () => {
  const markup = render([fish("188", false)]);
  assert.match(markup, /已售待出库 0 条/);
  assert.doesNotMatch(markup, /<details|<summary|<button/);
});

test("the species view keeps the in-tank filter and opens the existing linked-order dialog", async () => {
  const source = await readFile(new URL("./StockInView.tsx", import.meta.url), "utf8");
  assert.match(source, /isVisibleInStockInventory\(item, inventoryHiddenStockIds\)/);
  assert.match(source, /buildSpeciesStockGroups\(\{\s*stock: activeStock/);
  assert.match(source, /onOpenOrders=\{\(item\) => setLinkedStockItem\(\{ \.\.\.item \}\)\}/);
  assert.match(source, /已出库、已损耗不计入/);
});
