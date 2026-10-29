import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { buildStockMutationExpectation } from "./stock-mutation-relationships.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
async function setup(t, customize = () => {}) {
  const fixture = structuredClone(stockPricingFixture); customize(fixture);
  const server = await startMutableRouteServer(fixture); t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const history = (id, role = "admin", suffix = "") => server.request(`/api/stock/status-history?stockItemId=${encodeURIComponent(id)}${suffix}`, { token: tokens[role] });
  const details = (stockItemId, status, previousStatus = "healthy", role = "editor", extra = {}) => server.request("/api/bio-records/save", {
    token: tokens[role], body: { action: "saveDetails", stockItemId, details: { status }, expectedDetails: { status: previousStatus }, ...extra },
  });
  const batch = (items, targetStatus, clientMutationId = "status-test", role = "editor") => server.request("/api/maintenance/save", {
    token: tokens[role], body: { mode: "status", itemIds: items.map((item) => item.id), targetStatus, clientMutationId,
      expectedItems: items.map(({ id, subTankId, status, lost }) => ({ id, subTankId, status, lost: Boolean(lost) })), operator: "forged" },
  });
  const stockWrite = async (change, role = "admin") => {
    const state = await server.readPersistedState();
    return server.request("/api/stock/save", { token: tokens[role], body: { ...change, ...buildStockMutationExpectation(state, change) } });
  };
  return { ...server, tokens, history, details, batch, stockWrite };
}

test("single status save uses authenticated actor, persists audit separately and avoids no-op/retry duplicates", async (t) => {
  const s = await setup(t);
  const initial = await s.history("follower"); ok(initial); assert.equal(initial.body.total, 0);
  const before = await s.readPersistedState(); assert.equal(before.stockStatusHistory, undefined);
  ok(await s.details("follower", "feeding", "healthy", "editor", { operator: "forged", operatorName: "伪造", changedAt: "1900", stockStatusHistory: [{ id: "evil" }] }));
  let history = await s.history("follower", "editor"); ok(history);
  assert.equal(history.response.headers.get("cache-control"), "no-store, private");
  assert.equal(history.body.records.length, 1);
  const record = history.body.records[0];
  assert.equal(record.previousStatus, "healthy"); assert.equal(record.status, "feeding");
  assert.equal(record.operator, "pricing-editor"); assert.equal(record.operatorName, "价格测试editor");
  assert.equal(record.source, "bio_details"); assert.ok(Number.isFinite(Date.parse(record.changedAt)));
  assert.doesNotMatch(JSON.stringify(history.body), /forged|伪造|1900|evil/);
  ok(await s.details("follower", "feeding", "healthy"));
  ok(await s.details("follower", "feeding", "feeding"));
  history = await s.history("follower"); assert.equal(history.body.total, 1);
  for (const role of ["admin", "editor"]) {
    const general = await s.request("/api/state", { token: s.tokens[role] }); ok(general);
    assert.equal(general.body.data.stockStatusHistory, undefined);
    const slice = await s.request("/api/state/slice?keys=stockStatusHistory", { token: s.tokens[role] }); assert.equal(slice.response.status, 400);
  }
  const stored = await s.readPersistedState(); assert.equal(stored.stockStatusHistory.length, 1);
  assert.equal(stored.stockStatusHistory[0].operatorId, "pricing-editor");
});

test("batch changes create one audit per changed fish, idempotent replay creates none and stale concurrent mutations conflict", async (t) => {
  const s = await setup(t); const state = await s.readPersistedState();
  const items = state.stock.filter((item) => ["follower", "follower-stale"].includes(item.id));
  const results = await Promise.all([s.batch(items, "sick", "batch-a"), s.batch(items, "feeding", "batch-b")]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  const current = await s.readPersistedState(); assert.equal(current.stockStatusHistory.length, 2);
  const winnerStatus = current.stock.find((item) => item.id === "follower").status;
  const replay = await s.batch(items, winnerStatus, winnerStatus === "sick" ? "batch-a" : "batch-b"); ok(replay); assert.equal(replay.body.idempotent, true);
  assert.equal((await s.readPersistedState()).stockStatusHistory.length, 2);
  ok(await s.details("follower", "healthy", winnerStatus));
  const partlySame = (await s.readPersistedState()).stock.filter((item) => items.some((target) => target.id === item.id));
  ok(await s.batch(partlySame, winnerStatus, "batch-c"));
  const final = await s.readPersistedState(); assert.equal(final.stockStatusHistory.length, 4);
  assert.equal(final.stockStatusHistory.filter((r) => r.source === "batch_status").length, 3);
});

test("status audit is protected from unknown patch keys, unauthorized sites, absent permissions and revoked accounts", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const key of ["stockStatusHistory", "stock"]) {
    const result = await s.request("/api/state/patch", { token: s.tokens.admin, body: { patch: { [key]: [] }, basePatch: { [key]: [] } } });
    assert.equal(result.response.status, 400);
  }
  assert.equal((await s.history("follower", "anonymous")).response.status, 401);
  assert.equal((await s.history("follower", "viewer")).response.status, 403);
  assert.equal((await s.history("PRIVATE_JY_FOLLOWER", "editor")).response.status, 404);
  assert.equal((await s.details("PRIVATE_JY_FOLLOWER", "sick")).response.status, 404);
  assert.equal((await s.details("follower", "sick", "healthy", "viewer")).response.status, 403);
  for (const suffix of ["&limit=101", "&offset=-2", "&offset=bad"]) assert.equal((await s.history("follower", "admin", suffix)).response.status, 400);
  assert.deepEqual((await s.readPersistedState()).stock, before.stock);
  assert.equal((await s.readPersistedState()).stockStatusHistory, undefined);
  await s.patchTestPersonnel("pricing-editor", { permissions: { stockIn: { update: true } } });
  ok(await s.history("follower", "editor"));
  assert.equal((await s.details("follower", "sick")).response.status, 403);
  await s.patchTestPersonnel("pricing-editor", { accountEnabled: false });
  assert.equal((await s.history("follower", "editor")).response.status, 401);
});

