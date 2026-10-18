import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./cross-site-fulfillment-fixture.mjs";
export { FULFILLMENT_TEST_PASSWORD as TRANSFER_TEST_PASSWORD };

export function stockTransferFixture() {
  const fixture = crossSiteFulfillmentFixture({ origin: "nanjing", destination: "nanjing" });
  const state = fixture.state;
  state.personnel.push({ ...state.personnel[1], id: "receiver", username: "receiver", name: "江阴签收员", visibleSiteIds: ["jiangyin"] });
  state.tankGroups[0].subTanks.push({ id: "tank-n2", name: "N2" });
  state.stock[0].status = "sick";
  state.stock[0].basePrice = 222;
  state.stock[0].priceMode = "manual";
  state.stock[0].priceOverridden = true;
  state.stock[0].notes = "PRIVATE_STOCK_NOTE";
  state.stock[1].notes = "PRIVATE_STOCK_NOTE";
  state.stock.push({ ...state.stock[1], id: "foreign-fish", code: "FOREIGN", siteId: "jiangyin", subTankId: "tank-j", batchId: "batch-j" });
  state.stock.push({ ...state.stock[1], id: "lost-fish", lost: true });
  state.stock.push({ ...state.stock[1], id: "outbound-fish", sold: true });
  state.shipments = [{ id: "shipment-outbound", orderId: "old-order", status: "outbound", itemStockIds: ["outbound-fish"], siteId: "nanjing", shipMethod: "express" }];
  state.orders[0].customerName = "PRIVATE_CUSTOMER";
  state.bioRecords = [{ id: "private-bio", stockItemId: "unrelated-fish", date: "2026-10-18T08:00:00", text: "PRIVATE_BIO", photos: [], videos: [] }];
  return fixture;
}
