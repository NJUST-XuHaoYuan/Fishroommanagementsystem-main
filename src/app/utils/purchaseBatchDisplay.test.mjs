import test from "node:test";
import assert from "node:assert/strict";
import { batchCostBreakdown, batchPurchaseTotal, emptyPurchaseProcurement, purchasePackingProgress, purchaseLineFromProduct, removePurchaseLine, purchaseLineStepError, purchaseBasicError } from "./purchaseBatchDisplay.ts";

const product = { id: "p1", name: "黄金吊", size: "3–4", origin: "美国", speciesId: "sp1", defaultPrice: 300, imageUrl: "", notes: "" };
test("new draft has no official cost; historical draft including a zero retains its official total", () => {
  const draft = emptyPurchaseProcurement();
  assert.equal(batchPurchaseTotal({ bioFee: 0, shippingFee: 0, procurement: draft }), null);
  assert.equal(batchPurchaseTotal({ bioFee: 1000, shippingFee: 200, totalCost: 1200, procurement: draft }), 1200);
  assert.equal(batchPurchaseTotal({ bioFee: 0, shippingFee: 0, totalCost: 0, procurement: draft }), 0);
  assert.equal(batchPurchaseTotal({ bioFee: 1000, shippingFee: 200 }), 1200);
  assert.equal(batchPurchaseTotal({ bioFee: 1000, shippingFee: 200, totalCost: 1600 }), 1600);
});
test("same product lines remain separate; new procurement never copies sale price into purchase price", () => {
  const first = purchaseLineFromProduct(product, "a"); const second = purchaseLineFromProduct(product, "b");
  assert.equal(first.unitPrice, 0); assert.equal(first.taxWeightPercent, 100);
  first.quantity = 10; second.quantity = 20; second.unitPrice = 100;
  const progress = purchasePackingProgress([first, second], [{ id: "box", boxNo: "1", items: [{ id: "i", lineId: "b", quantity: 20, weightPercent: 100 }] }]);
  assert.equal(progress[0].remaining, 10); assert.equal(progress[1].remaining, 0);
});
test("deleting a procurement line removes only its box allocations and preserves other line identity", () => {
  const procurement = emptyPurchaseProcurement(); procurement.lines = [purchaseLineFromProduct(product, "a"), purchaseLineFromProduct(product, "b")];
  procurement.boxes = [{ id: "box", boxNo: "1", items: [{ id: "ia", lineId: "a", quantity: 1, weightPercent: 50 }, { id: "ib", lineId: "b", quantity: 1, weightPercent: 50 }] }];
  const next = removePurchaseLine(procurement, "a");
  assert.deepEqual(next.lines.map(line => line.id), ["b"]); assert.deepEqual(next.boxes[0].items.map(item => item.id), ["ib"]);
  assert.equal(procurement.lines.length, 2);
});
test("step validation rejects missing numeric input and invalid quantities while retaining valid zero price", () => {
  const line = { ...purchaseLineFromProduct(product, "a"), quantity: 2 };
  assert.equal(purchaseLineStepError([line]), "");
  for (const quantity of [NaN, 0, -1, 1.5]) assert.match(purchaseLineStepError([{ ...line, quantity }]), /数量/);
  for (const unitPrice of [NaN, -1, .001]) assert.match(purchaseLineStepError([{ ...line, unitPrice }]), /单价/);
  assert.match(purchaseBasicError({ supplier: " ", arrivalDate: "2026-11-28" }, "2026-11-28"), /供应商/);
  assert.match(purchaseBasicError({ supplier: "供货方", arrivalDate: "2026-11-28" }, "2026-11-28", "2026-11-20"), /最早入库/);
});


