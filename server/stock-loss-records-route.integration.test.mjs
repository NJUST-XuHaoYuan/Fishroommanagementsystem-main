import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { normalizeLossReasonRequest } from "./stock-loss-records.mjs";

const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const expectation = ({ id, subTankId, status, lost }) => ({ id, subTankId, status, lost: Boolean(lost) });
const loss = (items, extra = {}) => ({ mode: "loss", itemIds: items.map(item => item.id), expectedItems: items.map(expectation),
  clientMutationId: "test-loss-1", lossDate: "2026-11-01", lossReason: "", lossProof: ["/uploads/loss.jpg"], ...extra });
const legacyLoss = (extra = {}) => ({ id: "old-loss", stockItemId: "lost", siteId: "nanjing", tankGroupId: "group-n", subTankId: "tank-n",
  date: "2026-10-01", reason: "", operator: "pricing-editor", proofPhotos: ["/uploads/original.jpg"], ...extra });
async function setup(t, customize = () => {}) {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.personnel.find(person => person.username === "pricing-editor").permissions.lossRecords = { create: true, update: false, delete: false };
  fixture.state.personnel.find(person => person.username === "pricing-viewer").permissions.daily = { update: true };
  customize(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const save = (body, role = "editor") => server.request("/api/maintenance/save", { token: tokens[role], body });
  const reason = (recordId, reason, expectedReason = "", role = "editor") => server.request("/api/stock-loss-records/reason", { token: tokens[role], body: { recordId, reason, expectedReason } });
  const history = (query = "", role = "editor") => server.request(`/api/mobile-maintenance/history?siteId=nanjing${query}`, { token: tokens[role] });
  return { ...server, tokens, save, reason, history };
}

test("batch loss preserves previous history, links one immutable loss event per fish and retries idempotently", async t => {
  const originalBio = { id: "old-treatment", stockItemId: "follower", siteId: "nanjing", date: "2026-10-01T12:00:00", text: "旧治疗", photos: ["/uploads/old.jpg"], videos: [], sourceType: "manual", operator: "pricing-editor" };
  const s = await setup(t, state => { state.bioRecords = [originalBio]; });
  const before = await s.readPersistedState(); const items = before.stock.filter(item => ["follower", "follower-stale"].includes(item.id));
  const body = loss(items, { operator: "forged" }); const result = await s.save(body); ok(result);
  assert.equal(result.body.idempotent, false); assert.equal(result.body.lossRecordUpdates.length, 2); assert.equal(result.body.bioRecordUpdates.length, 2);
  const after = await s.readPersistedState();
  assert.deepEqual(after.bioRecords.find(record => record.id === originalBio.id), originalBio);
  for (const record of result.body.lossRecordUpdates) {
    assert.equal(record.operator, "pricing-editor"); assert.equal(record.reason, ""); assert.equal(record.siteId, "nanjing");
    assert.equal(record.tankGroupId, "group-n"); assert.equal(record.subTankId, "tank-n"); assert.equal(record.productName, "联动价格测试");
    assert.ok(record.fishCode); assert.ok(Number.isFinite(Date.parse(record.createdAt)));
    const bio = after.bioRecords.find(row => row.id === record.sourceBioRecordId);
    assert.equal(bio.sourceType, "stockLoss"); assert.equal(bio.sourceLossRecordId, record.id); assert.equal(bio.operator, record.operator);
    assert.deepEqual(bio.photos, body.lossProof); assert.equal(bio.date, body.lossDate);
    const item = after.stock.find(row => row.id === record.stockItemId); assert.equal(item.lost, true); assert.equal(item.lossReason, "");
  }
  assert.equal(after.batches.find(row => row.id === "batch-n").lossCount, before.stock.filter(item => item.batchId === "batch-n" && item.lost).length + 2);
  const retry = await s.save(body); ok(retry); assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.stockUpdates.length, 2); assert.equal(retry.body.bioRecordUpdates.length, 2); assert.deepEqual(await s.readPersistedState(), after);
  const mismatch = await s.save({ ...body, lossReason: "changed" }); assert.equal(mismatch.response.status, 409);
  const duplicate = await s.save(loss(after.stock.filter(item => items.some(target => target.id === item.id)), { clientMutationId: "another-loss" }));
  assert.equal(duplicate.response.status, 409); assert.deepEqual(await s.readPersistedState(), after);
  const record = result.body.bioRecordUpdates[0];
  for (const action of ["delete", "updateTime"]) {
    const response = await s.request("/api/bio-records/save", { token: s.tokens.admin, body: { action, stockItemId: record.stockItemId, recordId: record.id, expectedRecord: record, record: { date: "2026-11-02T12:00:00" } } });
    assert.equal(response.response.status, 409); assert.equal(response.body.code, "SYSTEM_BIO_RECORD_IMMUTABLE");
  }
  const patch = await s.request("/api/state/patch", { token: s.tokens.admin, body: { patch: { lossRecords: [] }, basePatch: { lossRecords: after.lossRecords } } });
  assert.equal(patch.response.status, 400); assert.deepEqual(await s.readPersistedState(), after);
});