test("stock creation/update and approved changes journal only actual mutations and preserve existing history", async (t) => {
  const s = await setup(t); const item = (await s.readPersistedState()).stock.find((entry) => entry.id === "follower");
  ok(await s.stockWrite({ upsert: [{ ...item, status: "feeding" }], deleteIds: [] }));
  ok(await s.stockWrite({ upsert: [{ ...item, id: "new-fish", code: "new-fish", status: "sick" }], deleteIds: [] }));
  let state = await s.readPersistedState(); assert.equal(state.stockStatusHistory.length, 2);
  const initial = state.stockStatusHistory.find((r) => r.stockItemId === "new-fish");
  assert.equal(initial.previousStatus, null); assert.equal(initial.status, "sick");
  const submit = await s.stockWrite({ upsert: [{ ...state.stock.find((entry) => entry.id === "follower"), status: "sick" }], deleteIds: [] }, "editor"); ok(submit);
  assert.equal(submit.body.pendingApproval, true); assert.equal((await s.readPersistedState()).stockStatusHistory.length, 2);
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: submit.body.approvalRequestId, decision: "approve" } }); ok(approved);
  state = await s.readPersistedState(); assert.equal(state.stockStatusHistory.length, 3);
  const audit = state.stockStatusHistory.at(-1); assert.equal(audit.source, "stock_approval");
  assert.equal(audit.operator, "pricing-admin"); assert.equal(audit.requestedBy, "pricing-editor");
  const page = await s.history("follower", "admin", "&limit=1&offset=1"); ok(page);
  assert.equal(page.body.total, 2); assert.equal(page.body.records.length, 1); assert.equal(page.body.records[0].status, "feeding");
  const duplicateApproval = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: submit.body.approvalRequestId, decision: "approve" } });
  assert.equal(duplicateApproval.response.status, 400); assert.equal((await s.readPersistedState()).stockStatusHistory.length, 3);
});

test("rejected and invalid combined saves leave status and history unchanged", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  const item = before.stock.find((entry) => entry.id === "follower");
  const submitted = await s.stockWrite({ upsert: [{ ...item, status: "sick" }], deleteIds: [] }, "editor"); ok(submitted);
  ok(await s.request("/api/approvals/stock", { token: s.tokens.admin, body: { requestId: submitted.body.approvalRequestId, decision: "reject", note: "不修改" } }));
  const invalid = await s.details("follower", "sick", "healthy", "editor", { record: { id: "invalid-record", date: "1900-01-01", text: "bad", photos: [], videos: [] } });
  assert.equal(invalid.response.status, 400);
  const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock); assert.equal(after.stockStatusHistory, undefined);
});

test("transaction failure after journal append rolls back both fish status and history", async (t) => {
  const s = await setup(t, (fixture) => { fixture.failStatusHistoryWrite = true; });
  const before = await s.readPersistedState();
  const failed = await s.details("follower", "sick"); assert.equal(failed.response.status, 500);
  const after = await s.readPersistedState(); assert.deepEqual(after.stock, before.stock); assert.equal(after.stockStatusHistory, undefined);
  ok(await s.details("follower", "sick")); assert.equal((await s.readPersistedState()).stockStatusHistory.length, 1);
});

test("existing journal rows survive status edits and hard stock deletion prunes only that fish's hidden rule", async (t) => {
  const oldRecord = { id: "historical-audit", stockItemId: "follower", previousStatus: "sick", status: "healthy",
    changedAt: "2026-10-01T00:00:00.000Z", operator: "retired-account", operatorName: "旧操作人", source: "bio_details", siteId: "nanjing" };
  const s = await setup(t, (fixture) => {
    fixture.state.stockStatusHistory = [oldRecord];
    fixture.state.publicCatalogPolicy = { hiddenStockIds: ["follower", "follower-stale"], hiddenProductIds: ["other-product"] };
  });
  ok(await s.details("follower", "sick"));
  let state = await s.readPersistedState(); assert.deepEqual(state.stockStatusHistory[0], oldRecord);
  ok(await s.stockWrite({ upsert: [], deleteIds: ["follower"] }));
  state = await s.readPersistedState();
  assert.equal(state.stockStatusHistory.length, 2); assert.deepEqual(state.stockStatusHistory[0], oldRecord);
  assert.deepEqual(state.publicCatalogPolicy.hiddenStockIds, ["follower-stale"]);
  assert.deepEqual(state.publicCatalogPolicy.hiddenProductIds, ["other-product"]);
  assert.equal((await s.history("follower")).response.status, 404);
});
