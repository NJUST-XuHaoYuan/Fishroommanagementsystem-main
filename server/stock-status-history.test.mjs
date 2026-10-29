import assert from "node:assert/strict";
import test from "node:test";
import { stockStatusChanges, stockStatusHistoryForResponse, stockStatusHistoryPageQuery, appendStockStatusHistorySql, STOCK_STATUS_HISTORY_SQL } from "./stock-status-history.mjs";

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
