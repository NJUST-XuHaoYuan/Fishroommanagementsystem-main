import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

async function setup(t, fixture = stockPricingFixture) {
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const state = async () => (await server.request("/api/state", { token: tokens.admin })).body.data;
  const upsert = (defaultPrice, expectedDefaultPrice = 100, role = "admin", extra = {}) => server.request("/api/products/upsert", {
    token: tokens[role], body: { product: { ...fixture.state.products[0], defaultPrice, ...extra }, expectedDefaultPrice },
  });
  const bio = (stockItemId, details, expectedDetails, role = "admin") => server.request("/api/bio-records/save", {
    token: tokens[role], body: { action: "saveDetails", stockItemId, details, expectedDetails },
  });
  return { ...server, tokens, state, upsert, bio };
}
const byId = (state, id) => state.stock.find((item) => item.id === id);
const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const stockWrite = (server, items, before = {}, role = "admin") => server.request("/api/stock/save", {
  token: server.tokens[role], body: { upsert: items, deleteIds: [],
    expectedOperations: Object.fromEntries(items.map((item) => [item.id, before[item.id] ? "update" : "create"])), expectedBefore: before },
});
const newFish = (id, extra = {}) => ({ ...stockPricingFixture.state.stock[0], id, code: id, ...extra });
const assertPricing = (state, id, price, mode) => {
  const item = byId(state, id); assert.ok(item, id);
  assert.equal(item.basePrice, price, `${id} price`); assert.equal(item.priceMode, mode, `${id} mode`);
};

test("product upsert atomically follows old-price evidence across sites and preserves manual, legacy, held and historical order values", async (t) => {
  const s = await setup(t); const before = await s.state();
  const result = await s.upsert(200); ok(result);
  assert.deepEqual(result.body.pricingSummary, { total: 25, product: 18, manual: 4, legacy: 3, protected: 13, priceUpdated: 7, modeFrozen: 5 });
  let state = await s.state();
  for (const id of ["follower", "follower-stale", "PRIVATE_JY_FOLLOWER", "legacy-equal", "shipment-preparing", "cancelled-order", "removed-order-item"]) assertPricing(state, id, 200, "product");
  for (const id of ["sold", "lost", "status-sold", "ordered-confirmed", "ordered-completed", "ordered-pending", "shipment-outbound", "shipment-shipped", "shipment-delivered", "shipment-damaged", "release-follower"]) assertPricing(state, id, 100, "product");
  assertPricing(state, "legacy-different", 140, "legacy"); assertPricing(state, "legacy-equal-new", 200, "legacy");
  assertPricing(state, "legacy-override", 100, "manual"); assertPricing(state, "manual-equal", 100, "manual");
  assertPricing(state, "manual-different", 150, "manual"); assertPricing(state, "release-manual", 145, "manual");
  assertPricing(state, "release-legacy", 145, "legacy"); assertPricing(state, "other-product-fish", 777, "product");
  assert.deepEqual(state.orders, before.orders); assert.deepEqual(state.shipments, before.shipments);
  ok(await s.upsert(250, 200)); state = await s.state();
  assertPricing(state, "follower", 250, "product"); assertPricing(state, "legacy-equal-new", 200, "legacy");
  assertPricing(state, "manual-equal", 100, "manual"); assert.deepEqual(state.orders, before.orders);
});

test("site-limited product editors may update shared product prices but receive only visible stock counts and IDs", async (t) => {
  const s = await setup(t); const result = await s.upsert(200, 100, "editor"); ok(result);
  assert.equal(result.body.pricingSummary.total, 24); assert.equal(result.body.pricingSummary.priceUpdated, 6);
  assert.equal(result.body.stockPricingUpdates.length, 10);
  assert.ok(result.body.stockPricingUpdates.every((item) => Object.keys(item).sort().join(",") === "basePrice,id,priceMode,priceOverridden"));
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_JY_|jiangyin|同步 7 条/);
  assertPricing(await s.state(), "PRIVATE_JY_FOLLOWER", 200, "product");
  for (const path of ["/api/state", "/api/state/slice?keys=operationLogs"]) {
    const read = await s.request(path, { token: s.tokens.editor }); ok(read);
    assert.ok(read.body.data?.operationLogs == null, "staff cannot retrieve globally scoped operation logs");
  }
});

