import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockTransferFixture, TRANSFER_TEST_PASSWORD } from "./test-support/stock-transfer-fixture.mjs";

const ok = (r) => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const rejected = (r, statuses = [400, 403, 409]) => assert.ok(statuses.includes(r.response.status), JSON.stringify(r.body));
const byId = (state, id) => state.stock.find((item) => item.id === id);
const expected = (item) => ({ id: item.id, subTankId: item.subTankId, status: item.status, lost: Boolean(item.lost), tankTransferId: item.tankTransfer?.id ?? "" });
let sequence = 0;
async function setup(t) {
  const fixture = stockTransferFixture();
  const server = await startMutableRouteServer(fixture); t.after(() => server.stop());
  const tokens = {};
  for (const name of ["pricing-admin", "pricing-editor", "pricing-viewer", "receiver", "dual-editor"]) tokens[name] = await server.login(name, TRANSFER_TEST_PASSWORD);
  const save = (body, user = "pricing-admin") => server.request("/api/maintenance/save", { token: tokens[user], body });
  const issueBody = async (ids) => {
    const state = await server.readPersistedState();
    return { mode: "transferIssue", itemIds: ids, expectedItems: ids.map((id) => expected(byId(state, id))), clientMutationId: `transfer-test-${++sequence}`, moveNotes: "换水期间转缸" };
  };
  const receiveBody = async (ids, target = "tank-j") => {
    const state = await server.readPersistedState();
    return { mode: "transferReceive", items: ids.map((id) => ({ stockItemId: id, transferId: byId(state, id).tankTransfer.id })), targetSubTankId: target, clientMutationId: `transfer-test-${++sequence}` };
  };
  return { ...server, fixture, tokens, save, issueBody, receiveBody };
}

test("dispatch and partial cross-site receipt preserve prices, health, orders and batch; global pool is redacted", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  ok(await s.save(await s.issueBody(["moved-fish", "unrelated-fish"]), "pricing-editor"));
  const issued = await s.readPersistedState();
  for (const id of ["moved-fish", "unrelated-fish"]) {
    const fish = byId(issued, id); const old = byId(before, id);
    assert.equal(fish.tankTransfer.status, "in_transit");
    assert.equal(fish.subTankId, old.subTankId);
    for (const key of ["sold", "lost", "status", "basePrice", "batchId", "priceMode"]) assert.deepEqual(fish[key], old[key], key);
  }
  assert.deepEqual(issued.orders, before.orders);
  const pool = await s.request("/api/stock/transfers", { token: s.tokens.receiver }); ok(pool);
  assert.deepEqual(pool.body.items.map((i) => i.stockItemId).sort(), ["moved-fish", "unrelated-fish"]);
  const whitelist = new Set(["stockItemId", "transferId", "productId", "productName", "size", "origin", "imageUrl", "code", "status", "sold", "fromSiteId", "fromSiteName", "fromSubTankId", "fromTankName", "issuedAt", "issuedBy", "notes"]);
  assert.ok(pool.body.items.every((item) => Object.keys(item).every((key) => whitelist.has(key))));
  assert.doesNotMatch(JSON.stringify(pool.body), /PRIVATE_CUSTOMER|PRIVATE_STOCK_NOTE|PRIVATE_BIO|basePrice|batchId|payments|customerId/);
  ok(await s.save(await s.receiveBody(["moved-fish"]), "receiver"));
  const after = await s.readPersistedState();
  assert.equal(byId(after, "moved-fish").tankTransfer.status, "received");
  assert.equal(byId(after, "moved-fish").siteId, "jiangyin");
  assert.equal(byId(after, "moved-fish").subTankId, "tank-j");
  assert.equal(byId(after, "unrelated-fish").tankTransfer.status, "in_transit");
  assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.batches, before.batches);
  assert.equal(after.bioRecords.filter((r) => r.sourceType === "stockTransferIssued").length, 2);
  assert.equal(after.bioRecords.filter((r) => r.sourceType === "stockTransferReceived").length, 1);
});

test("transfer authority is source-scoped for dispatch and destination-scoped for receipt", async (t) => {
  const s = await setup(t);
  rejected(await s.request("/api/stock/transfers"), [401]);
  rejected(await s.request("/api/stock/transfers", { token: s.tokens["pricing-viewer"] }), [403]);
  rejected(await s.save(await s.issueBody(["foreign-fish"]), "pricing-editor"), [403]);
  for (const id of ["lost-fish", "outbound-fish"]) rejected(await s.save(await s.issueBody([id])));
  ok(await s.save(await s.issueBody(["unrelated-fish"]), "pricing-editor"));
  rejected(await s.save(await s.receiveBody(["unrelated-fish"], "tank-n2"), "receiver"), [403]);
  ok(await s.save(await s.receiveBody(["unrelated-fish"], "tank-j"), "receiver"));
  // Reverse direction uses exactly the same workflow, including sold fish.
  ok(await s.save(await s.issueBody(["unrelated-fish"]), "receiver"));
  ok(await s.save(await s.receiveBody(["unrelated-fish"], "tank-n2"), "pricing-editor"));
  assert.equal(byId(await s.readPersistedState(), "unrelated-fish").subTankId, "tank-n2");
});

