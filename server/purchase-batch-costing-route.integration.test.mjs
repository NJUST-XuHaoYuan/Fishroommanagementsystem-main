import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const clone = value => structuredClone(value);
const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const rejected = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
const forbidden = result => assert.equal(result.response.status, 403, JSON.stringify(result.body));
const conflict = result => assert.equal(result.response.status, 409, JSON.stringify(result.body));
const amountKeys = ["purchaseCents", "internationalFreightCents", "documentFeeCents", "domesticFreightCents", "miscFeeCents", "importTaxCents", "totalCents"];

function procurement() {
  return { schemaVersion: 1, currency: "CNY", status: "draft",
    lines: [
      { id: "line-a", productId: "price-product", productName: "联动价格测试", size: "5-7cm", origin: "印尼", speciesId: "price-species", quantity: 3, unitPrice: 200, taxWeightPercent: 10 },
      { id: "line-b", productId: "other-product", productName: "其他商品", size: "8cm", origin: "印尼", speciesId: "price-species", quantity: 1, unitPrice: 100, taxWeightPercent: 100 },
    ],
    boxes: [
      { id: "box-one", boxNo: "1", items: [{ id: "box-one-a", lineId: "line-a", quantity: 2, weightPercent: 50 }, { id: "box-one-b", lineId: "line-b", quantity: 1, weightPercent: 50 }] },
      { id: "box-two", boxNo: "2", items: [{ id: "box-two-a", lineId: "line-a", quantity: 1, weightPercent: 100 }] },
    ],
    fees: { internationalFreight: 100, documentFee: 8, domesticFreight: 12, miscFee: 4, importTax: 16 },
  };
}

const batchInput = batch => ({ batchNo: batch?.batchNo || "PO-COST-QA-001", supplier: batch?.supplier || "独立采购测试供应商",
  arrivalDate: batch?.arrivalDate || "2026-08-01", notes: batch?.notes || "", lossCount: batch?.lossCount || 0,
  lossProof: batch?.lossProof || [], bioFee: batch?.bioFee ?? 0, shippingFee: batch?.shippingFee ?? 0 });

async function setup(t, customize = () => {}) {
  const fixture = clone(stockPricingFixture);
  fixture.state.batches[0].createdAt = "2026-08-20T09:00:00+08:00";
  fixture.state.orders[0].payments = [{ id: "cost-unchanged-payment", type: "balance", amount: 123.45, time: "2026-09-02T09:00:00+08:00", verificationStatus: "verified", channel: "cash" }];
  customize(fixture.state);
  const s = await startMutableRouteServer(fixture); t.after(s.stop);
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await s.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  let sequence = 0;
  const batch = async id => (await s.readPersistedState()).batches.find(item => item.id === id);
  const body = async ({ id = "cost-batch-new", mode = "confirm", revision, mutationId, siteId, batch: input, procurement: cost } = {}) => {
    const current = await batch(id);
    return { siteId: siteId ?? current?.siteId ?? "nanjing", batchId: id, expectedRevision: revision ?? current?.costingRevision ?? 0,
      ...(current ? { expectedLossCount: Number(current.lossCount ?? 0) } : {}),
      clientMutationId: mutationId || `cost-request-${++sequence}`, mode, batch: { ...batchInput(current), ...input },
      ...(mode === "legacy" ? {} : { procurement: cost || procurement() }) };
  };
  const post = (request, role = "editor") => s.request("/api/batches/save", { token: tokens[role], body: request });
  const patch = (data, base, role = "editor") => s.request("/api/state/patch", { token: tokens[role], body: { patch: { batches: data }, basePatch: { batches: base } } });
  return { ...s, tokens, batch, body, post, patch };
}

function assertNoBusinessRepricing(before, after) {
  for (const key of ["products", "stock", "orders", "shipments", "lossRecords", "bioRecords"]) assert.deepEqual(after[key], before[key], key);
}

function assertAllocationsSum(allocation) {
  for (const key of amountKeys) {
    assert.equal(allocation.lines.reduce((sum, line) => sum + line[key], 0), allocation.totals[key], `line sum: ${key}`);
    assert.equal(allocation.boxes.flatMap(box => box.items).reduce((sum, item) => sum + item[key], 0), allocation.totals[key], `box item sum: ${key}`);
  }
  assert.equal(allocation.boxes.reduce((sum, box) => sum + box.freightCents, 0), allocation.totals.internationalFreightCents);
}