test("unauthorized writes and invalid prices leave both product and stock unchanged", async (t) => {
  const s = await setup(t); const before = await s.state();
  for (const role of ["viewer", "anonymous"]) {
    const result = await s.upsert(200, 100, role);
    assert.ok((role === "viewer" ? [400, 403] : [401]).includes(result.response.status), JSON.stringify(result.body));
  }
  for (const value of [0, -1, "Infinity", "NaN", "invalid", 1e100, 0.001]) {
    const result = await s.upsert(value); assert.equal(result.response.status, 400, JSON.stringify(result.body));
  }
  const after = await s.state(); assert.deepEqual(after.products, before.products); assert.deepEqual(after.stock, before.stock);
});

test("product CAS rejects stale and pre-CAS clients; concurrent writers cannot leave mixed follow prices", async (t) => {
  const s = await setup(t);
  const oldClient = await s.request("/api/products/upsert", { token: s.tokens.admin, body: { product: { ...stockPricingFixture.state.products[0], defaultPrice: 200 } } });
  assert.equal(oldClient.response.status, 409);
  const results = await Promise.all([s.upsert(200), s.upsert(300)]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
  const state = await s.state(); const current = state.products.find((product) => product.id === "price-product").defaultPrice;
  assert.ok([200, 300].includes(current));
  for (const id of ["follower", "follower-stale", "PRIVATE_JY_FOLLOWER", "legacy-equal"]) assertPricing(state, id, current, "product");
  const stale = await s.upsert(100, 100); assert.equal(stale.response.status, 409);
  ok(await s.upsert(current, 100, "admin", { notes: "价格不变的旧页面其他编辑" }));
  assertPricing(await s.state(), "follower", current, "product");
});

test("generic state writes cannot bypass authoritative product-price synchronization or write stock", async (t) => {
  const s = await setup(t); const before = await s.state();
  const full = await s.request("/api/state", { token: s.tokens.admin, body: { data: before } }); assert.equal(full.response.status, 410);
  for (const key of ["products", "stock"]) {
    const patch = structuredClone(before[key]);
    if (key === "products") patch[0].defaultPrice = 999; else patch[0].basePrice = 999;
    const result = await s.request("/api/state/patch", { token: s.tokens.admin, body: { patch: { [key]: patch }, basePatch: { [key]: before[key] } } });
    assert.ok([400, 403, 409, 410].includes(result.response.status), JSON.stringify(result.body));
  }
  const after = await s.state(); assert.deepEqual(after.products, before.products); assert.deepEqual(after.stock, before.stock);
  for (const products of [[...before.products, { ...before.products[0], id: "bypass-new-product" }], before.products.slice(1)]) {
    const mutation = await s.request("/api/state/patch", { token: s.tokens.admin, body: { patch: { products }, basePatch: { products: before.products } } });
    assert.equal(mutation.response.status, 409, JSON.stringify(mutation.body));
  }
  ok(await s.upsert(200));
  const rename = await s.request("/api/state/patch", { token: s.tokens.admin, body: {
    patch: { products: [{ ...before.products[0], origin: "测试产地更新" }] }, basePatch: { products: [before.products[0]] },
  } }); ok(rename);
  const renamed = await s.state(); assert.equal(renamed.products[0].origin, "测试产地更新"); assert.equal(renamed.products[0].defaultPrice, 200);
  assertPricing(renamed, "follower", 200, "product");
});

test("maintenance pricing mode changes use stored-price and mode CAS and persist independently from later product prices", async (t) => {
  const s = await setup(t); ok(await s.upsert(200));
  const stale = await s.bio("follower", { basePrice: 100, priceMode: "manual" }, { basePrice: 100, priceMode: "product" });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  ok(await s.bio("follower", { basePrice: 200, priceMode: "manual" }, { basePrice: 200, priceMode: "product" }));
  assertPricing(await s.state(), "follower", 200, "manual");
  ok(await s.upsert(250, 200)); assertPricing(await s.state(), "follower", 200, "manual");
  ok(await s.bio("follower", { basePrice: 200, priceMode: "product" }, { basePrice: 200, priceMode: "manual" }));
  assertPricing(await s.state(), "follower", 250, "product");
  const missingModeCAS = await s.bio("follower", { basePrice: 250, priceMode: "manual" }, { basePrice: 250 });
  assert.equal(missingModeCAS.response.status, 409, JSON.stringify(missingModeCAS.body));
});

test("old maintenance clients cannot overwrite frozen modes, but notes remain editable and unclassified old fish can opt into manual prices", async (t) => {
  const s = await setup(t);
  ok(await s.bio("legacy-different", { basePrice: 145 }, { basePrice: 140 }));
  assertPricing(await s.state(), "legacy-different", 145, "manual");
  ok(await s.upsert(200));
  const stale = await s.bio("follower", { basePrice: 100, notes: "stale" }, { basePrice: 100, notes: "" });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  const missingMode = await s.bio("follower", { basePrice: 210 }, { basePrice: 200 });
  assert.equal(missingMode.response.status, 409, JSON.stringify(missingMode.body));
  assertPricing(await s.state(), "follower", 200, "product");
  ok(await s.bio("legacy-equal-new", { notes: "旧客户端备注" }, { notes: "" }));
  assertPricing(await s.state(), "legacy-equal-new", 200, "legacy");
  ok(await s.upsert(300, 200)); assertPricing(await s.state(), "follower", 300, "product"); assertPricing(await s.state(), "legacy-equal-new", 200, "legacy");
});

test("held inventory rejects maintenance price/mode changes and hidden stock cannot be edited by visible-site staff", async (t) => {
  const s = await setup(t);
  for (const id of ["sold", "lost", "ordered-confirmed", "ordered-completed", "ordered-pending", "shipment-outbound", "shipment-shipped", "shipment-delivered", "shipment-damaged"]) {
    const result = await s.bio(id, { basePrice: 150, priceMode: "manual" }, { basePrice: 100, priceMode: "product" });
    assert.equal(result.response.status, 409, `${id}: ${JSON.stringify(result.body)}`);
  }
  const hidden = await s.bio("PRIVATE_JY_FOLLOWER", { basePrice: 150, priceMode: "manual" }, { basePrice: 100, priceMode: "product" }, "editor");
  assert.equal(hidden.response.status, 404); assert.doesNotMatch(JSON.stringify(hidden.body), /PRIVATE_JY_|100|150/);
  assertPricing(await s.state(), "PRIVATE_JY_FOLLOWER", 100, "product");
});

test("releasing an order resumes only product-priced fish at the current product price without modifying surviving orders", async (t) => {
  const s = await setup(t); ok(await s.upsert(200)); const before = await s.state();
  const result = await s.request("/api/orders/delete", { token: s.tokens.admin, body: { orderId: "ORDER-RELEASE" } }); ok(result);
  const state = await s.state();
  assertPricing(state, "release-follower", 200, "product"); assertPricing(state, "release-manual", 145, "manual"); assertPricing(state, "release-legacy", 145, "legacy");
  for (const id of ["release-follower", "release-manual", "release-legacy"]) assert.equal(byId(state, id).sold, false);
  assert.deepEqual(state.orders, before.orders.filter((order) => order.id !== "ORDER-RELEASE"));
});

test("new stock resolves the product price server-side, distinguishes manual equal prices, and rejects stale inventory updates", async (t) => {
  const s = await setup(t); const before = await s.state(); ok(await s.upsert(200));
  const result = await stockWrite(s, [newFish("new-follow", { basePrice: 999 }), newFish("new-manual", { basePrice: 200, priceMode: "manual", priceOverridden: true })]); ok(result);
  assertPricing(await s.state(), "new-follow", 200, "product"); assertPricing(await s.state(), "new-manual", 200, "manual");
  assertPricing(await s.state(), "sold", 100, "product");
  assert.equal(byId(await s.state(), "sold").sold, true, "an unrelated stock insertion must not release a historical sold flag");
  const newLegacy = await stockWrite(s, [newFish("new-legacy", { basePrice: 999, priceMode: "legacy" })]); assert.equal(newLegacy.response.status, 400);
  const oldSnapshot = byId(before, "follower");
  const stale = await stockWrite(s, [{ ...oldSnapshot, notes: "旧库存编辑页" }], { follower: oldSnapshot });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  ok(await s.upsert(300, 200)); assertPricing(await s.state(), "new-follow", 300, "product"); assertPricing(await s.state(), "new-manual", 200, "manual");
  const hidden = await stockWrite(s, [newFish("new-hidden", { siteId: "jiangyin", subTankId: "tank-j", batchId: "batch-j" })], {}, "editor");
  assert.ok([400, 403].includes(hidden.response.status), JSON.stringify(hidden.body));
  assert.equal(byId(await s.state(), "new-hidden"), undefined);
});

test("generic order item removal is rejected so release and repricing must use the dedicated order transaction", async (t) => {
  const fixture = structuredClone(stockPricingFixture);
  const rawOrder = fixture.state.orders.find((order) => order.id === "ORDER-RELEASE");
  Object.assign(rawOrder, { status: "pending", source: "平台下单", platformOrderNo: "PRICING-QA123", douyinOrderNo: "PRICING-QA123",
    paymentChannel: "douyin", paymentAccount: "test-platform-account", shippingAddress: "测试地址", plannedShipDate: "2026-09-15",
    contactPersonnelId: "pricing-admin", contactPerson: "价格测试admin" });
  const s = await setup(t, fixture);
  const normalized = await s.request("/api/orders/update", { token: s.tokens.admin, body: { ...rawOrder, orderId: rawOrder.id } }); ok(normalized);
  const order = normalized.body.order; ok(await s.upsert(200));
  const result = await s.request("/api/state/patch", { token: s.tokens.admin, body: {
    patch: { orders: [{ ...order, items: order.items.slice(1) }] }, basePatch: { orders: [order] },
  } });
  const state = await s.readPersistedState();
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.deepEqual(state.orders.find((entry) => entry.id === order.id).items, order.items);
  assertPricing(state, "release-follower", 100, "product");
});

test("mode-only stock changes appear in approval details and preserve manual intent after approval", async (t) => {
  const s = await setup(t); const before = byId(await s.state(), "follower");
  const submitted = await stockWrite(s, [{ ...before, priceMode: "manual", priceOverridden: true }], { follower: before }, "editor"); ok(submitted);
  assert.equal(submitted.body.pendingApproval, true);
  let state = await s.readPersistedState(); const pending = state.approvalRequests.find((request) => request.id === submitted.body.approvalRequestId);
  assert.equal(pending.payload.upsert[0].priceMode, "manual");
  assert.equal(pending.stockDetails.items[0].before.priceMode, "product");
  assert.equal(pending.stockDetails.items[0].after.priceMode, "manual");
  assert.ok(pending.stockDetails.items[0].changedFields.includes("priceMode"));
  assertPricing(state, "follower", 100, "product");
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: pending.id, decision: "approve" } }); ok(approved);
  state = await s.state(); assertPricing(state, "follower", 100, "manual");
  ok(await s.upsert(200)); assertPricing(await s.state(), "follower", 100, "manual");
});

