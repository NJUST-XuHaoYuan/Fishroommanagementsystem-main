import test from "node:test";
import assert from "node:assert/strict";
import { batchPurchaseTotal, emptyPurchaseProcurement, purchasePackingProgress, purchaseLineFromProduct, removePurchaseLine, purchaseLineStepError, purchaseBasicError } from "./purchaseBatchDisplay.ts";

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
