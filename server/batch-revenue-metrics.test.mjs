import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateCents,
  buildBatchRevenueMetrics,
} from "./batch-revenue-metrics.mjs";

function batch(id) {
  return { id };
}

function stockItem(id, batchId) {
  return { id, batchId };
}

function item(stockItemId, price, extra = {}) {
  return { stockItemId, price, ...extra };
}

function payment(amount, verificationStatus = "verified", type = "balance") {
  return { amount, verificationStatus, type };
}

function metricById(result, batchId) {
  return result.metrics.find((metric) => metric.batchId === batchId);
}

test("allocateCents uses stable largest remainders and preserves every integer cent", () => {
  assert.deepEqual(allocateCents(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocateCents(-2, [1, 1, 1]), [-1, -1, 0]);
  assert.deepEqual(allocateCents(5, [0, 2, 1]), [0, 3, 2]);
  assert.deepEqual(allocateCents(5, [0, 0]), [0, 0]);
  assert.deepEqual(allocateCents(0, [3, 2]), [0, 0]);
  assert.deepEqual(allocateCents(7, []), []);

  for (const [total, weights] of [
    [101, [100, 200, 300]],
    [-101, [100, 200, 300]],
    [999, [1, 7, 13, 29]],
  ]) {
    const allocated = allocateCents(total, weights);
    assert.equal(allocated.reduce((sum, value) => sum + value, 0), total);
    assert.ok(allocated.every(Number.isInteger));
  }
});

test("sales net allocates an order discount by item value instead of item count", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b-small"), batch("b-large")],
    stock: [stockItem("s-small", "b-small"), stockItem("s-large", "b-large")],
    orders: [{
      id: "o-discount",
      items: [item("s-small", 100), item("s-large", 300)],
      discount: 100,
    }],
  });

  assert.deepEqual(metricById(result, "b-small"), {
    batchId: "b-small",
    salesNet: 75,
    pendingReceived: 0,
    verifiedReceived: 0,
    platformReceived: 0,
    gross: 100,
    discount: 25,
    refundAdjustment: 0,
    itemCount: 1,
    orderCount: 1,
    platformOrderCount: 0,
  });
  assert.equal(metricById(result, "b-large").salesNet, 225);
  assert.equal(metricById(result, "b-large").discount, 75);
});

test("separates ordinary verified and pending collections", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
    orders: [{
      id: "o1",
      items: [item("s1", 100)],
      payments: [payment(60), payment(20, "pending")],
    }],
  });

  const metric = metricById(result, "b1");
  assert.equal(metric.salesNet, 100);
  assert.equal(metric.verifiedReceived, 60);
  assert.equal(metric.pendingReceived, 20);
});

test("treats a legacy payment without verificationStatus as verified", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
    orders: [{
      id: "o-legacy",
      items: [item("s1", 50)],
      payments: [{ type: "balance", amount: 50 }],
    }],
  });

  assert.equal(metricById(result, "b1").verifiedReceived, 50);
  assert.equal(metricById(result, "b1").pendingReceived, 0);
});

test("moves a refund from pending collection to verified collection when approved", () => {
  const input = {
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
  };
  const pending = buildBatchRevenueMetrics({
    ...input,
    orders: [{
      id: "o-refund",
      items: [item("s1", 100)],
      payments: [payment(100), payment(20, "pending", "refund")],
    }],
  });
  const verified = buildBatchRevenueMetrics({
    ...input,
    orders: [{
      id: "o-refund",
      items: [item("s1", 100)],
      payments: [payment(100), payment(20, "verified", "refund")],
    }],
  });

  assert.equal(metricById(pending, "b1").verifiedReceived, 100);
  assert.equal(metricById(pending, "b1").pendingReceived, -20);
  assert.equal(metricById(verified, "b1").verifiedReceived, 80);
  assert.equal(metricById(verified, "b1").pendingReceived, 0);
});

test("only prepaid customer shipping dilutes a partial payment's goods allocation", () => {
  const batches = [batch("prepaid"), batch("free"), batch("collect")];
  const stock = [
    stockItem("s-prepaid", "prepaid"),
    stockItem("s-free", "free"),
    stockItem("s-collect", "collect"),
  ];
  const orders = [
    {
      id: "o-prepaid",
      shippingFeeMode: "prepaid",
      shippingFee: 100,
      items: [item("s-prepaid", 100)],
      payments: [payment(100)],
    },
    {
      id: "o-free",
      shippingFeeMode: "free",
      shippingFee: 100,
      items: [item("s-free", 100)],
      payments: [payment(100)],
    },
    {
      id: "o-collect",
      shippingFeeMode: "collect",
      shippingFee: 100,
      items: [item("s-collect", 100)],
      payments: [payment(100)],
    },
  ];

  const result = buildBatchRevenueMetrics({
    batches,
    stock,
    orders,
    shipments: [{
      orderId: "o-free",
      status: "shipped",
      shipMethod: "express",
      actualShippingFee: 100,
    }],
  });

  assert.equal(metricById(result, "prepaid").verifiedReceived, 50);
  assert.equal(metricById(result, "free").verifiedReceived, 100);
  assert.equal(metricById(result, "collect").verifiedReceived, 100);
});

