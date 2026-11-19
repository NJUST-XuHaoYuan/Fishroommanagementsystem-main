import test from "node:test";
import assert from "node:assert/strict";
import { originalOrderSalesAmount, captureOrderSalesAmount, preserveOrderSalesSnapshots,
  refundMetadataForOrder, assertOrderSalesMetadataUnchanged } from "./order-sales-snapshots.mjs";
import { appendShipmentDamageEvent, snapshotDamageReplacements } from "./shipment-damage-utils.mjs";

test("original agreement uses declared prepaid fee and remains intact after return or cancellation", () => {
  const original = { id: "o", items: [{ price: 100 }, { price: 80 }], shippingFeeMode: "prepaid", shippingFee: 30, packagingFee: 15, discount: 5 };
  assert.equal(originalOrderSalesAmount(original), 220);
  const next = preserveOrderSalesSnapshots({ orders: [original] }, { orders: [{ ...original, status: "cancelled", items: [] }] }, "2026-11-19T12:00:00");
  assert.deepEqual(next.orders[0].salesAmountSnapshot, { amount: 220, source: "legacy", capturedAt: "2026-11-19T12:00:00" });
  assert.equal(captureOrderSalesAmount(next.orders[0], "later").salesAmountSnapshot.amount, 220);
  assert.equal(originalOrderSalesAmount({ ...original, shippingFeeMode: "free" }), 190);
  assert.equal(originalOrderSalesAmount({ ...original, source: "线下自提" }), 190);
});

test("server metadata cannot be forged, dropped or changed through a general order write", () => {
  const order = captureOrderSalesAmount({ items: [{ price: 100 }], payments: [{ id: "p", type: "refund", refundStage: "before_shipment" }] }, "now", "created");
  assert.doesNotThrow(() => assertOrderSalesMetadataUnchanged(order, { notes: "ordinary edit" }));
  assert.throws(() => assertOrderSalesMetadataUnchanged(order, { ...order, salesAmountSnapshot: { ...order.salesAmountSnapshot, amount: 1 } }), error => error.code === "ORDER_SALES_SNAPSHOT_IMMUTABLE");
  assert.throws(() => assertOrderSalesMetadataUnchanged(order, { payments: [{ ...order.payments[0], refundStage: "after_shipment" }] }), error => error.code === "ORDER_SALES_SNAPSHOT_IMMUTABLE");
  assert.throws(() => assertOrderSalesMetadataUnchanged(order, { items: [] }, { partial: false }));
});

test("refund business facts survive partial shipment and missing completed shipment history", () => {
  const order = { id: "o", status: "completed", items: [{ stockItemId: "a", productId: "p", price: 60 }] };
  assert.equal(refundMetadataForOrder(order, [], { time: "now" }).refundStage, "after_shipment");
  const before = refundMetadataForOrder({ ...order, status: "shipped" }, [{ orderId: "o", status: "shipped" }], { time: "now", stage: "before_shipment", stockItemIds: ["a"] });
  assert.equal(before.refundStage, "before_shipment"); assert.deepEqual(before.refundItems.map(item => item.stockItemId), ["a"]);
});

test("replacement snapshots use effective current sale price and preserve legacy unknown prices as unknown", () => {
  const result = snapshotDamageReplacements({ replacements: [{ originalStockItemId: "a", replacementStockItemId: "b" }],
    stock: [{ id: "b", productId: "p", basePrice: 90, priceMode: "product" }], products: [{ id: "p", defaultPrice: 150 }] });
  assert.equal(result[0].replacementSalePrice, 150);
  const legacy = { id: "s", status: "damaged", damageResolution: "reship", shippedAt: "2026-10-10T10:00:00", damageAmount: 500,
    damageReplacements: [{ originalStockItemId: "old", replacementStockItemId: "old-new" }] };
  const events = appendShipmentDamageEvent(legacy, { id: "new", time: "2026-11-19", resolution: "reship", replacements: result, replacementSaleAmount: 150 });
  assert.equal(events.length, 2); assert.equal(events[0].legacy, true); assert.equal(events[0].time, legacy.shippedAt);
  assert.equal(events[0].replacementSaleAmount, undefined); assert.equal(events[0].replacements[0].replacementSalePrice, undefined);
});

test("an explicit free replacement is priced at zero while missing, null and blank prices stay unknown", () => {
  for (const price of [0, null, undefined, "", " "]) {
    const replacements = snapshotDamageReplacements({ replacements: [{ originalStockItemId: "a", replacementStockItemId: "b" }],
      stock: [{ id: "b", productId: "p", priceMode: "manual", basePrice: price }], products: [{ id: "p", defaultPrice: 150 }] });
    assert.equal(replacements[0].replacementSalePrice, price === 0 ? 0 : undefined);
  }
});
