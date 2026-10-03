import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { lossPricingSnapshot } from "./stock-loss-price.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const byId = (state, id = "lost") => state.stock.find((item) => item.id === id);
const initialSnapshot = { basePrice: 100, priceMode: "product", priceOverridden: false };
function fixture() {
  const value = structuredClone(stockPricingFixture);
  byId(value.state).lossDate = "2026-09-02";
  value.state.lossRecords = [{ id: "loss-record", stockItemId: "lost", date: "2026-09-02", siteId: "jiangyin", tankName: "历史江阴缸" }];
  value.state.orders.push({ ...value.state.orders[0], id: "HISTORICAL-LOST-ORDER", orderNo: "HISTORICAL-LOST-ORDER", status: "completed",
    items: [{ stockItemId: "lost", productId: "price-product", price: 777 }],
    payments: [{ id: "historical-receipt", type: "balance", amount: 777, verificationStatus: "verified", time: "2026-09-01" }] });
  // The endpoint must not reconcile or rewrite even an opaque existing ledger.
  value.state.commissionLedgerV1 = { version: 1, entries: [{ id: "immutable-audit-entry", personalCents: 345 }], targets: {} };
  return value;
}
async function setup(t, data = fixture()) {
  const server = await startMutableRouteServer(data);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const staff = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const update = (body = {}, token = admin) => server.request("/api/stock/loss-price", { token,
    body: { stockItemId: "lost", basePrice: 250.55, expectedPricing: initialSnapshot, ...body } });
  const summary = () => server.request("/api/dashboard-summary?startDate=2026-09-02&endDate=2026-09-02&siteId=all", { token: admin });
  return { ...server, admin, staff, update, summary };
}

test("admin corrects only lost stock pricing and summary totals, preserving loss site, orders, payments and ledger", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  const summary = await s.summary(); ok(summary);
  const detail = summary.body.summary.dailyLossData[0].lossDetails[0];
  assert.deepEqual(detail.pricingSnapshot, initialSnapshot);
  assert.equal(detail.canEditPrice, true);
  assert.equal(detail.siteId, "jiangyin");
  const result = await s.update({ siteId: "nanjing", lost: false, orders: [], commissionLedgerV1: {} }); ok(result);
  assert.deepEqual(result.body.stockPricingUpdate, { id: "lost", basePrice: 250.55, priceMode: "manual", priceOverridden: true });
  assert.deepEqual(Object.keys(result.body).sort(), ["ok", "operationLog", "stockPricingUpdate"]);
  assert.match(JSON.stringify(result.body.operationLog), /100.*250\.55/);
  const after = await s.readPersistedState();
  const expected = structuredClone(before);
  Object.assign(byId(expected), result.body.stockPricingUpdate);
  expected.operationLogs = after.operationLogs;
  assert.deepEqual(after, expected);
  assert.equal(after.operationLogs.length - before.operationLogs.length, 1);
  const updatedSummary = await s.summary(); ok(updatedSummary);
  const point = updatedSummary.body.summary.dailyLossData[0];
  assert.equal(point.estimatedValue, 250.55);
  assert.equal(point.lossDetails[0].estimatedValue, 250.55);
  assert.equal(point.lossDetails[0].siteId, "jiangyin");
  assert.equal(point.lossDetails[0].tankName, "历史江阴缸");
  assert.deepEqual(point.lossDetails[0].pricingSnapshot, lossPricingSnapshot(byId(after)));
});

test("anonymous and all staff writes are denied without leaking current pricing or changing state", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  for (const [token, status] of [[undefined, 401], [s.staff, 403]]) {
    const result = await s.update({}, token ?? "");
    assert.equal(result.response.status, status, JSON.stringify(result.body));
    assert.equal(result.body.stockPricingUpdate, undefined);
    assert.equal(result.response.headers.get("cache-control"), "no-store, private");
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test("invalid amounts and non-lost inventory never create an audit entry or any mutation", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const basePrice of [null, true, false, [], {}, "", " ", 0, -1, "NaN", "Infinity", 0.001, "1.234", "1e2"]) {
    const result = await s.update({ basePrice });
    assert.equal(result.response.status, 400, `${String(basePrice)} ${JSON.stringify(result.body)}`);
  }
  for (const stockItemId of ["follower", "sold", "ordered-confirmed"]) {
    const result = await s.update({ stockItemId });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "LOSS_STOCK_NOT_LOST");
  }
  assert.equal((await s.update({ stockItemId: "missing" })).response.status, 404);
  assert.deepEqual(await s.readPersistedState(), before);
});

