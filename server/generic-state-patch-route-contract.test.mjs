import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./local-server.mjs", import.meta.url), "utf8");
const start = source.indexOf('if (url.pathname === "/api/state/patch" && req.method === "POST")');
const end = source.indexOf('if (url.pathname === "/api/approvals/stock"', start);
const route = source.slice(start, end);

test("generic state patch projects dependencies instead of selecting the whole state", () => {
  assert.ok(start >= 0 && end > start, "state patch route must be discoverable");
  assert.match(route, /planGenericStatePatchReadKeys\(Object\.keys\(rawPatch\)\)/);
  assert.doesNotMatch(route, /SELECT\s+data\s+FROM app_state/i);
});

test("generic state patch appends audit logs inside PostgreSQL", () => {
  assert.match(route, /data\s*->\s*'operationLogs'/);
  assert.match(route, /jsonb_array_elements/);
  assert.match(route, /LIMIT \$\{MAX_OPERATION_LOGS\}/);
  assert.doesNotMatch(route, /mergeOperationLogsForGenericPost\(current\.operationLogs/);
});

test("generic state patch only returns a fresh inventory projection for fulfillment changes", () => {
  assert.match(route, /projectionChanged/);
  assert.match(route, /key === "orders" \|\| key === "shipments"/);
});
