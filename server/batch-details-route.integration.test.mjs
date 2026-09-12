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
const orderPath = (orderId, batchId = "batch-nj", siteId = "nanjing") => `/api/batches/order-detail?${new URLSearchParams({ batchId, siteId, orderId })}`;
const privateFieldPattern = /PRIVATE_(?:SHIPPING_ADDRESS|PAYMENT_ACCOUNT|FINANCE_NOTE|CUSTOMER_PHONE)|scrypt\$|"password"/;

test("batch details and per-fish history require authentication", async () => {
  for (const path of [detailPath, historyPath("fish-in"), orderPath("ORDER-SALE")]) {
    for (const token of [undefined, "invalid-session"]) {
      const { response, body } = await get(path, token);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get("cache-control"), "no-store, private");
      assert.equal(body.items, undefined);
      assert.equal(body.events, undefined);
    }
  }
});

test("tank distribution uses all matching fish before pagination and before selecting a tank", async () => {
  const first = await get(`${detailPath}&pageSize=50&page=1`, tokens.admin);
  const second = await get(`${detailPath}&pageSize=50&page=2`, tokens.admin);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.total, 73);
  assert.equal(first.body.items.length, 50);
  assert.equal(second.body.items.length, 23);
  assert.deepEqual(first.body.tanks, second.body.tanks);
  assert.equal(first.body.tanks.reduce((sum, tank) => sum + tank.total, 0), 73);
  assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.stockItemId)).size, 73);
  const groupSearch = await get(`${detailPath}&search=GROUP-QA`, tokens.admin);
  assert.equal(groupSearch.body.total, 63);
  assert.equal(groupSearch.body.items.length, 50);
  assert.equal(groupSearch.body.tanks.length, 3);
  assert.ok(groupSearch.body.tanks.every((tank) => tank.total === 21 && tank.inStock === 21));
  const oneTank = await get(`${detailPath}&search=GROUP-QA&status=inStock&tankKey=${encodeURIComponent("tank:nanjing:tank-n3")}&pageSize=10&page=2`, tokens.admin);
  assert.equal(oneTank.response.status, 200, JSON.stringify(oneTank.body));
  assert.equal(oneTank.body.total, 21);
  assert.equal(oneTank.body.items.length, 10);
  assert.ok(oneTank.body.items.every((item) => item.currentSubTankId === "tank-n3" && item.tankKey === "tank:nanjing:tank-n3"));
  assert.deepEqual(oneTank.body.tanks, groupSearch.body.tanks, "tank overview remains usable after entering a tank");
  const impossible = await get(`${detailPath}&search=GROUP-QA&status=lost&tankKey=${encodeURIComponent("tank:nanjing:tank-n3")}`, tokens.admin);
  assert.equal(impossible.body.total, 0);
  assert.deepEqual(impossible.body.tanks, []);
});

test("restricted, removed and unknown tank buckets expose no unauthorized physical identifiers", async () => {
  const staff = await get(`${detailPath}&pageSize=100`, tokens.staff);
  assert.equal(staff.response.status, 200, JSON.stringify(staff.body));
  assert.doesNotMatch(JSON.stringify(staff.body), /PRIVATE_JY_|tank-j1|jiangyin/);
  for (const [key, fishId, label] of [["restricted", "fish-cross", "记录受限"], ["removed", "fish-removed", "记录已删除"], ["unknown", "fish-unknown", "缸位未记录"]]) {
    const tank = staff.body.tanks.find((item) => item.key === key);
    assert.ok(tank, key);
    assert.equal(tank.total, 1);
    assert.equal(tank.siteName, "");
    assert.equal(tank.tankName, label);
    assert.equal(tank.siteId, undefined);
    assert.equal(tank.subTankId, undefined);
    const rows = await get(`${detailPath}&tankKey=${key}`, tokens.staff);
    assert.deepEqual(rows.body.items.map((item) => item.stockItemId), [fishId]);
    assert.equal(rows.body.items[0].currentSubTankId, "");
    assert.equal(rows.body.items[0].tankKey, key);
  }
  const hiddenTank = await get(`${detailPath}&tankKey=${encodeURIComponent("tank:jiangyin:tank-j1")}`, tokens.staff);
  assert.equal(hiddenTank.body.total, 0);
  assert.doesNotMatch(JSON.stringify(hiddenTank.body), /PRIVATE_JY_|tank-j1|jiangyin/);
});

