import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { currentTankLocationLabel, orderOutboundItems, outboundTransferConfirmationKey, outboundTransferSnapshotsMatch, selectExpectedStockLocations, stockLocationSnapshot } from "./orderOutbound.ts";

const groups = [
  { id: "nj", name: "南京缸组", siteId: "nanjing", subTanks: [{ id: "tank-nj", name: "1" }] },
  { id: "jy", name: "江阴缸组", siteId: "jiangyin", subTanks: [{ id: "tank-jy", name: "2" }] },
];
const sites = [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }];

test("retained order fish in transfer remain outbound candidates requiring explicit transfer confirmation", () => {
  const item = { stockItemId: "fish", price: 188 };
  const stock = { id: "fish", sold: true, tankTransfer: { id: "transfer", status: "in_transit" } };
  const result = orderOutboundItems([item], [], [stock]);
  assert.deepEqual(result.inventoryActiveItems, [item]);
  assert.deepEqual(result.transferUnshippedItems, [item]);
  assert.deepEqual(result.shippableUnshippedItems, [item]);
  assert.deepEqual(orderOutboundItems([item], [], [{ ...stock, tankTransfer: { ...stock.tankTransfer, status: "received" } }]).shippableUnshippedItems, [item]);
});

test("direct-dispatch confirmation covers all selected fish, actual site, and issuing transfer IDs", () => {
  const snapshot = { fish: "transfer-1", normal: "", other: "transfer-2" };
  const original = outboundTransferConfirmationKey(["fish", "normal"], snapshot, "nanjing");
  assert.equal(original, outboundTransferConfirmationKey(["normal", "fish"], snapshot, "nanjing"));
  assert.notEqual(original, outboundTransferConfirmationKey(["fish"], snapshot, "nanjing"));
  assert.notEqual(original, outboundTransferConfirmationKey(["fish", "normal", "other"], snapshot, "nanjing"));
  assert.notEqual(original, outboundTransferConfirmationKey(["fish", "normal"], snapshot, "jiangyin"));
  assert.notEqual(original, outboundTransferConfirmationKey(["fish", "normal"], { ...snapshot, fish: "transfer-new" }, "nanjing"));
});

test("outbound transfer snapshots fail closed after receive, reissue, new issuance, or disappearance", () => {
  const snapshots = { fish: "transfer-1", normal: "" };
  assert.equal(outboundTransferSnapshotsMatch(["fish", "normal"], snapshots, { ...snapshots }), true);
  assert.equal(outboundTransferSnapshotsMatch(["fish"], snapshots, { fish: "" }), false);
  assert.equal(outboundTransferSnapshotsMatch(["fish"], snapshots, { fish: "transfer-2" }), false);
  assert.equal(outboundTransferSnapshotsMatch(["normal"], snapshots, { normal: "new-transfer" }), false);
  assert.equal(outboundTransferSnapshotsMatch(["fish"], snapshots, {}), false);
  assert.equal(outboundTransferSnapshotsMatch(["added"], snapshots, { added: "" }), false);
});

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

test("safe order-linked transit projection enables actual-site dispatch without widening general stock", () => {
  const items = ["other-site-transit", "other-site-normal", "already-outbound", "removed"].map((stockItemId) => ({
    stockItemId, ...(stockItemId === "removed" ? { inventoryRemovedAt: "2026-10-24" } : {}),
  }));
  const projection = ["other-site-transit", "already-outbound", "removed", "unrelated-order-fish"].map((stockItemId) => ({
    stockItemId, transferId: `transfer-${stockItemId}`,
  }));
  const accessibleStock = [];
  const result = orderOutboundItems(items, [{ status: "outbound", itemStockIds: ["already-outbound"] }], accessibleStock, projection);
  assert.deepEqual(result.shippableUnshippedItems.map((item) => item.stockItemId), ["other-site-transit"]);
  assert.deepEqual(result.transferUnshippedItems.map((item) => item.stockItemId), ["other-site-transit"]);
  assert.deepEqual(result.unavailableUnshippedItems.map((item) => item.stockItemId), ["other-site-normal"]);
  assert.deepEqual(accessibleStock, []);
  assert.deepEqual(orderOutboundItems(items, [], [{ id: "other-site-transit", lost: true }], projection)
    .shippableUnshippedItems.map((item) => item.stockItemId), ["already-outbound"]);
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
  assert.match(source, /orderOutboundItems\(order\?\.items \?\? \[\], orderShipments, accessibleStock, orderTransferItems\)/);
  assert.match(source, /expectedStockLocations: data.expectedStockLocations/);
  assert.match(source, /stockItem=\{detailId \? getStockItem\(detailId\) : undefined\}/);
  assert.match(source, /loadedRecords\.records : state\.bioRecords/);
  assert.match(dialog, /selectExpectedStockLocations\(normalSelectedIds, locationSnapshots\)/);
  assert.match(dialog, /normalSelectedIds = \[\.\.\.selectedIds\]\.filter\(\(id\) => !transferSnapshots\[id\]\)/);
  assert.match(dialog, /outboundTransferSnapshotsMatch\(\[\.\.\.selectedIds\], transferSnapshots, currentTransfers\)/);
  assert.match(dialog, /transferDispatch: \{ siteId: dispatchSiteId, items: selectedTransferItems \}/);
  assert.match(dialog, /visibleSitesForUser\(state.user, state\)/);
  assert.match(dialog, /if \(!transferConfirmed\) return toast.error/);
  assert.match(dialog, /setDispatchSiteId\(id\); setConfirmedTransferKey\(""\)/);
  assert.match(source, /if \(Array\.isArray\(result.stock\)\) notifyStockTransfersChanged\(\)/);
  assert.match(source, /if \(s.tankTransfer\?\.status === "in_transit"\) return "移缸在途，签收入缸后才可选鱼"/);
  assert.match(source, /fetch\(`\/api\/orders\/transfer-items\?orderId=\$\{encodeURIComponent\(requestedOrderId\)\}/);
  assert.match(source, /setOrderTransferSnapshot\(\{ orderId: requestedOrderId, viewerKey: orderTransferViewerKey, items: data.items \}\)/);
});
