import assert from "node:assert/strict";
import test from "node:test";
import { buildPurchaseBatchDetail, buildPurchaseBatchFishHistory, buildPurchaseBatchOrderDetail, parseBatchDetailQuery, preserveStockEntrySnapshot } from "./purchase-batch-details.mjs";
import { calculateOrderFeeBreakdown } from "./finance-utils.mjs";
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

test("tank groups count all matching fish before pagination and remain stable when a tank is selected", () => {
  const state = fresh();
  state.approvalRequests = [];
  state.orders = [];
  state.shipments = [];
  const source = state.stock.find((item) => item.id === "fish-in");
  state.stock = Array.from({ length: 72 }, (_, index) => ({ ...source, id: `group-${index}`, code: `Group ${index}`, subTankId: index < 60 ? "tank-n1" : "tank-n2" }));
  const list = buildPurchaseBatchDetail(state, { ...admin, pageSize: 50, search: "Group", status: "inStock" });
  assert.equal(list.items.length, 50);
  assert.equal(list.total, 72);
  assert.deepEqual(list.tanks.map(({ key, total, inStock }) => ({ key, total, inStock })), [
    { key: "tank:nanjing:tank-n1", total: 60, inStock: 60 }, { key: "tank:nanjing:tank-n2", total: 12, inStock: 12 },
  ]);
  const selected = buildPurchaseBatchDetail(state, { ...admin, pageSize: 50, page: 2, tankKey: list.tanks[0].key });
  assert.deepEqual(selected.tanks, list.tanks);
  assert.equal(selected.items.length, 10);
  assert.equal(selected.total, 60);
  assert.ok(selected.items.every((row) => row.currentSubTankId === "tank-n1"));
  assert.equal(buildPurchaseBatchDetail(state, { ...admin, search: "missing", tankKey: list.tanks[0].key }).tanks.length, 0);
});

test("restricted, deleted and unknown-tank groups do not reveal location identifiers", () => {
  const state = fresh();
  const source = state.stock.find((item) => item.id === "fish-in");
  state.stock.push({ ...source, id: "unknown-tank-fish", subTankId: "HIDDEN_MISSING_TANK_ID" });
  const detail = buildPurchaseBatchDetail(state, staff);
  const hidden = detail.items.find((item) => item.stockItemId === "fish-cross");
  assert.equal(hidden.tankKey, "restricted");
  assert.equal(hidden.currentSubTankId, "");
  assert.equal(detail.items.find((item) => item.stockItemId === "unknown-tank-fish").tankKey, "unknown");
  const buckets = detail.tanks.filter((tank) => ["restricted", "removed", "unknown"].includes(tank.key));
  assert.ok(buckets.every((bucket) => bucket.siteName === ""));
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_JY_TANK|tank-j1|HIDDEN_MISSING_TANK_ID/);
  for (const key of ["restricted", "removed", "unknown"]) {
    const selected = buildPurchaseBatchDetail(state, { ...staff, tankKey: key });
    assert.ok(selected.items.every((row) => row.tankKey === key && row.currentSubTankId === ""));
  }
});

test("order modal validates exact batch membership and authoritative visible order sites", () => {
  const state = fresh();
  state.orders.push({ id: "same-product-unrelated", siteId: "nanjing", items: [{ stockItemId: "not-in-batch", productId: "product-tang", price: 100 }] });
  for (const [options, code] of [
    [{ ...admin, orderId: "same-product-unrelated" }, 404],
    [{ ...staff, orderId: "PRIVATE_JY_ORDER" }, 404],
    [{ ...staff, siteId: "jiangyin", batchId: "batch-jy", orderId: "ORDER-SALE" }, 403],
    [{ ...admin, siteId: "jiangyin", orderId: "ORDER-SALE" }, 404],
  ]) assert.throws(() => buildPurchaseBatchOrderDetail(state, options, calculateOrderFeeBreakdown), (error) => error.statusCode === code);
  assert.equal(buildPurchaseBatchOrderDetail(state, { ...admin, orderId: "PRIVATE_JY_ORDER" }, calculateOrderFeeBreakdown).order.siteName, "江阴");
});