const breakdownAmounts = result => Object.fromEntries(result.rows.map(row => [row.key, row.amount]));
const confirmedBreakdownBatch = () => ({ bioFee: 999, shippingFee: 888, totalCost: 160.36,
  procurement: { ...emptyPurchaseProcurement(), status: "confirmed", allocation: { totals: {
    purchaseCents: 10001, internationalFreightCents: 2002, documentFeeCents: 1003,
    domesticFreightCents: 1504, miscFeeCents: 505, importTaxCents: 1021, totalCents: 16036,
  } } },
});
test("confirmed breakdown uses all six saved allocation amounts and reconciles to the official batch total", () => {
  const batch = confirmedBreakdownBatch(); const result = batchCostBreakdown(batch);
  assert.equal(result.mode, "confirmed"); assert.equal(result.total, batchPurchaseTotal(batch));
  assert.deepEqual(breakdownAmounts(result), { purchase: 100.01, internationalFreight: 20.02, documentFee: 10.03,
    domesticFreight: 15.04, miscFee: 5.05, importTax: 10.21 });
  assert.deepEqual(result.rows.map(row => row.label), ["生物采购金额", "国际运费", "文件费", "国内运费", "杂费", "进口税金"]);
});
test("draft breakdown estimates with integer cents and never mixes in the old official cost", () => {
  const procurement = emptyPurchaseProcurement(); procurement.lines = [
    { ...purchaseLineFromProduct(product, "a"), quantity: 3, unitPrice: 0.1 },
    { ...purchaseLineFromProduct(product, "b"), quantity: 2, unitPrice: 0.2 },
  ];
  procurement.fees = { internationalFreight: .1, documentFee: .2, domesticFreight: .3, miscFee: .4, importTax: .5 };
  const batch = { bioFee: 1000, shippingFee: 200, totalCost: 1200, procurement };
  const result = batchCostBreakdown(batch);
  assert.equal(result.mode, "draft"); assert.equal(result.total, 2.2); assert.equal(result.rows[0].amount, .7);
  assert.equal(batchPurchaseTotal(batch), 1200, "official historical total is unchanged by draft estimates");
});
test("an empty or incomplete draft stays unknown while an explicitly valid zero-price purchase can estimate zero", () => {
  const procurement = emptyPurchaseProcurement();
  let result = batchCostBreakdown({ bioFee: 0, shippingFee: 0, totalCost: 0, procurement });
  assert.equal(result.mode, "draft"); assert.equal(result.total, null); assert.equal(result.rows[0].amount, null);
  procurement.lines = [purchaseLineFromProduct(product, "a")];
  assert.equal(batchCostBreakdown({ bioFee: 0, shippingFee: 0, procurement }).total, null);
  procurement.lines[0].quantity = 2;
  assert.equal(batchCostBreakdown({ bioFee: 0, shippingFee: 0, procurement }).total, 0);
});
test("legacy breakdown retains two recorded fields and marks every unitemized fee unknown", () => {
  const result = batchCostBreakdown({ bioFee: 1000, shippingFee: 200 });
  assert.equal(result.mode, "legacy"); assert.equal(result.total, 1200);
  assert.deepEqual(breakdownAmounts(result), { purchase: 1000, internationalFreight: 200, documentFee: null, domesticFreight: null, miscFee: null, importTax: null });
  assert.equal(result.rows[1].label, "运输费用");
  assert.equal(batchCostBreakdown({ bioFee: 1000, shippingFee: 200, totalCost: 1600 }).total, 1600);
  assert.equal(batchCostBreakdown({ bioFee: 0, shippingFee: 0, totalCost: 0 }).total, 0);
  assert.equal(batchCostBreakdown({}).total, null);
});
test("invalid, missing, fractional-cent and unsafe costs fail closed without NaN or a misleading total", () => {
  for (const invalid of [NaN, Infinity, -1, .001, "10", null, undefined, Number.MAX_SAFE_INTEGER]) {
    const procurement = emptyPurchaseProcurement(); procurement.lines = [{ ...purchaseLineFromProduct(product, "a"), quantity: 2, unitPrice: invalid }];
    const draft = batchCostBreakdown({ bioFee: 1, shippingFee: 1, procurement });
    assert.equal(draft.total, null); assert.equal(draft.rows[0].amount, null);
    const legacy = batchCostBreakdown({ bioFee: invalid, shippingFee: 1 });
    assert.equal(legacy.rows[0].amount, null); assert.equal(legacy.total, null);
  }
  const badFee = emptyPurchaseProcurement(); badFee.lines = [{ ...purchaseLineFromProduct(product, "a"), quantity: 1, unitPrice: 1 }];
  badFee.fees.documentFee = NaN;
  const draft = batchCostBreakdown({ bioFee: 0, shippingFee: 0, procurement: badFee });
  assert.equal(draft.rows[2].amount, null); assert.equal(draft.total, null);
  for (const mutate of [b => { delete b.procurement.allocation; }, b => { b.procurement.allocation.totals.importTaxCents = 1.1; },
    b => { b.procurement.allocation.totals.totalCents++; }, b => { b.totalCost++; }, b => { delete b.totalCost; }]) {
    const batch = confirmedBreakdownBatch(); mutate(batch); const result = batchCostBreakdown(batch);
    assert.equal(result.total, null);
    assert.ok(result.rows.every(row => row.amount === null || Number.isFinite(row.amount)));
  }
  const overflow = emptyPurchaseProcurement(); overflow.lines = [{ ...purchaseLineFromProduct(product, "a"), quantity: Number.MAX_SAFE_INTEGER, unitPrice: 1 }];
  assert.equal(batchCostBreakdown({ bioFee: 0, shippingFee: 0, procurement: overflow }).total, null);
});