test("batch-bound order details reject unrelated orders and cannot borrow the batch site's authorization", async () => {
  for (const token of [tokens.admin, tokens.staff]) {
    for (const orderId of ["ORDER-UNRELATED", "ORDER-ORIGINAL-ONLY", "does-not-exist"]) {
      const result = await get(orderPath(orderId), token);
      assert.ok([403, 404].includes(result.response.status), JSON.stringify(result.body));
      assert.equal(result.body.order, undefined);
      assert.doesNotMatch(JSON.stringify(result.body), /UNRELATED_ORDER_MUST_NOT_LEAK|8765/);
    }
  }
  const admin = await get(orderPath("PRIVATE_JY_ORDER"), tokens.admin);
  assert.equal(admin.response.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.order.siteId, "jiangyin");
  assert.equal(admin.body.order.items[0].price, 7654);
  for (const siteId of ["nanjing", "jiangyin"]) {
    const denied = await get(orderPath("PRIVATE_JY_ORDER", "batch-nj", siteId), tokens.staff);
    assert.ok([403, 404].includes(denied.response.status), JSON.stringify(denied.body));
    assert.equal(denied.body.order, undefined);
    assert.doesNotMatch(JSON.stringify(denied.body), /PRIVATE_JY_|7654/);
  }
});

test("order popup returns full-order line totals and verified receipts without leaking private payment fields", async () => {
  for (const token of [tokens.admin, tokens.staff]) {
    const { response, body } = await get(orderPath("ORDER-SALE"), token);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(body.order.id, "ORDER-SALE");
    assert.equal(body.order.items.length, 2, "the popup shows its full order, not only this batch's line");
    assert.equal(body.order.items.find((item) => item.stockItemId === "fish-sold").isBatchFish, true);
    assert.equal(body.order.items.find((item) => item.stockItemId === "other-batch-fish").isBatchFish, false);
    assert.equal(body.order.totals.itemSubtotal, 300);
    assert.equal(body.order.totals.discount, 50);
    assert.equal(body.order.totals.goodsNetTotal, 250);
    assert.equal(body.order.totals.billableShippingFee, 30, "include the order's shipment of other-batch fish when reconciling full-order shipping");
    assert.equal(body.order.totals.calculatedReceivable, 290);
    assert.equal(body.order.totals.received, 250);
    assert.equal(body.order.totals.refunded, 20);
    assert.equal(body.order.totals.netReceived, 230);
    assert.equal(body.order.totals.balance, 60);
    assert.equal(body.order.totals.pendingReceived, 50);
    assert.equal(body.order.totals.pendingRefunded, 5);
    assert.equal(body.order.payments.length, 4);
    assert.ok(body.order.shipments.some((shipment) => shipment.id === "shipment-other-batch" && shipment.batchFishCount === 0));
    assert.doesNotMatch(JSON.stringify(body), privateFieldPattern);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_FINANCE_PROOF|"proof"|"account"|"shippingAddress"|"phone"|"personnel"|"notes"/);
  }
});

test("missing historical line prices remain unknown and malformed order or tank requests are rejected", async () => {
  const missingPrice = await get(orderPath("ORDER-MISSING-PRICE"), tokens.admin);
  assert.equal(missingPrice.response.status, 200, JSON.stringify(missingPrice.body));
  assert.equal(missingPrice.body.order.items[0].price, null);
  for (const key of ["itemSubtotal", "goodsNetTotal", "calculatedReceivable", "balance"]) assert.equal(missingPrice.body.order.totals[key], null, key);
  assert.ok(missingPrice.body.order.warnings.some((warning) => warning.includes("行价缺失")));
  for (const path of [
    "/api/batches/order-detail?batchId=batch-nj&siteId=nanjing",
    orderPath("ORDER-SALE", "batch-nj", "all"),
    `${detailPath}&tankKey=invalid`, `${detailPath}&pageSize=101`, `${detailPath}&page=0`,
  ]) {
    const invalid = await get(path, tokens.admin);
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.order, undefined);
  }
});

