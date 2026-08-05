import test from "node:test";
import assert from "node:assert/strict";
import {
  productDeleteDisposition,
  productReferenceSummary,
} from "./product-delete-rules.mjs";

test("productReferenceSummary counts stock records and distinct orders", () => {
  const state = {
    stock: [
      { id: "stock-1", productId: "product-1" },
      { id: "stock-2", productId: "product-1", lost: true },
      { id: "stock-3", productId: "product-2" },
    ],
    orders: [
      { id: "order-1", items: [{ productId: "product-1" }, { productId: "product-1" }] },
      { id: "order-2", items: [{ productId: "product-2" }] },
      { id: "order-3", status: "cancelled", items: [{ productId: "product-1" }] },
    ],
  };

  assert.deepEqual(productReferenceSummary(state, "product-1"), {
    stockCount: 2,
    orderCount: 2,
  });
});

test("productDeleteDisposition hard-deletes an unreferenced product", () => {
  assert.deepEqual(productDeleteDisposition({ stock: [], orders: [] }, "product-1", "蓝圈"), {
    mode: "deleted",
    references: { stockCount: 0, orderCount: 0 },
    message: "商品「蓝圈」已删除。",
  });
});

test("productDeleteDisposition archives a referenced product and explains retained history", () => {
  const result = productDeleteDisposition({
    stock: [{ productId: "product-1" }],
    orders: [{ items: [{ productId: "product-1" }] }],
  }, "product-1", "蓝圈");

  assert.equal(result.mode, "archived");
  assert.deepEqual(result.references, { stockCount: 1, orderCount: 1 });
  assert.match(result.message, /蓝圈/);
  assert.match(result.message, /1 条库存记录/);
  assert.match(result.message, /1 个订单/);
  assert.match(result.message, /历史记录继续保留/);
});
