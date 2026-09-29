import assert from "node:assert/strict";
import test from "node:test";
import { expectedOrderFulfillmentLocation, resolveOrderFulfillmentStock } from "./order-fulfillment-stock.mjs";

const state = {
  sites: [{ id: "nanjing" }, { id: "jiangyin" }],
  tankGroups: [{ siteId: "nanjing", subTanks: [{ id: "tank-n" }] }, { siteId: "jiangyin", subTanks: [{ id: "tank-j" }] }],
  stock: [{ id: "fish", siteId: "nanjing", subTankId: "tank-j" }],
};

test("fulfillment location uses unique current tank rather than stale denormalized inventory site", () => {
  const resolved = resolveOrderFulfillmentStock(state, "fish", { visibleSiteIds: ["jiangyin"] });
  assert.equal(resolved.siteId, "jiangyin");
  assert.equal(resolved.subTankId, "tank-j");
  assert.throws(() => resolveOrderFulfillmentStock(state, "fish", { visibleSiteIds: ["nanjing"] }), { statusCode: 403 });
});

test("ambiguous, missing or unconfigured physical locations fail closed", () => {
  for (const [next, code] of [
    [{ ...state, stock: [...state.stock, ...state.stock] }, "STOCK_ID_NOT_UNIQUE"],
    [{ ...state, stock: [] }, "STOCK_NOT_FOUND"],
    [{ ...state, tankGroups: [] }, "STOCK_TANK_NOT_UNIQUE"],
    [{ ...state, tankGroups: [...state.tankGroups, state.tankGroups[1]] }, "STOCK_TANK_NOT_UNIQUE"],
    [{ ...state, sites: [{ id: "nanjing" }] }, "STOCK_SITE_NOT_UNIQUE"],
  ]) assert.throws(() => resolveOrderFulfillmentStock(next, "fish", { visibleSiteIds: ["nanjing", "jiangyin"] }), { code });
});

test("optional old-client compatibility never substitutes client-provided location for current authorization", () => {
  assert.equal(expectedOrderFulfillmentLocation({}, "fish"), undefined);
  const expectedLocation = expectedOrderFulfillmentLocation({ expectedStockLocations: { fish: { siteId: "jiangyin", subTankId: "tank-j" } } }, "fish");
  assert.doesNotThrow(() => resolveOrderFulfillmentStock(state, "fish", { visibleSiteIds: ["jiangyin"], expectedLocation }));
  assert.throws(() => resolveOrderFulfillmentStock(state, "fish", { visibleSiteIds: ["nanjing"], expectedLocation: { siteId: "nanjing", subTankId: "tank-n" } }), { statusCode: 403 });
  for (const expectedLocation of [{ siteId: "nanjing", subTankId: "tank-n" }, { siteId: "jiangyin", subTankId: "other-j" }, null]) {
    assert.throws(() => resolveOrderFulfillmentStock(state, "fish", { visibleSiteIds: ["jiangyin"], expectedLocation }), { code: "SHIPMENT_STOCK_LOCATION_CONFLICT" });
  }
  for (const expectedStockLocations of [null, [], {}, "wrong"]) {
    assert.throws(() => expectedOrderFulfillmentLocation({ expectedStockLocations }, "fish"), { code: "SHIPMENT_STOCK_LOCATION_CONFLICT" });
  }
});
