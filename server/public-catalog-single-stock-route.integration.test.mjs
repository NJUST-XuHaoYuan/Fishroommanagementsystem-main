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

test("stock picker is authenticated admin-only, private, bounded and contains no record/cost/business details", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const [token, status] of [["", 401], [s.staff, 403]]) {
    const denied = await s.picker({}, token);
    assert.equal(denied.response.status, status);
    assert.equal(denied.response.headers.get("cache-control"), "no-store, private");
  }
  const page = await s.picker({ pageSize: 2 }); ok(page);
  assert.equal(page.body.items.length, 2); assert.equal(page.body.total, 3);
  assert.deepEqual(Object.keys(page.body.items[0]).sort(), ["id", "code", "productId", "productName", "speciesName", "siteId", "siteName", "tankName", "status", "sold", "inTransit", "lost", "outStock", "hidden", "tankGroupId", "tankGroupName", "subTankId", "subTankName", "productSize", "productOrigin", "imageUrl"].sort());
  assert.doesNotMatch(JSON.stringify(page.body), /PRIVATE_FISH_NOTE|purchasePrice|basePrice|bioRecords|photos|videos|customerName|payments/);
  for (const body of [{ pageSize: 51 }, { page: 0 }, { search: "x".repeat(121) }, { siteId: "unknown" }, { subTankId: "unknown" }, { hiddenStockIds: ["fish-189", "fish-189"] }]) {
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

test("tank picker counts ignore the chosen tank, while stable pages keep same-species products and same-name cross-site tanks separate", async (t) => {
  const data = fixture();
  data.state.tankGroups[0].name = "同名大缸";
  data.state.tankGroups[1].name = "同名大缸";
  data.state.tankGroups[0].subTanks[0].name = "同名子缸";
  data.state.tankGroups[1].subTanks[0].name = "同名子缸";
  data.state.stock.push({ ...data.state.stock[0], id: "other-same-species", productId: "other-product", code: "200" });
  data.state.stock.reverse(); // Database array order must not dictate grouping/paging.
  const s = await setup(t, data);
  const all = await s.picker({ pageSize: 50 }); ok(all);
  assert.deepEqual(all.body.items.map((item) => item.id), ["fish-191", "other-same-species", "fish-189", "fish-190"]);
  assert.deepEqual(all.body.tanks.map((tank) => [tank.siteId, tank.subTankId, tank.count]), [["jiangyin", "tank-j", 1], ["nanjing", "tank-n", 3]]);
  const pagedIds = [];
  for (let page = 1; page <= 2; page++) {
    const result = await s.picker({ pageSize: 2, page }); ok(result);
    pagedIds.push(...result.body.items.map((item) => item.id));
  }
  assert.deepEqual(pagedIds, all.body.items.map((item) => item.id));
  const tank = await s.picker({ subTankId: "tank-n" }); ok(tank);
  assert.equal(tank.body.total, 3);
  assert.deepEqual(tank.body.tanks, all.body.tanks, "tank filter must not erase other tank counters");
  assert.deepEqual(new Set(tank.body.items.map((item) => item.productId)), new Set(["price-product", "other-product"]));
  assert.ok(tank.body.items.every((item) => item.productSize && item.productOrigin && item.tankGroupId === "group-n"));
  const scoped = await s.picker({ siteId: "nanjing", search: "8cm" }); ok(scoped);
  assert.deepEqual(scoped.body.items.map((item) => item.id), ["other-same-species"]);
  assert.deepEqual(scoped.body.tanks.map((item) => item.count), [1]);
  const hidden = await s.picker({ filter: "hidden", hiddenStockIds: ["fish-190", "fish-191"], subTankId: "tank-n" }); ok(hidden);
  assert.deepEqual(hidden.body.items.map((item) => item.id), ["fish-190"]);
  assert.deepEqual(hidden.body.tanks.map((item) => item.count), [1, 1]);
});

test("in-transfer and missing historical tanks remain explicit selectable groups, and filtering never drops existing hidden rules", async (t) => {
  const data = fixture();
  Object.assign(data.state.stock[0], { subTankId: "", tankTransfer: {
    id: "transfer-189", status: "in_transit", fromSiteId: "nanjing", fromTankName: "旧缸 / N1",
  } });
  Object.assign(data.state.stock[3], { subTankId: "deleted-tank" });
  data.state.publicCatalogPolicy.hiddenStockIds = ["lost-fish", "fish-191"];
  const s = await setup(t, data); const before = await s.readPersistedState();
  const transit = await s.picker({ subTankId: "__in_transit__" }); ok(transit);
  assert.deepEqual(transit.body.items.map((item) => item.id), ["fish-189"]);
  assert.equal(transit.body.items[0].tankGroupName, "移缸在途");
  assert.match(transit.body.items[0].tankName, /旧缸/);
  const historical = await s.picker({ filter: "hidden", subTankId: "__unassigned__" }); ok(historical);
  assert.deepEqual(historical.body.items.map((item) => item.id), ["lost-fish"]);
  assert.equal(historical.body.items[0].subTankName, "未分配/原缸位已删除");
  assert.equal(historical.body.items[0].hidden, true);
  await s.picker({ siteId: "nanjing", subTankId: "tank-n", hiddenStockIds: ["lost-fish", "fish-191", "fish-190"] });
  assert.deepEqual(await s.readPersistedState(), before, "draft filtering never mutates any persisted rule or inventory");
  const restored = await s.picker({ filter: "hidden", hiddenStockIds: ["fish-191"], subTankId: "__unassigned__" }); ok(restored);
  assert.equal(restored.body.total, 0);
});

test("picker previews prefer latest real fish photo, then video poster, then product image, with safe bounded public output", async (t) => {
  const data = fixture();
  data.state.products[0].imageUrl = "/uploads/default-fish.jpg";
  data.state.products[1].imageUrl = "/uploads/.personnel-private/SECRET-PRODUCT.jpg";
  data.state.stock.push({ ...data.state.stock[0], id: "no-media-default", code: "192" });
  data.state.stock.push({ ...data.state.stock[0], id: "no-media-no-default", code: "193", productId: "other-product" });
  data.state.bioRecords.push(
    { id: "older-photo", stockItemId: "fish-189", date: "2026-10-28T09:00:00+08:00", photos: ["/uploads/old.jpg"], text: "PRIVATE_RECORD_BODY" },
    { id: "latest-photo", stockItemId: "fish-189", date: "2026-11-01T09:00:00+08:00", photos: ["/uploads/latest-first.jpg", "/uploads/latest-last.jpg"], text: "PRIVATE_RECORD_BODY" },
    { id: "newest-video", stockItemId: "fish-189", date: "2026-11-02T09:00:00+08:00", videos: ["/uploads/newest.mp4"] },
    { id: "private-photo", stockItemId: "fish-191", date: "2026-11-02T09:00:00+08:00", photos: ["/uploads/.personnel-private/SECRET-ATTACHMENT.jpg"], videos: ["/uploads/.personnel-private/SECRET-VIDEO.mp4"] },
    { id: "script-photo", stockItemId: "no-media-no-default", date: "2026-11-02T09:00:00+08:00", photos: ["javascript:alert(1)", "/uploads/unsafe.svg", "/api/personnel/SECRET.jpg"] },
    { id: "off-page-secret", stockItemId: "lost-fish", date: "2026-11-02T09:00:00+08:00", photos: ["/uploads/OFF-PAGE-URL.jpg"], text: "PRIVATE_RECORD_BODY" },
  );
  const s = await setup(t, data); const before = await s.readPersistedState();
  const response = await s.picker({ pageSize: 50 }); ok(response);
  const byId = new Map(response.body.items.map((item) => [item.id, item]));
  assert.equal(byId.get("fish-189").imageUrl, "/uploads/latest-last.jpg");
  const poster = new URL(byId.get("fish-190").imageUrl, "http://localhost");
  assert.equal(poster.pathname, "/api/public/media/video-derivative");
  assert.equal(poster.searchParams.get("kind"), "poster");
  assert.equal(poster.searchParams.get("url"), "/uploads/fish-190.mp4");
  assert.ok(poster.searchParams.get("signature"));
  assert.equal(byId.get("fish-191").imageUrl, "/uploads/default-fish.jpg");
  assert.equal(byId.get("no-media-default").imageUrl, "/uploads/default-fish.jpg");
  assert.equal(byId.get("no-media-no-default").imageUrl, "");
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET|PRIVATE_RECORD_BODY|OFF-PAGE-URL|newest\.mp4|photos|videos|operator|text|videoPreviews|videoPlaybacks/);
  const page = await s.picker({ search: "189", pageSize: 1 }); ok(page);
  assert.doesNotMatch(JSON.stringify(page.body), /fish-190\.mp4|default-fish\.jpg/);
  assert.deepEqual(await s.readPersistedState(), before);
});

test("picker limits a large tank to fifty cards per page without losing its total or leaking off-page media", async (t) => {
  const data = fixture();
  const template = data.state.stock[0];
  data.state.stock = Array.from({ length: 63 }, (_, index) => ({ ...template, id: `large-${index}`, code: String(index) }));
  data.state.bioRecords = data.state.stock.map((item) => ({
    id: `media-${item.id}`, stockItemId: item.id, date: "2026-11-01T09:00:00+08:00",
    photos: [`/uploads/${item.id}.jpg`], text: "PRIVATE-LARGE-RECORD",
  }));
  const s = await setup(t, data);
  const first = await s.picker({ pageSize: 50 }); ok(first);
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.total, 63);
  assert.equal(first.body.tanks[0].count, 63);
  assert.doesNotMatch(JSON.stringify(first.body), /large-50\.jpg|PRIVATE-LARGE-RECORD/);
  const second = await s.picker({ pageSize: 50, page: 2 }); ok(second);
  assert.equal(second.body.items.length, 13);
  assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.id)).size, 63);
  const clamped = await s.picker({ pageSize: 50, page: 100 }); ok(clamped);
  assert.equal(clamped.body.page, 2);
  assert.deepEqual(clamped.body.items, second.body.items);
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