test("concurrent double-click and independent attempts create exactly one loss event; revoked permission blocks retry", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const fish = before.stock.find(row => row.id === "follower");
  const body = loss([fish]); const results = await Promise.all([s.save(body), s.save(body)]);
  results.forEach(ok); assert.deepEqual(results.map(result => result.body.idempotent).sort(), [false, true]);
  let state = await s.readPersistedState(); assert.equal(state.lossRecords.length, 1); assert.equal(state.bioRecords.length, 1);
  const reasonResults = await Promise.all([s.reason(state.lossRecords[0].id, "原因A"), s.reason(state.lossRecords[0].id, "原因B")]);
  assert.deepEqual(reasonResults.map(result => result.response.status).sort(), [200, 409]);
  state = await s.readPersistedState(); assert.equal(state.operationLogs.length, 2);
  await s.patchTestPersonnel("pricing-editor", { permissions: { daily: { update: true } } });
  assert.equal((await s.save(body)).response.status, 403);
  assert.equal((await s.readPersistedState()).lossRecords.length, 1);
});

test("loss validation is atomic for proof, dates, stale stock, prior loss, out-of-tank fish and permissions", async t => {
  const s = await setup(t, state => {
    state.stock.push({ ...state.stock[0], id: "transit", tankTransfer: { id: "transfer-1", status: "in_transit" }, tankTransferId: "transfer-1" });
    state.lossRecords.push(legacyLoss({ stockItemId: "legacy-equal" }));
  });
  const before = await s.readPersistedState(); const fish = before.stock.find(item => item.id === "follower");
  for (const proof of [[], ["/uploads/a.mp4"], ["/api/private-attachments/proof.jpg"], ["javascript:evil.jpg"]]) {
    const result = await s.save(loss([fish], { lossProof: proof })); assert.equal(result.response.status, 400, JSON.stringify(result.body));
  }
  for (const date of ["2099-01-01", "2026-02-30", "2026-08-31"]) assert.equal((await s.save(loss([fish], { lossDate: date }))).response.status, 400);
  for (const id of ["lost", "shipment-shipped", "transit", "legacy-equal"]) {
    const result = await s.save(loss([before.stock.find(item => item.id === id)], { clientMutationId: `loss-${id}` }));
    assert.equal(result.response.status, 409, `${id}: ${JSON.stringify(result.body)}`);
  }
  const stale = loss([fish]); stale.expectedItems[0].status = "sick";
  assert.equal((await s.save(stale)).response.status, 409);
  assert.equal((await s.save(loss([fish]), "viewer")).response.status, 403);
  assert.equal((await s.save(loss([before.stock.find(item => item.id === "PRIVATE_JY_FOLLOWER")]))).response.status, 403);
  assert.deepEqual(await s.readPersistedState(), before);
});

