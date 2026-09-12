import assert from "node:assert/strict";
import test from "node:test";
import { buildPurchaseBatchDetail, buildPurchaseBatchFishHistory, parseBatchDetailQuery, preserveStockEntrySnapshot } from "./purchase-batch-details.mjs";
import { batchDetailsFixture } from "./test-support/batch-details-fixture.mjs";

const fresh = () => structuredClone(batchDetailsFixture.state);
const admin = { batchId: "batch-nj", siteId: "nanjing", visibleSiteIds: ["nanjing", "jiangyin"], isAdmin: true, page: 1, pageSize: 100 };
const staff = { ...admin, visibleSiteIds: ["nanjing"], isAdmin: false };

test("new entry snapshots use authoritative tanks and ignore client-provided historical facts", () => {
  const state = fresh();
  const item = { ...state.stock[0], entrySnapshot: { version: 1, tankName: "forged", operator: "forged" } };
  const created = preserveStockEntrySnapshot({ item, tankGroups: state.tankGroups, sites: state.sites, operator: "real-operator", recordedAt: "2026-09-13T00:00:00Z" });
  assert.equal(created.entrySnapshot.tankName, "南京鱼缸 / N2");
  assert.equal(created.entrySnapshot.siteId, "nanjing");
  assert.equal(created.entrySnapshot.inDate, item.inDate);
  assert.equal(created.entrySnapshot.operator, "real-operator");
  assert.equal(created.entrySnapshot.recordedAt, "2026-09-13T00:00:00Z");
  assert.equal(item.entrySnapshot.tankName, "forged", "input is not mutated");
});

test("updates retain the original snapshot and never backfill legacy fish from their current tank", () => {
  const state = fresh();
  const legacy = state.stock[0];
  const updatedLegacy = preserveStockEntrySnapshot({ existing: legacy, item: { ...legacy, entrySnapshot: { version: 1, tankName: "forged" } }, tankGroups: state.tankGroups });
  assert.equal(updatedLegacy.entrySnapshot, undefined);
  const original = preserveStockEntrySnapshot({ item: legacy, tankGroups: state.tankGroups, sites: state.sites });
  const moved = preserveStockEntrySnapshot({ existing: original, item: { ...original, subTankId: "tank-j1", siteId: "jiangyin", entrySnapshot: { version: 1, tankName: "forged" } }, tankGroups: state.tankGroups });
  assert.deepEqual(moved.entrySnapshot, original.entrySnapshot);
  const stateAfterMove = { ...state, stock: [moved] };
  const detail = buildPurchaseBatchDetail(stateAfterMove, admin);
  assert.equal(detail.items[0].initialTankName, "南京鱼缸 / N2");
  assert.equal(detail.items[0].currentTankName, "PRIVATE_JY_TANK / J1");
});

test("only executed approved snapshots can establish initial tanks or deleted fish batch membership", () => {
  const state = fresh();
  const snapshot = { stockItemId: "fish-in", batchId: "batch-nj", productId: "product-tang", siteId: "nanjing", inDate: "2026-08-01", subTankId: "tank-n1", tankName: "历史南京 / 初始N1" };
  state.approvalRequests = [
    { id: "approved-add", status: "approved", siteId: "nanjing", resolvedAt: "2026-08-01T09:00:00+08:00", stockDetails: { items: [{ operation: "add", stockItemId: "fish-in", before: null, after: snapshot }] } },
    { id: "approved-remove", status: "approved", siteId: "nanjing", resolvedAt: "2026-08-03", stockDetails: { items: [{ operation: "remove", stockItemId: "deleted-fish", before: { ...snapshot, stockItemId: "deleted-fish" }, after: null }] } },
    { id: "pending", status: "pending", siteId: "nanjing", stockDetails: { items: [{ operation: "add", stockItemId: "unexecuted-fish", before: null, after: snapshot }] } },
  ];
  const detail = buildPurchaseBatchDetail(state, admin);
  assert.equal(detail.items.find((row) => row.stockItemId === "fish-in").initialTankName, "历史南京 / 初始N1");
  assert.equal(detail.items.find((row) => row.stockItemId === "deleted-fish").status, "removed");
  assert.equal(detail.items.some((row) => row.stockItemId === "unexecuted-fish"), false);
});

test("unknown historical sites stay unknown for admins and fail closed for staff", () => {
  const state = fresh();
  state.stock.find((item) => item.id === "fish-lost").subTankId = "tank-j1";
  state.lossRecords[0] = { id: "unknown-location", stockItemId: "fish-lost", date: "2026-08-09", reason: "unknown-event-location", proofPhotos: ["/uploads/loss.jpg"] };
  const history = buildPurchaseBatchFishHistory(state, { ...admin, stockItemId: "fish-lost" });
  const event = history.events.find((item) => item.id === "loss:unknown-location");
  assert.equal(event.siteName, "");
  assert.equal(event.tankName, "");
  assert.doesNotMatch(JSON.stringify(buildPurchaseBatchFishHistory(state, { ...staff, stockItemId: "fish-lost" })), /unknown-event-location|\/uploads\/loss\.jpg/);
});

test("hidden entry site also hides its operator and does not leak through search", () => {
  const state = fresh();
  state.stock[0].entrySnapshot = { version: 1, siteId: "jiangyin", tankName: "PRIVATE_ENTRY_TANK", operator: "PRIVATE_ENTRY_OPERATOR", inDate: "2026-08-01" };
  const history = buildPurchaseBatchFishHistory(state, { ...staff, stockItemId: "fish-in" });
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_ENTRY_TANK|PRIVATE_ENTRY_OPERATOR/);
  assert.equal(buildPurchaseBatchDetail(state, { ...staff, search: "PRIVATE_ENTRY_TANK" }).total, 0);
});

test("ambiguous or missing fish item prices remain unknown rather than using current price or same-product orders", () => {
  const state = fresh();
  const order = state.orders.find((item) => item.id === "ORDER-SALE");
  order.items.push({ ...order.items[0], price: 900 });
  state.stock.find((item) => item.id === "fish-in").sold = true;
  const result = buildPurchaseBatchDetail(state, admin);
  assert.equal(result.items.find((item) => item.stockItemId === "fish-sold").sales.find((sale) => sale.orderId === "ORDER-SALE").price, null);
  const unmatched = result.items.find((item) => item.stockItemId === "fish-in");
  assert.deepEqual(unmatched.sales, []);
  assert.ok(unmatched.warnings.some((message) => message.includes("不能推算")));
});

test("conflicting identifiers fail closed before linking cross-batch or cross-site evidence", () => {
  for (const collection of ["stock", "orders", "tankGroups"]) {
    const state = fresh();
    state[collection].push(structuredClone(state[collection][0]));
    assert.throws(() => buildPurchaseBatchDetail(state, admin), (error) => error.statusCode === 409, collection);
  }
});

test("pagination and site inputs reject malformed or unbounded requests", () => {
  for (const query of [
    "batchId=batch-nj&siteId=all", "batchId=batch-nj&siteId=nanjing&page=0",
    "batchId=batch-nj&siteId=nanjing&page=1.2", "batchId=batch-nj&siteId=nanjing&pageSize=101",
    "batchId=batch-nj&siteId=nanjing&status=unknown",
  ]) assert.throws(() => parseBatchDetailQuery(new URLSearchParams(query)), (error) => error.statusCode === 400);
  const parsed = parseBatchDetailQuery(new URLSearchParams("batchId=batch-nj&siteId=nanjing&status=restricted"));
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.status, "restricted");
});
