import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockTransferFixture, TRANSFER_TEST_PASSWORD } from "./test-support/stock-transfer-fixture.mjs";

const ok = (r) => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const bad = (r, status = 409) => assert.equal(r.response.status, status, JSON.stringify(r.body));
const fish = (state, id = "moved-fish") => state.stock.find((item) => item.id === id);
let seq = 0;
async function setup(t, customize = () => {}) {
  const fixture = stockTransferFixture(); customize(fixture.state);
  const s = await startMutableRouteServer(fixture); t.after(s.stop);
  const tokens = {};
  for (const name of ["pricing-admin", "pricing-editor", "receiver", "dual-editor"]) tokens[name] = await s.login(name, TRANSFER_TEST_PASSWORD);
  const write = (path, body, user = "pricing-admin") => s.request(path, { body, token: tokens[user] });
  const issue = async (ids = ["moved-fish"]) => {
    const state = await s.readPersistedState();
    return write("/api/maintenance/save", { mode: "transferIssue", itemIds: ids, clientMutationId: `dispatch-${++seq}`,
      expectedItems: ids.map((id) => ({ id, subTankId: fish(state, id).subTankId, status: fish(state, id).status,
        lost: Boolean(fish(state, id).lost), tankTransferId: fish(state, id).tankTransfer?.id ?? "" })) });
  };
  const outboundBody = async (siteId = "jiangyin") => ({
    orderId: "moved-order", selectedItemIds: ["moved-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-10-24",
    expectedStockLocations: {}, transferDispatch: { siteId,
      items: [{ stockItemId: "moved-fish", transferId: fish(await s.readPersistedState()).tankTransfer.id }] },
  });
  const recent = (user = "pricing-admin") => s.request("/api/stock/transfers?view=recent", { token: tokens[user] });
  return { ...s, tokens, write, issue, outboundBody, recent };
}

test("direct in-transit outbound preserves financial ownership, clears physical tank, confirms and delivers normally", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState(); ok(await s.issue());
  const out = await s.write("/api/shipments/outbound", await s.outboundBody(), "dual-editor"); ok(out);
  const state = await s.readPersistedState(); const item = fish(state);
  assert.equal(item.siteId, "jiangyin"); assert.equal(item.subTankId, "");
  assert.equal(item.tankTransfer.status, "dispatched"); assert.equal(item.tankTransfer.fromSubTankId, "tank-n");
  assert.equal(item.tankTransfer.dispatchSiteId, "jiangyin"); assert.equal(item.tankTransfer.orderId, "moved-order");
  assert.equal(out.body.shipment.siteId, "nanjing"); assert.equal(state.orders[0].siteId, "nanjing");
  for (const key of ["basePrice", "priceMode", "batchId", "sold", "status"]) assert.equal(item[key], fish(before)[key]);
  assert.ok(out.body.stock.some((row) => row.id === item.id && row.subTankId === ""));
  const pool = await s.request("/api/stock/transfers", { token: s.tokens.receiver }); ok(pool); assert.equal(pool.body.items.length, 0);
  const recent = await s.recent("receiver"); ok(recent); assert.equal(recent.body.items[0].transferStatus, "dispatched");
  assert.doesNotMatch(JSON.stringify(recent.body), /PRIVATE_|orderId|orderNo|shipmentId|basePrice|payments|customer/);
  ok(await s.write("/api/orders/update", { ...state.orders[0], orderId: "moved-order", notes: "直接出库后仍可编辑" }, "dual-editor"));
  ok(await s.write("/api/shipments/confirm", { shipmentId: out.body.shipment.id, packingProof: ["/uploads/one.jpg", "/uploads/two.jpg"] }));
  ok(await s.write("/api/shipments/deliver", { shipmentId: out.body.shipment.id }));
  assert.equal((await s.readPersistedState()).shipments.at(-1).status, "delivered");
});

test("direct dispatch requires explicit exact cycle acknowledgement and both order and actual-site permissions", async (t) => {
  const s = await setup(t); ok(await s.issue()); const body = await s.outboundBody();
  bad(await s.write("/api/shipments/outbound", { ...body, transferDispatch: undefined }));
  for (const transferDispatch of [null, { siteId: "jiangyin", items: [] },
    { ...body.transferDispatch, items: [...body.transferDispatch.items, ...body.transferDispatch.items] },
    { ...body.transferDispatch, items: [{ stockItemId: "moved-fish", transferId: "stale" }] },
    { ...body.transferDispatch, siteId: "unknown" }]) {
    bad(await s.write("/api/shipments/outbound", { ...body, transferDispatch }));
  }
  bad(await s.write("/api/shipments/outbound", body, "pricing-editor"), 403);
  bad(await s.write("/api/shipments/outbound", body, "receiver"), 403);
  await s.patchTestPersonnel("dual-editor", { visibleSiteIds: ["nanjing"] });
  bad(await s.write("/api/shipments/outbound", body, "dual-editor"), 403);
  assert.equal(fish(await s.readPersistedState()).tankTransfer.status, "in_transit");
});

