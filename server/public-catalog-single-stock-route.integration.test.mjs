import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { normalizePublicCatalogPolicy } from "./public-catalog-policy.mjs";
import { buildStockMutationExpectation } from "./stock-mutation-relationships.mjs";

function fixture() {
  const value = structuredClone(stockPricingFixture);
  Object.assign(value.state, {
    _publicCatalogPolicySchemaVersion: 1,
    publicCatalogPolicy: normalizePublicCatalogPolicy({ productDisplayCaps: { "price-product": 1 } }),
    orders: [], shipments: [],
    stock: [
      { ...value.state.stock[0], id: "fish-189", code: "189", notes: "PRIVATE_FISH_NOTE", purchasePrice: 99 },
      { ...value.state.stock[1], id: "fish-190", code: "190" },
      { ...value.state.stock[2], id: "fish-191", code: "191" },
      { ...value.state.stock[0], id: "lost-fish", code: "999", lost: true },
    ],
    bioRecords: [
      { id: "record-189", stockItemId: "fish-189", date: "2026-10-29T09:00:00+08:00", photos: ["/uploads/fish-189.jpg"] },
      { id: "record-190", stockItemId: "fish-190", date: "2026-10-28T09:00:00+08:00", videos: ["/uploads/fish-190.mp4"] },
    ],
  });
  return value;
}
async function setup(t, data = fixture()) {
  const server = await startMutableRouteServer(data);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const staff = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const save = async (hiddenStockIds, token = admin, base) => {
    const state = await server.readPersistedState();
    const current = normalizePublicCatalogPolicy(state.publicCatalogPolicy);
    return server.request("/api/state/patch", { token, body: {
      patch: { publicCatalogPolicy: { ...current, hiddenStockIds } },
      basePatch: { publicCatalogPolicy: base ?? current },
    } });
  };
  const picker = (body = {}, token = admin) => server.request("/api/public-catalog/stock-options", { token, body });
  return { ...server, admin, staff, save, picker };
}
const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));

test("saving one hidden fish refills the public cap, removes its media/deep link and preserves siblings", async (t) => {
  const s = await setup(t);
  const catalog = () => s.request("/api/public/catalog?siteId=all");
  const initial = await catalog(); ok(initial);
  assert.deepEqual(initial.body.catalog.stock.map((item) => item.id), ["fish-189"]);
  const before = await s.readPersistedState();
  const saved = await s.save(["fish-189"]); ok(saved);
  const after = await catalog(); ok(after);
  assert.deepEqual(after.body.catalog.stock.map((item) => item.id), ["fish-190"]);
  assert.equal(after.body.catalog.bioRecords.some((record) => record.stockItemId === "fish-189"), false);
  assert.doesNotMatch(JSON.stringify(after.body), /hiddenStockIds|fish-189/);
  for (const siteId of ["all", "nanjing", "jiangyin"]) {
    const hidden = await s.request(`/api/public/bio-records?stockItemId=fish-189&siteId=${siteId}`);
    assert.equal(hidden.response.status, 404, JSON.stringify(hidden.body));
  }
  const directSibling = await s.request("/api/public/bio-records?stockItemId=fish-190&siteId=all"); ok(directSibling);
  const persisted = await s.readPersistedState();
  assert.deepEqual(persisted.stock, before.stock, "hiding is not a stock/sale/health mutation");
  assert.deepEqual(persisted.orders, before.orders);
  assert.match(saved.body.appliedOperationLogs[0].detail, /隐藏鱼只.*189/);
  ok(await s.save([]));
  assert.deepEqual((await catalog()).body.catalog.stock.map((item) => item.id), ["fish-189"]);
});

test("single-fish generic policy writes enforce administrator, exact IDs and optimistic concurrency", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const ids of [["missing"], ["fish-189", "fish-189"], [1]]) {
    assert.equal((await s.save(ids)).response.status, 400);
  }
  assert.equal((await s.save(["fish-189"], s.staff)).response.status, 400);
  assert.equal((await s.save(["fish-189"], "")).response.status, 401);
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.save(["fish-189"]));
  const conflict = await s.save(["fish-190"], s.admin, before.publicCatalogPolicy);
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.body.error, /已被其他管理员修改/);
  assert.deepEqual((await s.readPersistedState()).publicCatalogPolicy.hiddenStockIds, ["fish-189"]);
});

