import { scryptSync } from "node:crypto";

export const BATCH_TEST_PASSWORD = "batch-detail-route-test-password";
const salt = "batch-detail-route-test-salt";
const password = `scrypt$1$${salt}$${scryptSync(BATCH_TEST_PASSWORD, salt, 32).toString("base64url")}`;
const personnel = ["admin", "staff"].map((accessRole) => ({
  id: `batch-${accessRole}`, username: `batch-${accessRole}`, name: `批次${accessRole}`,
  password, accessRole, accountEnabled: true, employmentStatus: "active", sessionVersion: 0,
  visibleSiteIds: accessRole === "admin" ? [] : ["nanjing"],
  permissions: { batches: { create: true, update: true, delete: true } },
}));
const fish = (id, extra = {}) => ({
  id, code: id.replace("fish-", ""), siteId: "nanjing", productId: "product-tang", batchId: "batch-nj",
  subTankId: "tank-n2", inDate: "2026-08-01", basePrice: 100, status: "healthy", sold: false, lost: false, notes: "", ...extra,
});
const line = (stockItemId, price) => ({ stockItemId, productId: "product-tang", fishCode: stockItemId, price });
const order = (id, extra = {}) => ({
  id, orderNo: id, siteId: "nanjing", date: "2026-08-03", status: "confirmed", source: "私域线上",
  customerId: "private-customer", shippingAddress: "PRIVATE_SHIPPING_ADDRESS", paymentAccount: "PRIVATE_PAYMENT_ACCOUNT",
  payments: [{ type: "balance", amount: 9999, account: "PRIVATE_PAYMENT_ACCOUNT", notes: "PRIVATE_FINANCE_NOTE" }],
  ...extra,
});

