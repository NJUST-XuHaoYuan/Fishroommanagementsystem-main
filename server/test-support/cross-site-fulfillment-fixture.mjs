import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./stock-pricing-fixture.mjs";
export { PRICING_TEST_PASSWORD as FULFILLMENT_TEST_PASSWORD };

export function crossSiteFulfillmentFixture({ origin = "nanjing", destination = "jiangyin", method = "express" } = {}) {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.personnel.push({ ...fixture.state.personnel[1], id: "dual-editor", username: "dual-editor", visibleSiteIds: ["nanjing", "jiangyin"] });
  fixture.state.customers = [{ id: "fulfillment-customer", name: "履约测试客户" }];
  fixture.state.shipments = [];
  fixture.state.orders = [{
    id: "moved-order", orderNo: "SO-MOVED", siteId: origin, status: "pending", date: "2026-09-01",
    source: method === "pickup" ? "线下" : "平台下单", customerId: method === "pickup" ? "fulfillment-customer" : "",
    platformOrderNo: method === "pickup" ? "" : "MOVED-PLATFORM", douyinOrderNo: method === "pickup" ? "" : "MOVED-PLATFORM",
    paymentChannel: method === "pickup" ? "cash" : "douyin", paymentAccount: "synthetic-account",
    plannedShipDate: method === "pickup" ? "" : "2026-09-28", contactPersonnelId: "pricing-admin", contactPerson: "价格测试admin",
    items: [{ stockItemId: "moved-fish", productId: "price-product", price: 188, minReturnPrice: 0, commissionRate: 0 }],
    payments: [], shippingFeeMode: "collect", shippingFee: 0, packagingFee: 0, discount: 0, notes: "保留订单归属",
  }];
  fixture.state.stock = [{ ...fixture.state.stock[0], id: "moved-fish", code: "MOVED-001", siteId: destination,
    subTankId: destination === "nanjing" ? "tank-n" : "tank-j", sold: true,
  }, { ...fixture.state.stock[0], id: "unrelated-fish", code: "OTHER-001", siteId: destination,
    subTankId: destination === "nanjing" ? "tank-n" : "tank-j", sold: false,
  }];
  fixture.state.logs = []; fixture.state.checks = [];
  return fixture;
}
