import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { validateCloudTestEnvironment } from "./cloud-test-access.mjs";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const cloudEnv = { FISHROOM_CLOUD_TEST: "true", PGHOST: "database", PGDATABASE: "fishroom_test", PGUSER: "fishroom_test", PGPORT: "5432", DATABASE_URL: "", PGHOSTADDR: "" };
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=", "base64");
async function setup(t, env) {
  const server = await startMutableRouteServer(structuredClone(stockPricingFixture), { env });
  t.after(() => server.stop());
  await writeFile(join(server.uploadDir, "test-photo.png"), image);
  return server;
}

test("cloud test refuses production database targets and connection-string overrides before startup", () => {
  assert.equal(validateCloudTestEnvironment(cloudEnv), true);
  for (const patch of [{ PGHOST: "production-db" }, { PGDATABASE: "fishroom" }, { PGUSER: "fishroom" }, { PGPORT: "5433" },
    { DATABASE_URL: "postgresql://production/database" }, { PGHOSTADDR: "127.0.0.1" }]) {
    assert.throws(() => validateCloudTestEnvironment({ ...cloudEnv, ...patch }), /CLOUD_TEST_DATABASE_TARGET_REFUSED/);
  }
  assert.equal(validateCloudTestEnvironment({}), false);
  assert.equal(validateCloudTestEnvironment({ FISHROOM_CLOUD_TEST: "false", PGDATABASE: "fishroom" }), false);
});

test("cloud test blocks anonymous public APIs, Mini Program entry and uploads before their handlers", async t => {
  const s = await setup(t, cloudEnv);
  for (const [path, method] of [
    ["/api/public/catalog", "GET"], ["/api/public/bio-records", "GET"],
    ["/api/public/media/video-derivative?src=/uploads/test-photo.png", "GET"],
    ["/api/public/media/cos", "HEAD"], ["/api/mini/login", "POST"], ["/api/mini/config", "GET"],
    ["/api/assistant/feishu/events", "POST"], ["/uploads/test-photo.png", "GET"],
    ["/uploads/.personnel-private/private.bin", "GET"], ["/api/auth/login", "GET"],
  ]) {
    const response = await fetch(`${s.baseUrl}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    if (method !== "HEAD") assert.equal((await response.json()).code, "CLOUD_TEST_AUTH_REQUIRED");
  }
  for (const path of ["/api/health", "/api/version"]) assert.equal((await s.request(path)).response.status, 200);
  assert.equal((await s.request("/api/auth/logout", { method: "POST" })).response.status, 200);
  const preflight = await fetch(`${s.baseUrl}/api/public/catalog`, { method: "OPTIONS", headers: { Origin: "https://outside.invalid" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("cloud test allows authenticated image/video requests using cookies and rejects revoked sessions", async t => {
  const s = await setup(t, cloudEnv);
  const login = await s.request("/api/auth/login", { body: { username: "pricing-admin", password: PRICING_TEST_PASSWORD } });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";", 1)[0];
  const token = login.body.token;
  for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
    const response = await fetch(`${s.baseUrl}/uploads/test-photo.png`, { headers });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const catalog = await s.request("/api/public/catalog", { token });
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.response.headers.get("cache-control"), "no-store, private");
  assert.equal((await s.request("/api/mobile-maintenance/history?siteId=nanjing", { token })).response.status, 200);
  // Existing private attachment protections still apply to authenticated users.
  const privateFile = await fetch(`${s.baseUrl}/uploads/.personnel-private/private.bin`, { headers: { Cookie: cookie } });
  assert.equal(privateFile.status, 404);
  await s.patchTestPersonnel("pricing-admin", { accountEnabled: false });
  assert.equal((await fetch(`${s.baseUrl}/uploads/test-photo.png`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await s.request("/api/public/catalog", { token })).response.status, 401);
});

test("flag unset preserves ordinary public catalog and upload access", async t => {
  const s = await setup(t, { FISHROOM_CLOUD_TEST: "false" });
  assert.equal((await s.request("/api/public/catalog")).response.status, 200);
  const response = await fetch(`${s.baseUrl}/uploads/test-photo.png`);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  assert.match(response.headers.get("cache-control"), /public/);
  const health = await s.request("/api/health");
  assert.equal(health.response.headers.get("access-control-allow-origin"), "*");
});
