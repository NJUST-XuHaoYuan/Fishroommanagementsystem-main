import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { batchDetailsFixture, BATCH_TEST_PASSWORD } from "./test-support/batch-details-fixture.mjs";

test("batch valuation routes agree, preserve scope and remain independent of list filters", async () => {
  const fixture = structuredClone(batchDetailsFixture);
  fixture.state.checks = [];
  const cross = fixture.state.stock.find(item => item.id === "fish-cross");
  // A transferred, unsold fish remains part of its original procurement batch.
  fixture.state.orders = fixture.state.orders.filter(order => order.id !== "PRIVATE_JY_ORDER");
  cross.basePrice = 777;
  cross.priceMode = "manual";
  const server = await startMutableRouteServer(fixture);
  try {
    const admin = await server.login("batch-admin", BATCH_TEST_PASSWORD);
    const staff = await server.login("batch-staff", BATCH_TEST_PASSWORD);
    const before = await server.readPersistedState();
    const path = "/api/batches/detail?batchId=batch-nj&siteId=nanjing";
    const detail = await server.request(path, { token: admin });
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.response.headers.get("cache-control"), "no-store, private");
    const valuation = detail.body.valuation;
    assert.ok(valuation);
    assert.equal(valuation.unsold.count, 66);
    assert.equal(valuation.unsold.estimatedSaleValue, 7277);
    assert.equal(valuation.lost.count, 1);
    assert.equal(valuation.lost.estimatedSaleValue, 100);
    assert.equal(valuation.bySpecies.length, 1);
    assert.deepEqual(valuation.bySpecies[0].unsold, valuation.unsold);
    const filtered = await server.request(`${path}&search=NONMATCH&status=lost&pageSize=1&page=2`, { token: admin });
    assert.equal(filtered.body.items.length, 0);
    assert.deepEqual(filtered.body.valuation, valuation);
    const list = await server.request("/api/batches/revenue-metrics?siteId=nanjing", { token: admin });
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.metrics.find(item => item.batchId === "batch-nj").valuation, valuation);
    const restricted = await server.request(path, { token: staff });
    assert.equal(restricted.body.valuation.unsold.count, 65);
    assert.equal(restricted.body.valuation.unsold.estimatedSaleValue, 6500);
    assert.equal(restricted.body.valuation.restrictedCount, 1);
    assert.doesNotMatch(JSON.stringify(restricted.body.valuation), /777|PRIVATE_|jiangyin|tank-j1/);
    const staffList = await server.request("/api/batches/revenue-metrics?siteId=nanjing", { token: staff });
    assert.deepEqual(staffList.body.metrics.find(item => item.batchId === "batch-nj").valuation, restricted.body.valuation);
    assert.equal((await server.request("/api/batches/revenue-metrics?siteId=jiangyin", { token: staff })).response.status, 403);
    assert.equal((await server.request(path)).response.status, 401);
    assert.deepEqual(await server.readPersistedState(), before, "estimates must not change inventory, historical prices or finances");
  } finally { await server.stop(); }
});
