import assert from "node:assert/strict";
import test from "node:test";

import { ALL_SITE_ID, stockMatchesSite } from "./sites.ts";

const tankGroups = [{
  id: "group-nanjing",
  siteId: "nanjing",
  subTanks: [{ id: "tank-nanjing", name: "南京一号缸" }],
}];

test("tank ownership wins when a stock row carries a stale conflicting siteId", () => {
  const stock = { siteId: "jiangyin", subTankId: "tank-nanjing" };

  assert.equal(stockMatchesSite(stock, "nanjing", tankGroups), true);
  assert.equal(stockMatchesSite(stock, "jiangyin", tankGroups), false);
});

test("unresolved tank ownership falls back to the stock row siteId", () => {
  const stock = { siteId: "jiangyin", subTankId: "missing-tank" };

  assert.equal(stockMatchesSite(stock, "jiangyin", tankGroups), true);
  assert.equal(stockMatchesSite(stock, "nanjing", tankGroups), false);
});

test("a tank group without a siteId also falls back to the stock row siteId", () => {
  const stock = { siteId: "jiangyin", subTankId: "legacy-tank" };
  const legacyGroups = [{ subTanks: [{ id: "legacy-tank", name: "旧缸" }] }];

  assert.equal(stockMatchesSite(stock, "jiangyin", legacyGroups), true);
  assert.equal(stockMatchesSite(stock, "nanjing", legacyGroups), false);
});

test("all-site scope includes stock regardless of tank mapping", () => {
  assert.equal(
    stockMatchesSite({ siteId: "jiangyin", subTankId: "tank-nanjing" }, ALL_SITE_ID, tankGroups),
    true,
  );
});
