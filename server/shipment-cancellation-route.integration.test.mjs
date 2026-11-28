import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./test-support/cross-site-fulfillment-fixture.mjs";
import { stockTransferFixture } from "./test-support/stock-transfer-fixture.mjs";
import { buildStockMutationExpectation } from "./stock-mutation-relationships.mjs";
import { projectedShippedOutStockIds } from "./shipment-inventory-integrity.mjs";

const ok = (r) => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const rejected = (r) => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
const inTankIds = (state) => {
  const out = projectedShippedOutStockIds(state);
  return state.stock.filter((s) => !s.lost && s.tankTransfer?.status !== "in_transit" && !out.has(s.id)).map((s) => s.id).sort();
};

async function setup(t, customize = () => {}, transfer = false) {
  const fixture = transfer ? stockTransferFixture() : crossSiteFulfillmentFixture({ origin: "nanjing", destination: "nanjing" });
  // Cancellation is an order-owner action; delegated outbound/confirmation is
  // covered separately. Keep these reconciliation cases owned by their editor.
  const owner = fixture.state.personnel.find(person => person.id === (transfer ? "dual-editor" : "pricing-editor"));
  Object.assign(fixture.state.orders.find(order => order.id === "moved-order"), {
    contactPersonnelId: owner.id, contactPerson: owner.name,
  });
  fixture.state.tankGroups[0].subTanks.push({ id: "cancel-return-tank", name: "回缸核对缸" });
  fixture.state.operationLogs = [];
  customize(fixture.state);
  const s = await startMutableRouteServer(fixture);
  t.after(s.stop);
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await s.login(`pricing-${role}`, FULFILLMENT_TEST_PASSWORD);
  tokens.dual = await s.login("dual-editor", FULFILLMENT_TEST_PASSWORD);
  const post = (path, body, role = "admin") => s.request(path, { token: tokens[role], body });
  const preview = (shipmentId, role = "admin") => s.request(`/api/shipments/cancel-preview?shipmentId=${encodeURIComponent(shipmentId)}`, { token: tokens[role] });
  const saveStock = async (change) => post("/api/stock/save", { ...change, ...buildStockMutationExpectation(await s.readPersistedState(), change) });
  const outbound = async (extra = {}) => {
    const r = await post("/api/shipments/outbound", { orderId: "moved-order", selectedItemIds: ["moved-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-11-18", ...extra });
    ok(r); return r.body.shipment.id;
  };
  const cancellation = (shipmentId, p, returnItems = [{ stockItemId: "moved-fish", subTankId: "tank-n" }]) => ({
    shipmentId, reviewToken: p.reviewToken, confirmedPhysicalReturn: true, returnItems,
  });
  const addDuplicate = async (id = "stocktake-added-fish", extra = {}) => {
    const original = (await s.readPersistedState()).stock.find((row) => row.id === "moved-fish");
    const duplicate = { ...original, id, code: `COUNT-${id}`, sold: false, notes: "盘库增加：合成回缸核对", ...extra };
    ok(await saveStock({ upsert: [duplicate], deleteIds: [], adjustmentContext: { kind: "inventory_adjustment", siteId: "nanjing", removeStockIds: [], additionStockIds: [id] } }));
    return duplicate;
  };
  return { ...s, tokens, post, preview, saveStock, outbound, cancellation, addDuplicate };
}

test("stocktake duplicate is merged on cancellation by the ordinary order owner, preserving identity, count, maintenance and audit", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound();
  assert.deepEqual(inTankIds(await s.readPersistedState()), ["unrelated-fish"]);
  await s.addDuplicate("stocktake-added-fish", { status: "feeding", subTankId: "cancel-return-tank" });
  ok(await s.post("/api/bio-records/save", { action: "create", stockItemId: "stocktake-added-fish", record: {
    id: "count-maintenance", date: "2026-11-18T08:00:00", text: "补录期间的实际养护", photos: ["/uploads/synthetic-count.jpg"], videos: ["/uploads/synthetic-count.mp4"],
  } }));
  const before = await s.readPersistedState();
  await s.patchTestPersonnel("pricing-editor", { permissions: { orders: { update: true } } });
  const p = await s.preview(shipmentId, "editor"); ok(p);
  assert.ok(p.body.items[0].candidates.some((candidate) => candidate.stockItemId === "stocktake-added-fish"));
  const r = await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, [{ stockItemId: "moved-fish", subTankId: "cancel-return-tank", duplicateStockItemId: "stocktake-added-fish" }]), "editor"); ok(r);
  const after = await s.readPersistedState();
  assert.deepEqual(inTankIds(after), ["moved-fish", "unrelated-fish"]);
  assert.equal(after.stock.length, 2);
  const original = after.stock.find((row) => row.id === "moved-fish");
  assert.equal(original.sold, true); assert.equal(original.status, "feeding"); assert.equal(original.subTankId, "cancel-return-tank");
  assert.equal(after.orders[0].items[0].stockItemId, "moved-fish");
  assert.equal(after.orders[0].items[0].price, before.orders[0].items[0].price);
  assert.equal(after.orders[0].status, "pending");
  assert.equal(after.batches.find((row) => row.id === "batch-n").stockedCount, before.batches.find((row) => row.id === "batch-n").stockedCount - 1);
  const mergedRecord = after.bioRecords.find((row) => row.text === "补录期间的实际养护");
  assert.equal(mergedRecord.stockItemId, "moved-fish"); assert.equal(mergedRecord.mergedFromStockItemId, "stocktake-added-fish");
  assert.deepEqual(mergedRecord.photos, ["/uploads/synthetic-count.jpg"]);
  assert.deepEqual(mergedRecord.videos, ["/uploads/synthetic-count.mp4"]);
  assert.ok(after.stockStatusHistory.some((row) => row.stockItemId === "moved-fish" && row.mergedFromStockItemId === "stocktake-added-fish"));
  const audit = after.shipmentCancellationAudits.at(-1);
  assert.equal(audit.cancelledBy, "pricing-editor"); assert.equal(audit.shipmentBefore.id, shipmentId);
  assert.equal(audit.items[0].originalBefore.id, "moved-fish");
  assert.equal(audit.items[0].duplicateBefore.id, "stocktake-added-fish"); assert.equal(audit.items[0].after.id, "moved-fish");
  assert.ok(after.bioRecords.some((row) => row.stockItemId === "moved-fish" && row.sourceType === "shipmentCancellation"));
  const systemRecord = after.bioRecords.find((row) => row.sourceType === "shipmentCancellation");
  const deleteSystemRecord = await s.post("/api/bio-records/save", { action: "delete", stockItemId: systemRecord.stockItemId, recordId: systemRecord.id, expectedRecord: systemRecord });
  rejected(deleteSystemRecord); assert.equal(deleteSystemRecord.body.code, "SYSTEM_BIO_RECORD_IMMUTABLE");
  const visible = await s.request("/api/state", { token: s.tokens.editor }); ok(visible);
  assert.equal(visible.body.data.shipmentCancellationAudits, undefined);
  const afterMerge = await s.readPersistedState();
  for (const auditValue of [[], [{ id: "forged", shipmentId }]]) {
    rejected(await s.post("/api/state/patch", { patch: { shipmentCancellationAudits: auditValue }, basePatch: { shipmentCancellationAudits: afterMerge.shipmentCancellationAudits } }));
    assert.deepEqual(await s.readPersistedState(), afterMerge);
  }
  const fullState = await s.post("/api/state", { ...afterMerge, shipmentCancellationAudits: [] });
  rejected(fullState); assert.deepEqual(await s.readPersistedState(), afterMerge);
  const recreated = await s.saveStock({ upsert: [{ ...audit.items[0].duplicateBefore }], deleteIds: [] });
  rejected(recreated); assert.deepEqual(await s.readPersistedState(), afterMerge);
});