test("order modal returns minimal fields and uses only the supplied existing fee calculation", () => {
  const state = fresh();
  const rawOrder = state.orders.find((order) => order.id === "ORDER-SALE");
  rawOrder.payments = [
    { id: "p1", type: "balance", amount: 250, verificationStatus: "verified", account: "PRIVATE_PAYMENT_ACCOUNT", proof: ["PRIVATE_PROOF"] },
    { id: "p2", type: "refund", amount: 20, verificationStatus: "verified" },
    { id: "p3", type: "balance", amount: 50, verificationStatus: "pending" },
    { id: "p4", type: "refund", amount: 5, verificationStatus: "pending" },
  ];
  state.shipments.push({ id: "other-batch-shipment", orderId: "ORDER-SALE", itemStockIds: ["other-batch-fish"], status: "shipped", actualShippingFee: 99 });
  let calls = 0;
  const { order } = buildPurchaseBatchOrderDetail(state, { ...admin, orderId: "ORDER-SALE" }, (selected, shipments) => {
    calls += 1;
    assert.equal(selected, rawOrder);
    assert.ok(shipments.some((shipment) => shipment.id === "other-batch-shipment"), "whole-order shipping is provided");
    return calculateOrderFeeBreakdown(selected, { billableShippingFee: 33, damageRefundAdjustment: 10 });
  });
  assert.equal(calls, 1);
  assert.equal(order.customerName, "PRIVATE_CUSTOMER_NAME");
  assert.equal(order.items.length, 2);
  assert.deepEqual(order.items.map((item) => item.isBatchFish), [true, false]);
  assert.equal(order.totals.itemSubtotal, 300);
  assert.equal(order.totals.goodsNetTotal, 250);
  assert.equal(order.totals.calculatedReceivable, 283);
  assert.equal(order.totals.netReceived, 230);
  assert.equal(order.totals.pendingReceived, 50);
  assert.equal(order.totals.pendingRefunded, 5);
  assert.equal(order.totals.balance, 53);
  assert.doesNotMatch(JSON.stringify(order), /PRIVATE_CUSTOMER_PHONE|PRIVATE_PAYMENT_ACCOUNT|PRIVATE_FINANCE_NOTE|PRIVATE_SHIPPING_ADDRESS|PRIVATE_PROOF/);
});

test("replacement-only order association is retained without inventing an original invoice row", () => {
  const state = fresh();
  for (const stock of state.stock) if (stock.id.startsWith("fish-replacement")) stock.batchId = "batch-jy";
  const { order } = buildPurchaseBatchOrderDetail(state, { ...admin, orderId: "ORDER-REPLACEMENT" }, calculateOrderFeeBreakdown);
  assert.equal(order.items.length, 2);
  assert.ok(order.items.every((item) => !item.isBatchFish && item.kind === "replacement" && item.note.includes("不是补发鱼")));
  assert.deepEqual(order.items.map((item) => item.price), [350, 450], "the retained order bill is shown, not claimed as new fish sales");
  assert.ok(order.warnings.some((message) => message.includes("原鱼补发")));
});

test("missing order line prices remain null and cannot turn unknown totals into zero", () => {
  const state = fresh();
  delete state.orders.find((order) => order.id === "ORDER-SALE").items[0].price;
  const { order } = buildPurchaseBatchOrderDetail(state, { ...admin, orderId: "ORDER-SALE" }, calculateOrderFeeBreakdown);
  assert.equal(order.items[0].price, null);
  for (const key of ["itemSubtotal", "goodsNetTotal", "calculatedReceivable", "balance"]) assert.equal(order.totals[key], null, key);
  assert.equal(order.totals.discount, 50);
});

test("order and tank queries validate required identifiers and bounded tank keys", () => {
  const base = "batchId=batch-nj&siteId=nanjing";
  assert.throws(() => parseBatchDetailQuery(new URLSearchParams(base), { orderDetail: true }), (error) => error.statusCode === 400);
  for (const tankKey of ["broken-key", "tank:nanjing", "tank::fish", `tank:nanjing:${"x".repeat(600)}`]) {
    const params = new URLSearchParams(base); params.set("tankKey", tankKey);
    assert.throws(() => parseBatchDetailQuery(params), (error) => error.statusCode === 400);
  }
  const params = new URLSearchParams(base); params.set("tankKey", "tank:nanjing:tank-n1"); params.set("orderId", "ORDER-SALE");
  assert.equal(parseBatchDetailQuery(params, { orderDetail: true }).orderId, "ORDER-SALE");
});