test("confirmed costs split freight equally per box, use aggregate row weight and discounted tax weights without repricing stock or orders", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const request = await s.body();
  const result = await s.post(request); ok(result);
  const saved = await s.batch(request.batchId); assert.deepEqual(result.body.batch, saved);
  assert.equal(saved.costingRevision, 1); assert.equal(saved.procurement.status, "confirmed");
  assert.equal(saved.bioFee, 700); assert.equal(saved.shippingFee, 100); assert.equal(saved.totalCost, 840);
  assert.equal(saved.procurement.confirmedBy, "pricing-editor");
  const allocation = saved.procurement.allocation;
  assert.deepEqual(allocation.totals, { purchaseCents: 70000, internationalFreightCents: 10000, documentFeeCents: 800,
    domesticFreightCents: 1200, miscFeeCents: 400, importTaxCents: 1600, totalCents: 84000,
    quantity: 4, lineCount: 2, productCount: 2, boxCount: 2 });
  const a = allocation.lines.find(line => line.lineId === "line-a"), b = allocation.lines.find(line => line.lineId === "line-b");
  assert.equal(a.internationalFreightCents, 7500); assert.equal(b.internationalFreightCents, 2500);
  assert.equal(a.importTaxCents, 600); assert.equal(b.importTaxCents, 1000);
  assert.equal(a.totalCents, 69900); assert.equal(b.totalCents, 14100);
  assert.equal(allocation.boxes[0].items.find(item => item.lineId === "line-a").internationalFreightCents, 2500,
    "two fish occupying 50% of one box receive 50%, not twice the other row's share");
  assertAllocationsSum(allocation);
  const after = await s.readPersistedState(); assertNoBusinessRepricing(before, after);
  assert.equal(after.operationLogs.length, before.operationLogs.length + 1);
});

test("drafting a legacy batch preserves historical fees and counts until explicit confirmation; new drafts have zero official cost", async t => {
  const s = await setup(t); const original = clone(await s.batch("batch-n")); const before = await s.readPersistedState();
  const draft = await s.post(await s.body({ id: "batch-n", mode: "draft", batch: { bioFee: 999999, shippingFee: 999999 } })); ok(draft);
  assert.equal(draft.body.batch.bioFee, original.bioFee); assert.equal(draft.body.batch.shippingFee, original.shippingFee);
  assert.equal(draft.body.batch.stockedCount, original.stockedCount); assert.equal(draft.body.batch.createdAt, original.createdAt);
  assert.equal(draft.body.batch.procurement.status, "draft"); assert.equal(draft.body.batch.costingRevision, 1);
  const fresh = await s.post(await s.body({ id: "new-draft", mode: "draft", batch: { batchNo: "PO-NEW-DRAFT", bioFee: 999, shippingFee: 999 } })); ok(fresh);
  assert.equal(fresh.body.batch.bioFee, 0); assert.equal(fresh.body.batch.shippingFee, 0); assert.equal(fresh.body.batch.totalCost ?? 0, 0);
  const confirmed = await s.post(await s.body({ id: "batch-n", mode: "confirm" })); ok(confirmed);
  assert.equal(confirmed.body.batch.totalCost, 840); assert.equal(confirmed.body.batch.costingRevision, 2);
  const locked = await s.readPersistedState();
  rejected(await s.post(await s.body({ id: "batch-n", mode: "draft" })));
  rejected(await s.post(await s.body({ id: "batch-n", mode: "legacy" })));
  assert.deepEqual(await s.readPersistedState(), locked);
  assertNoBusinessRepricing(before, locked);
});

test("authentication, batch create/update permissions and authoritative site are checked without any write on failure", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const create = await s.body();
  assert.equal((await s.post(create, "anonymous")).response.status, 401);
  forbidden(await s.post(create, "viewer"));
  forbidden(await s.post(await s.body({ id: "new-jy", siteId: "jiangyin" })));
  const hiddenBatch = await s.post(await s.body({ id: "batch-j", siteId: "nanjing" }));
  assert.equal(hiddenBatch.response.status, 404); assert.equal(hiddenBatch.body.code, "BATCH_NOT_FOUND");
  assert.deepEqual(await s.readPersistedState(), before);
  await s.patchTestPersonnel("pricing-editor", { permissions: { batches: { create: false, update: true, delete: false } } });
  forbidden(await s.post(create));
  ok(await s.post(await s.body({ id: "batch-n", mode: "draft" })));
  await s.patchTestPersonnel("pricing-editor", { permissions: { batches: { create: true, update: false, delete: false } } });
  const changed = await s.readPersistedState();
  forbidden(await s.post(await s.body({ id: "batch-n", mode: "confirm" })));
  assert.deepEqual(await s.readPersistedState(), changed);
  ok(await s.post(await s.body({ id: "new-jy", siteId: "jiangyin" }), "admin"));
});