test("payment block leaves the transfer in transit and creates no dispatch event", async (t) => {
  const s = await setup(t, (state) => { Object.assign(state.orders[0], { source: "私域线上", paymentChannel: "cash",
    paymentMethodId: "cash", paymentMethodName: "现金", paymentAccount: "synthetic-account", platformOrderNo: "", douyinOrderNo: "" }); });
  ok(await s.issue()); const out = await s.write("/api/shipments/outbound", await s.outboundBody());
  bad(out); assert.equal(out.body.code, "CREDIT_SALE_CONFIRMATION_REQUIRED");
  const state = await s.readPersistedState(); assert.equal(fish(state).tankTransfer.status, "in_transit");
  assert.equal(state.bioRecords.filter((record) => record.sourceType === "stockTransferDispatched").length, 0);
});

test("outbound races receipt or duplicate outbound: exactly one transition commits", async (t) => {
  for (const kind of ["receipt", "duplicate"]) await t.test(kind, async (t) => {
    const s = await setup(t); ok(await s.issue()); const body = await s.outboundBody();
    const other = kind === "receipt" ? s.write("/api/maintenance/save", { mode: "transferReceive", targetSubTankId: "tank-j",
      items: body.transferDispatch.items, clientMutationId: `race-${++seq}` }) : s.write("/api/shipments/outbound", body);
    const result = await Promise.all([s.write("/api/shipments/outbound", body), other]);
    assert.equal(result.filter((r) => r.response.status === 200).length, 1, JSON.stringify(result.map((r) => r.body)));
    const state = await s.readPersistedState(); assert.equal(state.bioRecords.filter((r) => ["stockTransferDispatched", "stockTransferReceived"].includes(r.sourceType)).length, 1);
  });
});

test("cancel restores original transit rather than source tank inventory; stale history is suppressed and later receipt remains", async (t) => {
  const s = await setup(t); ok(await s.issue()); const original = fish(await s.readPersistedState());
  const out = await s.write("/api/shipments/outbound", await s.outboundBody()); ok(out);
  bad(await s.write("/api/shipments/cancel", { shipmentId: out.body.shipment.id }, "pricing-editor"), 403);
  ok(await s.write("/api/shipments/cancel", { shipmentId: out.body.shipment.id }, "dual-editor"));
  const state = await s.readPersistedState(); assert.deepEqual(fish(state), original);
  assert.equal(state.bioRecords.filter((r) => r.sourceType === "stockTransferDispatchCancelled").length, 1);
  assert.equal((await s.recent()).body.items.length, 0);
  assert.equal((await s.request("/api/stock/transfers", { token: s.tokens.receiver })).body.items.length, 1);
  ok(await s.write("/api/maintenance/save", { mode: "transferReceive", targetSubTankId: "tank-j", clientMutationId: `receipt-${++seq}`,
    items: [{ stockItemId: original.id, transferId: original.tankTransfer.id }] }, "receiver"));
  assert.equal((await s.recent()).body.items[0].transferStatus, "received");
});

test("delete, generic shipment mutation and system timeline edits cannot bypass restoration", async (t) => {
  const s = await setup(t); ok(await s.issue()); const out = await s.write("/api/shipments/outbound", await s.outboundBody()); ok(out);
  bad(await s.write("/api/orders/delete", { orderId: "moved-order" }));
  const state = await s.readPersistedState();
  const removed = await s.write("/api/state/patch", { patch: { shipments: state.shipments.filter((r) => r.id !== out.body.shipment.id) }, basePatch: { shipments: state.shipments } });
  bad(removed);
  const forged = await s.write("/api/state/patch", { patch: { shipments: state.shipments.map((r) => r.id === out.body.shipment.id ? { ...r, transferDispatch: undefined } : r) }, basePatch: { shipments: state.shipments } });
  assert.ok(forged.response.status >= 400);
  const event = state.bioRecords.find((r) => r.sourceType === "stockTransferDispatched");
  const deletion = await s.write("/api/bio-records/save", { action: "delete", recordId: event.id, stockItemId: event.stockItemId, expectedRecord: event });
  bad(deletion); assert.equal(deletion.body.code, "SYSTEM_BIO_RECORD_IMMUTABLE");
  assert.equal(fish(await s.readPersistedState()).tankTransfer.status, "dispatched");
});

