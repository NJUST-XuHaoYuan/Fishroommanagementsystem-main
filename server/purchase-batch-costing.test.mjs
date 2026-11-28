import test from "node:test";
import assert from "node:assert/strict";
import { calculatePurchaseBatchCosting, normalizePurchaseProcurement, PURCHASE_COST_LIMITS } from "./purchase-batch-costing.mjs";

const keys = ["purchaseCents", "internationalFreightCents", "documentFeeCents", "domesticFreightCents", "miscFeeCents", "importTaxCents", "totalCents"];
const fixture = () => ({ schemaVersion: 1, currency: "CNY", status: "draft", lines: [
  { id: "a", productId: "product-a", productName: "黄金吊", size: "5cm", origin: "夏威夷", quantity: 3, unitPrice: 200, taxWeightPercent: 10 },
  { id: "b", productId: "product-b", productName: "粉蓝", size: "8cm", origin: "马尔代夫", quantity: 2, unitPrice: 100, taxWeightPercent: 100 },
], boxes: [
  { id: "box-z", boxNo: "Z", items: [{ id: "za", lineId: "a", quantity: 1, weightPercent: 40 }, { id: "zb", lineId: "b", quantity: 1, weightPercent: 60 }] },
  { id: "box-a", boxNo: "A", items: [{ id: "aa", lineId: "a", quantity: 2, weightPercent: 70 }, { id: "ab", lineId: "b", quantity: 1, weightPercent: 30 }] },
], fees: { internationalFreight: 100.01, documentFee: 1.01, domesticFreight: 2.03, miscFee: 0.01, importTax: 26 } });
const rejected = (body, code, confirmed = true) => assert.throws(() => normalizePurchaseProcurement(body, { confirmed }), error => {
  assert.equal(error.statusCode, 400); if (code) assert.equal(error.code, code); return true;
});
function conservation(result) {
  for (const key of keys) {
    assert.equal(result.lines.reduce((sum, line) => sum + BigInt(line[key]), 0n), BigInt(result.totals[key]), key);
    assert.equal(result.boxes.flatMap(box => box.items).reduce((sum, item) => sum + BigInt(item[key]), 0n), BigInt(result.totals[key]), key);
    for (const line of result.lines) assert.equal(result.boxes.flatMap(box => box.items).filter(item => item.lineId === line.lineId)
      .reduce((sum, item) => sum + BigInt(item[key]), 0n), BigInt(line[key]), `${line.lineId} ${key}`);
  }
  for (const box of result.boxes) assert.equal(box.items.reduce((sum, item) => sum + item.internationalFreightCents, 0), box.freightCents);
  for (const amount of [result.totals, ...result.lines, ...result.boxes.flatMap(box => box.items)]) {
    for (const key of keys) assert.ok(Number.isSafeInteger(amount[key]) && amount[key] >= 0);
    assert.equal(keys.slice(0, -1).reduce((sum, key) => sum + BigInt(amount[key]), 0n), BigInt(amount.totalCents));
  }
}

test("freight splits equally across boxes then by aggregate species weight; other costs use original purchase quantity", () => {
  const input = fixture(); input.stockedCount = 1; input.lossCount = 4;
  const before = structuredClone(input); const result = calculatePurchaseBatchCosting(input);
  assert.deepEqual(result.totals, { purchaseCents: 80000, internationalFreightCents: 10001, documentFeeCents: 101,
    domesticFreightCents: 203, miscFeeCents: 1, importTaxCents: 2600, totalCents: 92906, quantity: 5, lineCount: 2, productCount: 2, boxCount: 2 });
  assert.deepEqual(result.lines.map(line => [line.lineId, line.internationalFreightCents, line.documentFeeCents, line.domesticFreightCents, line.miscFeeCents, line.importTaxCents, line.totalCents]),
    [["a", 5501, 61, 122, 1, 600, 66285], ["b", 4500, 40, 81, 0, 2000, 26621]]);
  assert.deepEqual(result.boxes.map(box => [box.boxId, box.freightCents]), [["box-z", 5000], ["box-a", 5001]]);
  assert.deepEqual(input, before); conservation(result);
});

