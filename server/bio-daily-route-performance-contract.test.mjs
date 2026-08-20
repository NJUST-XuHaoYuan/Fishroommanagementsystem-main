import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");

function routeBlock(path) {
  const marker = `if (url.pathname === "${path}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n\s+if \(url\.pathname === /.exec(remaining);
  const nextRoute = nextMatch ? start + marker.length + nextMatch.index : -1;
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

test("daily-log save locks projected keys and incrementally preserves fish timeline sync", () => {
  const block = routeBlock("/api/daily-logs/save");
  assert.doesNotMatch(block, /SELECT\s+data\s+FROM\s+app_state/i);
  assert.doesNotMatch(block, /JSON\.stringify\((?:nextState|nextLogs|nextBioRecords|operationLogs)\)/);
  assert.doesNotMatch(block, /\b(?:logs|bioRecords):\s*next(?:Logs|BioRecords)\b/);
  assert.match(block, /data\s*->\s*'tankGroups'\s+AS\s+tank_groups/);
  assert.match(block, /matching_logs/);
  assert.match(block, /existing_bio_records/);
  assert.match(block, /outbound_stock_ids/);
  assert.match(block, /jsonb_set\([\s\S]*?'\{logs\}'[\s\S]*?'\{bioRecords\}'[\s\S]*?'\{operationLogs\}'/);
  assert.match(block, /changedLog/);
  assert.match(block, /deletedLogId/);
  assert.match(block, /bioRecordUpdates/);
  assert.match(block, /deletedBioRecordIds/);
});

test("bio-record save never materializes full stock, history, order, shipment or audit arrays in Node", () => {
  const block = routeBlock("/api/bio-records/save");
  for (const key of ["stock", "bioRecords", "orders", "shipments", "operationLogs"]) {
    assert.doesNotMatch(block, new RegExp(`data\\s*->\\s*'${key}'\\s+AS\\s+[a-z_]`, "i"));
  }
  assert.doesNotMatch(block, /JSON\.stringify\((?:state|plan\.records|nextStock|nextOperationLogs)\)/);
  assert.doesNotMatch(block, /sendJson\(req, res, 200,[\s\S]{0,700}?\bbioRecords\s*:/);
  assert.match(block, /CROSS JOIN LATERAL[\s\S]*?stock_target/);
  assert.match(block, /record_target\.bio_records/);
  assert.match(block, /jsonb_set\([\s\S]*?'\{operationLogs\}'/);
  assert.match(block, /bioRecord: plan\.record/);
  assert.match(block, /deletedRecordId: plan\.deletedRecordId/);
});