test("recent history persists separate cycles, respects authorized related sites and keeps active endpoint unchanged", async (t) => {
  const s = await setup(t); ok(await s.issue(["unrelated-fish"]));
  const issued = fish(await s.readPersistedState(), "unrelated-fish");
  ok(await s.write("/api/maintenance/save", { mode: "transferReceive", targetSubTankId: "tank-n2", clientMutationId: `receive-${++seq}`,
    items: [{ stockItemId: issued.id, transferId: issued.tankTransfer.id }] }));
  assert.equal((await s.recent("receiver")).body.items.length, 0);
  assert.equal((await s.recent("pricing-editor")).body.items.length, 1);
  ok(await s.issue(["unrelated-fish"]));
  const second = fish(await s.readPersistedState(), "unrelated-fish");
  ok(await s.write("/api/maintenance/save", { mode: "transferReceive", targetSubTankId: "tank-j", clientMutationId: `receive-${++seq}`,
    items: [{ stockItemId: second.id, transferId: second.tankTransfer.id }] }, "receiver"));
  assert.equal((await s.recent("pricing-editor")).body.items.length, 2);
  assert.equal((await s.recent("receiver")).body.items.length, 1);
});

test("normal rows in a mixed dispatch retain source-site permission and tank-location CAS", async (t) => {
  const s = await setup(t, (state) => { state.orders[0].items.push({ ...state.orders[0].items[0], stockItemId: "unrelated-fish" }); state.stock[1].sold = true; });
  ok(await s.issue()); const body = await s.outboundBody(); body.selectedItemIds.push("unrelated-fish");
  body.expectedStockLocations = { "unrelated-fish": { siteId: "nanjing", subTankId: "wrong-tank" } };
  bad(await s.write("/api/shipments/outbound", body));
  body.expectedStockLocations["unrelated-fish"].subTankId = "tank-n";
  ok(await s.write("/api/shipments/outbound", body));
  assert.equal(fish(await s.readPersistedState(), "unrelated-fish").subTankId, "tank-n");
});

test("authorized order can see only its redacted foreign in-transit fish and dispatch at an authorized site", async (t) => {
  const s = await setup(t, (state) => {
    for (const id of ["moved-fish", "unrelated-fish"]) Object.assign(fish(state, id), { siteId: "jiangyin", subTankId: "tank-j" });
  });
  ok(await s.issue(["moved-fish", "unrelated-fish"]));
  const path = "/api/orders/transfer-items?orderId=moved-order";
  const projection = await s.request(path, { token: s.tokens["pricing-editor"] }); ok(projection);
  assert.deepEqual(projection.body.items.map((item) => item.stockItemId), ["moved-fish"]);
  assert.equal(projection.body.items[0].fromSiteId, "jiangyin");
  assert.doesNotMatch(JSON.stringify(projection.body), /PRIVATE_CUSTOMER|PRIVATE_STOCK_NOTE|PRIVATE_BIO|basePrice|payments|customerId|orderNo|orderId|batchId/);
  bad(await s.request(path, { token: s.tokens.receiver }), 403);
  const out = await s.write("/api/shipments/outbound", await s.outboundBody("nanjing"), "pricing-editor"); ok(out);
  assert.equal(fish(await s.readPersistedState()).siteId, "nanjing");
  assert.equal((await s.request(path, { token: s.tokens["pricing-editor"] })).body.items.length, 0);
});

test("damage refund and item return cannot resurrect directly dispatched stock", async (t) => {
  const s = await setup(t); ok(await s.issue()); const out = await s.write("/api/shipments/outbound", await s.outboundBody()); ok(out);
  const shipmentId = out.body.shipment.id;
  const returnAttempt = await s.write("/api/orders/return-item", { orderId: "moved-order", stockItemId: "moved-fish" });
  bad(returnAttempt, 400);
  ok(await s.write("/api/shipments/confirm", { shipmentId, packingProof: ["/uploads/one.jpg", "/uploads/two.jpg"] }));
  ok(await s.write("/api/shipments/damage", { shipmentId, resolution: "refund", damagedItemStockIds: ["moved-fish"], refundAmount: 188 }));
  bad(await s.write("/api/shipments/cancel", { shipmentId }), 400);
  bad(await s.write("/api/orders/delete", { orderId: "moved-order" }));
  const state = await s.readPersistedState(); assert.equal(fish(state).tankTransfer.status, "dispatched");
  assert.equal(fish(state).subTankId, ""); assert.equal((await s.recent()).body.items[0].transferStatus, "dispatched");
});

test("direct pickup completes without fictitious receipt and retains the shipment financial site", async (t) => {
  const s = await setup(t, (state) => Object.assign(state.orders[0], { source: "线下", customerId: "fulfillment-customer", paymentChannel: "cash" }));
  ok(await s.issue()); const body = { ...await s.outboundBody(), shipMethod: "pickup" };
  const out = await s.write("/api/shipments/outbound", body); ok(out);
  assert.equal(out.body.shipment.status, "delivered"); assert.equal(out.body.shipment.siteId, "nanjing");
  const state = await s.readPersistedState(); assert.equal(fish(state).tankTransfer.status, "dispatched");
  assert.equal(fish(state).subTankId, "");
  assert.equal(state.bioRecords.filter((record) => record.sourceType === "stockTransferReceived").length, 0);
});