test("tax percentage is a relative purchase-value weight, not a tax charge; zero tax and zero weights remain valid", () => {
  const input = fixture(); input.lines[0].quantity = 1; input.lines[1].quantity = 1;
  input.boxes = [{ id: "box", boxNo: "1", items: [{ id: "a", lineId: "a", quantity: 1, weightPercent: 50 }, { id: "b", lineId: "b", quantity: 1, weightPercent: 50 }] }];
  input.fees.importTax = 12;
  const result = calculatePurchaseBatchCosting(input);
  // 200 * 10% = 20 and 100 * 100% = 100. The supplied tax 12 splits 2:10.
  assert.deepEqual(result.lines.map(line => line.importTaxCents), [200, 1000]);
  input.lines.forEach(line => { line.taxWeightPercent = 0; });
  rejected(input, "PURCHASE_COST_TAX_WEIGHT_ZERO");
  input.fees.importTax = 0;
  assert.deepEqual(calculatePurchaseBatchCosting(input).lines.map(line => line.importTaxCents), [0, 0]);
  input.fees.importTax = 0.01; input.lines[1].taxWeightPercent = 100;
  assert.deepEqual(calculatePurchaseBatchCosting(input).lines.map(line => line.importTaxCents), [0, 1]);
});

test("every cent and tie winner is stable when lines, boxes or box items are reordered", () => {
  const input = fixture(); input.fees = { internationalFreight: 0.03, documentFee: 0.01, domesticFreight: 0.03, miscFee: 0.07, importTax: 0.01 };
  const first = calculatePurchaseBatchCosting(input);
  const reordered = structuredClone(input); reordered.lines.reverse(); reordered.boxes.reverse(); reordered.boxes.forEach(box => box.items.reverse());
  const second = calculatePurchaseBatchCosting(reordered);
  assert.deepEqual(second.totals, first.totals);
  for (const line of first.lines) assert.deepEqual(second.lines.find(row => row.lineId === line.lineId), line);
  for (const box of first.boxes) {
    const next = second.boxes.find(row => row.boxId === box.boxId); assert.equal(next.freightCents, box.freightCents);
    for (const item of box.items) assert.deepEqual(next.items.find(row => row.itemId === item.itemId), item);
  }
  conservation(first); conservation(second);
});

test("one product purchased at distinct prices keeps independent line weights and allocations", () => {
  const input = fixture(); input.lines[1].productId = input.lines[0].productId;
  const result = calculatePurchaseBatchCosting(input);
  assert.equal(result.totals.productCount, 1); assert.equal(result.totals.lineCount, 2);
  assert.deepEqual(result.lines.map(line => [line.lineId, line.purchaseCents, line.internationalFreightCents, line.importTaxCents]),
    [["a", 60000, 5501, 600], ["b", 20000, 4500, 2000]]);
  conservation(result);
});

test("drafts allow unfinished quantities and box lists without preserving forged allocation or server audit", () => {
  const result = normalizePurchaseProcurement({ ...fixture(), lines: [], boxes: [], allocation: { totalCents: 999 }, confirmedBy: "forged", updatedAt: "forged" });
  assert.equal(result.status, "draft"); assert.equal(result.allocation, undefined); assert.equal(result.confirmedBy, undefined); assert.equal(result.updatedAt, undefined);
  const input = fixture(); input.lines[0].quantity = 0; input.boxes = [];
  assert.equal(normalizePurchaseProcurement(input).lines[0].quantity, 0);
  rejected(input, "PURCHASE_COST_LINES_INCOMPLETE");
  rejected({ ...fixture(), boxes: [] }, "PURCHASE_COST_BOX_INCOMPLETE");
  input.lines[0].quantity = 1; input.lines[0].taxWeightPercent = undefined;
  assert.equal(normalizePurchaseProcurement(input).lines[0].taxWeightPercent, 100);
});

test("blank, NaN, infinity, negative and overprecision inputs never silently become zero", () => {
  for (const value of ["", " ", null, false, NaN, Infinity, -1, "1e2", 0.001, "10.123", {}, []]) {
    for (const key of ["unitPrice", "taxWeightPercent"]) { const input = fixture(); input.lines[0][key] = value; rejected(input, undefined, false); }
    const fee = fixture(); fee.fees.documentFee = value; rejected(fee, undefined, false);
    const weight = fixture(); weight.boxes[0].items[0].weightPercent = value; rejected(weight, undefined, false);
  }
  for (const value of ["", " ", null, false, NaN, Infinity, -1, 1.5, "2.0", PURCHASE_COST_LIMITS.quantity + 1]) {
    const input = fixture(); input.lines[0].quantity = value; rejected(input, undefined, false);
  }
  for (const value of [100.01, 101]) { const input = fixture(); input.lines[0].taxWeightPercent = value; rejected(input, "PURCHASE_COST_LIMIT_EXCEEDED", false); }
});