test("a product price change while follow-priced new stock awaits approval rejects approval without creating stock or changing pending state", async (t) => {
  const fixture = structuredClone(stockPricingFixture); fixture.state.batches[0].createdAt = "2026-09-01T00:00:00+08:00";
  const s = await setup(t, fixture);
  const submitted = await stockWrite(s, [newFish("approval-follow")], {}, "editor"); ok(submitted);
  assert.equal(submitted.body.pendingApproval, true);
  const requestId = submitted.body.approvalRequestId;
  ok(await s.upsert(200)); const before = await s.readPersistedState();
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId, decision: "approve" } });
  assert.equal(approved.response.status, 409, JSON.stringify(approved.body));
  assert.equal(approved.body.code, "STOCK_APPROVAL_PRICING_STALE");
  const state = await s.readPersistedState(); assert.equal(byId(state, "approval-follow"), undefined);
  assert.deepEqual(state.approvalRequests, before.approvalRequests); assert.deepEqual(state.stock, before.stock);
});

test("restoring lost follow inventory reviews the exact new product price that will be committed", async (t) => {
  const s = await setup(t); ok(await s.upsert(200));
  const before = byId(await s.state(), "lost"); assert.equal(before.basePrice, 100);
  const submitted = await stockWrite(s, [{ ...before, lost: false }], { lost: before }, "editor"); ok(submitted);
  assert.equal(submitted.body.pendingApproval, true);
  const pending = (await s.readPersistedState()).approvalRequests.find((request) => request.id === submitted.body.approvalRequestId);
  assert.equal(pending.payload.upsert[0].basePrice, 200, "review payload must reflect release reconciliation, not pre-release normalization");
  assert.equal(pending.payload.upsert[0].priceMode, "product");
  assert.equal(pending.stockDetails.items[0].after.basePrice, 200);
  assert.equal(pending.stockDetails.items[0].after.priceMode, "product");
  assertPricing(await s.state(), "lost", 100, "product"); assert.equal(byId(await s.state(), "lost").lost, true);
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: pending.id, decision: "approve" } }); ok(approved);
  const actual = byId(await s.readPersistedState(), "lost");
  assert.equal(actual.lost, false); assert.equal(actual.basePrice, pending.stockDetails.items[0].after.basePrice); assert.equal(actual.priceMode, pending.stockDetails.items[0].after.priceMode);
});

