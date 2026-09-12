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

test("salesperson ranking and totals count only orders inside the selected dates", () => {
  const result = buildDashboardSalespersonSeries({
    dates: ["2026-08-19", "2026-08-20"],
    personnel: [{ name: "甲" }, { name: "乙" }, { name: "未成交" }],
    orders: [
      { id: "older", date: "2026-08-18", contactPerson: "甲", amount: 10000 },
      { id: "first", date: "2026-08-19", contactPerson: "甲", amount: 10 },
      { id: "last", date: "2026-08-20", contactPerson: "乙", amount: 20 },
      { id: "newer", date: "2026-08-21", contactPerson: "甲", amount: 10000 },
      { id: "outside-person", date: "2026-08-18", contactPerson: "范围外人员", amount: 50000 },
    ],
    amountForOrder: (order) => order.amount,
  });
  assert.deepEqual(result.salespersonOptions, [
    { name: "乙", orderCount: 1, amount: 20 },
    { name: "甲", orderCount: 1, amount: 10 },
    { name: "未成交", orderCount: 0, amount: 0 },
  ]);
  assert.equal(result.dailySalespersonData.reduce((sum, day) => sum + day.total, 0), 30);
});

test("loss details preserve event site and scope after stock moves to another site", () => {
  const options = {
    dates: ["2026-09-01"],
    sites: [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }],
    tankGroups: [
      { id: "nj", name: "南京缸组", siteId: "nanjing", subTanks: [{ id: "nj1", name: "旧缸" }] },
      { id: "jy", name: "江阴缸组", siteId: "jiangyin", subTanks: [{ id: "jy1", name: "新缸" }] },
    ],
    stock: [{ id: "f1", productId: "p1", inDate: "2026-08-01", siteId: "jiangyin", subTankId: "jy1", lost: true, lossDate: "2026-09-01" }],
    products: [{ id: "p1", speciesId: "s1" }],
    species: [{ id: "s1" }],
    lossRecords: [{ id: "l1", stockItemId: "f1", date: "2026-09-01", siteId: "nanjing", subTankId: "nj1" }],
  };
  const all = buildDashboardLossSeries(options)[0];
  assert.equal(all.lossDetails[0].siteId, "nanjing");
  assert.equal(all.lossDetails[0].siteName, "南京");
  assert.equal(all.lossDetails[0].tankName, "南京缸组 / 旧缸");
  const nanjing = buildDashboardLossSeries({ ...options, siteId: "nanjing" })[0];
  assert.equal(nanjing.lostCount, 1);
  assert.equal(nanjing.stockBase, 1);
  const jiangyin = buildDashboardLossSeries({ ...options, siteId: "jiangyin" })[0];
  assert.equal(jiangyin.lostCount, 0);
  assert.equal(jiangyin.stockBase, 0);
});

test("legacy loss sites fall back to event tank, current tank, then stock site", () => {
  const result = buildDashboardLossSeries({
    dates: ["2026-09-01"],
    sites: [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }],
    tankGroups: [{ id: "jy", siteId: "jiangyin", subTanks: [{ id: "jy1" }] }],
    stock: [
      { id: "event-tank", productId: "p1", siteId: "nanjing", inDate: "2026-08-01" },
      { id: "current-tank", productId: "p1", siteId: "nanjing", subTankId: "jy1", inDate: "2026-08-01" },
      { id: "stock-site", productId: "p1", siteId: "jiangyin", inDate: "2026-08-01", lost: true, lossDate: "2026-09-01" },
    ],
    products: [{ id: "p1" }],
    lossRecords: [
      { stockItemId: "event-tank", date: "2026-09-01", subTankId: "jy1" },
      { stockItemId: "current-tank", date: "2026-09-01" },
    ],
  })[0];
  assert.equal(result.lostCount, 3);
  assert.deepEqual(result.lossDetails.map((row) => row.siteId), ["jiangyin", "jiangyin", "jiangyin"]);
  assert.deepEqual(result.lossDetails.map((row) => row.siteName), ["江阴", "江阴", "江阴"]);
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
