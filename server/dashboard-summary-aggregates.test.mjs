import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardFinanceSeries,
  buildDashboardFocusDetail,
  buildDashboardFocusOptions,
  buildDashboardLossSeries,
  buildDashboardSalespersonSeries,
  indexShipmentsByOrder,
} from "./dashboard-summary-aggregates.mjs";

function dates(count) {
  return Array.from({ length: count }, (_, index) => `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`);
}

test("finance aggregation scans each order once regardless of chart range", () => {
  const chartDates = dates(730);
  let amountCalls = 0;
  let verificationCalls = 0;
  const orders = [
    { id: "o1", date: chartDates[0], source: "私域线上", payments: [{ type: "balance", amount: 20, time: chartDates[0] }] },
    { id: "o2", date: chartDates[729], source: "线下", payments: [{ type: "balance", amount: 30, time: chartDates[729] }] },
  ];
  const series = buildDashboardFinanceSeries({
    dates: chartDates,
    orders,
    shipments: [],
    amountForOrder: () => { amountCalls += 1; return 50; },
    isPaymentVerified: () => { verificationCalls += 1; return true; },
    isValidSalesOrder: () => true,
  });
  assert.equal(series.length, 730);
  assert.equal(amountCalls, orders.length);
  assert.equal(verificationCalls, 2);
  assert.equal(series[0].received, 20);
  assert.equal(series[729].received, 30);
});

test("salesperson aggregation computes each valid order amount once", () => {
  let amountCalls = 0;
  const orders = [
    { id: "o1", date: "2026-08-19", contactPerson: "甲", items: [{ price: 10 }] },
    { id: "o2", date: "2026-08-19", contactPerson: "乙", items: [{ price: 20 }] },
  ];
  const result = buildDashboardSalespersonSeries({
    dates: ["2026-08-19"],
    orders,
    shipmentsByOrderId: indexShipmentsByOrder([]),
    amountForOrder: (order) => { amountCalls += 1; return order.items[0].price; },
    isValidSalesOrder: () => true,
  });
  assert.equal(amountCalls, orders.length);
  assert.deepEqual(result.salespersonOptions.map((item) => item.name), ["乙", "甲"]);
  assert.equal(result.dailySalespersonData[0].total, 30);
});

test("loss inventory base uses actual outbound date before shipment creation date", () => {
  const result = buildDashboardLossSeries({
    dates: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"],
    stock: [{ id: "f1", productId: "p1", batchId: "b1", inDate: "2026-08-01" }],
    products: [{ id: "p1", speciesId: "s1" }],
    species: [{ id: "s1", category: "fish" }],
    shipments: [{
      id: "sh1",
      status: "delivered",
      createdAt: "2026-08-01T09:00:00Z",
      shipDate: "2026-08-04",
      itemStockIds: ["f1"],
    }],
    isFishInventoryItem: () => true,
  });
  assert.deepEqual(result.map((point) => point.stockBase), [1, 1, 1, 1, 0]);
});

test("focus summary returns compact options and detail without raw collections", () => {
  const species = [{ id: "s1", name: "鱼一", commonNames: ["一号"] }];
  const products = [{ id: "p1", speciesId: "s1", name: "商品一", size: "M", origin: "本地" }];
  const stock = [
    { id: "f1", productId: "p1", inDate: "2026-08-01", sold: false, lost: false, status: "healthy" },
    { id: "f2", productId: "p1", inDate: "2026-08-01", sold: true, lost: false, status: "healthy" },
  ];
  const options = buildDashboardFocusOptions({ species, products, stock, outStockIds: new Set() });
  assert.equal(options.species[0].inTankCount, 2);
  const detail = buildDashboardFocusDetail({
    mode: "species",
    id: "s1",
    today: "2026-08-20",
    species,
    products,
    stock,
    orders: [{ id: "o1", date: "2026-08-19", status: "completed", items: [{ stockItemId: "f2", productId: "p1", price: 80 }] }],
    outStockIds: new Set(),
  });
  assert.equal(detail.metrics.inTank, 2);
  assert.equal(detail.metrics.salesCount, 1);
  assert.equal(detail.productRows[0].salesAmount, 80);
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "orders"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "stock"), false);
});
