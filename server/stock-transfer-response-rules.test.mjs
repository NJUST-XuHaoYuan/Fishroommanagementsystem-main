import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeBioRecordTransferForVisibleSites,
  sanitizeStockTransferForVisibleSites,
} from "./stock-transfer-response-rules.mjs";

test("the authorized current site receives the latest snapshot required for CAS and reissue", () => {
  const stock = {
    id: "fish-1",
    siteId: "nanjing",
    tankTransfer: {
      id: "transfer-1",
      status: "received",
      fromSiteId: "jiangyin",
      fromSubTankId: "jy-1",
      fromTankName: "江阴组 / J1",
      toSiteId: "nanjing",
      toSubTankId: "nj-1",
      toTankName: "南京组 / N1",
    },
  };
  assert.equal(sanitizeStockTransferForVisibleSites(stock, ["nanjing"]).tankTransfer.id, "transfer-1");
  assert.equal(sanitizeStockTransferForVisibleSites(stock, ["jiangyin"]).tankTransfer, undefined);
  assert.equal(sanitizeStockTransferForVisibleSites(stock, ["nanjing", "jiangyin"]).tankTransfer.id, "transfer-1");
  assert.equal(sanitizeStockTransferForVisibleSites(stock, [], { isAdmin: true }), stock);
});

test("active issue snapshots remain visible at their source while malformed ones fail closed", () => {
  const active = {
    id: "fish-1",
    tankTransfer: { id: "transfer-1", status: "in_transit", fromSiteId: "nanjing", fromTankName: "南京组 / N1" },
  };
  assert.equal(sanitizeStockTransferForVisibleSites(active, ["nanjing"]).tankTransfer.id, "transfer-1");
  assert.equal(sanitizeStockTransferForVisibleSites(active, ["jiangyin"]).tankTransfer, undefined);
  assert.equal(sanitizeStockTransferForVisibleSites({ ...active, tankTransfer: { id: "bad", status: "in_transit" } }, ["nanjing"]).tankTransfer, undefined);
});

test("cross-site and unstructured transfer records redact route text and fields", () => {
  const record = {
    id: "bio-1",
    siteId: "nanjing",
    stockItemId: "fish-1",
    sourceType: "stockTransferReceived",
    text: "移缸签收：PRIVATE_SOURCE → 南京组 / N1",
    fromSiteId: "jiangyin",
    fromSubTankId: "jy-1",
    fromTankName: "PRIVATE_SOURCE",
    toSiteId: "nanjing",
    toSubTankId: "nj-1",
    toTankName: "南京组 / N1",
    notes: "PRIVATE_NOTE",
    photos: ["PRIVATE_PHOTO"],
    videos: ["PRIVATE_VIDEO"],
  };
  const hidden = sanitizeBioRecordTransferForVisibleSites(record, ["nanjing"]);
  assert.match(hidden.text, /历史位置已隐藏/);
  assert.equal(hidden.fromSiteId, undefined);
  assert.deepEqual(hidden.photos, []);
  assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE_/);
  assert.equal(sanitizeBioRecordTransferForVisibleSites(record, ["nanjing", "jiangyin"]), record);

  const legacy = sanitizeBioRecordTransferForVisibleSites({ id: "legacy", text: "移缸：A → B" }, ["nanjing"]);
  assert.match(legacy.text, /历史位置已隐藏/);
});
test("destination-only stock and timeline views cannot disclose foreign order or shipment references", () => {
  const item = { id: "fish", siteId: "jiangyin", subTankId: "", tankTransfer: {
    id: "transfer", status: "dispatched", fromSiteId: "nanjing", dispatchSiteId: "jiangyin", orderId: "foreign-order", shipmentId: "foreign-shipment",
  } };
  const projected = sanitizeStockTransferForVisibleSites(item, ["jiangyin"]);
  assert.equal(projected.tankTransfer.status, "dispatched");
  assert.equal(projected.tankTransfer.orderId, undefined); assert.equal(projected.tankTransfer.shipmentId, undefined);
  const record = { sourceType: "stockTransferDispatched", fromSiteId: "nanjing", dispatchSiteId: "jiangyin", orderId: "foreign-order", shipmentId: "foreign-shipment", text: "来源南京" };
  for (const sites of [["jiangyin"], ["nanjing", "jiangyin"]]) {
    const safe = sanitizeBioRecordTransferForVisibleSites(record, sites);
    assert.equal(safe.orderId, undefined); assert.equal(safe.shipmentId, undefined);
  }
});
