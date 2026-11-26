import assert from "node:assert/strict";
import { mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudTestMediaResolver } from "./cloud-test-media.mjs";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";

const source = "https://fishroom-123456.cos.ap-nanjing.myqcloud.com/original/fish.jpg";
const signed = `${source}?q-sign-algorithm=sha1&q-signature=test-get-signature`;
const clock = Date.now();
const mapping = (entry = { url: signed, expiresAt: clock + 7 * 24 * 3600 * 1000 }) => ({ generatedAt: new Date(clock).toISOString(), entries: { [source]: entry } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "fishroom-cloud-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "media-map.json");
  await writeFile(path, JSON.stringify(mapping()));
  return { dir, path, resolve: createCloudTestMediaResolver({ path, now: () => clock }) };
}

test("signed map resolves exact allowed originals and reloads an atomic renewal", async t => {
  const s = await fixture(t);
  assert.deepEqual(await s.resolve(source), { url: signed, expiresIn: 7 * 24 * 3600 });
  await assert.rejects(s.resolve(`${source}?extra=1`), error => error.statusCode === 404);
  const renewed = `${source}?q-signature=renewed-get-signature`;
  await writeFile(`${s.path}.next`, JSON.stringify(mapping({ url: renewed, expiresAt: clock + 3600_000 })));
  await rename(`${s.path}.next`, s.path);
  assert.deepEqual(await s.resolve(source), { url: renewed, expiresIn: 3600 });
});

test("signed map never returns mismatched hosts, paths, HTTP, credentials or expired links", async t => {
  const s = await fixture(t);
  for (const url of ["https://attacker.invalid/fish.jpg", signed.replace("fishroom-123456", "other-123456"),
    signed.replace("fish.jpg", "different.jpg"), signed.replace("https:", "http:"), signed.replace("https://", "https://user:password@")]) {
    await writeFile(s.path, JSON.stringify(mapping({ url, expiresAt: clock + 3600_000 })));
    await assert.rejects(s.resolve(source), error => error.statusCode === 503);
  }
  await writeFile(s.path, JSON.stringify(mapping({ url: signed, expiresAt: clock + 59_000 })));
  await assert.rejects(s.resolve(source), error => error.statusCode === 503 && error.message.includes("已过期"));
  await assert.rejects(s.resolve("https://attacker.invalid/fish.jpg"), error => error.statusCode === 404);
});

test("missing, oversized and symlink indexes fail closed without exposing their path or content", async t => {
  const s = await fixture(t);
  await rm(s.path);
  await assert.rejects(s.resolve(source), error => error.statusCode === 503 && !error.message.includes(s.path));
  await writeFile(s.path, "{}"); await truncate(s.path, 32 * 1024 * 1024 + 1);
  await assert.rejects(s.resolve(source), error => error.statusCode === 503);
  await rm(s.path); await writeFile(join(s.dir, "elsewhere.json"), JSON.stringify(mapping()));
  await symlink(join(s.dir, "elsewhere.json"), s.path);
  await assert.rejects(s.resolve(source), error => error.statusCode === 503);
});

test("cloud HTTP signing and legacy redirect require login, work without COS keys and preserve local uploads", async t => {
  const f = await fixture(t);
  const server = await startMutableRouteServer(structuredClone(stockPricingFixture), { env: {
    FISHROOM_CLOUD_TEST: "true", PGHOST: "database", PGDATABASE: "fishroom_test", PGUSER: "fishroom_test", PGPORT: "5432",
    DATABASE_URL: "", PGHOSTADDR: "", COS_SECRET_ID: "", COS_SECRET_KEY: "", COS_BUCKET: "", COS_REGION: "",
    FISHROOM_CLOUD_TEST_MEDIA_MAP: f.path,
  } });
  t.after(() => server.stop());
  const query = new URLSearchParams({ url: source, preview: "image", width: "96" });
  const path = `/api/media/cos-url?${query}`;
  assert.equal((await server.request(path)).response.status, 401);
  assert.equal((await fetch(`${server.baseUrl}/api/media/cos?${query}`, { redirect: "manual" })).status, 401);
  const token = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const result = await server.request(path, { token });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.url, signed); assert.ok(result.body.expiresIn > 0);
  assert.equal(result.response.headers.get("cache-control"), "no-store, private");
  const redirect = await fetch(`${server.baseUrl}/api/media/cos?${query}`, { headers: { Cookie: `fishroom_auth=${token}` }, redirect: "manual" });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get("location"), signed);
  assert.equal(redirect.headers.get("cache-control"), "no-store, private");
  const absent = await server.request(`/api/media/cos-url?url=${encodeURIComponent(source.replace("fish.jpg", "absent.jpg"))}`, { token });
  assert.equal(absent.response.status, 404);
  await writeFile(f.path, JSON.stringify(mapping({ url: signed, expiresAt: clock - 1000 })));
  const expired = await server.request(path, { token }); assert.equal(expired.response.status, 503);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=", "base64");
  const upload = await fetch(`${server.baseUrl}/api/media/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png", "X-File-Name": "new.png" }, body: image });
  assert.equal(upload.status, 200); const uploaded = await upload.json();
  assert.equal(uploaded.storage, "local"); assert.match(uploaded.url, /^\/uploads\//);
  const reopened = await fetch(`${server.baseUrl}${uploaded.url}`, { headers: { Cookie: `fishroom_auth=${token}` } });
  assert.equal(reopened.status, 200); assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), image);
});