test("prepaid shipping uses known actual freight and otherwise falls back to quoted freight", () => {
  const common = {
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
    orders: [{
      id: "o1",
      shippingFeeMode: "prepaid",
      shippingFee: 100,
      items: [item("s1", 100)],
      payments: [payment(100)],
    }],
  };
  const knownActual = buildBatchRevenueMetrics({
    ...common,
    shipments: [{
      orderId: "o1",
      status: "shipped",
      shipMethod: "express",
      actualShippingFee: 50,
    }],
  });
  const pendingActual = buildBatchRevenueMetrics({
    ...common,
    shipments: [{
      orderId: "o1",
      status: "shipped",
      shipMethod: "express",
      actualShippingFee: 0,
    }],
  });

  assert.equal(metricById(knownActual, "b1").verifiedReceived, 66.67);
  assert.equal(metricById(pendingActual, "b1").verifiedReceived, 50);
});

test("packaging is allocated before a partial collection reaches goods", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
    orders: [{
      id: "o-package",
      items: [item("s1", 100)],
      packagingFee: 100,
      payments: [payment(100)],
    }],
  });

  assert.equal(metricById(result, "b1").salesNet, 100);
  assert.equal(metricById(result, "b1").verifiedReceived, 50);
});

test("allocates one order's collections across procurement batches by sales net", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1"), batch("b2")],
    stock: [stockItem("s1", "b1"), stockItem("s2", "b2")],
    orders: [{
      id: "o-cross-batch",
      items: [item("s1", 100), item("s2", 300)],
      payments: [payment(200)],
    }],
  });

  assert.equal(metricById(result, "b1").verifiedReceived, 50);
  assert.equal(metricById(result, "b2").verifiedReceived, 150);
  assert.equal(result.metrics.reduce((sum, metric) => sum + metric.verifiedReceived, 0), 200);
});

test("applies a damage refund only to the shipment's specified stock item", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1"), batch("b2")],
    stock: [stockItem("s1", "b1"), stockItem("s2", "b2")],
    orders: [{
      id: "o-damage",
      items: [item("s1", 100), item("s2", 300)],
      discount: 40,
    }],
    shipments: [{
      orderId: "o-damage",
      status: "damaged",
      damageResolution: "refund",
      damageItemStockIds: ["s1"],
      itemStockIds: ["s1", "s2"],
      damageRefundAmount: 50,
    }],
  });

  const damaged = metricById(result, "b1");
  const untouched = metricById(result, "b2");
  assert.equal(damaged.gross, 100);
  assert.equal(damaged.discount, 10);
  assert.equal(damaged.refundAdjustment, 50);
  assert.equal(damaged.salesNet, 40);
  assert.equal(untouched.discount, 30);
  assert.equal(untouched.refundAdjustment, 0);
  assert.equal(untouched.salesNet, 270);
});

test("excludes cancelled orders from every batch metric", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1")],
    stock: [stockItem("s1", "b1")],
    orders: [{
      id: "o-cancelled",
      status: "cancelled",
      items: [item("s1", 100)],
      payments: [payment(100)],
    }],
  });

  assert.deepEqual(metricById(result, "b1"), {
    batchId: "b1",
    salesNet: 0,
    pendingReceived: 0,
    verifiedReceived: 0,
    platformReceived: 0,
    gross: 0,
    discount: 0,
    refundAdjustment: 0,
    itemCount: 0,
    orderCount: 0,
    platformOrderCount: 0,
  });
});

