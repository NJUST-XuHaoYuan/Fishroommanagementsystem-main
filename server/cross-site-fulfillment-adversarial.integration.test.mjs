import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./test-support/cross-site-fulfillment-fixture.mjs";
import { maintenanceExpectedStockSnapshot } from "./maintenance-save-rules.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
async function setup(t, fixture = crossSiteFulfillmentFixture()) {
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const tokens = {};
  for (const [role, username] of Object.entries({ admin: "pricing-admin", dual: "dual-editor", single: "pricing-editor" })) {
    tokens[role] = await server.login(username, FULFILLMENT_TEST_PASSWORD);
  }
  const outbound = (extra = {}, role = "dual") => server.request("/api/shipments/outbound", {
    token: tokens[role], body: { orderId: "moved-order", selectedItemIds: ["moved-fish"],
      shipMethod: "express", carrier: "顺丰", shipDate: "2026-09-28", actualShippingFee: 0, ...extra },
  });
  return { ...server, tokens, outbound };
}
const locations = (stock) => Object.fromEntries(stock.map((item) => [item.id, { siteId: item.siteId, subTankId: item.subTankId }]));

test("mixed-location fulfillment preserves order ownership and requires authority over every selected physical site", async (t) => {
  const fixture = crossSiteFulfillmentFixture();
  const local = { ...fixture.state.stock[0], id: "local-fish", code: "LOCAL-001", siteId: "nanjing", subTankId: "tank-n" };
  fixture.state.stock.push(local);
  fixture.state.orders[0].items.push({ ...fixture.state.orders[0].items[0], stockItemId: local.id, price: 99 });
  const s = await setup(t, fixture);
  const before = await s.readPersistedState();
  const body = { selectedItemIds: ["moved-fish", "local-fish"], expectedStockLocations: locations([fixture.state.stock[0], local]) };
  const denied = await s.outbound(body, "single");
  assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
  assert.deepEqual(await s.readPersistedState(), before);
  const result = await s.outbound(body); ok(result);
  assert.equal(result.body.shipment.siteId, "nanjing");
  const after = await s.readPersistedState();
  const { status: _beforeStatus, ...original } = before.orders[0];
  const { status: _afterStatus, ...retained } = after.orders[0];
  assert.deepEqual(retained, original, "transfer fulfillment cannot reparent or reprice the financial order");
  assert.deepEqual(after.stock, before.stock);
  const projection = await s.request("/api/state/slice?keys=stock,tankGroups,orders,shipments", { token: s.tokens.single }); ok(projection);
  assert.equal(projection.body.data.stock.some((item) => item.id === "moved-fish"), false);
  assert.equal(projection.body.data.stock.some((item) => item.id === "local-fish"), true);
  assert.equal(projection.body.data.inventoryProjection.outStockIds.includes("local-fish"), true);
  assert.equal(projection.body.data.inventoryProjection.outStockIds.includes("moved-fish"), false);
});

test("invalid cross-site selections fail without financial, stock, shipment or audit writes", async (t) => {
  const scenarios = [
    ["duplicate stock identity", (fixture) => fixture.state.stock.push({ ...fixture.state.stock[0], siteId: "nanjing", subTankId: "tank-n" })],
    ["ambiguous physical tank", (fixture) => fixture.state.tankGroups[0].subTanks.push({ id: "tank-j", name: "duplicate" })],
    ["lost fish", (fixture) => { fixture.state.stock[0].lost = true; }],
    ["already outbound", (fixture) => fixture.state.shipments.push({ id: "existing-out", orderId: "moved-order", siteId: "nanjing", status: "outbound", shipMethod: "express", itemStockIds: ["moved-fish"] })],
    ["removed inventory order line", (fixture) => { fixture.state.orders[0].items[0].inventoryRemovedAt = "2026-09-27"; }],
    ["not in order", () => {}, { selectedItemIds: ["unrelated-fish"] }],
    ["duplicate selection", () => {}, { selectedItemIds: ["moved-fish", "moved-fish"] }],
  ];
  for (const [name, change, body] of scenarios) {
    await t.test(name, async (subtest) => {
      const fixture = crossSiteFulfillmentFixture(); change(fixture);
      const s = await setup(subtest, fixture);
      const before = await s.readPersistedState();
      const result = await s.outbound(body, "admin");
      assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
      assert.deepEqual(await s.readPersistedState(), before);
    });
  }
});

test("a move after opening fulfillment rejects stale location snapshots and hidden-site actions; a fresh authorized retry succeeds", async (t) => {
  const fixture = crossSiteFulfillmentFixture({ destination: "nanjing" });
  const s = await setup(t, fixture);
  const original = (await s.readPersistedState()).stock.find((item) => item.id === "moved-fish");
  const staleLocations = locations([original]);
  const moved = await s.request("/api/maintenance/save", { token: s.tokens.admin, body: {
    mode: "move", clientMutationId: "cross-site-after-open", itemIds: [original.id], expectedItems: [maintenanceExpectedStockSnapshot(original)],
    targetSubTankId: "tank-j", moveDate: "2026-09-28", moveNotes: "弹窗打开后调拨",
  } }); ok(moved);
  const before = await s.readPersistedState();
  const stale = await s.outbound({ expectedStockLocations: staleLocations });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  assert.deepEqual(await s.readPersistedState(), before);
  const hidden = await s.outbound({ expectedStockLocations: staleLocations }, "single");
  assert.equal(hidden.response.status, 403, JSON.stringify(hidden.body));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.outbound({ expectedStockLocations: locations([before.stock.find((item) => item.id === original.id)]) }));
});

test("malformed or incomplete location expectations cannot silently fall back to a legacy write", async (t) => {
  const s = await setup(t);
  const before = await s.readPersistedState();
  for (const expectedStockLocations of [null, [], {}, "invalid", { "moved-fish": null }, { "moved-fish": {} },
    { "moved-fish": { siteId: "jiangyin", subTankId: "tank-n" } }, { "moved-fish": { siteId: "nanjing", subTankId: "tank-j" } }]) {
    const result = await s.outbound({ expectedStockLocations });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("physical-site visibility cannot grant authority over a hidden original order or its editing", async (t) => {
  const s = await setup(t, crossSiteFulfillmentFixture({ origin: "jiangyin", destination: "nanjing" }));
  const before = await s.readPersistedState();
  const read = await s.request("/api/state/slice?keys=stock,tankGroups,orders", { token: s.tokens.single }); ok(read);
  assert.equal(read.body.data.stock.some((item) => item.id === "moved-fish"), true);
  assert.deepEqual(read.body.data.orders, []);
  const out = await s.outbound({}, "single");
  assert.equal(out.response.status, 403, JSON.stringify(out.body));
  const edit = await s.request("/api/orders/update", { token: s.tokens.single, body: {
    ...before.orders[0], orderId: "moved-order", notes: "unauthorized origin edit",
  } });
  assert.equal(edit.response.status, 403, JSON.stringify(edit.body));
  assert.deepEqual(await s.readPersistedState(), before);
});
