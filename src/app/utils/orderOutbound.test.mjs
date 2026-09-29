import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { currentTankLocationLabel, orderOutboundItems, selectExpectedStockLocations, stockLocationSnapshot } from "./orderOutbound.ts";

const groups = [
  { id: "nj", name: "南京缸组", siteId: "nanjing", subTanks: [{ id: "tank-nj", name: "1" }] },
  { id: "jy", name: "江阴缸组", siteId: "jiangyin", subTanks: [{ id: "tank-jy", name: "2" }] },
];
const sites = [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }];

test("both cross-site directions retain sold order fish as outbound candidates without changing order origin", () => {
  for (const [origin, currentSite, subTankId] of [["nanjing", "jiangyin", "tank-jy"], ["jiangyin", "nanjing", "tank-nj"]]) {
    const order = { siteId: origin, items: [{ stockItemId: "fish", productId: "product", price: 400 }] };
    const stock = { id: "fish", siteId: currentSite, subTankId, sold: true, lost: false };
    const result = orderOutboundItems(order.items, [], [stock]);
    assert.deepEqual(result.shippableUnshippedItems, order.items);
    assert.equal(order.siteId, origin);
    assert.deepEqual(stockLocationSnapshot(stock, groups), { siteId: currentSite, subTankId });
  }
});

test("deleted, unauthorized, lost, removed and already-outbound fish cannot enter the candidate list", () => {
  const items = ["healthy", "lost", "hidden", "removed", "shipped"].map((id) => ({ stockItemId: id, ...(id === "removed" ? { inventoryRemovedAt: "2026-09-28" } : {}) }));
  const stock = [{ id: "healthy", sold: true }, { id: "lost", lost: true }, { id: "removed" }, { id: "shipped" }];
  const result = orderOutboundItems(items, [{ status: "outbound", itemStockIds: ["shipped"] }], stock);
  assert.deepEqual(result.shippableUnshippedItems.map((item) => item.stockItemId), ["healthy"]);
  assert.deepEqual(result.unavailableUnshippedItems.map((item) => item.stockItemId), ["hidden"]);
  assert.deepEqual(result.lostUnshippedItems.map((item) => item.stockItemId), ["lost"]);
  assert.deepEqual(orderOutboundItems([items[0]], [{ status: "preparing", itemStockIds: ["healthy"] }], stock).shippableUnshippedItems, [items[0]]);
});

test("physical tank location wins over a stale stock site and labels always name the actual site", () => {
  assert.deepEqual(stockLocationSnapshot({ siteId: "nanjing", subTankId: "tank-jy" }, groups), { siteId: "jiangyin", subTankId: "tank-jy" });
  assert.equal(currentTankLocationLabel("tank-jy", groups, sites), "江阴 · 江阴缸组 / 2");
  assert.equal(currentTankLocationLabel("tank-nj", groups, sites), "南京 · 南京缸组 / 1");
  assert.deepEqual(stockLocationSnapshot({ siteId: "jiangyin", subTankId: "missing" }, groups), { siteId: "jiangyin", subTankId: "missing" });
  assert.equal(stockLocationSnapshot(undefined, groups), undefined);
  assert.equal(currentTankLocationLabel("missing", groups, sites), "缸位暂不可见");
});

test("selected location payload retains dialog-open snapshots and fails closed for missing locations", () => {
  const first = { siteId: "jiangyin", subTankId: "tank-jy" };
  const snapshots = { fish: { ...first }, other: { siteId: "nanjing", subTankId: "tank-nj" } };
  first.siteId = "nanjing";
  first.subTankId = "tank-nj";
  assert.deepEqual(selectExpectedStockLocations(["fish"], snapshots), { fish: { siteId: "jiangyin", subTankId: "tank-jy" } });
  assert.equal(selectExpectedStockLocations(["missing"], snapshots), null);
  assert.equal(selectExpectedStockLocations(["fish"], { fish: { siteId: "jiangyin", subTankId: "" } }), null);
  assert.deepEqual(selectExpectedStockLocations([], snapshots), {});
});

test("order detail uses authorized all-site inventory and passes opening-location snapshots through outbound", async () => {
  const source = await readFile(new URL("../components/OrdersView.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  const dialog = await readFile(new URL("../components/ShipDialog.tsx", import.meta.url), "utf8");
  assert.match(app, /<OrdersView\s+allStock=\{state.stock\}\s+allTankGroups=\{state.tankGroups\}/);
  assert.match(source, /const accessibleStock = allStock \?\? state.stock/);
  assert.match(source, /orderOutboundItems\(order\?\.items \?\? \[\], orderShipments, accessibleStock\)/);
  assert.match(source, /expectedStockLocations: data.expectedStockLocations/);
  assert.match(source, /stockItem=\{detailId \? getStockItem\(detailId\) : undefined\}/);
  assert.match(source, /loadedRecords\.records : state\.bioRecords/);
  assert.match(dialog, /selectExpectedStockLocations\(\[\.\.\.selectedIds\], locationSnapshots\)/);
});