test("reason corrections use owner permissions, CAS and stable linkage; retry returns current deltas without duplicate audit", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const saved = await s.save(loss([before.stock.find(item => item.id === "follower")])); ok(saved);
  const record = saved.body.lossRecordUpdates[0], originalBio = saved.body.bioRecordUpdates[0];
  assert.equal((await s.reason(record.id, "他人修改", "", "viewer")).response.status, 403);
  const changed = await s.reason(record.id, "呼吸异常"); ok(changed);
  assert.equal(changed.body.lossRecordUpdates[0].reason, "呼吸异常"); assert.equal(changed.body.lossRecordUpdates[0].operator, record.operator);
  assert.equal(changed.body.lossRecordUpdates[0].reasonUpdatedBy, "pricing-editor");
  assert.equal(changed.body.stockUpdates[0].lossReason, "呼吸异常");
  assert.deepEqual(changed.body.bioRecordUpdates[0], { ...originalBio, text: "损耗：呼吸异常", reasonUpdatedBy: "pricing-editor", reasonUpdatedAt: changed.body.lossRecordUpdates[0].reasonUpdatedAt });
  const stored = await s.readPersistedState(); const retry = await s.reason(record.id, "呼吸异常"); ok(retry);
  assert.equal(retry.body.idempotent, true); assert.deepEqual(retry.body.stockUpdates, changed.body.stockUpdates); assert.deepEqual(retry.body.bioRecordUpdates, changed.body.bioRecordUpdates);
  assert.deepEqual(await s.readPersistedState(), stored);
  assert.equal((await s.reason(record.id, "不同新原因")).response.status, 409);
  for (const body of [{ recordId: record.id, reason: "新原因" }, { recordId: record.id, reason: "   ", expectedReason: "呼吸异常" }, { recordId: record.id, reason: "x".repeat(2001), expectedReason: "呼吸异常" }]) {
    const result = await s.request("/api/stock-loss-records/reason", { token: s.tokens.editor, body }); assert.ok([400, 409].includes(result.response.status));
  }
  await s.patchTestPersonnel("pricing-viewer", { permissions: { lossRecords: { update: true } } });
  ok(await s.reason(record.id, "复核原因", "呼吸异常", "viewer"));
  const final = await s.readPersistedState(); const row = final.lossRecords.find(item => item.id === record.id);
  assert.equal(row.operator, "pricing-editor"); assert.equal(row.reasonUpdatedBy, "pricing-viewer");
  for (const key of ["date", "proofPhotos", "createdAt", "stockItemId", "sourceBioRecordId", "subTankId"]) assert.deepEqual(row[key], record[key]);
  const stock = final.stock.find(item => item.id === record.stockItemId);
  for (const key of ["lost", "lossDate", "lossProof", "basePrice", "status", "sold", "batchId"]) assert.deepEqual(stock[key], stored.stock.find(item => item.id === record.stockItemId)[key]);
  await s.patchTestPersonnel("pricing-editor", { accountEnabled: false });
  assert.equal((await s.reason(record.id, "disabled", "复核原因")).response.status, 401);
});

test("old unlinked loss gets one explicit supplement; original history and current later loss remain unchanged", async t => {
  const oldBio = { id: "old-manual-loss", stockItemId: "lost", siteId: "nanjing", date: "2026-10-01", text: "损耗", photos: ["/uploads/old.jpg"], videos: [], sourceType: "manual", operator: "retired" };
  const s = await setup(t, state => {
    state.lossRecords = [legacyLoss(), legacyLoss({ id: "later-loss", date: "2026-10-02", reason: "现有原因" })];
    state.bioRecords = [oldBio]; Object.assign(state.stock.find(item => item.id === "lost"), { lossDate: "2026-10-02", lossReason: "现有原因" });
  });
  const first = await s.reason("old-loss", "补充旧原因"); ok(first); assert.equal(first.body.stockUpdates.length, 0);
  const bio = first.body.bioRecordUpdates[0]; assert.equal(bio.sourceType, "stockLoss"); assert.equal(bio.lossReasonSupplement, true); assert.equal(bio.sourceLossRecordId, "old-loss");
  const after = await s.readPersistedState(); assert.deepEqual(after.bioRecords.find(row => row.id === oldBio.id), oldBio);
  assert.equal(after.stock.find(row => row.id === "lost").lossReason, "现有原因");
  ok(await s.reason("old-loss", "补充旧原因")); assert.deepEqual(await s.readPersistedState(), after);
  const edit = await s.reason("old-loss", "再更正", "补充旧原因"); ok(edit); assert.equal(edit.body.bioRecordUpdates[0].id, bio.id);
  assert.equal((await s.readPersistedState()).bioRecords.length, 2);
});