export const batchDetailsFixture = {
  revision: 121,
  state: {
    _siteSchemaVersion: 4, _personnelSchemaVersion: 3,
    sites: [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }],
    personnel, personnelProfileRequests: [], personnelPrivateAttachments: [], retiredPersonnelUsernames: [],
    batches: [
      { id: "batch-nj", siteId: "nanjing", batchNo: "PO-QA-001", supplier: "测试供应商", arrivalDate: "2026-08-01", stockedCount: 75, lossCount: 1, bioFee: 2000, shippingFee: 100 },
      { id: "batch-jy", siteId: "jiangyin", batchNo: "PRIVATE_JY_BATCH", supplier: "PRIVATE_JY_SUPPLIER", arrivalDate: "2026-08-01", stockedCount: 1, lossCount: 0, bioFee: 500, shippingFee: 50 },
      { id: "batch-original-only", siteId: "nanjing", batchNo: "PO-ORIGINAL-ONLY", supplier: "补发原鱼关联测试", arrivalDate: "2026-08-01", stockedCount: 1, lossCount: 0, bioFee: 300, shippingFee: 0 },
    ],
    species: [{ id: "species-tang", name: "黄金吊", category: "刺尾鱼科" }],
    products: [{ id: "product-tang", speciesId: "species-tang", name: "黄金吊", size: "5-7cm", origin: "印尼", defaultPrice: 100 }],
    tankGroups: [
      { id: "group-n", siteId: "nanjing", name: "南京鱼缸", subTanks: [{ id: "tank-n1", name: "N1" }, { id: "tank-n2", name: "N2" }, { id: "tank-n3", name: "N3" }] },
      { id: "group-j", siteId: "jiangyin", name: "PRIVATE_JY_TANK", subTanks: [{ id: "tank-j1", name: "J1" }] },
    ],
    stock: [
      fish("fish-in"),
      fish("fish-sold", { sold: true }),
      fish("fish-lost", { lost: true, lossDate: "2026-08-09", lossReason: "损耗原因" }),
      fish("fish-cross", { siteId: "jiangyin", subTankId: "tank-j1", notes: "PRIVATE_JY_STOCK_NOTE" }),
      fish("fish-original-a", { sold: true }), fish("fish-original-b", { sold: true }),
      fish("fish-replacement-a", { sold: true, inDate: "2026-08-06" }), fish("fish-replacement-b", { sold: true, inDate: "2026-08-06" }),
      fish("fish-jy-other", { siteId: "jiangyin", subTankId: "tank-j1", batchId: "batch-jy", notes: "PRIVATE_OTHER_BATCH_FISH" }),
      fish("fish-unknown", { subTankId: "missing-legacy-tank" }),
      ...Array.from({ length: 63 }, (_, index) => fish(`fish-group-${String(index + 1).padStart(3, "0")}`, {
        code: `GROUP-QA-${String(index + 1).padStart(3, "0")}`, subTankId: `tank-n${1 + index % 3}`,
      })),
      fish("fish-only-original", { sold: true, batchId: "batch-original-only", subTankId: "tank-n1" }),
    ],
    orders: [
      order("ORDER-CANCELLED", { date: "2026-08-02", status: "cancelled", items: [line("fish-sold", 120)] }),
      order("ORDER-SALE", { date: "2026-08-03", status: "completed", discount: 50, packagingFee: 10, shippingFee: 20, items: [line("fish-sold", 200), line("other-batch-fish", 100)], payments: [
        { id: "receipt-verified", date: "2026-08-03", type: "balance", amount: 250, verificationStatus: "verified", account: "PRIVATE_PAYMENT_ACCOUNT", notes: "PRIVATE_FINANCE_NOTE", proof: ["/uploads/PRIVATE_FINANCE_PROOF.jpg"] },
        { id: "receipt-pending", date: "2026-08-04", type: "balance", amount: 50, verificationStatus: "pending", account: "PRIVATE_PAYMENT_ACCOUNT" },
        { id: "refund-verified", date: "2026-08-05", type: "refund", amount: 20, verificationStatus: "verified", account: "PRIVATE_PAYMENT_ACCOUNT" },
        { id: "refund-pending", date: "2026-08-06", type: "refund", amount: 5, verificationStatus: "pending", account: "PRIVATE_PAYMENT_ACCOUNT" },
      ] }),
      order("ORDER-REPLACEMENT", { date: "2026-08-03", status: "shipped", items: [line("fish-replacement-a", 350), line("fish-replacement-b", 450)] }),
      order("PRIVATE_JY_ORDER", { siteId: "jiangyin", date: "2026-08-10", items: [line("fish-cross", 7654)] }),
      order("ORDER-UNRELATED", { items: [line("other-batch-fish", 8765)], notes: "UNRELATED_ORDER_MUST_NOT_LEAK" }),
      order("ORDER-ORIGINAL-ONLY", { status: "shipped", items: [line("fish-outside-replacement", 300)] }),
      order("ORDER-MISSING-PRICE", { status: "cancelled", items: [line("fish-group-063", null)] }),
    ],
    shipments: [
      { id: "shipment-sold", siteId: "nanjing", orderId: "ORDER-SALE", status: "delivered", shipMethod: "pickup", itemStockIds: ["fish-sold"], createdAt: "2026-08-03T09:00:00+08:00", outboundDate: "2026-08-04", shipDate: "2026-08-04", deliveredAt: "2026-08-04T10:00:00+08:00", actualShippingFee: 0 },
      { id: "shipment-other-batch", siteId: "nanjing", orderId: "ORDER-SALE", status: "delivered", shipMethod: "express", carrier: "测试快递", trackingNo: "QA-OTHER-BATCH-SHIPMENT", itemStockIds: ["other-batch-fish"], actualShippingFee: 30, shipDate: "2026-08-05", deliveredAt: "2026-08-06T10:00:00+08:00" },
      { id: "shipment-original", siteId: "nanjing", orderId: "ORDER-REPLACEMENT", status: "damaged", itemStockIds: ["fish-original-a", "fish-original-b"], shipDate: "2026-08-04", damagedAt: "2026-08-07T12:00:00+08:00", damageResolution: "reship", damageAmount: 800, damageReplacements: [
        { originalStockItemId: "fish-original-a", replacementStockItemId: "fish-replacement-a", originalFishCode: "original-a", replacementFishCode: "replacement-a" },
        { originalStockItemId: "fish-original-b", replacementStockItemId: "fish-replacement-b", originalFishCode: "original-b", replacementFishCode: "replacement-b" },
      ] },
      { id: "shipment-replacement", siteId: "nanjing", orderId: "ORDER-REPLACEMENT", status: "shipped", itemStockIds: ["fish-replacement-a", "fish-replacement-b"], shipDate: "2026-08-08" },
      { id: "shipment-original-only", siteId: "nanjing", orderId: "ORDER-ORIGINAL-ONLY", status: "damaged", itemStockIds: ["fish-only-original"], shipDate: "2026-08-04", damagedAt: "2026-08-07T12:00:00+08:00", damageResolution: "reship", damageReplacements: [
        { originalStockItemId: "fish-only-original", replacementStockItemId: "fish-outside-replacement" },
      ] },
    ],
    lossRecords: [{ id: "loss-1", siteId: "nanjing", stockItemId: "fish-lost", date: "2026-08-09", reason: "损耗原因", tankName: "损耗时南京旧缸 / N1", proofPhotos: ["/uploads/batch-loss.jpg"], operator: "测试饲养员" }],
    bioRecords: [
      { id: "move-1", siteId: "nanjing", stockItemId: "fish-in", date: "2026-08-02T09:00:00+08:00", sourceType: "manual", text: "移缸：南京鱼缸 / N1 → 南京鱼缸 / N2", photos: [], videos: [] },
      ...Array.from({ length: 105 }, (_, index) => ({
        id: `maintenance-${index + 1}`, siteId: "nanjing", stockItemId: "fish-in", date: `2026-08-${String(3 + Math.floor(index / 5)).padStart(2, "0")}T${String(9 + index % 5).padStart(2, "0")}:00:00+08:00`, text: `养护记录 ${index + 1}`,
        photos: index === 0 ? ["/uploads/batch-health.jpg"] : [], videos: index === 0 ? ["/uploads/batch-health.mp4"] : [], operator: "测试饲养员",
      })),
      { id: "time-earlier-local", siteId: "nanjing", stockItemId: "fish-in", date: "2026-08-27T01:00:00+08:00", text: "较早的北京时间维护", photos: [], videos: [] },
      { id: "time-later-utc", siteId: "nanjing", stockItemId: "fish-in", date: "2026-08-26T18:00:00Z", text: "较晚的UTC维护", photos: [], videos: [] },
      { id: "cross-visible", siteId: "nanjing", stockItemId: "fish-cross", date: "2026-08-02", text: "南京时期维护", photos: [], videos: [] },
      { id: "cross-hidden", siteId: "jiangyin", stockItemId: "fish-cross", date: "2026-08-09", text: "PRIVATE_JY_MAINTENANCE", photos: ["/uploads/PRIVATE_JY_MEDIA.jpg"], videos: [] },
      { id: "mixed-hidden", siteId: "jiangyin", stockItemId: "fish-in", date: "2026-08-10", text: "PRIVATE_JY_MIXED_RECORD", photos: ["/uploads/PRIVATE_JY_MIXED_MEDIA.jpg"], videos: [] },
    ],
    approvalRequests: [{
      id: "approved-removal", status: "approved", siteId: "nanjing", resolvedAt: "2026-08-12T10:00:00+08:00",
      resolvedBy: "batch-admin", resolvedByName: "测试管理员",
      stockDetails: { items: [{
        stockItemId: "fish-removed", operation: "remove",
        before: {
          id: "fish-removed", rawCode: "removed", siteId: "nanjing", batchId: "batch-nj", productId: "product-tang",
          subTankId: "tank-n1", inDate: "2026-08-01", tankGroupName: "南京鱼缸", subTankName: "N1", tankName: "南京鱼缸 / N1",
        },
      }] },
    }],
    customers: [{ id: "private-customer", name: "PRIVATE_CUSTOMER_NAME", phone: "PRIVATE_CUSTOMER_PHONE" }],
    stockChangeRequests: [], stockDetails: [], logs: [], waterQualityRecords: [], operationLogs: [], systemSettings: {},
  },
};
