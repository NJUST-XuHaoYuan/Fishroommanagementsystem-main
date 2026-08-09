import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardOrderAdjustmentTotals,
  isUnshippedOrderRefund,
  shipmentDamageAmount,
  shipmentDamagedAt,
} from "./dashboard-sales-metrics.mjs";

test("unshipped refunds count order operations regardless of finance verification", () => {
  const shipments = [{ status: "preparing", shipDate: "2026-08-10" }];
  assert.equal(isUnshippedOrderRefund({
    type: "refund",
    amount: 80,
    time: "2026-08-09T10:00:00",
    recordSource: "order",
    verificationStatus: "pending",
  }, shipments), true);
  assert.equal(isUnshippedOrderRefund({
    type: "refund",
    amount: 80,
    time: "2026-08-09T10:00:00",
    recordSource: "finance",
    verificationStatus: "verified",
  }, shipments), false);
});

test("refunds recorded after fulfillment are not counted as unshipped refunds", () => {
  const shipments = [{
    status: "damaged",
    shipDate: "2026-08-08",
    shippedAt: "2026-08-08T15:00:00",
  }];
  assert.equal(isUnshippedOrderRefund({
    type: "refund",
    amount: 120,
    time: "2026-08-09T10:00:00",
  }, shipments), false);
  assert.equal(isUnshippedOrderRefund({
    type: "refund",
    amount: 120,
    time: "2026-08-08T10:00:00",
  }, shipments), true);
});

test("statement matching preserves the original order refund date and source", () => {
  const order = {
    id: "order-1",
    payments: [{
      type: "refund",
      amount: 100,
      time: "2026-08-09T14:00:00",
      recordSource: "statement",
      statementOriginal: {
        time: "2026-08-07T10:00:00",
        recordSource: "order",
      },
    }],
  };
  assert.deepEqual(
    dashboardOrderAdjustmentTotals([order], [], "2026-08-07"),
    { unshippedRefund: 100, shippedDamage: 0 }
  );
  assert.deepEqual(
    dashboardOrderAdjustmentTotals([order], [], "2026-08-09"),
    { unshippedRefund: 0, shippedDamage: 0 }
  );
});

test("damage metrics use the business snapshot for refund and reship resolutions", () => {
  const order = {
    id: "order-1",
    items: [
      { stockItemId: "fish-1", price: 120 },
      { stockItemId: "fish-2", price: 80 },
    ],
  };
  assert.equal(shipmentDamageAmount({
    status: "damaged",
    damageResolution: "refund",
    damageRefundAmount: 65,
  }, order), 65);
  assert.equal(shipmentDamageAmount({
    status: "damaged",
    damageResolution: "reship",
    damageAmount: 120,
  }, order), 120);
  assert.equal(shipmentDamageAmount({
    status: "damaged",
    damageResolution: "reship",
    damageItemStockIds: ["fish-2"],
  }, order), 80);
});

test("legacy damage uses the post-shipment order refund time without double counting it", () => {
  const order = {
    id: "order-1",
    payments: [{
      type: "refund",
      amount: 80,
      time: "2026-08-09T10:00:00",
    }],
  };
  const shipment = {
    orderId: "order-1",
    status: "damaged",
    shippedAt: "2026-08-08T15:00:00",
    damageResolution: "refund",
    damageRefundAmount: 80,
  };
  assert.equal(shipmentDamagedAt(shipment, order), "2026-08-09T10:00:00");
  assert.deepEqual(
    dashboardOrderAdjustmentTotals([order], [shipment], "2026-08-09"),
    { unshippedRefund: 0, shippedDamage: 80 }
  );
});

test("daily adjustment totals include every order source", () => {
  const orders = ["抖音", "闲鱼", "微拍堂", "私域线上", "线下自提"].map((source, index) => ({
    id: `order-${index}`,
    source,
    payments: [{
      type: "refund",
      amount: 10 + index,
      time: "2026-08-09T10:00:00",
      recordSource: "order",
    }],
  }));
  assert.deepEqual(
    dashboardOrderAdjustmentTotals(orders, [], "2026-08-09"),
    { unshippedRefund: 60, shippedDamage: 0 }
  );
});