test("historical same-site reason editing does not expose or overwrite fish now in another site; foreign history denied", async t => {
  const s = await setup(t, state => {
    state.lossRecords = [legacyLoss(), legacyLoss({ id: "private-loss", siteId: "jiangyin", tankGroupId: "group-j", subTankId: "tank-j", stockItemId: "PRIVATE_JY_FOLLOWER" })];
    Object.assign(state.stock.find(item => item.id === "lost"), { siteId: "jiangyin", subTankId: "tank-j", lossDate: "2026-10-01", lossReason: "PRIVATE_CURRENT_REASON" });
  });
  const result = await s.reason("old-loss", "原登记补充"); ok(result); assert.deepEqual(result.body.stockUpdates, []);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_CURRENT_REASON|PRIVATE_JY/);
  const retry = await s.reason("old-loss", "原登记补充"); ok(retry); assert.deepEqual(retry.body.stockUpdates, []);
  assert.equal((await s.reason("private-loss", "不能更改")).response.status, 403);
  assert.equal((await s.readPersistedState()).stock.find(item => item.id === "lost").lossReason, "PRIVATE_CURRENT_REASON");
});

test("personal loss history filters missing reasons before paging and never displaces normal maintenance history", async t => {
  const s = await setup(t, state => {
    state.lossRecords = Array.from({ length: 40 }, (_, i) => legacyLoss({ id: `recent-${i}`, createdAt: `2026-11-20T12:${String(i).padStart(2, "0")}:00Z`, reason: "已填" }));
    state.lossRecords.push(legacyLoss({ id: "missing", reason: "  " }), legacyLoss({ id: "other-person", operator: "pricing-admin" }), legacyLoss({ id: "other-site", siteId: "jiangyin", tankGroupId: "group-j", subTankId: "tank-j" }));
    state.bioRecords.push({ id: "normal-history", stockItemId: "follower", siteId: "nanjing", tankGroupId: "group-n", subTankId: "tank-n", date: "2026-09-01T12:00:00", text: "治疗", sourceType: "manual", operator: "pricing-editor", photos: [], videos: [] });
  });
  const normal = await s.history("&limit=1"); ok(normal); assert.deepEqual(normal.body.lossRecords, []); assert.equal(normal.body.bioRecords[0].id, "normal-history");
  const pending = await s.history("&kind=loss&reasonStatus=missing&tankGroupId=group-n&subTankId=tank-n&limit=1"); ok(pending);
  assert.equal(pending.body.lossRecords.length, 1); assert.equal(pending.body.lossRecords[0].id, "missing"); assert.equal(pending.body.truncated, false);
  assert.deepEqual(pending.body.bioRecords, []); assert.deepEqual(pending.body.logs, []); assert.deepEqual(pending.body.waterQualityRecords, []);
  const all = await s.history("&kind=loss&limit=2"); ok(all); assert.equal(all.body.lossRecords.length, 2); assert.equal(all.body.truncated, true);
  assert.doesNotMatch(JSON.stringify(all.body), /other-person|other-site/);
  ok(await s.reason("missing", "已补", "", "admin"));
  const after = await s.history("&kind=loss&reasonStatus=missing"); ok(after); assert.equal(after.body.lossRecords.length, 0);
  const own = await s.history("&kind=loss&limit=100"); assert.ok(own.body.lossRecords.some(row => row.id === "missing"));
});

test("loss reason request and SQL keep bounded reads and one large JSON field update at a time", async () => {
  assert.deepEqual(normalizeLossReasonRequest({ recordId: " a ", reason: " why ", expectedReason: " " }), { recordId: "a", reason: "why", expectedReason: "" });
  assert.throws(() => normalizeLossReasonRequest({ recordId: "a", reason: "why", expectedReason: null }));
  const source = await readFile(new URL("./stock-loss-records.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SELECT\s+data\s+FROM/i); assert.doesNotMatch(source, /jsonb_set\(jsonb_set/);
  assert.match(source, /ARRAY\['\$\{key\}',\$2::text\]/); assert.match(source, /loss_reason_stock/);
  const route = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const delegate = route.indexOf('if (mode === "loss") return stockLossService.saveLoss({ client, req, preparedMutation });');
  assert.ok(delegate > 0); assert.ok(route.slice(delegate, delegate + 500).includes("SELECT data FROM app_state"));
});