test("stock picker is authenticated admin-only, private, bounded and contains no media/cost/business details", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const [token, status] of [["", 401], [s.staff, 403]]) {
    const denied = await s.picker({}, token);
    assert.equal(denied.response.status, status);
    assert.equal(denied.response.headers.get("cache-control"), "no-store, private");
  }
  const page = await s.picker({ pageSize: 2 }); ok(page);
  assert.equal(page.body.items.length, 2); assert.equal(page.body.total, 3);
  assert.deepEqual(Object.keys(page.body.items[0]).sort(), ["id", "code", "productId", "productName", "speciesName", "siteId", "siteName", "tankName", "status", "sold", "inTransit", "lost", "outStock", "hidden"].sort());
  assert.doesNotMatch(JSON.stringify(page.body), /PRIVATE_FISH_NOTE|purchasePrice|basePrice|bioRecords|\/uploads\//);
  for (const body of [{ pageSize: 51 }, { page: 0 }, { search: "x".repeat(121) }, { siteId: "unknown" }, { hiddenStockIds: ["fish-189", "fish-189"] }]) {
    assert.equal((await s.picker(body)).response.status, 400);
  }
  assert.deepEqual(await s.readPersistedState(), before, "picker is read-only");
});

test("draft-aware hidden list supports exact IDs, cross-site search, restoration and departed fish without writes", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  const draft = await s.picker({ hiddenStockIds: ["fish-191", "lost-fish"], filter: "hidden", pageSize: 1, page: 2 }); ok(draft);
  assert.equal(draft.body.total, 2); assert.equal(draft.body.items[0].id, "lost-fish"); assert.equal(draft.body.items[0].lost, true);
  const search = await s.picker({ search: "191", siteId: "jiangyin", hiddenStockIds: ["fish-191"] }); ok(search);
  assert.deepEqual(search.body.items.map((item) => item.id), ["fish-191"]);
  assert.equal(search.body.items[0].hidden, true);
  const restored = await s.picker({ hiddenStockIds: [], filter: "hidden" }); ok(restored);
  assert.equal(restored.body.total, 0);
  assert.deepEqual(await s.readPersistedState(), before);
});

test("revoked administrator access cannot use stale authentication cache to read picker or save visibility", async (t) => {
  const s = await setup(t);
  ok(await s.picker());
  await s.patchTestPersonnel("pricing-admin", { accessRole: "staff" });
  assert.ok([401, 403].includes((await s.picker()).response.status));
  const denied = await s.save(["fish-189"]);
  assert.ok([400, 401, 403].includes(denied.response.status), JSON.stringify(denied.body));
  assert.deepEqual((await s.readPersistedState()).publicCatalogPolicy.hiddenStockIds, []);
});

test("hard deletion removes only the deleted fish rule atomically, while pending/rejected deletion preserves it", async (t) => {
  const s = await setup(t);
  ok(await s.save(["fish-189", "fish-190"]));
  const deleteStock = async (id, token) => {
    const state = await s.readPersistedState();
    const change = { upsert: [], deleteIds: [id] };
    return s.request("/api/stock/save", { token, body: { ...change, ...buildStockMutationExpectation(state, change) } });
  };
  const pending = await deleteStock("fish-189", s.staff); ok(pending);
  assert.equal(pending.body.pendingApproval, true);
  assert.deepEqual((await s.readPersistedState()).publicCatalogPolicy.hiddenStockIds, ["fish-189", "fish-190"]);
  const reject = await s.request("/api/approvals/stock", { token: s.admin, body: { requestId: pending.body.approvalRequestId, decision: "reject", note: "保留" } }); ok(reject);
  assert.deepEqual((await s.readPersistedState()).publicCatalogPolicy.hiddenStockIds, ["fish-189", "fish-190"]);
  ok(await deleteStock("fish-189", s.admin));
  let state = await s.readPersistedState();
  assert.equal(state.stock.some((item) => item.id === "fish-189"), false);
  assert.deepEqual(state.publicCatalogPolicy.hiddenStockIds, ["fish-190"]);
  ok(await s.save(["fish-190"]));
  const second = await deleteStock("fish-190", s.staff); ok(second);
  ok(await s.request("/api/approvals/stock", { token: s.admin, body: { requestId: second.body.approvalRequestId, decision: "approve" } }));
  state = await s.readPersistedState();
  assert.equal(state.stock.some((item) => item.id === "fish-190"), false);
  assert.deepEqual(state.publicCatalogPolicy.hiddenStockIds, []);
  const picker = await s.picker({ filter: "hidden" }); ok(picker); assert.equal(picker.body.total, 0);
});
