import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const localServerPath = fileURLToPath(new URL("./local-server.mjs", import.meta.url));
const pgLoaderPath = fileURLToPath(new URL("./test-support/pg-stub-loader.mjs", import.meta.url));
const TEST_PASSWORD = "route-test-password";

function passwordHash(password) {
  const salt = "batch-route-test-salt";
  const hash = scryptSync(password, salt, 32).toString("base64url");
  return `scrypt$1$${salt}$${hash}`;
}

const databaseFixture = {
  revision: 73,
  state: {
    _siteSchemaVersion: 4,
    _personnelSchemaVersion: 3,
    sites: [
      { id: "nanjing", name: "南京" },
      { id: "jiangyin", name: "江阴" },
    ],
    personnel: [
      {
        id: "person-route-admin",
        name: "Route Admin",
        username: "route-admin",
        password: passwordHash(TEST_PASSWORD),
        accessRole: "admin",
        accountEnabled: true,
        employmentStatus: "active",
        sessionVersion: 0,
      },
      {
        id: "person-route-staff",
        name: "Nanjing Staff",
        username: "route-staff",
        password: passwordHash(TEST_PASSWORD),
        accessRole: "staff",
        accountEnabled: true,
        employmentStatus: "active",
        sessionVersion: 0,
        visibleSiteIds: ["nanjing"],
        permissions: {},
      },
    ],
    personnelProfileRequests: [],
    personnelPrivateAttachments: [],
    retiredPersonnelUsernames: [],
    tankGroups: [
      { id: "group-nj", siteId: "nanjing", subTanks: [{ id: "tank-nj" }] },
      { id: "group-jy", siteId: "jiangyin", subTanks: [{ id: "tank-jy" }] },
    ],
    batches: [
      { id: "batch-nj-a", siteId: "nanjing" },
      { id: "batch-nj-b", siteId: "nanjing" },
      { id: "batch-jy", siteId: "jiangyin" },
    ],
    stock: [
      { id: "stock-nj-a", batchId: "batch-nj-a", subTankId: "tank-nj", siteId: "nanjing", inDate: "2026-08-03" },
      { id: "stock-nj-b", batchId: "batch-nj-b", subTankId: "tank-nj", siteId: "nanjing", inDate: "2026-08-04" },
      { id: "stock-jy", batchId: "batch-jy", subTankId: "tank-jy", siteId: "jiangyin", inDate: "2026-08-05" },
    ],
    orders: [
      {
        id: "order-nj-cross-batch",
        siteId: "nanjing",
        items: [
          { stockItemId: "stock-nj-a", price: 100 },
          { stockItemId: "stock-nj-b", price: 300 },
        ],
        discount: 40,
        payments: [
          { type: "balance", amount: 180, verificationStatus: "verified" },
          { type: "balance", amount: 90, verificationStatus: "pending" },
        ],
      },
      {
        id: "order-nj-platform",
        siteId: "nanjing",
        source: "平台下单",
        douyinOrderNo: "SHARED-42",
        items: [{ stockItemId: "stock-nj-a", price: 50 }],
        payments: [{ type: "balance", amount: 50, verificationStatus: "verified" }],
      },
      {
        id: "order-nj-unassigned",
        siteId: "nanjing",
        items: [{ stockItemId: "missing-stock", price: 25 }],
        payments: [{ type: "balance", amount: 25, verificationStatus: "verified" }],
      },
      {
        id: "order-jy-platform",
        siteId: "jiangyin",
        source: "平台下单",
        douyinOrderNo: "SHARED-42",
        items: [{ stockItemId: "stock-jy", price: 999 }],
        payments: [{ type: "balance", amount: 999, verificationStatus: "verified" }],
      },
    ],
    shipments: [],
    logs: [],
    bioRecords: [],
  },
  platformSettlements: [
    {
      state_id: "main",
      site_id: "nanjing",
      platform: "douyin",
      external_order_no: "SHARED-42",
      data: { incomeTotal: 12.34 },
    },
    {
      state_id: "main",
      site_id: "nanjing",
      platform: "douyin",
      external_order_no: "SHARED-42",
      data: { incomeTotal: 7.66 },
    },
    {
      state_id: "main",
      site_id: "jiangyin",
      platform: "douyin",
      external_order_no: "SHARED-42",
      data: { incomeTotal: 700 },
    },
  ],
};