test("raw pricing CAS prevents stale price, mode and override writes; concurrent editors produce one correction", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  for (const expectedPricing of [null, {}, { basePrice: 100, priceMode: "product" },
    { ...initialSnapshot, basePrice: "100" }, { ...initialSnapshot, priceMode: "manual" }, { ...initialSnapshot, priceOverridden: true }]) {
    const result = await s.update({ expectedPricing });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.deepEqual(result.body.currentPricingSnapshot, initialSnapshot);
  }
  assert.deepEqual(await s.readPersistedState(), before);
  const results = await Promise.all([s.update({ basePrice: 200 }), s.update({ basePrice: 300 })]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const after = await s.readPersistedState();
  assert.equal(after.operationLogs.length - before.operationLogs.length, 1);
  const current = byId(after);
  const retry = await s.update({ basePrice: current.basePrice, expectedPricing: lossPricingSnapshot(current) }); ok(retry);
  assert.equal(retry.body.unchanged, true);
  assert.deepEqual(await s.readPersistedState(), after);
});

test("legacy null snapshots work, historical non-lost loss rows remain read-only, duplicate IDs cannot be corrected", async (t) => {
  const f = fixture();
  delete byId(f.state).basePrice; delete byId(f.state).priceMode; delete byId(f.state).priceOverridden;
  f.state.lossRecords.push({ id: "historical-row", stockItemId: "follower", date: "2026-09-02", siteId: "nanjing" });
  const s = await setup(t, f);
  const summary = await s.summary(); ok(summary);
  const details = summary.body.summary.dailyLossData[0].lossDetails;
  assert.deepEqual(details.find((item) => item.stockItemId === "lost").pricingSnapshot, { basePrice: null, priceMode: null, priceOverridden: null });
  assert.equal(details.find((item) => item.stockItemId === "follower").canEditPrice, false);
  ok(await s.update({ expectedPricing: { basePrice: null, priceMode: null, priceOverridden: null } }));
  const duplicate = fixture(); duplicate.state.stock.push(structuredClone(byId(duplicate.state)));
  const d = await setup(t, duplicate); const before = await d.readPersistedState();
  assert.equal((await d.update()).body.code, "LOSS_STOCK_AMBIGUOUS");
  assert.deepEqual(await d.readPersistedState(), before);
});

test("generic maintenance/stock writes stay protected and product price sync preserves corrected loss value", async (t) => {
  const s = await setup(t); ok(await s.update());
  const before = await s.readPersistedState();
  const item = byId(before);
  const maintenance = await s.request("/api/bio-records/save", { token: s.admin, body: {
    action: "saveDetails", stockItemId: item.id, details: { basePrice: 999, priceMode: "manual" },
    expectedDetails: { basePrice: item.basePrice, priceMode: item.priceMode },
  } });
  assert.equal(maintenance.response.status, 409, JSON.stringify(maintenance.body));
  const stock = await s.request("/api/stock/save", { token: s.admin, body: {
    upsert: [{ ...item, basePrice: 999 }], deleteIds: [], expectedOperations: { [item.id]: "update" }, expectedBefore: { [item.id]: item },
  } });
  assert.equal(stock.response.status, 409, JSON.stringify(stock.body));
  const generic = await s.request("/api/state/patch", { token: s.admin, body: {
    patch: { stock: [{ ...item, basePrice: 999 }] }, basePatch: { stock: [item] },
  } });
  assert.equal(generic.response.status, 400, JSON.stringify(generic.body));
  assert.deepEqual(await s.readPersistedState(), before);
  const product = before.products[0];
  ok(await s.request("/api/products/upsert", { token: s.admin, body: { product: { ...product, defaultPrice: 400 }, expectedDefaultPrice: product.defaultPrice } }));
  const after = await s.readPersistedState();
  assert.deepEqual(byId(after), item);
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.commissionLedgerV1, before.commissionLedgerV1);
});

test("a request authenticated before administrator deactivation is rechecked under the transaction lock", async (t) => {
  const f = fixture();
  const admin = f.state.personnel[0];
  f.state.personnel.push({ ...admin, id: "other-admin", username: "other-admin", name: "另一个管理员" });
  const s = await setup(t, f);
  const other = await s.login("other-admin", PRICING_TEST_PASSWORD);
  const body = JSON.stringify({ stockItemId: "lost", basePrice: 300, expectedPricing: initialSnapshot });
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = httpRequest(`${s.baseUrl}/api/stock/loss-price`, { method: "POST", headers: {
      Authorization: `Bearer ${s.admin}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    pending.on("error", reject); pending.write(body.slice(0, 1));
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const resigned = await s.request("/api/personnel/resign", { token: other, body: { id: admin.id } }); ok(resigned);
  const before = await s.readPersistedState();
  pending.end(body.slice(1));
  const result = await response;
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, "ORDER_ACCOUNT_CHANGED");
  assert.deepEqual(await s.readPersistedState(), before);
});
