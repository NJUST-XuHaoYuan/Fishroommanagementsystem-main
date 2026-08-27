import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_SLICE_KEYS,
  planGenericStatePatchReadKeys,
  planStateSliceDependencies,
} from "./state-slice-planner.mjs";

test("global reference collections do not pull unrelated state", () => {
  assert.deepEqual(planStateSliceDependencies(["species"]), {
    requestedKeys: ["species"],
    queryKeys: ["species"],
    supportKeys: [],
    needsInventoryProjection: false,
    inventoryProjectionSourceKeys: [],
  });
});

test("site-scoped collections query site definitions without returning them", () => {
  const plan = planStateSliceDependencies(["batches"]);
  assert.deepEqual(plan.queryKeys, ["sites", "batches"]);
  assert.deepEqual(plan.supportKeys, ["sites"]);
  assert.deepEqual(plan.requestedKeys, ["batches"]);
});

test("tank-linked records include tank groups for inherited site filtering", () => {
  for (const key of ["logs", "waterQualityRecords", "checks"]) {
    const plan = planStateSliceDependencies([key]);
    assert.deepEqual(plan.queryKeys, ["sites", "tankGroups", key]);
    assert.deepEqual(plan.supportKeys, ["sites", "tankGroups"]);
  }
});

test("stock-linked history includes stock and tank groups but not projection sources", () => {
  for (const key of ["lossRecords", "bioRecords"]) {
    const plan = planStateSliceDependencies([key]);
    assert.deepEqual(plan.queryKeys, ["sites", "tankGroups", "stock", key]);
    assert.deepEqual(plan.supportKeys, ["sites", "tankGroups", "stock"]);
    assert.equal(plan.needsInventoryProjection, false);
    assert.equal(plan.queryKeys.includes("orders"), false);
    assert.equal(plan.queryKeys.includes("shipments"), false);
  }
});

test("shipment visibility includes its order relationship", () => {
  const plan = planStateSliceDependencies(["shipments"]);
  assert.deepEqual(plan.queryKeys, ["sites", "orders", "shipments"]);
  assert.deepEqual(plan.supportKeys, ["sites", "orders"]);
});

test("stock requests retain global fulfillment sources for cross-site projection", () => {
  const plan = planStateSliceDependencies(["stock"]);
  assert.deepEqual(plan.queryKeys, ["sites", "tankGroups", "stock", "orders", "shipments"]);
  assert.deepEqual(plan.supportKeys, ["sites", "tankGroups", "orders", "shipments"]);
  assert.equal(plan.needsInventoryProjection, true);
  assert.deepEqual(plan.inventoryProjectionSourceKeys, ["orders", "shipments"]);
});

test("daily-view requests are deduplicated and add only the missing site dependency", () => {
  const requested = [
    "systemSettings",
    "products",
    "tankGroups",
    "batches",
    "stock",
    "orders",
    "shipments",
    "logs",
    "waterQualityRecords",
    "bioRecords",
    "personnel",
    "stock",
  ];
  const plan = planStateSliceDependencies(requested);
  assert.deepEqual(plan.requestedKeys, requested.slice(0, -1));
  assert.deepEqual(plan.supportKeys, ["sites"]);
  assert.deepEqual(plan.queryKeys, STATE_SLICE_KEYS.filter((key) =>
    new Set([...plan.requestedKeys, "sites"]).has(key)
  ));
});

test("mixed stock history still loads fulfillment dependencies exactly once", () => {
  const plan = planStateSliceDependencies(["bioRecords", "stock", "shipments"]);
  assert.deepEqual(plan.queryKeys, ["sites", "tankGroups", "stock", "bioRecords", "orders", "shipments"]);
  assert.deepEqual(plan.supportKeys, ["sites", "tankGroups", "orders"]);
});

test("rejects unknown, empty and non-array requests", () => {
  assert.throws(() => planStateSliceDependencies("stock"), /must be an array/);
  assert.throws(() => planStateSliceDependencies(["stock", "unknown"]), /unknown/);
  assert.throws(() => planStateSliceDependencies([""]), /Invalid state slice key/);
});

test("generic settings and customer source patches read only their own fields", () => {
  const plan = planGenericStatePatchReadKeys(["customerSources", "systemSettings"]);
  assert.deepEqual(plan, ["systemSettings", "customerSources"]);
});

test("generic relationship dependencies are key-specific and deduplicated", () => {
  const plan = planGenericStatePatchReadKeys(["lossRecords", "lossRecords"]);
  assert.deepEqual(plan, ["sites", "tankGroups", "stock", "lossRecords"]);
});

test("customer mutations read orders for deletion integrity but no inventory history", () => {
  assert.deepEqual(planGenericStatePatchReadKeys(["customers"]), ["orders", "customers"]);
});

test("product mutations read only product reference owners", () => {
  assert.deepEqual(
    planGenericStatePatchReadKeys(["products"]),
    ["species", "products", "stock", "orders"],
  );
});

test("order and shipment mutations retain their exact business dependencies", () => {
  assert.deepEqual(
    planGenericStatePatchReadKeys(["orders"]),
    ["systemSettings", "sites", "personnel", "products", "tankGroups", "stock", "orders", "shipments", "customers"],
  );
  assert.deepEqual(
    planGenericStatePatchReadKeys(["shipments"]),
    ["systemSettings", "sites", "stock", "orders", "shipments"],
  );
});

test("generic patch planning never loads unrelated heavy histories or audit logs", () => {
  for (const key of STATE_SLICE_KEYS.filter((value) => !["personnel", "operationLogs", "bioRecords", "stock"].includes(value))) {
    const plan = planGenericStatePatchReadKeys([key]);
    assert.equal(plan.includes("bioRecords"), false, key);
    assert.equal(plan.includes("operationLogs"), false, key);
  }
});

test("generic patch planner rejects unknown fields", () => {
  assert.throws(() => planGenericStatePatchReadKeys(["hiddenRegistry"]), /hiddenRegistry/);
});
