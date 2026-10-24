import assert from "node:assert/strict";
import test from "node:test";
import { recentStockTransferItems } from "./stock-transfer-history.mjs";
const now = Date.parse("2026-10-24T09:00:00Z");
const event = { stockItemId: "fish", transferId: "t1", fromSiteId: "n", fromTankName: "N1", toSiteId: "j", toTankName: "J1",
  sourceType: "stockTransferReceived", receivedAt: "2026-10-24T08:00:00Z", receivedBy: "receiver", issuedAt: "2026-10-23T08:00:00Z", issuedBy: "issuer" };
const state = { sites: [{ id: "n", name: "南京" }, { id: "j", name: "江阴" }],
  products: [{ id: "p", name: "法仙" }], stock: [{ id: "fish", productId: "p", code: "957", basePrice: 999 }], bioRecords: [event] };
test("recent history uses completed events, retains cycles and explicitly projects fields without private data", () => {
  const items = recentStockTransferItems({ ...state, bioRecords: [event, { ...event, transferId: "t2", receivedAt: "2026-10-24T08:30:00Z",
    orderId: "secret-order", orderNo: "secret-no", customerId: "secret-customer", payments: [999], photos: ["secret-photo"] }] }, { now, visibleSiteIds: ["n"] });
  assert.deepEqual(items.map((item) => item.transferId), ["t2", "t1"]);
  assert.doesNotMatch(JSON.stringify(items), /secret|basePrice|payments|orderId|orderNo|customer/);
  assert.equal(recentStockTransferItems(state, { now, visibleSiteIds: ["other"] }).length, 0);
  assert.equal(recentStockTransferItems(state, { now, visibleSiteIds: ["j"] }).length, 1);
});
test("recent history applies 30-day and 200-row bounds, including legacy snapshots", () => {
  const items = recentStockTransferItems({ ...state, bioRecords: Array.from({ length: 230 }, (_, i) => ({ ...event, transferId: `t-${i}` })),
    stock: [...state.stock, { id: "old", tankTransfer: { id: "old-transfer", status: "received", fromSiteId: "n", receivedAt: "2026-09-01T00:00:00Z" } },
      { id: "future", tankTransfer: { id: "future-transfer", status: "received", fromSiteId: "n", receivedAt: "2027-01-01T00:00:00Z" } }] }, { now, visibleSiteIds: ["n"] });
  assert.equal(items.length, 200); assert.ok(items.every((item) => item.stockItemId === "fish"));
  assert.equal(recentStockTransferItems({ ...state, bioRecords: [], stock: [{ id: "fish", tankTransfer: { ...event, id: "legacy", status: "received" } }] },
    { now, visibleSiteIds: ["n"] })[0].transferId, "legacy");
});
test("cancellation hides only the invalidated dispatch, not a later redispatch of the same transfer", () => {
  const dispatch = { ...event, sourceType: "stockTransferDispatched", dispatchSiteId: "j", dispatchedAt: "2026-10-24T06:00:00Z", shipmentId: "s1" };
  const cancelled = { ...dispatch, sourceType: "stockTransferDispatchCancelled", cancelledAt: "2026-10-24T07:00:00Z" };
  const second = { ...dispatch, dispatchedAt: "2026-10-24T08:00:00Z", shipmentId: "s2" };
  const items = recentStockTransferItems({ ...state, bioRecords: [dispatch, cancelled, second] }, { now, visibleSiteIds: ["j"] });
  assert.equal(items.length, 1); assert.equal(items[0].completedAt, second.dispatchedAt);
});