test("references, IDs and box quantities are unambiguous even in drafts", () => {
  const cases = [
    [input => input.lines.push({ ...input.lines[0] }), "PURCHASE_COST_DUPLICATE_ID"],
    [input => input.boxes.push({ ...input.boxes[0] }), "PURCHASE_COST_DUPLICATE_ID"],
    [input => { input.boxes[1].items[0].id = input.boxes[0].items[0].id; }, "PURCHASE_COST_DUPLICATE_ID"],
    [input => { input.boxes[0].items[0].lineId = "missing"; }, "PURCHASE_COST_LINE_NOT_FOUND"],
    [input => input.boxes[0].items.push({ ...input.boxes[0].items[0], id: "duplicate-line" }), "PURCHASE_COST_DUPLICATE_BOX_LINE"],
    [input => { input.boxes[1].boxNo = input.boxes[0].boxNo; }, "PURCHASE_COST_DUPLICATE_BOX_NUMBER"],
  ];
  for (const [change, code] of cases) { const input = fixture(); change(input); rejected(input, code, false); }
  const incomplete = fixture(); incomplete.boxes[0].items[0].quantity = 0; rejected(incomplete, "PURCHASE_COST_BOX_INCOMPLETE");
  const mismatched = fixture(); mismatched.boxes[0].items[0].quantity = 2; rejected(mismatched, "PURCHASE_COST_QUANTITY_MISMATCH");
  const weight = fixture(); weight.boxes[0].items[0].weightPercent = 39.99; rejected(weight, "PURCHASE_COST_BOX_WEIGHT_INVALID");
  const nameless = fixture(); nameless.boxes[0].boxNo = " "; rejected(nameless);
});

test("large values use exact products up to safe integer cents and reject overflowing drafts and confirmed batches", () => {
  const input = fixture(); input.lines = [{ ...input.lines[0], quantity: 100000, unitPrice: 900719925.47, taxWeightPercent: 100 }];
  input.boxes = [{ id: "one", boxNo: "1", items: [{ id: "one-a", lineId: "a", quantity: 100000, weightPercent: 100 }] }];
  input.fees = { internationalFreight: 0, documentFee: 409.91, domesticFreight: 0, miscFee: 0, importTax: 0 };
  const exact = calculatePurchaseBatchCosting(input); assert.equal(exact.totals.totalCents, Number.MAX_SAFE_INTEGER); conservation(exact);
  input.fees.documentFee = 409.92; rejected(input, "PURCHASE_COST_LIMIT_EXCEEDED"); rejected(input, "PURCHASE_COST_LIMIT_EXCEEDED", false);
  input.lines[0].unitPrice = PURCHASE_COST_LIMITS.money + 0.01; rejected(input, "PURCHASE_COST_LIMIT_EXCEEDED", false);
  input.lines = Array.from({ length: 11 }, (_, index) => ({ ...fixture().lines[0], id: String(index), quantity: 100000 })); input.boxes = [];
  rejected(input, "PURCHASE_COST_LIMIT_EXCEEDED", false);
  rejected({ ...fixture(), lines: Array(1001).fill(fixture().lines[0]) }, "PURCHASE_COST_LIMIT_EXCEEDED", false);
  rejected({ ...fixture(), boxes: Array(1001).fill(fixture().boxes[0]) }, "PURCHASE_COST_LIMIT_EXCEEDED", false);
});

test("bounded generated box manifests preserve all component totals and equal-box freight to one cent", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const input = fixture();
    input.lines.forEach((line, index) => { line.quantity = 0; line.unitPrice = ((seed * 331 + index * 53) % 10001) / 100; line.taxWeightPercent = index ? 100 : seed % 101; });
    input.boxes = Array.from({ length: 1 + seed % 7 }, (_, index) => {
      const qa = 1 + (seed + index) % 13, qb = 1 + (seed * 2 + index) % 11;
      input.lines[0].quantity += qa; input.lines[1].quantity += qb;
      const weight = (seed * 197 + index * 29) % 10001;
      return { id: `box-${index}`, boxNo: String(index + 1), items: [{ id: `${index}-a`, lineId: "a", quantity: qa, weightPercent: weight / 100 },
        { id: `${index}-b`, lineId: "b", quantity: qb, weightPercent: (10000 - weight) / 100 }] };
    });
    Object.keys(input.fees).forEach((fee, index) => { input.fees[fee] = (seed * 107 + index * 31) / 100; });
    const result = calculatePurchaseBatchCosting(input); conservation(result);
    const freight = result.boxes.map(box => box.freightCents); assert.ok(Math.max(...freight) - Math.min(...freight) <= 1);
  }
});