test("client-computed allocations and audit identities are ignored in favor of authoritative recalculation", async t => {
  const s = await setup(t); const request = await s.body();
  Object.assign(request.procurement, { status: "draft", updatedBy: "forged", updatedAt: "1999-01-01", confirmedBy: "forged-admin", confirmedAt: "1999-01-01",
    allocation: { totals: { totalCents: 1 }, lines: [], boxes: [] } });
  Object.assign(request.procurement.lines[0], { productName: "forged product", size: "forged size", origin: "forged origin", speciesId: "forged-species" });
  Object.assign(request.batch, { bioFee: 1, shippingFee: 1 });
  const result = await s.post(request); ok(result);
  assert.equal(result.body.batch.totalCost, 840); assert.equal(result.body.batch.procurement.allocation.totals.totalCents, 84000);
  assert.equal(result.body.batch.procurement.status, "confirmed");
  assert.equal(result.body.batch.procurement.updatedBy, "pricing-editor"); assert.equal(result.body.batch.procurement.confirmedBy, "pricing-editor");
  assert.notEqual(result.body.batch.procurement.confirmedAt, "1999-01-01");
  assert.deepEqual(result.body.batch.procurement.lines[0], procurement().lines[0]);
  assertAllocationsSum(result.body.batch.procurement.allocation);
});

test("editing confirmed costs retains original product snapshots after catalog rename", async t => {
  const s = await setup(t); const first = await s.post(await s.body()); ok(first);
  const before = await s.readPersistedState();
  const renamed = before.products.map(product => product.id === "price-product" ? { ...product, name: "商品更名后", size: "新版规格", origin: "新版产地" } : product);
  ok(await s.request("/api/state/patch", { token: s.tokens.admin, body: { basePatch: { products: before.products }, patch: { products: renamed } } }));
  const request = await s.body();
  Object.assign(request.procurement.lines[0], { productName: "商品更名后", size: "新版规格", origin: "新版产地" });
  request.procurement.fees.miscFee = 5;
  const result = await s.post(request); ok(result);
  assert.equal(result.body.batch.totalCost, 841);
  assert.deepEqual(result.body.batch.procurement.lines[0], first.body.batch.procurement.lines[0]);
  assert.equal(result.body.batch.procurement.confirmedAt, first.body.batch.procurement.confirmedAt);
  assert.equal(result.body.batch.procurement.confirmedBy, first.body.batch.procurement.confirmedBy);
});

