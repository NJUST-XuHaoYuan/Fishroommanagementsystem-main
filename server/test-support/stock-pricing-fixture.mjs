import { scryptSync } from "node:crypto";

export const PRICING_TEST_PASSWORD = "stock-pricing-route-test-password";
const salt = "stock-pricing-route-test-salt";
const password = `scrypt$1$${salt}$${scryptSync(PRICING_TEST_PASSWORD, salt, 32).toString("base64url")}`;
const fish = (id, extra = {}) => ({
  id, code: id, siteId: "nanjing", subTankId: "tank-n", batchId: "batch-n", productId: "price-product",
  inDate: "2026-09-01", basePrice: 100, priceMode: "product", priceOverridden: false,
  sold: false, lost: false, status: "healthy", notes: "", ...extra,
});
const legacy = (id, extra = {}) => {
  const item = fish(id, extra);
  delete item.priceMode;
  return item;
};
const order = (id, stockItemId, extra = {}) => ({
  id, orderNo: id, siteId: "nanjing", date: "2026-09-01", customerName: "价格测试客户", status: "confirmed", source: "私域线上",
  items: [{ stockItemId, productId: "price-product", fishCode: stockItemId, price: 123.45 }],
  payments: [], discount: 0, packagingFee: 0, shippingFee: 0, ...extra,
});

export const stockPricingFixture = {
  revision: 200,
  state: {
    _siteSchemaVersion: 4, _personnelSchemaVersion: 3,
    sites: [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }],
    personnel: ["admin", "editor", "viewer"].map((role) => ({
      id: `pricing-${role}`, username: `pricing-${role}`, name: `价格测试${role}`, password,
      accessRole: role === "admin" ? "admin" : "staff", accountEnabled: true, employmentStatus: "active", sessionVersion: 0,
      visibleSiteIds: role === "admin" ? [] : ["nanjing"],
      permissions: role === "viewer" ? {} : Object.fromEntries(["products", "daily", "stockIn", "orders", "shipments", "batches"].map((module) => [module, { create: true, update: true, delete: true }])),
    })),
    personnelProfileRequests: [], personnelPrivateAttachments: [], retiredPersonnelUsernames: [],
    species: [{ id: "price-species", name: "黄金吊", category: "刺尾鱼科" }],
    products: [
      { id: "price-product", speciesId: "price-species", name: "联动价格测试", size: "5-7cm", origin: "印尼", defaultPrice: 100, minReturnPrice: 0 },
      { id: "other-product", speciesId: "price-species", name: "其他商品", size: "8cm", origin: "印尼", defaultPrice: 777, minReturnPrice: 0 },
    ],
    tankGroups: [
      { id: "group-n", siteId: "nanjing", name: "南京测试缸", subTanks: [{ id: "tank-n", name: "N1" }] },
      { id: "group-j", siteId: "jiangyin", name: "PRIVATE_JY_TANK", subTanks: [{ id: "tank-j", name: "J1" }] },
    ],
    batches: [
      { id: "batch-n", siteId: "nanjing", batchNo: "PRICE-N", supplier: "测试供应商", arrivalDate: "2026-09-01", stockedCount: 30, lossCount: 0, bioFee: 1000, shippingFee: 0 },
      { id: "batch-j", siteId: "jiangyin", batchNo: "PRIVATE_JY_BATCH", supplier: "测试供应商", arrivalDate: "2026-09-01", stockedCount: 1, lossCount: 0, bioFee: 100, shippingFee: 0 },
    ],
    stock: [
      fish("follower"), fish("follower-stale", { basePrice: 90 }),
      fish("PRIVATE_JY_FOLLOWER", { siteId: "jiangyin", subTankId: "tank-j", batchId: "batch-j" }),
      legacy("legacy-equal"), legacy("legacy-different", { basePrice: 140 }), legacy("legacy-equal-new", { basePrice: 200 }),
      legacy("legacy-override", { priceOverridden: true }),
      fish("manual-equal", { priceMode: "manual", priceOverridden: true }),
      fish("manual-different", { priceMode: "manual", priceOverridden: true, basePrice: 150 }),
      fish("sold", { sold: true }), fish("lost", { lost: true }), fish("status-sold", { status: "sold" }),
      fish("ordered-confirmed"), fish("ordered-completed"), fish("ordered-pending"),
      fish("shipment-outbound"), fish("shipment-shipped"), fish("shipment-delivered"), fish("shipment-damaged"), fish("shipment-preparing"),
      fish("cancelled-order"), fish("removed-order-item"),
      fish("release-follower", { sold: true }),
      fish("release-manual", { sold: true, priceMode: "manual", basePrice: 145, priceOverridden: true }),
      legacy("release-legacy", { sold: true, basePrice: 145 }),
      fish("other-product-fish", { productId: "other-product", basePrice: 777 }),
    ],
    orders: [
      order("ORDER-CONFIRMED", "ordered-confirmed"),
      order("ORDER-COMPLETED", "ordered-completed", { status: "completed" }),
      order("ORDER-PENDING", "ordered-pending", { status: "pending" }),
      order("ORDER-CANCELLED", "cancelled-order", { status: "cancelled" }),
      order("ORDER-REMOVED", "removed-order-item", { items: [{ stockItemId: "removed-order-item", productId: "price-product", price: 246.89, inventoryRemovedAt: "2026-09-02T10:00:00+08:00" }] }),
      order("ORDER-RELEASE", "release-follower", { items: ["release-follower", "release-manual", "release-legacy"].map((stockItemId) => ({ stockItemId, productId: "price-product", fishCode: stockItemId, price: 123.45 })) }),
    ],
    shipments: ["outbound", "shipped", "delivered", "damaged", "preparing"].map((status) => ({
      id: `shipment-${status}`, siteId: "nanjing", orderId: `SHIPMENT-ORDER-${status}`, status, shipMethod: "express", itemStockIds: [`shipment-${status}`],
    })),
    bioRecords: [], lossRecords: [], approvalRequests: [], stockChangeRequests: [], inventoryAdjustments: [], customers: [],
    productOrigins: ["印尼"], waterQualityRecords: [], operationLogs: [], systemSettings: {},
  },
};
