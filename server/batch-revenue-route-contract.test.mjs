import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");

function routeBlock(path) {
  const marker = `if (url.pathname === "${path}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n  if \(url\.pathname === /.exec(remaining);
  const end = nextMatch ? start + marker.length + nextMatch.index : source.length;
  return source.slice(start, end);
}

function sqlTemplateContaining(block, tableName) {
  const templates = [...block.matchAll(/`([\s\S]*?)`/g)].map((match) => match[1]);
  const template = templates.find((candidate) => new RegExp(`\\bFROM\\s+${tableName}\\b`, "i").test(candidate));
  assert.ok(template, `missing SQL query for ${tableName}`);
  return template;
}

const route = routeBlock("/api/batches/revenue-metrics");

test("batch revenue metrics requires GET and a concrete visible site", () => {
  assert.match(route, /^if \(url\.pathname === "\/api\/batches\/revenue-metrics" && req\.method === "GET"\)/);
  assert.match(route, /url\.searchParams\.get\("siteId"\)/);
  assert.match(route, /!requestedSiteId\s*\|\|\s*requestedSiteId === ALL_SITE_ID/);
  assert.match(route, /sendJson\(req, res, 400,/);
  assert.match(route, /requireVisibleSiteForAuth\(\s*req,\s*state,\s*requestedSiteId,/);
  assert.doesNotMatch(route, /requireFinanceAccessForAuth\s*\(/);
});

test("batch revenue metrics projects only the required app-state JSONB keys", () => {
  const query = sqlTemplateContaining(route, "app_state");
  assert.doesNotMatch(query, /SELECT\s+data\s+FROM\s+app_state/i);
  assert.match(query, /WHERE\s+id\s*=\s*\$1/i);

  const projectedKeys = [...query.matchAll(/data\s*->\s*'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(projectedKeys, [
    "batches",
    "orders",
    "shipments",
    "sites",
    "stock",
    "tankGroups",
  ]);
});

test("batch revenue metrics aggregates only matched Douyin settlements for the requested state and site", () => {
  const query = sqlTemplateContaining(route, "finance_platform_settlements");
  assert.match(query, /WHERE\s+state_id\s*=\s*\$1\s+AND\s+site_id\s*=\s*\$2\s+AND\s+platform\s*=\s*'douyin'/i);
  assert.match(query, /SUM\s*\([\s\S]*?data\s*->\s*'incomeTotal'[\s\S]*?data\s*->>\s*'incomeTotal'[\s\S]*?\)/i);
  assert.match(query, /GROUP\s+BY\s+external_order_no/i);
  assert.match(route, /pool\.query\([\s\S]*?finance_platform_settlements[\s\S]*?\[stateId, siteId\]/);
  assert.match(route, /buildBatchRevenueMetrics\(\{[\s\S]*?platformSettlements:\s*settlementResult\.rows[\s\S]*?\}\)/);
});

test("batch revenue metrics returns aggregate data privately without raw settlement fields", () => {
  const responseMatch = /sendJson\(req, res, 200, \{([\s\S]*?)\}, \{ "Cache-Control": "no-store, private" \}\);/.exec(route);
  assert.ok(responseMatch, "missing private success response");
  const responsePayload = responseMatch[1];
  assert.match(responsePayload, /ok:\s*true/);
  assert.match(responsePayload, /siteId/);
  assert.match(responsePayload, /version/);
  assert.match(responsePayload, /\.\.\.result/);
  assert.doesNotMatch(
    responsePayload,
    /external_order_no|income_total|row_count|settlementResult|platformSettlements|raw|\bdata\b/i
  );

  const sendCount = [...route.matchAll(/\bsendJson\(/g)].length;
  const privateCount = [...route.matchAll(/"Cache-Control": "no-store, private"/g)].length;
  assert.ok(sendCount > 0, "route must send at least one response");
  assert.equal(privateCount, sendCount, "every response path must disable shared caching");
});