test("concurrent receipts, replay and away-and-back dispatch are safe", async (t) => {
  const s = await setup(t); const issue = await s.issueBody(["unrelated-fish"]);
  ok(await s.save(issue, "pricing-editor")); ok(await s.save(issue, "pricing-editor"));
  const receipt = await s.receiveBody(["unrelated-fish"], "tank-n");
  const results = await Promise.all([s.save(receipt), s.save({ ...receipt, clientMutationId: "other-receipt" })]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  const replay = await s.save(issue, "pricing-editor"); ok(replay);
  assert.equal(replay.body.idempotent, true);
  assert.ok(replay.body.stockUpdates.every((i) => i.tankTransfer.status === "received"), "replay must not restore stale in-transit UI");
  rejected(await s.save({ ...issue, clientMutationId: "stale-aba-issue" }), [409]);
  ok(await s.save(await s.issueBody(["unrelated-fish"])));
  rejected(await s.save({ ...receipt, clientMutationId: "stale-receipt" }), [409]);
  const after = await s.readPersistedState();
  assert.equal(after.bioRecords.filter((r) => r.sourceType === "stockTransferIssued").length, 2);
  assert.equal(after.bioRecords.filter((r) => r.sourceType === "stockTransferReceived").length, 1);
});

test("idempotent retries recheck current user permissions and target scope", async (t) => {
  const s = await setup(t); const issue = await s.issueBody(["unrelated-fish"]);
  ok(await s.save(issue, "pricing-editor"));
  await s.patchTestPersonnel("pricing-editor", { permissions: {} });
  rejected(await s.save(issue, "pricing-editor"), [403]);
  const receive = await s.receiveBody(["unrelated-fish"]); ok(await s.save(receive, "receiver"));
  await s.patchTestPersonnel("receiver", { visibleSiteIds: ["nanjing"] });
  rejected(await s.save(receive, "receiver"), [403]);
});

test("legacy move, direct tank editing and transfer forgery cannot bypass dispatch and receipt", async (t) => {
  const s = await setup(t); let state = await s.readPersistedState();
  const original = byId(state, "unrelated-fish");
  rejected(await s.save({ mode: "move", itemIds: [original.id], expectedItems: [expected(original)], targetSubTankId: "tank-n2", clientMutationId: "legacy-move" }));
  const stockWrite = (item, old) => s.request("/api/stock/save", { token: s.tokens["pricing-admin"], body: { upsert: [item], deleteIds: [], expectedOperations: { [item.id]: "update" }, expectedBefore: { [item.id]: old } } });
  rejected(await stockWrite({ ...original, subTankId: "tank-n2" }, original));
  rejected(await stockWrite({ ...original, tankTransfer: { id: "forged", status: "received" } }, original));
  ok(await s.save(await s.issueBody([original.id]))); state = await s.readPersistedState();
  const active = byId(state, original.id);
  rejected(await stockWrite({ ...active, tankTransfer: undefined }, active));
  rejected(await stockWrite({ ...active, notes: "cannot-edit-transit" }, active));
  rejected(await s.request("/api/state/patch", { token: s.tokens["pricing-admin"], body: { patch: { stock: [original] }, basePatch: { stock: [active] } } }));
  assert.equal(byId(await s.readPersistedState(), original.id).tankTransfer.status, "in_transit");
});

test("public catalog and specimen history hide an active transfer and recover after receipt", async (t) => {
  const s = await setup(t);
  const path = "/api/public/bio-records?siteId=all&stockItemId=unrelated-fish";
  ok(await s.request(path));
  ok(await s.save(await s.issueBody(["unrelated-fish"])));
  const hidden = await s.request(path); rejected(hidden, [404]);
  const catalog = await s.request("/api/public/catalog?siteId=all"); ok(catalog);
  assert.doesNotMatch(JSON.stringify(catalog.body), /unrelated-fish/);
  ok(await s.save(await s.receiveBody(["unrelated-fish"])));
  ok(await s.request(path));
});

test("in-transit fish cannot be newly ordered or fulfilled but retained order edits preserve ownership", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); const order = before.orders[0];
  ok(await s.save(await s.issueBody(["moved-fish", "unrelated-fish"])));
  ok(await s.request("/api/orders/update", { token: s.tokens["pricing-admin"], body: { ...order, orderId: order.id, notes: "仍可编辑原订单" } }));
  const add = await s.request("/api/orders/update", { token: s.tokens["pricing-admin"], body: { ...order, orderId: order.id, items: [...order.items, { stockItemId: "unrelated-fish", productId: "price-product", price: 100 }] } });
  rejected(add);
  const outbound = { orderId: order.id, selectedItemIds: ["moved-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-10-18" };
  rejected(await s.request("/api/shipments/outbound", { token: s.tokens["pricing-admin"], body: outbound }));
  ok(await s.save(await s.receiveBody(["moved-fish"])));
  ok(await s.request("/api/shipments/outbound", { token: s.tokens["pricing-admin"], body: outbound }));
  const after = await s.readPersistedState();
  assert.deepEqual(after.orders[0].items.map(({ stockItemId, productId, price }) => ({ stockItemId, productId, price })),
    order.items.map(({ stockItemId, productId, price }) => ({ stockItemId, productId, price })));
  assert.equal(after.orders[0].siteId, "nanjing");
});