test("confirmation rejects invalid quantities, box references, weights, product identity and fees atomically", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const invalid = [
    p => { p.lines[0].quantity = 2.5; },
    p => { p.boxes[0].items[0].quantity = 1; },
    p => { p.boxes[0].items[0].lineId = "missing-line"; },
    p => { p.boxes[0].items[0].weightPercent = 49; },
    p => { p.lines[0].taxWeightPercent = -1; },
    p => { p.lines.forEach(line => { line.taxWeightPercent = 0; }); },
    p => { p.lines[0].productId = "missing-product"; },
    p => { p.fees.internationalFreight = -1; },
  ];
  for (const mutate of invalid) {
    const p = procurement(); mutate(p); rejected(await s.post(await s.body({ procurement: p })));
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("mutation replay is idempotent, payload changes conflict and replay after a later edit never rolls the batch back", async t => {
  const s = await setup(t); const request = await s.body({ mutationId: "fixed-costing-mutation" });
  const first = await s.post(request); ok(first); const initial = await s.readPersistedState();
  const replay = await s.post(clone(request)); ok(replay); assert.equal(replay.body.replayed, true);
  assert.deepEqual(await s.readPersistedState(), initial);
  conflict(await s.post({ ...clone(request), batch: { ...request.batch, notes: "different payload" } }));
  assert.deepEqual(await s.readPersistedState(), initial);
  const updated = await s.post(await s.body({ batch: { notes: "newer revision" } })); ok(updated);
  assert.equal(updated.body.batch.costingRevision, 2); const latest = await s.readPersistedState();
  const delayedReplay = await s.post(request); ok(delayedReplay); assert.equal(delayedReplay.body.replayed, true);
  assert.equal(delayedReplay.body.batch.costingRevision, 2); assert.equal(delayedReplay.body.batch.notes, "newer revision");
  assert.deepEqual(await s.readPersistedState(), latest);
});

test("concurrent stale writers cannot overwrite the winning allocation or add a second audit", async t => {
  const s = await setup(t); ok(await s.post(await s.body()));
  const before = await s.readPersistedState();
  const a = await s.body({ batch: { notes: "writer-a" } }), b = await s.body({ batch: { notes: "writer-b" } });
  b.procurement.fees.internationalFreight = 200;
  const results = await Promise.all([s.post(a), s.post(b)]);
  assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
  const winner = results.find(r => r.response.status === 200).body.batch;
  const after = await s.readPersistedState(); assert.deepEqual(await s.batch(winner.id), winner);
  assert.equal(winner.costingRevision, 2); assert.equal(winner.totalCost, winner.notes === "writer-a" ? 840 : 940);
  assert.equal(after.operationLogs.length, before.operationLogs.length + 1); assertNoBusinessRepricing(before, after);
});

test("generic old-client patches cannot introduce, erase or silently change upgraded procurement data", async t => {
  const s = await setup(t); const old = clone(await s.batch("batch-n"));
  for (const extra of [{ procurement: procurement() }, { costingRevision: 1 }, { totalCost: 1 }]) {
    rejected(await s.patch([{ ...old, ...extra }], [old]));
    assert.deepEqual(await s.batch("batch-n"), old);
  }
  ok(await s.post(await s.body({ id: "batch-n" })));
  const upgraded = clone(await s.batch("batch-n")), before = await s.readPersistedState();
  const withoutCost = clone(upgraded); delete withoutCost.procurement; delete withoutCost.costingRevision; delete withoutCost.totalCost;
  for (const [incoming, base] of [
    [withoutCost, upgraded],
    [{ ...old, notes: "stale client update" }, old],
    [{ ...upgraded, totalCost: 1 }, upgraded],
    [{ ...upgraded, stockedCount: 99999 }, upgraded],
  ]) {
    rejected(await s.patch([incoming], [base])); assert.deepEqual(await s.readPersistedState(), before);
  }
  // A completely unchanged stale row is harmless; it must never erase the upgrade.
  ok(await s.patch([old], [old])); assert.deepEqual(await s.batch("batch-n"), upgraded);
});

test("batch identifiers, per-site numbers and arrival chronology remain authoritative", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const input of [
    { id: "batch-n", batch: { batchNo: "RENAMED-OLD-BATCH" } },
    { id: "duplicate-number", batch: { batchNo: "PRICE-N" } },
    { id: "future-batch", batch: { arrivalDate: "2099-01-01" } },
    { id: "batch-n", batch: { arrivalDate: "2026-09-02" } },
    { id: "empty-supplier", batch: { supplier: " " } },
  ]) {
    rejected(await s.post(await s.body(input))); assert.deepEqual(await s.readPersistedState(), before);
  }
  const otherSite = await s.post(await s.body({ id: "same-number-other-site", siteId: "jiangyin", batch: { batchNo: "PRICE-N" } }), "admin"); ok(otherSite);
  assert.equal(otherSite.body.batch.siteId, "jiangyin");
});

test("cent remainders stay balanced at batch, line and box levels", async t => {
  const s = await setup(t); const p = procurement();
  p.fees = { internationalFreight: 0.01, documentFee: 0.01, domesticFreight: 0.01, miscFee: 0.01, importTax: 0.01 };
  const result = await s.post(await s.body({ procurement: p })); ok(result);
  assert.equal(result.body.batch.totalCost, 700.05); assertAllocationsSum(result.body.batch.procurement.allocation);
  for (const row of result.body.batch.procurement.allocation.lines) for (const key of amountKeys) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
});

