import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { buildPurchaseBatchDetail } from "../../../server/purchase-batch-details.mjs";
import { batchDetailsFixture } from "../../../server/test-support/batch-details-fixture.mjs";

let server, ui;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ui = await server.ssrLoadModule("/src/app/components/BatchDetailsView.tsx");
});
after(async () => { await server?.close(); });

function transferProjection() {
  const state = structuredClone(batchDetailsFixture.state);
  const item = state.stock.find((fish) => fish.id === "fish-in");
  item.sold = true;
  item.tankTransfer = { id: "transfer-1", status: "in_transit", issuedAt: "2026-10-18T09:00:00+08:00", issuedBy: "测试签发人", fromSiteId: "nanjing", fromSubTankId: item.subTankId, fromTankName: "南京鱼缸 / N2", notes: "调整密度" };
  state.stock = [item];
  state.orders = [{ id: "retained-order", orderNo: "原订单保留", siteId: "nanjing", date: "2026-10-17", status: "confirmed", items: [{ stockItemId: item.id, productId: item.productId, price: 123 }] }];
  state.shipments = [];
  return buildPurchaseBatchDetail(state, { batchId: "batch-nj", siteId: "nanjing", visibleSiteIds: ["nanjing", "jiangyin"], isAdmin: true, status: "inTransit", page: 1, pageSize: 50 });
}

test("batch UI accepts the real in-transit projection without showing a source tank as current occupancy", () => {
  const result = transferProjection();
  const fish = result.items.find((row) => row.stockItemId === "fish-in");
  assert.equal(fish.status, "inTransit");
  assert.equal(fish.currentTankName, "");
  const html = renderToStaticMarkup(createElement(ui.FishRow, { fish, batchId: "batch-nj", siteId: "nanjing" }));
  assert.match(html, /移缸在途，尚未签收入缸/);
  assert.match(html, /当前位置/);
  assert.doesNotMatch(html, /档案缸位|缸位未记录/);
  assert.match(html, /原订单保留/);
  assert.match(html, /¥123\.00/);
});

test("status filter and tank totals have a separate in-transit bucket", () => {
  const result = transferProjection();
  const filters = ui.batchFishStatusFilters(result.summary);
  assert.deepEqual(filters.find((filter) => filter.value === "inTransit"), { value: "inTransit", label: "移缸在途", count: 1 });
  const tank = result.tanks.find((row) => row.key === "inTransit");
  assert.equal(tank.tankName, "移缸在途");
  assert.equal(tank.inStock, 0);
  const html = renderToStaticMarkup(createElement(ui.BatchTankCounts, { tank }));
  assert.match(html, /移缸在途 1/);
  assert.doesNotMatch(html, /在库 |已售 |损耗 /);
});

test("missing historical location and restricted records do not become in-transit by inference", () => {
  const base = { stockItemId: "fish", productName: "黄金吊", status: "restricted", statusLabel: "记录受限", sales: [], recordCount: 0, warnings: [], currentTankName: "" };
  const restricted = renderToStaticMarkup(createElement(ui.FishRow, { fish: base, batchId: "batch", siteId: "nanjing" }));
  assert.match(restricted, /无权查看/);
  assert.doesNotMatch(restricted, /移缸在途/);
  const ordinary = renderToStaticMarkup(createElement(ui.FishRow, { fish: { ...base, status: "inStock", statusLabel: "在库" }, batchId: "batch", siteId: "nanjing" }));
  assert.match(ordinary, /当前缸位/);
  assert.doesNotMatch(ordinary, /移缸在途/);
});

test("batch tank view explains the separate in-transit group and sends the selected status to the API", async () => {
  const source = await readFile(new URL("./BatchDetailsView.tsx", import.meta.url), "utf8");
  assert.match(source, /URLSearchParams\(\{ batchId, siteId, search, status, tankKey/);
  assert.match(source, /移缸在途单独列出，不占原缸位/);
  assert.match(source, /tank\.key === "inTransit" \? "待签收入缸"/);
});
