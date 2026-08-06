import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDamageReplacementSelection,
  snapshotDamageReplacements,
} from "./shipment-damage-utils.mjs";

test("accepts replacement mappings for only the selected damaged fish", () => {
  assert.deepEqual(normalizeDamageReplacementSelection([
    { originalStockItemId: "stock-b", replacementStockItemId: "stock-new" },
  ], ["stock-a", "stock-b"]), [
    { originalStockItemId: "stock-b", replacementStockItemId: "stock-new" },
  ]);
});

test("rejects duplicate replacement fish", () => {
  assert.throws(() => normalizeDamageReplacementSelection([
    { originalStockItemId: "stock-a", replacementStockItemId: "stock-new" },
    { originalStockItemId: "stock-b", replacementStockItemId: "stock-new" },
  ], ["stock-a", "stock-b"]), /同一条库存鱼不能重复补发/);
});

test("rejects original fish outside the shipment", () => {
  assert.throws(() => normalizeDamageReplacementSelection([
    { originalStockItemId: "stock-c", replacementStockItemId: "stock-new" },
  ], ["stock-a", "stock-b"]), /不属于当前发货单/);
});

test("snapshots the original and replacement fish for later shipment display", () => {
  const result = snapshotDamageReplacements({
    replacements: [{ originalStockItemId: "stock-old", replacementStockItemId: "stock-new" }],
    stock: [
      { id: "stock-old", productId: "product-old", subTankId: "tank-a", code: "A-17" },
      { id: "stock-new", productId: "product-new", subTankId: "tank-b", code: "B-29" },
    ],
    products: [
      { id: "product-old", name: "蓝吊" },
      { id: "product-new", name: "粉蓝吊" },
    ],
    tankGroups: [
      { name: "鱼A", subTanks: [{ id: "tank-a", name: "A1" }] },
      { name: "鱼B", subTanks: [{ id: "tank-b", name: "B2" }] },
    ],
  });

  assert.deepEqual(result, [{
    originalStockItemId: "stock-old",
    replacementStockItemId: "stock-new",
    originalFishCode: "A-17",
    replacementFishCode: "B-29",
    originalProductId: "product-old",
    replacementProductId: "product-new",
    originalProductName: "蓝吊",
    replacementProductName: "粉蓝吊",
    originalTankName: "鱼A / A1",
    replacementTankName: "鱼B / B2",
  }]);
});

test("keeps identifiers when referenced inventory is unavailable", () => {
  assert.deepEqual(snapshotDamageReplacements({
    replacements: [{ originalStockItemId: "old", replacementStockItemId: "new" }],
  }), [{
    originalStockItemId: "old",
    replacementStockItemId: "new",
    originalFishCode: "",
    replacementFishCode: "",
    originalProductId: "",
    replacementProductId: "",
    originalProductName: "",
    replacementProductName: "",
    originalTankName: "",
    replacementTankName: "",
  }]);
});