test("a genuine return restores exactly one original fish and retains an unselected similar fish", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); const p = await s.preview(shipmentId); ok(p);
  const before = await s.readPersistedState();
  const r = await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, [{ stockItemId: "moved-fish", subTankId: "cancel-return-tank" }])); ok(r);
  const after = await s.readPersistedState();
  assert.deepEqual(inTankIds(after), ["moved-fish", "unrelated-fish"]);
  assert.equal(after.stock.length, before.stock.length);
  assert.deepEqual(after.stock.find((row) => row.id === "unrelated-fish"), before.stock.find((row) => row.id === "unrelated-fish"));
  assert.equal(after.shipmentCancellationAudits.at(-1).items[0].duplicateStockItemId || "", "");
  rejected(await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body)));
  assert.deepEqual(inTankIds(await s.readPersistedState()), inTankIds(after));
});

test("cancellation requires reviewed exact fish, explicit physical return and an authorized valid target tank", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); const p = await s.preview(shipmentId); ok(p);
  const valid = s.cancellation(shipmentId, p.body); const before = await s.readPersistedState();
  for (const body of [
    { shipmentId }, { ...valid, reviewToken: "forged" }, { ...valid, confirmedPhysicalReturn: false },
    { ...valid, returnItems: [] }, { ...valid, returnItems: [...valid.returnItems, ...valid.returnItems] },
    { ...valid, returnItems: [{ stockItemId: "unrelated-fish", subTankId: "tank-n" }] },
    { ...valid, returnItems: [{ stockItemId: "moved-fish", subTankId: "unknown" }] },
  ]) { rejected(await s.post("/api/shipments/cancel", body)); assert.deepEqual(await s.readPersistedState(), before); }
  const editorPreview = await s.preview(shipmentId, "editor"); ok(editorPreview);
  rejected(await s.post("/api/shipments/cancel", s.cancellation(shipmentId, editorPreview.body, [{ stockItemId: "moved-fish", subTankId: "tank-j" }]), "editor"));
  assert.deepEqual(await s.readPersistedState(), before);
});

