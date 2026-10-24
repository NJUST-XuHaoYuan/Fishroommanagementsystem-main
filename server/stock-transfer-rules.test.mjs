import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTransferStockIds,
  assertStockIdsNotInTransfer,
  isStockInTransfer,
  stockTransferConcurrencySnapshot,
  stockTransferId,
} from "./stock-transfer-rules.mjs";

const active = {
  id: "fish-active",
  tankTransfer: {
    id: "transfer-active",
    status: "in_transit",
    issuedAt: "2026-10-18T01:00:00Z",
    issuedBy: "staff-a",
    fromSiteId: "nanjing",
    fromSubTankId: "tank-a",
    fromTankName: "A组 / A缸",
    notes: "测试",
  },
};

test("only an explicit active transfer removes stock from a physical tank", () => {
  assert.equal(isStockInTransfer(active), true);
  assert.equal(isStockInTransfer({ ...active, tankTransfer: { ...active.tankTransfer, status: "received" } }), false);
  assert.equal(isStockInTransfer({ ...active, tankTransfer: { id: "legacy", status: "unknown" } }), false);
  assert.equal(isStockInTransfer(null), false);
  assert.equal(stockTransferId(active), "transfer-active");
  assert.deepEqual(activeTransferStockIds({ stock: [active, { id: "received", tankTransfer: { id: "done", status: "received" } }] }),
    new Set(["fish-active"]));
});

test("transfer concurrency snapshots are strict allowlists and stable for missing values", () => {
  assert.equal(stockTransferConcurrencySnapshot({ id: "none" }), null);
  assert.deepEqual(stockTransferConcurrencySnapshot({
    ...active,
    tankTransfer: { ...active.tankTransfer, privateField: "must-not-project" },
  }), {
    ...active.tankTransfer,
    receivedAt: "",
    receivedBy: "",
    toSiteId: "",
    toSubTankId: "",
    toTankName: "",
    dispatchedAt: "", dispatchedBy: "", dispatchSiteId: "", dispatchSiteName: "", orderId: "", shipmentId: "",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(
    stockTransferConcurrencySnapshot({ ...active, tankTransfer: { ...active.tankTransfer, privateField: "must-not-project" } }),
    "privateField",
  ), false);
});

test("outbound guards reject any active transfer without treating received history as active", () => {
  const state = {
    stock: [active, { id: "fish-received", tankTransfer: { id: "done", status: "received" } }],
  };
  assert.throws(() => assertStockIdsNotInTransfer(state, ["fish-received", "fish-active"]), (error) =>
    error.statusCode === 409 && error.code === "STOCK_IN_TRANSFER"
  );
  assert.equal(assertStockIdsNotInTransfer(state, ["fish-received"]), true);
});