test("matched Douyin rows sum incomeTotal, normalize order numbers, and override payments", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("settled"), batch("zero-settlement")],
    stock: [stockItem("s1", "settled"), stockItem("s2", "zero-settlement")],
    orders: [
      {
        id: "o-platform",
        source: "平台下单",
        douyinOrderNo: '=\"12 34\"',
        items: [item("s1", 100)],
        payments: [payment(88)],
      },
      {
        id: "o-platform-zero",
        source: "平台下单",
        platformOrderNo: "0007",
        items: [item("s2", 80)],
        payments: [payment(80)],
      },
    ],
    platformSettlements: [
      {
        external_order_no: "'1234",
        income_total: 20,
        settlement_amount: 999,
      },
      {
        data: {
          externalOrderNo: "12 34",
          incomeTotal: 30,
          settlementAmount: 999,
        },
      },
      {
        external_order_no: "0007",
        income_total: 0,
        settlement_amount: 80,
      },
    ],
  });

  const settled = metricById(result, "settled");
  assert.equal(settled.verifiedReceived, 50);
  assert.equal(settled.platformReceived, 50);
  assert.equal(settled.pendingReceived, 0);
  assert.equal(settled.platformOrderCount, 1);

  const zero = metricById(result, "zero-settlement");
  assert.equal(zero.verifiedReceived, 0);
  assert.equal(zero.platformReceived, 0);
  assert.equal(zero.platformOrderCount, 1);
});

test("platform order matching prefers the current field and falls back from a blank legacy field", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("current"), batch("legacy-fallback")],
    stock: [stockItem("s-current", "current"), stockItem("s-legacy", "legacy-fallback")],
    orders: [
      {
        id: "o-current",
        source: "平台下单",
        platformOrderNo: "CURRENT-1",
        douyinOrderNo: "STALE-1",
        items: [item("s-current", 100)],
        payments: [payment(99)],
      },
      {
        id: "o-legacy-fallback",
        source: "平台下单",
        platformOrderNo: "",
        douyinOrderNo: "LEGACY-2",
        items: [item("s-legacy", 100)],
        payments: [payment(98)],
      },
    ],
    platformSettlements: [
      { external_order_no: "CURRENT-1", income_total: 61 },
      { external_order_no: "STALE-1", income_total: 11 },
      { external_order_no: "LEGACY-2", income_total: 72 },
    ],
  });

  assert.equal(metricById(result, "current").verifiedReceived, 61);
  assert.equal(metricById(result, "current").platformReceived, 61);
  assert.equal(metricById(result, "legacy-fallback").verifiedReceived, 72);
  assert.equal(metricById(result, "legacy-fallback").platformReceived, 72);
});

test("reports each batch's earliest valid stock-in date without exposing stock rows", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("b1"), batch("b2")],
    stock: [
      { ...stockItem("s1", "b1"), inDate: "2026-08-12" },
      { ...stockItem("s2", "b1"), inDate: "2026-08-03T10:30:00+08:00" },
      { ...stockItem("s3", "b1"), inDate: "invalid" },
      { ...stockItem("s4", "missing"), inDate: "2026-01-01" },
    ],
  });

  assert.equal(metricById(result, "b1").earliestStockInDate, "2026-08-03");
  assert.equal(Object.hasOwn(metricById(result, "b2"), "earliestStockInDate"), false);
  assert.equal(Object.hasOwn(metricById(result, "b1"), "stock"), false);
});

test("reports items whose procurement batch cannot be assigned without leaking rows", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch("known")],
    stock: [stockItem("s-known", "known"), stockItem("s-missing", "missing")],
    orders: [{
      id: "o-unassigned",
      items: [item("s-known", 100), item("s-missing", 300)],
      payments: [payment(400)],
    }],
  });

  assert.equal(metricById(result, "known").salesNet, 100);
  assert.equal(metricById(result, "known").verifiedReceived, 100);
  assert.deepEqual(result.diagnostics, {
    unassignedItemCount: 1,
    unassignedSalesNet: 300,
  });
  assert.equal(result.metrics.length, 1);
});

test("coerces invalid and negative money to zero and keeps output finite", () => {
  const result = buildBatchRevenueMetrics({
    batches: [batch(" b1 "), batch(""), batch(null)],
    stock: [stockItem("s-valid", "b1"), stockItem("s-invalid", "b1")],
    orders: [{
      id: "o-invalid-money",
      items: [item("s-valid", "10.005"), item("s-invalid", Number.POSITIVE_INFINITY)],
      discount: "not-a-number",
      shippingFee: Number.NaN,
      packagingFee: -100,
      payments: [
        payment("10.005"),
        payment(Number.POSITIVE_INFINITY),
        payment(-50),
        payment("garbage", "verified", "refund"),
      ],
    }],
  });

  assert.equal(result.metrics.length, 1);
  assert.deepEqual(metricById(result, "b1"), {
    batchId: "b1",
    salesNet: 10.01,
    pendingReceived: 0,
    verifiedReceived: 10.01,
    platformReceived: 0,
    gross: 10.01,
    discount: 0,
    refundAdjustment: 0,
    itemCount: 2,
    orderCount: 1,
    platformOrderCount: 0,
  });
  assert.ok(Object.values(metricById(result, "b1"))
    .filter((value) => typeof value === "number")
    .every(Number.isFinite));
});