let child;
let baseUrl;
let uploadDir;
let staffToken;
let adminToken;
let childOutput = "";

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServerStart(process, timeoutMs = 10_000) {
  if (childOutput.includes("Local Fishroom API/static server:")) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off("data", onStdout);
      process.off("exit", onExit);
      callback(value);
    };
    const onStdout = (chunk) => {
      if (String(chunk).includes("Local Fishroom API/static server:")) finish(resolve);
    };
    const onExit = (code, signal) => {
      finish(reject, new Error(
        `local-server exited before listening (code=${code}, signal=${signal})\n${childOutput}`
      ));
    };
    const timer = setTimeout(() => finish(
      reject,
      new Error(`timed out waiting for local-server\n${childOutput}`)
    ), timeoutMs);
    process.stdout.on("data", onStdout);
    process.once("exit", onExit);
  });
}

async function login(username) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 20);
  return body.token;
}

async function getMetrics(siteId, token) {
  const query = siteId === undefined ? "" : `?siteId=${encodeURIComponent(siteId)}`;
  const response = await fetch(`${baseUrl}/api/batches/revenue-metrics${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { response, body: await response.json() };
}

before(async () => {
  const port = await unusedPort();
  uploadDir = await mkdtemp(join(tmpdir(), "fishroom-batch-route-test-"));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-loader",
    pgLoaderPath,
    localServerPath,
  ], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_SESSION_SECRET: "replace_with_integration_test_secret",
      UPLOAD_DIR: uploadDir,
      TRANSCODE_VIDEO_UPLOADS: "false",
      FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(databaseFixture),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  await waitForServerStart(child);
  staffToken = await login("route-staff");
  adminToken = await login("route-admin");
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    let shutdownTimer;
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => { shutdownTimer = setTimeout(resolve, 2_000); }),
    ]);
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, "exit");
      child.kill("SIGKILL");
      await forcedExit;
    }
  }
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

test("GET revenue metrics rejects requests without a valid authenticated session", async () => {
  const missing = await getMetrics("nanjing");
  assert.equal(missing.response.status, 401);
  assert.deepEqual(missing.body, { ok: false, error: "Authentication required" });

  const invalid = await getMetrics("nanjing", "not-a-valid-session");
  assert.equal(invalid.response.status, 401);
  assert.deepEqual(invalid.body, { ok: false, error: "Authentication required" });
});

test("GET revenue metrics rejects missing and all-site scopes", async () => {
  for (const siteId of [undefined, "all"]) {
    const { response, body } = await getMetrics(siteId, adminToken);
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /请选择具体场地/);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
  }
});

test("a staff session cannot cross its authoritative visible-site scope", async () => {
  const { response, body } = await getMetrics("jiangyin", staffToken);
  assert.equal(response.status, 403);
  assert.equal(body.ok, false);
  assert.match(body.error, /未授权场地/);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
});

test("authorized request aggregates cross-batch payments and site-scoped settlements", async () => {
  const { response, body } = await getMetrics("nanjing", staffToken);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(body.ok, true);
  assert.equal(body.siteId, "nanjing");
  assert.equal(body.version, "73");
  assert.deepEqual(body.metrics, [
    {
      batchId: "batch-nj-a",
      earliestStockInDate: "2026-08-03",
      salesNet: 140,
      pendingReceived: 22.5,
      verifiedReceived: 65,
      platformReceived: 20,
      gross: 150,
      discount: 10,
      refundAdjustment: 0,
      itemCount: 2,
      orderCount: 2,
      platformOrderCount: 1,
    },
    {
      batchId: "batch-nj-b",
      earliestStockInDate: "2026-08-04",
      salesNet: 270,
      pendingReceived: 67.5,
      verifiedReceived: 135,
      platformReceived: 0,
      gross: 300,
      discount: 30,
      refundAdjustment: 0,
      itemCount: 1,
      orderCount: 1,
      platformOrderCount: 0,
    },
  ]);
  assert.deepEqual(body.diagnostics, {
    unassignedItemCount: 1,
    unassignedSalesNet: 25,
  });

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /batch-jy|order-jy|stock-jy|SHARED-42/);
  assert.doesNotMatch(serialized, /external_order_no|income_total|platformSettlements/);
});

test("an admin request sees the other site's independent aggregate only", async () => {
  const { response, body } = await getMetrics("jiangyin", adminToken);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.siteId, "jiangyin");
  assert.deepEqual(body.metrics, [{
    batchId: "batch-jy",
    earliestStockInDate: "2026-08-05",
    salesNet: 999,
    pendingReceived: 0,
    verifiedReceived: 700,
    platformReceived: 700,
    gross: 999,
    discount: 0,
    refundAdjustment: 0,
    itemCount: 1,
    orderCount: 1,
    platformOrderCount: 1,
  }]);
  assert.deepEqual(body.diagnostics, {
    unassignedItemCount: 0,
    unassignedSalesNet: 0,
  });
});