test("candidate matching cannot merge another product, batch, occupied, lost, in-transit or foreign fish", async (t) => {
  const s = await setup(t, (state) => {
    const base = state.stock[1];
    state.stock.push(
      { ...base, id: "other-product", productId: "other-product" },
      { ...base, id: "other-batch", batchId: "batch-j" },
      { ...base, id: "lost", lost: true },
      { ...base, id: "occupied", sold: true },
      { ...base, id: "transit", tankTransfer: { id: "transit-cycle", status: "in_transit" } },
      { ...base, id: "foreign", siteId: "jiangyin", subTankId: "tank-j" },
      { ...base, id: "historical-order" },
      { ...base, id: "pending-approval" },
      { ...base, id: "pending-draft" },
    );
    state.orders.push({ ...structuredClone(state.orders[0]), id: "historical", orderNo: "SO-HISTORY", status: "cancelled", items: [{ stockItemId: "historical-order", productId: base.productId, price: 20 }] });
    state.approvalRequests = [{ id: "pending-adjustment", status: "pending", approvalAction: "inventory_adjustment", siteId: "nanjing", payload: { deleteIds: ["pending-approval"] } }];
    state.inventoryAdjustmentDrafts = [{ id: "pending-count-draft", siteId: "nanjing", createdBy: "pricing-editor", removeStockIds: ["pending-draft"], additions: [] }];
  });
  const shipmentId = await s.outbound(); const p = await s.preview(shipmentId, "editor"); ok(p);
  const candidates = p.body.items[0].candidates.map((candidate) => candidate.stockItemId);
  assert.ok(candidates.includes("unrelated-fish"));
  const before = await s.readPersistedState();
  for (const duplicateStockItemId of ["other-product", "other-batch", "lost", "occupied", "transit", "foreign", "historical-order", "pending-approval", "pending-draft", "moved-fish", "missing"]) {
    assert.ok(!candidates.includes(duplicateStockItemId), duplicateStockItemId);
    rejected(await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, [{ stockItemId: "moved-fish", subTankId: "tank-n", duplicateStockItemId }]), "editor"));
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("duplicate merge must use its reviewed physical tank and cannot consume one duplicate twice", async (t) => {
  const s = await setup(t, (state) => {
    state.orders[0].items.push({ ...state.orders[0].items[0], stockItemId: "second-sold" });
    state.stock.push({ ...state.stock[0], id: "second-sold", code: "SECOND-SOLD" });
    state.stock[1].subTankId = "cancel-return-tank";
  });
  const shipmentId = await s.outbound({ selectedItemIds: ["moved-fish", "second-sold"] }); const p = await s.preview(shipmentId); ok(p);
  const before = await s.readPersistedState();
  for (const returnItems of [
    [{ stockItemId: "moved-fish", subTankId: "tank-n", duplicateStockItemId: "unrelated-fish" }, { stockItemId: "second-sold", subTankId: "tank-n" }],
    [{ stockItemId: "moved-fish", subTankId: "cancel-return-tank", duplicateStockItemId: "unrelated-fish" }, { stockItemId: "second-sold", subTankId: "cancel-return-tank", duplicateStockItemId: "unrelated-fish" }],
  ]) { rejected(await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, returnItems))); assert.deepEqual(await s.readPersistedState(), before); }
});

test("new stocktake additions invalidate a previously reviewed cancellation instead of bypassing duplicate review", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); const p = await s.preview(shipmentId); ok(p);
  await s.addDuplicate(); const before = await s.readPersistedState();
  const r = await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body));
  assert.equal(r.response.status, 409, JSON.stringify(r.body)); assert.deepEqual(await s.readPersistedState(), before);
  const current = await s.preview(shipmentId); ok(current); assert.notEqual(current.body.reviewToken, p.body.reviewToken);
});

test("candidate maintenance changes invalidate review so later health or evidence is not silently overwritten", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); const p = await s.preview(shipmentId); ok(p);
  const item = (await s.readPersistedState()).stock.find((row) => row.id === "unrelated-fish");
  ok(await s.post("/api/bio-records/save", { action: "saveDetails", stockItemId: item.id, details: { status: "feeding" }, expectedDetails: { status: item.status } }));
  const before = await s.readPersistedState();
  const r = await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, [{ stockItemId: "moved-fish", subTankId: "tank-n", duplicateStockItemId: item.id }]));
  assert.equal(r.response.status, 409, JSON.stringify(r.body)); assert.deepEqual(await s.readPersistedState(), before);
});

