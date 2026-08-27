import assert from "node:assert/strict";
import test from "node:test";
import {
  RecordIdConflictError,
  resolveCreateRecordId,
} from "./record-id-rules.mjs";

test("preserves an available external record id for compatibility", () => {
  assert.equal(resolveCreateRecordId({
    records: [{ id: "order-existing" }],
    requestedId: " external-order-42 ",
    createId: () => "unused",
    label: "订单",
    conflictCode: "ORDER_ID_CONFLICT",
  }), "external-order-42");
});

test("rejects duplicate external ids globally, including another site", () => {
  assert.throws(() => resolveCreateRecordId({
    records: [{ id: "shared-id", siteId: "jiangyin" }],
    requestedId: "shared-id",
    createId: () => "unused",
    label: "发货单",
    conflictCode: "SHIPMENT_ID_CONFLICT",
  }), (error) => {
    assert.equal(error instanceof RecordIdConflictError, true);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "SHIPMENT_ID_CONFLICT");
    return true;
  });
});

test("retries a generated collision and returns only an unused id", () => {
  const generated = ["shipment-existing", "shipment-new"];
  assert.equal(resolveCreateRecordId({
    records: [{ id: "shipment-existing" }],
    createId: () => generated.shift(),
    label: "发货单",
  }), "shipment-new");
});
