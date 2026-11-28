import test from "node:test";
import assert from "node:assert/strict";
import { preparePurchaseProcurement } from "./purchase-batch-costing-rules.mjs";

const products = [{ id: "p", name: "黄金吊", size: "5-6", origin: "美国", speciesId: "yellow-tang" },
  { id: "q", name: "粉蓝", size: "8-10", origin: "马尔代夫", speciesId: "powder-blue" }];
const input = () => ({ schemaVersion: 1, currency: "CNY", lines: [{ id: "line", productId: "p", productName: "伪造名称", size: "伪造规格", origin: "伪造产地",
  speciesId: "forged-species", quantity: 2, unitPrice: 200, taxWeightPercent: 100 }],
  boxes: [{ id: "box", boxNo: "1", items: [{ id: "item", lineId: "line", quantity: 2, weightPercent: 100 }] }],
  fees: { internationalFreight: 10, documentFee: 1, domesticFreight: 2, miscFee: 0, importTax: 4 },
  allocation: { totals: { totalCents: 1 } }, updatedBy: "forged", confirmedBy: "forged", confirmedAt: "1900-01-01" });
const options = { products, confirmed: true, operator: "actual-user", now: "2026-11-28T10:00:00+08:00" };

test("new lines use authoritative unique product snapshots and server audit; calculated costs cannot be supplied by client", () => {
  const data = input(); const original = structuredClone(data); const result = preparePurchaseProcurement(data, options);
  assert.deepEqual(result.lines[0], { id: "line", productId: "p", productName: "黄金吊", size: "5-6", origin: "美国", speciesId: "yellow-tang", quantity: 2, unitPrice: 200, taxWeightPercent: 100 });
  assert.equal(result.allocation.totals.totalCents, 41700);
  assert.equal(result.updatedBy, "actual-user"); assert.equal(result.confirmedBy, "actual-user");
  assert.equal(result.confirmedAt, "2026-11-28T02:00:00.000Z"); assert.deepEqual(data, original);
  assert.equal(result.bioFee, undefined); assert.equal(result.stock, undefined); assert.equal(result.payments, undefined);
});

test("existing line and product identities preserve historical snapshots after rename/archive/delete", () => {
  const current = preparePurchaseProcurement(input(), options); const before = structuredClone(current);
  for (const catalog of [[], [{ ...products[0], name: "现在新名字", origin: "新产地", archivedAt: "2026-11-28" }]]) {
    const result = preparePurchaseProcurement(input(), { ...options, current, products: catalog, operator: "editor", now: "2026-11-29T00:00:00Z" });
    assert.deepEqual(result.lines, current.lines);
    assert.equal(result.confirmedAt, current.confirmedAt); assert.equal(result.confirmedBy, current.confirmedBy);
    assert.equal(result.updatedBy, "editor"); assert.equal(result.updatedAt, "2026-11-29T00:00:00.000Z");
  }
  assert.deepEqual(current, before);
});

test("changing a product or adding a line requires a live unique product; it never inherits another line snapshot", () => {
  const current = preparePurchaseProcurement(input(), options);
  const changed = input(); changed.lines[0].productId = "q";
  assert.equal(preparePurchaseProcurement(changed, { ...options, current }).lines[0].productName, "粉蓝");
  for (const catalog of [[], [products[0], { ...products[1], archivedAt: "2026-11-28" }], [...products, { ...products[1] }]]) {
    assert.throws(() => preparePurchaseProcurement(changed, { ...options, current, products: catalog }), { code: "PURCHASE_COST_PRODUCT_INVALID", statusCode: 409 });
  }
  const renamedId = input(); renamedId.lines[0].id = "new-line"; renamedId.boxes[0].items[0].lineId = "new-line";
  assert.throws(() => preparePurchaseProcurement(renamedId, { ...options, current, products: [] }), { code: "PURCHASE_COST_PRODUCT_INVALID" });
});

test("draft does not confirm, allocate, copy client audit or infer missing manifests; current duplicates fail closed", () => {
  const draftInput = input(); draftInput.boxes = []; draftInput.lines[0].quantity = 0;
  const draft = preparePurchaseProcurement(draftInput, { ...options, confirmed: false });
  assert.equal(draft.status, "draft"); assert.equal(draft.allocation, undefined); assert.equal(draft.confirmedAt, undefined); assert.equal(draft.confirmedBy, undefined);
  assert.deepEqual(draft.boxes, []); assert.equal(draft.lines[0].quantity, 0);
  const current = preparePurchaseProcurement(input(), options); current.lines.push({ ...current.lines[0] });
  assert.throws(() => preparePurchaseProcurement(input(), { ...options, current }), { code: "PURCHASE_COST_CURRENT_LINE_AMBIGUOUS", statusCode: 409 });
  assert.throws(() => preparePurchaseProcurement(input(), { ...options, operator: " " }), { code: "PURCHASE_COST_OPERATOR_REQUIRED" });
  assert.throws(() => preparePurchaseProcurement(input(), { ...options, now: "invalid" }), { code: "PURCHASE_COST_TIME_INVALID" });
});