test("legacy batch generic edits and creation cannot bypass the dedicated version check", async t => {
  const s = await setup(t); const old = clone(await s.batch("batch-n"));
  const before = await s.readPersistedState();
  const openEditorRequest = await s.body({ id: old.id, mode: "legacy", batch: { notes: "dedicated edit" } });
  for (const change of [{ notes: "old client notes" }, { bioFee: 0 }, { supplier: "old client supplier" }]) {
    const result = await s.patch([{ ...old, ...change }], [old]);
    conflict(result); assert.equal(result.body.code, "BATCH_COSTING_DEDICATED_REQUIRED");
    assert.deepEqual(await s.readPersistedState(), before);
  }
  const created = { ...old, id: "generic-created-batch", batchNo: "GENERIC-CREATE-001", stockedCount: 0, lossCount: 0 };
  const addition = await s.patch([old, created], [old]);
  conflict(addition); assert.equal(addition.body.code, "BATCH_COSTING_DEDICATED_REQUIRED");
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.patch([old], [old]));
  assert.deepEqual(await s.readPersistedState(), before, "unchanged legacy rows remain harmless");
  const saved = await s.post(openEditorRequest); ok(saved);
  assert.equal(saved.body.batch.costingRevision, 1); assert.equal(saved.body.batch.notes, "dedicated edit");
  const stale = { ...openEditorRequest, clientMutationId: "legacy-stale-editor", batch: { ...openEditorRequest.batch, notes: "stale" } };
  const failed = await s.post(stale); conflict(failed); assert.equal(failed.body.code, "BATCH_COSTING_VERSION_CONFLICT");
  assert.equal((await s.batch(old.id)).notes, "dedicated edit");
});

test("a concurrent inventory loss cannot be overwritten by an open cost editor", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const stale = await s.body({ id: "batch-n", mode: "draft" });
  const fish = before.stock.find(item => item.id === "follower");
  const loss = await s.request("/api/maintenance/save", { token: s.tokens.admin, body: {
    mode: "loss", itemIds: [fish.id], expectedItems: [{ id: fish.id, subTankId: fish.subTankId, status: fish.status, lost: Boolean(fish.lost) }],
    clientMutationId: "costing-concurrent-loss", lossDate: "2026-11-01", lossReason: "costing concurrent test", lossProof: ["/uploads/costing-loss.jpg"],
  } }); ok(loss);
  const afterLoss = await s.readPersistedState();
  const current = afterLoss.batches.find(item => item.id === "batch-n");
  assert.notEqual(current.lossCount, stale.expectedLossCount);
  assert.equal(current.costingRevision ?? 0, stale.expectedRevision);
  const failed = await s.post(stale); conflict(failed); assert.equal(failed.body.code, "BATCH_LOSS_COUNT_CONFLICT");
  assert.deepEqual(await s.readPersistedState(), afterLoss);
  const omitted = clone(stale); omitted.clientMutationId = "costing-keep-latest-loss";
  delete omitted.batch.lossCount; delete omitted.expectedLossCount;
  const saved = await s.post(omitted); ok(saved); assert.equal(saved.body.batch.lossCount, current.lossCount);
  assert.equal(saved.body.batch.costingRevision, 1);
  const edit = await s.body({ id: "batch-n", mode: "draft", batch: { lossCount: current.lossCount + 1 } });
  const noExpectation = clone(edit); delete noExpectation.expectedLossCount;
  conflict(await s.post(noExpectation));
  const explicit = await s.post(edit); ok(explicit); assert.equal(explicit.body.batch.lossCount, current.lossCount + 1);
  const replay = await s.post(edit); ok(replay); assert.equal(replay.body.replayed, true);
});

test("API rejects safe-cent totals that lose a cent when stored as a yuan number", async t => {
  const s = await setup(t); const before = await s.readPersistedState(); const p = procurement();
  p.lines = [{ ...p.lines[0], quantity: 100000, unitPrice: 900719925.47, taxWeightPercent: 100 }];
  p.boxes = [{ id: "large-box", boxNo: "1", items: [{ id: "large-item", lineId: "line-a", quantity: 100000, weightPercent: 100 }] }];
  p.fees = { internationalFreight: 0, documentFee: 409.90, domesticFreight: 0, miscFee: 0, importTax: 0 };
  const result = await s.post(await s.body({ procurement: p }));
  assert.equal(result.response.status, 400); assert.equal(result.body.code, "BATCH_COSTING_MONEY_PRECISION");
  assert.deepEqual(await s.readPersistedState(), before);
});
