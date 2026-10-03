import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildBatchRevenueMetrics } from "./batch-revenue-metrics.mjs";
import { buildBatchStockValuations } from "./batch-stock-valuations.mjs";
import { reconcileCommissionLedger } from "./commission-ledger.mjs";
import { buildDashboardLossSeries } from "./dashboard-summary-aggregates.mjs";

const NOW = new Date("2026-10-03T12:00:00+08:00");

function fixture(basePrice = 125.25) {
  return {
    sites: [{ id: "nanjing", name: "南京" }],
    batches: [{ id: "batch-1", siteId: "nanjing", batchNo: "PO-1", arrivalDate: "2026-10-01" }],
    species: [{ id: "species-1", name: "黄金吊" }],
    products: [{ id: "product-1", speciesId: "species-1", name: "黄金吊", defaultPrice: 999 }],
    tankGroups: [{ id: "group-1", name: "一号缸组", siteId: "nanjing", subTanks: [{ id: "tank-1", name: "一号缸" }] }],
    stock: [{
      id: "fish-1", siteId: "nanjing", batchId: "batch-1", productId: "product-1", subTankId: "tank-1",
      inDate: "2026-10-01", lost: true, lossDate: "2026-10-02", basePrice,
      priceMode: basePrice === 125.25 ? "product" : "manual", priceOverridden: basePrice !== 125.25,
    }],
    lossRecords: [{ id: "loss-1", stockItemId: "fish-1", siteId: "nanjing", subTankId: "tank-1", date: "2026-10-02", reason: "死亡" }],
    personnel: [{ id: "person-1", username: "seller", name: "销售员" }],
    customers: [],
    shipments: [],
    orders: [{
      id: "order-1", orderNo: "SO-1", siteId: "nanjing", source: "私域线上", status: "completed",
      createdAt: "2026-10-01T10:00:00+08:00", date: "2026-10-01", contactPersonnelId: "person-1", contactPerson: "seller",
      items: [{ stockItemId: "fish-1", productId: "product-1", price: 200 }], discount: 0,
      shippingFeeMode: "collect", shippingFee: 0, packagingFee: 0,
      payments: [{ id: "payment-1", type: "balance", amount: 200, verificationStatus: "verified", verifiedAt: "2026-10-02T10:00:00+08:00" }],
    }],
  };
}

function lossPoint(state) {
  return buildDashboardLossSeries({
    dates: ["2026-10-02"], ...state, siteId: "nanjing", defaultSiteId: "nanjing",
    isFishInventoryItem: () => true,
  })[0];
}

function lostValuation(state) {
  return buildBatchStockValuations({ ...state, visibleSiteIds: ["nanjing"] })
    .metrics.find((metric) => metric.batchId === "batch-1")?.lost;
}

test("current stock basePrice is the shared source for daily loss and retained batch-loss valuation", () => {
  const before = fixture();
  const lossRecordBefore = structuredClone(before.lossRecords);
  assert.equal(lossPoint(before).estimatedValue, 125.25);
  assert.equal(lossPoint(before).lossDetails[0].estimatedValue, 125.25);
  assert.equal(lossPoint(before).lossDetails[0].isPriceMissing, false);
  assert.deepEqual(lostValuation(before), { count: 1, estimatedSaleValue: 125.25, unpricedCount: 0 });

  const after = fixture(88.88);
  assert.equal(lossPoint(after).estimatedValue, 88.88);
  assert.equal(lossPoint(after).lossDetails[0].estimatedValue, 88.88);
  assert.deepEqual(lostValuation(after), { count: 1, estimatedSaleValue: 88.88, unpricedCount: 0 });
  assert.deepEqual(after.lossRecords, lossRecordBefore);
  assert.equal(Object.hasOwn(after.lossRecords[0], "basePrice"), false);
});

test("legacy lost stock without basePrice stays unpriced when the product default changes", async () => {
  const legacy = fixture();
  delete legacy.stock[0].basePrice;
  legacy.products[0].defaultPrice = 123.45;

  const before = lossPoint(legacy);
  assert.equal(before.estimatedValue, 0);
  assert.equal(before.lossDetails[0].estimatedValue, 0);
  assert.equal(before.lossDetails[0].isPriceMissing, true);
  assert.deepEqual(lostValuation(legacy), { count: 1, estimatedSaleValue: 0, unpricedCount: 1 });

  legacy.products[0].defaultPrice = 999.99;
  assert.deepEqual(lossPoint(legacy), before);
  assert.deepEqual(lostValuation(legacy), { count: 1, estimatedSaleValue: 0, unpricedCount: 1 });

  // The legacy assistant helper is private to local-server, so lock its shared
  // price resolver here to prevent the old mutable-product fallback returning.
  const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("function buildLossRows"), source.indexOf("function buildDailyLossData"));
  assert.match(helper, /lossStockPriceDetail\(stockItem\)/);
  assert.doesNotMatch(helper, /basePrice\s*\?\?\s*product\?\.defaultPrice/);
});

test("changing stock basePrice does not reprice historical orders, batch sales, receipts, or commission", () => {
  const before = fixture();
  const after = fixture(88.88);
  assert.deepEqual(after.orders, before.orders);

  const batchBefore = buildBatchRevenueMetrics(before);
  const batchAfter = buildBatchRevenueMetrics(after);
  assert.deepEqual(batchAfter, batchBefore);
  assert.equal(batchAfter.metrics[0].salesNet, 200);
  assert.equal(batchAfter.metrics[0].verifiedReceived, 200);

  const commissionBefore = reconcileCommissionLedger(before, [], NOW);
  const commissionAfter = reconcileCommissionLedger(after, [], NOW);
  assert.deepEqual(commissionAfter.byOrder.get("order-1"), commissionBefore.byOrder.get("order-1"));
  assert.deepEqual(commissionAfter.ledger, commissionBefore.ledger);
  assert.equal(commissionAfter.byOrder.get("order-1").commissionBase, 200);
});