test("restoring lost inventory cannot commit a changed follow price after its approval snapshot was submitted", async (t) => {
  const s = await setup(t); const before = byId(await s.state(), "lost");
  const submitted = await stockWrite(s, [{ ...before, lost: false }], { lost: before }, "editor"); ok(submitted);
  assert.equal(submitted.body.pendingApproval, true);
  ok(await s.upsert(200)); const beforeApproval = await s.readPersistedState();
  const pending = beforeApproval.approvalRequests.find((request) => request.id === submitted.body.approvalRequestId);
  assert.equal(pending.stockDetails.items[0].after.basePrice, 100);
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: pending.id, decision: "approve" } });
  assert.equal(approved.response.status, 409, JSON.stringify(approved.body)); assert.equal(approved.body.code, "STOCK_APPROVAL_PRICING_STALE");
  const afterApproval = await s.readPersistedState();
  assert.deepEqual(afterApproval.stock, beforeApproval.stock); assert.deepEqual(afterApproval.approvalRequests, beforeApproval.approvalRequests);
  assert.equal(byId(afterApproval, "lost").lost, true); assertPricing(afterApproval, "lost", 100, "product");
});

test("clearing a lost flag cannot bypass independent active-order or shipment pricing protection", async (t) => {
  const fixture = structuredClone(stockPricingFixture);
  for (const id of ["ordered-confirmed", "shipment-outbound", "shipment-shipped"]) fixture.state.stock.find((item) => item.id === id).lost = true;
  const s = await setup(t, fixture); ok(await s.upsert(200)); const before = await s.readPersistedState();
  for (const id of ["ordered-confirmed", "shipment-outbound", "shipment-shipped"]) {
    const item = byId(before, id);
    for (const changes of [{ basePrice: 200 }, { priceMode: "manual", priceOverridden: true }]) {
      const result = await stockWrite(s, [{ ...item, ...changes, lost: false }], { [id]: item }, "editor");
      assert.equal(result.response.status, 409, `${id}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, "STOCK_PRICING_PROTECTED");
    }
  }
  const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.approvalRequests, before.approvalRequests);
});

test("restoring lost manual and legacy inventory retains reviewed prices instead of following the new product default", async (t) => {
  const fixture = structuredClone(stockPricingFixture);
  const ids = ["manual-different", "legacy-different"];
  for (const id of ids) fixture.state.stock.find((item) => item.id === id).lost = true;
  const s = await setup(t, fixture); ok(await s.upsert(200)); const before = await s.readPersistedState();
  const originals = ids.map((id) => byId(before, id));
  const submitted = await stockWrite(s, originals.map((item) => ({ ...item, lost: false })), Object.fromEntries(originals.map((item) => [item.id, item])), "editor"); ok(submitted);
  const pending = (await s.readPersistedState()).approvalRequests.find((request) => request.id === submitted.body.approvalRequestId);
  assert.equal(pending.stockDetails.items.find((item) => item.stockItemId === "manual-different").after.basePrice, 150);
  assert.equal(pending.stockDetails.items.find((item) => item.stockItemId === "legacy-different").after.basePrice, 140);
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: pending.id, decision: "approve" } }); ok(approved);
  const state = await s.readPersistedState();
  assertPricing(state, "manual-different", 150, "manual"); assertPricing(state, "legacy-different", 140, "legacy");
  for (const id of ids) assert.equal(byId(state, id).lost, false);
});

test("manual equal-price adjustment drafts survive save/load and remain manual after the product default changes", async (t) => {
  const s = await setup(t);
  const draft = { siteId: "nanjing", removeStockIds: [], additions: [{ id: "draft-manual", subTankId: "tank-n", productId: "price-product", batchId: "batch-n", quantity: 1, status: "healthy", inDate: "2026-09-01", basePrice: 100, priceMode: "manual", priceOverridden: true, notes: "同价单独定价" }] };
  const saved = await s.request("/api/stock/adjustment-draft", { token: s.tokens.editor, body: { draft } }); ok(saved);
  assert.equal(saved.body.draft.additions[0].priceMode, "manual"); assert.equal(saved.body.draft.additions[0].priceOverridden, true);
  ok(await s.upsert(200));
  const loaded = await s.request("/api/stock/adjustment-draft", { token: s.tokens.editor }); ok(loaded);
  assert.equal(loaded.body.draft.additions[0].priceMode, "manual"); assert.equal(loaded.body.draft.additions[0].basePrice, 100);
  const adminDraft = await s.request("/api/stock/adjustment-draft", { token: s.tokens.admin }); ok(adminDraft); assert.equal(adminDraft.body.draft, null);
});

test("cross-site maintenance movement preserves all three price modes and future product sync respects them", async (t) => {
  const s = await setup(t); ok(await s.upsert(200));
  const before = await s.state(); const itemIds = ["follower", "manual-different", "legacy-different"];
  const result = await s.request("/api/maintenance/save", { token: s.tokens.admin, body: {
    mode: "move", clientMutationId: "pricing-cross-site-move", itemIds,
    expectedItems: itemIds.map((id) => { const item = byId(before, id); return { id, subTankId: item.subTankId, status: item.status, lost: item.lost }; }),
    targetSubTankId: "tank-j", moveDate: "2026-09-10", moveNotes: "价格来源回归测试",
  } }); ok(result);
  let state = await s.state();
  for (const id of itemIds) { assert.equal(byId(state, id).siteId, "jiangyin"); assert.equal(byId(state, id).batchId, "batch-n"); }
  assertPricing(state, "follower", 200, "product"); assertPricing(state, "manual-different", 150, "manual"); assertPricing(state, "legacy-different", 140, "legacy");
  ok(await s.upsert(300, 200)); state = await s.state();
  assertPricing(state, "follower", 300, "product"); assertPricing(state, "manual-different", 150, "manual"); assertPricing(state, "legacy-different", 140, "legacy");
});
