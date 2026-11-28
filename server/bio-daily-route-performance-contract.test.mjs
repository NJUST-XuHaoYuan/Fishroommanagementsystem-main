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
  assert.match(block, /tankTransfer'\s*->>\s*'status'[\s\S]{0,100}<>\s*'in_transit'/,
    "new daily-log sync must not attach active in-transit fish from their retained source subTankId");
  assert.match(block, /\$3::boolean[\s\S]{0,180}id[^]*?ANY\(\$4::text\[\]\)/,
    "editing an existing log must preserve its original synchronized fish set, including later transfers");
  assert.match(block, /jsonb_set\([\s\S]*?'\{logs\}'[\s\S]*?'\{bioRecords\}'[\s\S]*?'\{operationLogs\}'/);
  assert.match(block, /changedLog/);
  assert.match(block, /deletedLogId/);
  assert.match(block, /bioRecordUpdates/);
  assert.match(block, /deletedBioRecordIds/);
});

test("daily-log mutations release large JSONB temporaries between statements and append new sync records", () => {
  const block = routeBlock("/api/daily-logs/save");
  const updateStatements = [...block.matchAll(/`UPDATE app_state[\s\S]*?WHERE id = \$1`/g)].map(match => match[0]);
  assert.equal(updateStatements.length, 3, "log, fish history and audit writes use separate statements inside one transaction");
  assert.ok(block.indexOf('await client.query("BEGIN")') < block.indexOf(updateStatements[0]));
  assert.ok(block.lastIndexOf('await client.query("COMMIT")') > block.indexOf(updateStatements[2]));
  for (const statement of updateStatements) {
    assert.equal((statement.match(/jsonb_set\(/g) ?? []).length, 1, "do not retain multiple expanded whole-state JSONB values");
    assert.doesNotMatch(statement, /jsonb_agg\(/, "large array rebuilds use streaming JSON text aggregation before conversion");
  }
  const bioStatement = updateStatements[1];
  assert.match(bioStatement, /CASE WHEN \$3::boolean THEN/);
  assert.match(bioStatement, /ELSE COALESCE\(data -> 'bioRecords', '\[\]'::jsonb\) END \|\| \$4::jsonb/);
  assert.match(block, /existingBioRecords.length > 0, JSON.stringify\(bioRecordUpdates\)/);
  assert.match(block, /if \(existingBioRecords.length > 0 \|\| bioRecordUpdates.length > 0\)/);
});

test("legacy daily-log synchronization scans large fish history once and reuses only its small matched set", () => {
  const block = routeBlock("/api/daily-logs/save");
  const query = block.match(/`(WITH outbound_stock_ids AS MATERIALIZED[\s\S]*?AS existing_bio_records)`/)[1];
  assert.match(query, /prior_bio_records AS MATERIALIZED \([\s\S]*?sourceLogId[\s\S]*?= \$2/);
  assert.match(query, /prior_synced_stock_ids AS MATERIALIZED \([\s\S]*?FROM prior_bio_records/);
  assert.match(query, /IN \(\s*SELECT stock_id FROM prior_synced_stock_ids\s*\)/);
  assert.match(query, /FROM prior_bio_records AS bio_row/);
  assert.equal((query.match(/jsonb_array_elements\(COALESCE\(source\.data -> 'bioRecords'/g) ?? []).length, 1,
    "one filtered materialized scan, never a full history scan per stock item");
  const inventoryScan = query.slice(query.indexOf("SELECT jsonb_agg(stock_row.item"));
  assert.doesNotMatch(inventoryScan, /jsonb_array_elements\([^]*?bioRecords/);
});

test("bio-record save never materializes full stock, history, order, shipment or audit arrays in Node", () => {
  const block = routeBlock("/api/bio-records/save");
  const lockIndex = block.indexOf("SELECT 1 FROM app_state WHERE id = $1 FOR UPDATE");
  const projectionIndex = block.indexOf("CROSS JOIN LATERAL");
  assert.ok(lockIndex >= 0 && projectionIndex > lockIndex, "the row must be locked before running aggregate projections");
  assert.doesNotMatch(
    block,
    /CROSS JOIN LATERAL[\s\S]*?WHERE id = \$1\s+FOR UPDATE/,
    "PostgreSQL forbids FOR UPDATE on the aggregate projection query"
  );
  for (const key of ["stock", "bioRecords", "orders", "shipments", "operationLogs"]) {
    assert.doesNotMatch(block, new RegExp(`data\\s*->\\s*'${key}'\\s+AS\\s+[a-z_]`, "i"));
  }
  assert.doesNotMatch(block, /JSON\.stringify\((?:state|plan\.records|nextStock|nextOperationLogs)\)/);
  assert.doesNotMatch(block, /sendJson\(req, res, 200,[\s\S]{0,700}?\bbioRecords\s*:/);
  assert.match(block, /CROSS JOIN LATERAL[\s\S]*?stock_target/);
  assert.match(block, /record_target\.bio_records/);
  assert.match(block, /jsonb_set\([\s\S]*?'\{operationLogs\}'/);
  assert.match(block, /appendBioRecordsMutationSql\(\{/);
  assert.doesNotMatch(block, /recordIdParam\s*=\s*bindValue\(targetRecordId\)/);
  assert.match(block, /bioRecord: plan\.record/);
  assert.match(block, /deletedRecordId: plan\.deletedRecordId/);
});

test("video upload streams first, queues processing second, and reports the processing mode", () => {
  const block = routeBlock("/api/media/upload");
  const receiveIndex = block.indexOf("readRawBodyToFile(req, inputPath, maxBytes)");
  const queueIndex = block.indexOf("videoTranscodeLimiter.acquire()");
  assert.ok(receiveIndex >= 0 && queueIndex > receiveIndex, "a queued transcode must not block the client from uploading bytes");
  assert.match(block, /prepareWechatVideoFile/);
  assert.match(block, /storeOriginalMediaFile/);
  assert.match(block, /processingMode/);
  assert.match(block, /Server-Timing/);
});

test("video normalization selects one usable audio stream and retries without broken audio", () => {
  const start = source.indexOf("async function prepareWechatVideoFile(");
  const end = source.indexOf("\nasync function transcodeVideoToWechatMp4(", start);
  assert.ok(start >= 0 && end > start, "missing WeChat video normalization function");
  const block = source.slice(start, end);

  assert.match(block, /selectWechatAudioStream\(probe\)/);
  assert.match(block, /`0:\$\{selectedAudio\.index\}`/);
  assert.doesNotMatch(block, /"0:a\?"/, "normal uploads must not map every audio stream");
  assert.match(block, /"0:a:0\?"/, "ffprobe failure may make one bounded audio attempt");
  assert.match(block, /transcodeArgs\(\{ withoutAudio: true \}\)/);
  assert.match(block, /mode: "transcode-no-audio"/);
});

test("media upload keeps FFmpeg details in server logs instead of the client response", () => {
  const block = routeBlock("/api/media/upload");
  assert.match(block, /console\.error\(`Media upload failed/);
  assert.match(block, /mediaKind === "video" \? "视频上传失败，请稍后重试"/);
});
