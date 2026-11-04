import assert from "node:assert/strict";
import test from "node:test";
import { stockStatusChanges, orderReleasedStockChanges, stockStatusHistoryForResponse, stockStatusHistoryPageQuery, appendStockStatusHistorySql, STOCK_STATUS_HISTORY_SQL } from "./stock-status-history.mjs";

const account = { id: "person1", username: "keeper", name: "张三" };
test("only real changes are journaled, initial creation is explicit and unchanged old fish are not backfilled", () => {
  const before = [{ id: "same", status: "healthy" }, { id: "changed", status: "sick" }];
  const after = [{ id: "same", status: "healthy" }, { id: "changed", status: "feeding", siteId: "nanjing", operator: "forged" }, { id: "new", status: "healthy" }];
  const records = stockStatusChanges({ before, after, account, source: "stock_mutation", changedAt: "2026-10-29T00:00:00.000Z" });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(({ stockItemId, previousStatus, status }) => ({ stockItemId, previousStatus, status })), [
    { stockItemId: "changed", previousStatus: "sick", status: "feeding" }, { stockItemId: "new", previousStatus: null, status: "healthy" },
  ]);
  assert.ok(records.every((record) => record.operator === "keeper" && record.operatorName === "张三" && record.operatorId === "person1"));
  assert.equal(new Set(records.map((record) => record.id)).size, 2);
  assert.deepEqual(stockStatusChanges({ before, after: before, account }), []);
  assert.throws(() => stockStatusChanges({ before, after, account: { username: "forged" } }), /认证/);
  assert.throws(() => stockStatusChanges({ before: [before[0], before[0]], after: [before[0]], account }), /不唯一/);
});

test("history pagination bounded, safe allowlist and SQL append does not truncate journal", () => {
  assert.deepEqual(stockStatusHistoryPageQuery(new URLSearchParams("stockItemId=fish")), { stockItemId: "fish", offset: 0, limit: 20 });
  for (const query of ["", "stockItemId=fish&limit=101", "stockItemId=fish&offset=-1", "stockItemId=fish&limit=1.5", "stockItemId=fish&offset=1000001"]) {
    assert.throws(() => stockStatusHistoryPageQuery(new URLSearchParams(query)));
  }
  const [safe] = stockStatusHistoryForResponse([{ id: "x", operator: "keeper", password: "secret", customerName: "private", operatorId: "person1" }]);
  assert.equal(safe.password, undefined); assert.equal(safe.operatorId, undefined); assert.equal(safe.customerName, undefined);
  let bound;
  assert.match(appendStockStatusHistorySql("data", [{ id: "new" }], (value) => { bound = value; return "$2"; }), /COALESCE\(data -> 'stockStatusHistory'.*\|\| \$2::jsonb/s);
  assert.deepEqual(JSON.parse(bound), [{ id: "new" }]);
  assert.equal(appendStockStatusHistorySql("data", [], () => { throw new Error(); }), "data");
  assert.match(STOCK_STATUS_HISTORY_SQL, /LIMIT \$3 OFFSET \$4/);
  assert.doesNotMatch(STOCK_STATUS_HISTORY_SQL, /FOR UPDATE/);
});

test("sale-release events preserve order identity and are separate from health changes", () => {
  const fish = { id: "fish", siteId: "nanjing", status: "feeding", sold: true };
  const order = { id: "order", orderNo: "SO-2026-001", items: [{ stockItemId: "fish" }] };
  const before = { stock: [fish], orders: [order] };
  for (const orders of [[], [{ ...order, items: [] }], [{ ...order, status: "cancelled" }],
    [{ ...order, items: [{ stockItemId: "fish", inventoryRemovedAt: "2026-11-04" }] }]]) {
    const records = orderReleasedStockChanges({ before, after: { stock: [{ ...fish, sold: false }], orders },
      account, source: "order_return_item", changedAt: "2026-11-04T01:00:00.000Z" });
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.eventType, "order_release"); assert.equal(record.previousSold, true); assert.equal(record.sold, false);
    assert.equal(record.previousStatus, "feeding"); assert.equal(record.status, "feeding");
    assert.equal(record.orderId, order.id); assert.equal(record.orderNo, order.orderNo);
    assert.equal(record.operatorId, account.id); assert.equal(record.operatorName, account.name);
    const [response] = stockStatusHistoryForResponse(records);
    assert.equal(response.eventType, "order_release"); assert.equal(response.orderNo, order.orderNo);
    assert.equal(response.operatorId, undefined);
  }
});

test("sale release skips refunds, remaining reservations, deleted fish, no-ops and legacy inconsistencies", () => {
  const fish = { id: "fish", status: "healthy", sold: true };
  const order = { id: "order", items: [{ stockItemId: "fish" }] };
  const before = { stock: [fish], orders: [order] };
  for (const after of [before, { stock: [], orders: [] }, { stock: [{ ...fish, sold: false }], orders: [order] },
    { stock: [fish], orders: [] }, { stock: [{ ...fish, sold: false }], orders: [{ ...order, id: "other" }] }]) {
    assert.deepEqual(orderReleasedStockChanges({ before, after, account }), []);
  }
  assert.deepEqual(orderReleasedStockChanges({ before: { stock: [fish], orders: [] },
    after: { stock: [{ ...fish, sold: false }], orders: [] }, account }), []);
  assert.deepEqual(orderReleasedStockChanges({ before: { stock: [{ ...fish, sold: false }], orders: [order] },
    after: { stock: [{ ...fish, sold: false }], orders: [] }, account }), []);
  assert.throws(() => orderReleasedStockChanges({ before, after: { stock: [{ ...fish, sold: false }], orders: [] } }), /认证/);
});
