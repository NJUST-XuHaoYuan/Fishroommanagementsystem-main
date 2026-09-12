import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { TEST_PASSWORD, CHINA_TODAY, databaseFixture } from "./test-support/dashboard-fixture.mjs";

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
  uploadDir = await mkdtemp(join(tmpdir(), "fishroom-dashboard-route-test-"));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./test-support/pg-stub-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./local-server.mjs", import.meta.url)),
  ], {
    env: {
      ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      AUTH_SESSION_SECRET: "replace_with_dashboard_integration_secret",
      UPLOAD_DIR: uploadDir, TRANSCODE_VIDEO_UPLOADS: "false",
      FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(databaseFixture),
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
      body: JSON.stringify({ username: `dashboard-${role}`, password: TEST_PASSWORD }),
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

test("both dashboard endpoints deny unauthenticated and staff sessions even with finance permissions", async () => {
  for (const path of ["/api/dashboard-summary", "/api/dashboard-focus?mode=species&id=s1", "/api/dashboard-focus"]) {
    for (const token of [undefined, "invalid-session"]) {
      const { response, body } = await get(path, token);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get("cache-control"), "no-store, private");
      assert.equal(body.summary, undefined);
      assert.equal(body.focus, undefined);
    }
    const { response, body } = await get(path, tokens.staff);
    assert.equal(response.status, 403, path);
    assert.equal(body.summary, undefined);
    assert.equal(body.focus, undefined);
    assert.match(body.error, /管理员/);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
  }
});

test("admin can read summary and focus without exposing raw personnel records", async () => {
  for (const path of ["/api/dashboard-summary", "/api/dashboard-focus?mode=species&id=s1"]) {
    const { response, body } = await get(path, tokens.admin);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.doesNotMatch(JSON.stringify(body), /scrypt\$|"password"|"personnel"/);
  }
});

test("staff fallback daily page can still load its normal state slice with array collections", async () => {
  const keys = "systemSettings,products,tankGroups,batches,stock,orders,shipments,logs,waterQualityRecords,personnel";
  const { response, body } = await get(`/api/state/slice?keys=${keys}`, tokens.staff);
  assert.equal(response.status, 200, JSON.stringify(body));
  for (const key of keys.split(",").filter((key) => key !== "systemSettings")) {
    assert.equal(Array.isArray(body.data[key]), true, `${key} must remain an array`);
  }
  assert.equal(body.data.products[0].id, "p1");
  assert.equal(body.data.tankGroups.length, 2);
});

test("historical start/end range is inclusive and salesperson totals ignore orders outside it", async () => {
  const { response, body } = await get("/api/dashboard-summary?startDate=2026-09-01&endDate=2026-09-02&siteId=all", tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  const summary = body.summary;
  assert.equal(summary.startDate, "2026-09-01");
  assert.equal(summary.endDate, "2026-09-02");
  assert.equal(summary.financeDays, 2);
  for (const key of ["dailySalespersonData", "dailyFinanceData", "dailyLossData"]) {
    assert.deepEqual(summary[key].map((point) => point.date), ["2026-09-01", "2026-09-02"]);
  }
  assert.deepEqual(summary.salespersonOptions.slice(0, 5).map((option) => [option.name, option.amount]), [
    ["销售1", 750], ["销售6", 600], ["销售5", 500], ["销售4", 400], ["销售3", 300],
  ]);
  assert.equal(summary.salespersonOptions.find((option) => option.name === "销售0")?.amount ?? 0, 0);
  assert.deepEqual(summary.dailySalespersonData.map((point) => point.total), [2100, 650]);
});

test("loss details preserve the loss event site and site filters use that historical site", async () => {
  const expected = {
    all: [["lost-nj", "nanjing", "南京"], ["lost-jy", "jiangyin", "江阴"], ["lost-legacy-nj", "nanjing", "南京"]],
    nanjing: [["lost-nj", "nanjing", "南京"], ["lost-legacy-nj", "nanjing", "南京"]],
    jiangyin: [["lost-jy", "jiangyin", "江阴"]],
  };
  for (const [siteId, details] of Object.entries(expected)) {
    const { response, body } = await get(`/api/dashboard-summary?startDate=2026-09-01&endDate=2026-09-02&siteId=${siteId}`, tokens.admin);
    assert.equal(response.status, 200, JSON.stringify(body));
    const actual = body.summary.dailyLossData.flatMap((point) => point.lossDetails);
    assert.deepEqual(actual.map((row) => [row.stockItemId, row.siteId, row.siteName]), details, siteId);
    if (siteId !== "jiangyin") assert.equal(actual.find((row) => row.stockItemId === "lost-nj").tankName, "历史南京缸 / N1");
  }
});

test("today receipt card stays on China today when chart selects a different historical ending day", async () => {
  const { response, body } = await get("/api/dashboard-summary?startDate=2026-09-01&endDate=2026-09-02&siteId=all", tokens.admin);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.summary.today, CHINA_TODAY);
  assert.equal(body.summary.todayReceived, 987 + (CHINA_TODAY === "2026-09-02" ? 100 : 0));
  assert.equal(body.summary.dailyFinanceData.at(-1).received, 100 + (CHINA_TODAY === "2026-09-02" ? 987 : 0));
});

test("explicit malformed or overlong date ranges are rejected instead of silently selecting another interval", async () => {
  for (const query of [
    "startDate=2026-09-01", "endDate=2026-09-02", "startDate=&endDate=2026-09-02",
    "startDate=2026-02-30&endDate=2026-03-01", "startDate=2026-09-03&endDate=2026-09-02",
    "startDate=2026-09-01T00:00:00&endDate=2026-09-02", "startDate=2024-09-01&endDate=2026-09-01",
  ]) {
    const { response, body } = await get(`/api/dashboard-summary?${query}`, tokens.admin);
    assert.equal(response.status, 400, `${query}: ${JSON.stringify(body)}`);
    assert.equal(body.summary, undefined);
  }
});

test("single-day and maximum 730-day ranges are accepted and legacy financeDays remains compatible", async () => {
  for (const [query, count] of [
    ["startDate=2026-09-01&endDate=2026-09-01", 1],
    ["startDate=2024-09-01&endDate=2026-08-31", 730],
    ["financeDays=7", 7],
    ["days=30", 30],
  ]) {
    const { response, body } = await get(`/api/dashboard-summary?${query}`, tokens.admin);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.summary.financeDays, count, query);
    assert.equal(body.summary.dailySalespersonData.length, count, query);
  }
});