test("replacement orders bind to both original and replacement batch evidence without creating duplicate fish sales", async () => {
  const current = await get(orderPath("ORDER-REPLACEMENT"), tokens.admin);
  assert.equal(current.response.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.order.items.length, 2);
  assert.ok(current.body.order.items.every((item) => item.kind === "replacement" && item.isBatchFish));
  const originalOnly = await get(orderPath("ORDER-ORIGINAL-ONLY", "batch-original-only"), tokens.staff);
  assert.equal(originalOnly.response.status, 200, JSON.stringify(originalOnly.body));
  assert.equal(originalOnly.body.order.id, "ORDER-ORIGINAL-ONLY");
  assert.equal(originalOnly.body.order.items.length, 1);
  assert.equal(originalOnly.body.order.items[0].stockItemId, "fish-outside-replacement");
  assert.equal(originalOnly.body.order.items[0].isBatchFish, false);
  assert.ok(originalOnly.body.order.shipments.some((shipment) => shipment.batchFishCount === 1));
});

test("duplicate order identifiers across sites fail closed before hidden-site shipments can be included", async () => {
  const fixture = structuredClone(batchDetailsFixture);
  fixture.state.orders.push({ ...fixture.state.orders.find((order) => order.id === "ORDER-SALE"), siteId: "jiangyin", items: [], customerName: "PRIVATE_DUPLICATE_CUSTOMER" });
  fixture.state.shipments.push({ id: "hidden-duplicate-shipment", orderId: "ORDER-SALE", siteId: "jiangyin", itemStockIds: ["fish-jy-other"], trackingNo: "PRIVATE_DUPLICATE_TRACKING" });
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const variant = spawn(process.execPath, ["--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./test-support/pg-stub-loader.mjs", import.meta.url)), fileURLToPath(new URL("./local-server.mjs", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      AUTH_SESSION_SECRET: "replace_with_batch_detail_duplicate_test_secret", UPLOAD_DIR: uploadDir,
      TRANSCODE_VIDEO_UPLOADS: "false", FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(fixture) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  variant.stdout.on("data", (chunk) => { output += chunk; });
  variant.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Variant server did not start: ${output}`)), 10_000);
      const finish = (error) => { clearTimeout(timer); variant.stdout.off("data", check); variant.off("exit", earlyExit); error ? reject(error) : resolve(); };
      const check = () => { if (output.includes("Local Fishroom API/static server:")) finish(); };
      const earlyExit = () => finish(new Error(`Variant server exited: ${output}`));
      variant.stdout.on("data", check); variant.once("exit", earlyExit); check();
    });
    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "batch-staff", password: BATCH_TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const response = await fetch(`${origin}${orderPath("ORDER-SALE")}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.order, undefined);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_DUPLICATE_/);
  } finally {
    if (variant.exitCode === null && variant.signalCode === null) {
      const exited = once(variant, "exit");
      const timer = setTimeout(() => variant.kill("SIGKILL"), 2_000);
      variant.kill("SIGTERM"); await exited; clearTimeout(timer);
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
  const { response, body } = await get(`${detailPath}&pageSize=100`, tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(body.batch.id, "batch-nj");
  assert.equal(body.items.length, 73);
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
  const { response, body } = await get(`${detailPath}&pageSize=100`, tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  const item = body.items.find((row) => row.stockItemId === "fish-in");
  assert.equal(item.inDate, "2026-08-01");
  assert.ok(!item.initialTankName, "legacy fish have no authoritative initial-position snapshot");
  assert.match(item.currentTankName, /N2/);
  assert.ok(item.warnings.length > 0);
});

test("replacement relationships retain both original fish and replacements without fake sales amounts", async () => {
  const { response, body } = await get(`${detailPath}&pageSize=100`, tokens.admin);
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
  const { response, body } = await get(`${detailPath}&pageSize=100`, tokens.staff);
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
