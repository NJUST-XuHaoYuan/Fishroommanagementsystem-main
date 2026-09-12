import assert from "node:assert/strict";
import test from "node:test";
import { buildLinkedOrderNavigation } from "./linkedOrderNavigation.ts";

const base = {
  orderId: "order-1",
  activeSiteId: "nanjing",
  sourceView: "batches",
  canAccessSite: (siteId) => ["nanjing", "jiangyin"].includes(siteId),
};

test("batch details open a cross-site order without loading orders first", () => {
  assert.deepEqual(buildLinkedOrderNavigation({ ...base, requestedSiteId: "jiangyin" }), {
    orderId: "order-1",
    targetSiteId: "jiangyin",
    returnView: "batches",
    returnSiteId: "nanjing",
  });
});

test("the latest authenticated detail takes precedence over a stale cached order site", () => {
  const result = buildLinkedOrderNavigation({
    ...base, requestedSiteId: "jiangyin", cachedOrderSiteId: "nanjing",
  });
  assert.equal(result.targetSiteId, "jiangyin");
});

test("explicit forbidden, unknown, blank and all-site targets cannot bypass site access", () => {
  for (const requestedSiteId of ["jiangyin", "unknown", "", " ", "all"]) {
    assert.equal(buildLinkedOrderNavigation({
      ...base,
      requestedSiteId,
      cachedOrderSiteId: "nanjing",
      canAccessSite: (siteId) => siteId === "nanjing",
    }), null);
  }
});

test("existing inventory, daily and notification links preserve their source and loaded site", () => {
  for (const sourceView of ["stockIn", "daily", "notifications"]) {
    assert.deepEqual(buildLinkedOrderNavigation({
      ...base, sourceView, cachedOrderSiteId: "jiangyin",
    }), {
      orderId: "order-1",
      targetSiteId: "jiangyin",
      returnView: sourceView,
      returnSiteId: "nanjing",
    });
  }
});

test("links without a site keep the active site and do not manufacture a return route", () => {
  assert.deepEqual(buildLinkedOrderNavigation({ ...base, sourceView: "orders" }), {
    orderId: "order-1",
    targetSiteId: "nanjing",
    returnView: undefined,
    returnSiteId: "nanjing",
  });
});

test("blank order IDs and a forbidden cached order site are rejected", () => {
  assert.equal(buildLinkedOrderNavigation({ ...base, orderId: " " }), null);
  assert.equal(buildLinkedOrderNavigation({ ...base, cachedOrderSiteId: "unavailable" }), null);
});