test("preview and commit enforce current order-update permission and do not expose foreign site candidates", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound();
  assert.equal((await s.request(`/api/shipments/cancel-preview?shipmentId=${shipmentId}`)).response.status, 401);
  rejected(await s.preview(shipmentId, "viewer"));
  const p = await s.preview(shipmentId, "editor"); ok(p);
  await s.patchTestPersonnel("pricing-editor", { permissions: {} });
  const before = await s.readPersistedState();
  assert.equal((await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body), "editor")).response.status, 403);
  assert.deepEqual(await s.readPersistedState(), before);
});

test("concurrent cancellation commits one audited inventory transition", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); const p = await s.preview(shipmentId); ok(p);
  const body = s.cancellation(shipmentId, p.body);
  const results = await Promise.all([s.post("/api/shipments/cancel", body), s.post("/api/shipments/cancel", body)]);
  assert.equal(results.filter((r) => r.response.status === 200).length, 1, JSON.stringify(results.map((r) => r.body)));
  const state = await s.readPersistedState(); assert.equal(state.shipmentCancellationAudits.length, 1);
  assert.deepEqual(inTankIds(state), ["moved-fish", "unrelated-fish"]);
});

test("generic shipment deletion or rollback cannot bypass physical-return and duplicate review", async (t) => {
  const s = await setup(t); const shipmentId = await s.outbound(); await s.addDuplicate();
  const before = await s.readPersistedState();
  for (const shipments of [
    before.shipments.filter((row) => row.id !== shipmentId),
    before.shipments.map((row) => row.id === shipmentId ? { ...row, status: "preparing" } : row),
  ]) {
    const r = await s.post("/api/state/patch", { patch: { shipments }, basePatch: { shipments: before.shipments } });
    rejected(r); assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("deleting an unpaid order with an outbound fish cannot bypass return reconciliation", async (t) => {
  const s = await setup(t); await s.outbound(); await s.addDuplicate();
  const before = await s.readPersistedState();
  assert.deepEqual(before.orders[0].payments, []);
  const deletion = await s.post("/api/orders/delete", { orderId: "moved-order" });
  assert.equal(deletion.response.status, 409, JSON.stringify(deletion.body));
  assert.deepEqual(await s.readPersistedState(), before);
  assert.deepEqual(inTankIds(await s.readPersistedState()), ["stocktake-added-fish", "unrelated-fish"]);
});

test("direct-transfer cancellation returns to transit and does not add a physical tank record", async (t) => {
  const s = await setup(t, () => {}, true);
  const item = (await s.readPersistedState()).stock.find((row) => row.id === "moved-fish");
  ok(await s.post("/api/maintenance/save", { mode: "transferIssue", itemIds: [item.id], clientMutationId: "cancel-route-issue",
    expectedItems: [{ id: item.id, subTankId: item.subTankId, status: item.status, lost: false, tankTransferId: "" }] }));
  const issued = (await s.readPersistedState()).stock.find((row) => row.id === item.id);
  const shipmentId = await s.outbound({ transferDispatch: { siteId: "jiangyin", items: [{ stockItemId: item.id, transferId: issued.tankTransfer.id }] }, expectedStockLocations: {} });
  const p = await s.preview(shipmentId, "dual"); ok(p); assert.equal(p.body.items[0].restoreTransfer, true);
  ok(await s.post("/api/shipments/cancel", s.cancellation(shipmentId, p.body, []), "dual"));
  const after = await s.readPersistedState(); const restored = after.stock.find((row) => row.id === item.id);
  assert.equal(restored.tankTransfer.status, "in_transit"); assert.ok(!inTankIds(after).includes(item.id));
  assert.equal(after.stock.length, 5); assert.equal(after.shipmentCancellationAudits.length, 1);
});

test("legacy missing or lost original fish fail closed without manufacturing a returned fish", async (t) => {
  for (const kind of ["missing", "lost"]) await t.test(kind, async (t) => {
    const s = await setup(t, (state) => {
      if (kind === "missing") state.stock = state.stock.filter((row) => row.id !== "moved-fish");
      else state.stock.find((row) => row.id === "moved-fish").lost = true;
      state.shipments = [{ id: "legacy-outbound", orderId: "moved-order", siteId: "nanjing", status: "outbound", shipMethod: "express", itemStockIds: ["moved-fish"] }];
    });
    const before = await s.readPersistedState();
    assert.equal((await s.preview("legacy-outbound")).response.status, 409);
    rejected(await s.post("/api/shipments/cancel", { shipmentId: "legacy-outbound", reviewToken: "forged", confirmedPhysicalReturn: true, returnItems: [{ stockItemId: "moved-fish", subTankId: "tank-n" }] }));
    assert.deepEqual(await s.readPersistedState(), before);
  });
});
