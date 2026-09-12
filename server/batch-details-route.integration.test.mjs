import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { BATCH_TEST_PASSWORD, batchDetailsFixture } from "./test-support/batch-details-fixture.mjs";

let child;
let baseUrl;
let uploadDir;
let childOutput = "";
const tokens = {};

async function get(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { response, body: await response.json() };
}

before(async () => {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  uploadDir = await mkdtemp(join(tmpdir(), "fishroom-batch-detail-test-"));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./test-support/pg-stub-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./local-server.mjs", import.meta.url)),
  ], {
    env: {
      ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      AUTH_SESSION_SECRET: "replace_with_batch_detail_integration_secret",
      UPLOAD_DIR: uploadDir, TRANSCODE_VIDEO_UPLOADS: "false",
      FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(batchDetailsFixture),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Server did not start: ${childOutput}`)), 10_000);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.off("exit", earlyExit);
      error ? reject(error) : resolve();
    };
    const check = () => { if (childOutput.includes("Local Fishroom API/static server:")) finish(); };
    const earlyExit = () => finish(new Error(`Server exited before listening: ${childOutput}`));
    child.stdout.on("data", check);
    child.once("exit", earlyExit);
    check();
  });
  for (const role of ["admin", "staff"]) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `batch-${role}`, password: BATCH_TEST_PASSWORD }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(typeof body.token, "string");
    tokens[role] = body.token;
  }
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(timer);
  }
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

const detailPath = "/api/batches/detail?batchId=batch-nj&siteId=nanjing";
const historyPath = (stockItemId) => `/api/batches/fish-history?batchId=batch-nj&siteId=nanjing&stockItemId=${encodeURIComponent(stockItemId)}`;
const privateFieldPattern = /PRIVATE_(?:SHIPPING_ADDRESS|PAYMENT_ACCOUNT|FINANCE_NOTE|CUSTOMER_PHONE)|scrypt\$|"password"/;

test("batch details and per-fish history require authentication", async () => {
  for (const path of [detailPath, historyPath("fish-in")]) {
    for (const token of [undefined, "invalid-session"]) {
      const { response, body } = await get(path, token);
      assert.equal(response.status, 401, path);
      assert.equal(body.items, undefined);
      assert.equal(body.events, undefined);
    }
  }
});

test("server checks authoritative batch site and rejects cross-batch fish identifiers", async () => {
  for (const path of [
    "/api/batches/detail?batchId=batch-jy&siteId=nanjing",
    "/api/batches/detail?batchId=batch-jy&siteId=jiangyin",
    "/api/batches/fish-history?batchId=batch-jy&siteId=nanjing&stockItemId=fish-jy-other",
    historyPath("fish-jy-other"),
  ]) {
    const { response, body } = await get(path, tokens.staff);
    assert.ok([400, 403, 404].includes(response.status), `${path}: ${JSON.stringify(body)}`);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_JY_BATCH|PRIVATE_JY_SUPPLIER|PRIVATE_OTHER_BATCH_FISH|PRIVATE_JY_TANK/);
  }
  const missing = await get("/api/batches/detail?batchId=missing&siteId=nanjing", tokens.admin);
  assert.equal(missing.response.status, 404);
});

test("admin sees only this batch with per-fish row price independent of receipts and whole-order costs", async () => {
  const { response, body } = await get(detailPath, tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(body.batch.id, "batch-nj");
  assert.equal(body.items.length, 9);
  assert.ok(body.items.every((item) => item.stockItemId !== "fish-jy-other"));
  const sold = body.items.find((item) => item.stockItemId === "fish-sold");
  assert.ok(sold, "the sold fish must remain in its procurement batch history");
  const sale = sold.sales.find((item) => item.orderId === "ORDER-SALE");
  assert.equal(sale.price, 200);
  assert.equal(sale.date.slice(0, 10), "2026-08-03");
  assert.ok(sold.sales.some((item) => item.orderId === "ORDER-CANCELLED" && item.status === "cancelled"));
  assert.doesNotMatch(JSON.stringify(body), privateFieldPattern);
});

test("legacy initial tanks are not invented from current position or unstructured move notes", async () => {
  const { response, body } = await get(detailPath, tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  const item = body.items.find((row) => row.stockItemId === "fish-in");
  assert.equal(item.inDate, "2026-08-01");
  assert.ok(!item.initialTankName, "legacy fish have no authoritative initial-position snapshot");
  assert.match(item.currentTankName, /N2/);
  assert.ok(item.warnings.length > 0);
});

test("replacement relationships retain both original fish and replacements without fake sales amounts", async () => {
  const { response, body } = await get(detailPath, tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  for (const suffix of ["a", "b"]) {
    const replacement = body.items.find((item) => item.stockItemId === `fish-replacement-${suffix}`);
    const relation = replacement.sales.find((sale) => sale.orderId === "ORDER-REPLACEMENT");
    assert.equal(relation.kind, "replacement");
    assert.equal(relation.date.slice(0, 10), "2026-08-07");
    assert.equal(relation.price, null);
    const original = body.items.find((item) => item.stockItemId === `fish-original-${suffix}`);
    const originalRelation = original.sales.find((sale) => sale.orderId === "ORDER-REPLACEMENT");
    assert.equal(originalRelation.kind, "originalReplaced");
    assert.notEqual(originalRelation.price, 800, "shipment aggregate is not an individual fish price");
    const history = await get(historyPath(`fish-replacement-${suffix}`), tokens.admin);
    assert.equal(history.response.status, 200, JSON.stringify(history.body));
    assert.ok(!history.body.events.some((event) => event.type === "shipment" && event.date.slice(0, 10) < "2026-08-06"),
      "the original fish's shipment cannot become a shipment of the replacement before its own entry");
  }
});

test("staff batch traceability redacts hidden current location and events even when fish belongs to visible batch", async () => {
  const { response, body } = await get(detailPath, tokens.staff);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_JY_|7654/);
  const cross = body.items.find((item) => item.stockItemId === "fish-cross");
  assert.equal(cross.status, "restricted");
  for (const stockItemId of ["fish-cross", "fish-in"]) {
    const history = await get(historyPath(stockItemId), tokens.staff);
    assert.equal(history.response.status, 200, JSON.stringify(history.body));
    assert.doesNotMatch(JSON.stringify(history.body), /PRIVATE_JY_|7654/);
    if (stockItemId === "fish-cross") assert.ok(history.body.events.some((event) => event.text.includes("南京时期维护")));
  }
  const hiddenSearch = await get(`${detailPath}&search=PRIVATE_JY_TANK`, tokens.staff);
  assert.equal(hiddenSearch.response.status, 200, JSON.stringify(hiddenSearch.body));
  assert.equal(hiddenSearch.body.items.length, 0);
});

test("pagination and filters return bounded distinct fish without changing batch membership", async () => {
  const first = await get(`${detailPath}&page=1&pageSize=3`, tokens.admin);
  const second = await get(`${detailPath}&page=2&pageSize=3`, tokens.admin);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.items.length, 3);
  assert.equal(second.body.items.length, 3);
  assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.stockItemId)).size, 6);
  const lost = await get(`${detailPath}&status=lost`, tokens.admin);
  assert.deepEqual(lost.body.items.map((item) => item.stockItemId), ["fish-lost"]);
  const searched = await get(`${detailPath}&search=fish-sold`, tokens.admin);
  assert.deepEqual(searched.body.items.map((item) => item.stockItemId), ["fish-sold"]);
});

test("per-fish history preserves maintenance media, moves and loss event location with independent pagination", async () => {
  const all = await get(historyPath("fish-in"), tokens.admin);
  assert.equal(all.response.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.events.length, 100, "the first history page is bounded even for long-lived fish");
  const next = await get(`${historyPath("fish-in")}&page=2&pageSize=100`, tokens.admin);
  assert.equal(next.response.status, 200, JSON.stringify(next.body));
  assert.ok(next.body.events.length > 0, "remaining events must be accessible through load more");
  all.body.events.push(...next.body.events);
  assert.equal(all.body.events.length, all.body.total);
  assert.equal(new Set(all.body.events.map((event) => event.id)).size, all.body.total);
  assert.equal(all.body.events.filter((event) => /养护记录 \d+/.test(event.text)).length, 105);
  assert.ok(all.body.events.some((event) => event.text.includes("移缸：南京鱼缸 / N1 → 南京鱼缸 / N2")));
  assert.ok(all.body.events.some((event) => event.photos?.includes("/uploads/batch-health.jpg") && event.videos?.includes("/uploads/batch-health.mp4")));
  assert.ok(all.body.events.findIndex((event) => event.id.includes("time-earlier-local")) < all.body.events.findIndex((event) => event.id.includes("time-later-utc")),
    "UTC and China-local timestamps must sort by the represented time, not their raw strings");
  assert.doesNotMatch(JSON.stringify(all.body), privateFieldPattern);
  const first = await get(`${historyPath("fish-in")}&page=1&pageSize=5`, tokens.admin);
  const second = await get(`${historyPath("fish-in")}&page=2&pageSize=5`, tokens.admin);
  assert.equal(first.body.events.length, 5);
  assert.equal(second.body.events.length, 5);
  assert.equal(new Set([...first.body.events, ...second.body.events].map((event) => event.id)).size, 10);
  const loss = await get(historyPath("fish-lost"), tokens.admin);
  assert.equal(loss.response.status, 200, JSON.stringify(loss.body));
  assert.ok(loss.body.events.some((event) => event.date.startsWith("2026-08-09") && event.siteName === "南京" && event.tankName === "损耗时南京旧缸 / N1"));
});

test("deleted fish remain traceable only through their approved batch snapshot", async () => {
  const listed = await get(`${detailPath}&status=removed`, tokens.admin);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.items.map((item) => item.stockItemId), ["fish-removed"]);
  assert.equal(listed.body.summary.removed, 1);
  assert.equal(listed.body.items[0].currentTankName, "");
  assert.ok(listed.body.items[0].warnings.some((warning) => warning.includes("删除")));
  for (const token of [tokens.admin, tokens.staff]) {
    const history = await get(historyPath("fish-removed"), token);
    assert.equal(history.response.status, 200, JSON.stringify(history.body));
    assert.ok(history.body.events.some((event) => event.type === "change" && event.title === "库存记录删除" && event.date === "2026-08-12T10:00:00+08:00"));
    assert.doesNotMatch(JSON.stringify(history.body), privateFieldPattern);
  }
});
