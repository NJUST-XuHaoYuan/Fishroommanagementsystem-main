import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { newCustomerEvidenceFixture, evidencePng, EVIDENCE_TEST_KEYRING, PRICING_TEST_PASSWORD } from "./test-support/new-customer-evidence-fixture.mjs";
import { NEW_CUSTOMER_EVIDENCE_DIRECTORY, newCustomerEvidenceId, newCustomerEvidencePath, normalizeNewCustomerEvidenceImage } from "./new-customer-evidence.mjs";
import { publicVideoDerivativeProxyPath } from "./video-preview.mjs";
const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const image = evidencePng();
async function setup(t, fixture = newCustomerEvidenceFixture(), env = {}) {
  const s = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING, ...env } });
  t.after(() => s.stop());
  const admin = await s.login("pricing-admin", PRICING_TEST_PASSWORD), owner = await s.login("pricing-editor", PRICING_TEST_PASSWORD), other = await s.login("pricing-viewer", PRICING_TEST_PASSWORD);
  const upload = async ({ token = owner, body = image, mime = "image/png", orderId = "ORDER-PENDING", name = "客户聊天截图.png" } = {}) => {
    const response = await fetch(`${s.baseUrl}/api/orders/new-customer/evidence?orderId=${encodeURIComponent(orderId)}`, { method: "POST", headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": mime, "x-file-name": encodeURIComponent(name),
    }, body });
    return { response, body: await response.json() };
  };
  const get = (id, token = owner, method = "GET") => fetch(`${s.baseUrl}/api/orders/new-customer/evidence/${id}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const detail = (token = owner) => s.request("/api/orders/new-customer/detail?orderId=ORDER-PENDING", { token });
  const submit = (evidenceIds = [], body = {}, token = owner) => s.request("/api/orders/new-customer/request", { token, body: { orderId: "ORDER-PENDING", reason: "已核对微信记录为首次购买客户", expectedApprovalVersion: 0, evidenceIds, ...body } });
  const review = async (decision = "approve") => {
    const current = (await s.readPersistedState()).orders[0].newCustomerApproval;
    return s.request("/api/orders/new-customer/review", { token: admin, body: { orderId: "ORDER-PENDING", requestId: current.requestId, expectedApprovalVersion: current.version, decision, note: "补充核实说明" } });
  };
  return { ...s, admin, owner, other, upload, get, detail, submit, review };
}

test("real image upload encrypts private bytes, recovers own drafts, authorizes private previews and alters no business data", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  const result = await s.upload(); ok(result); const attachment = result.body.attachment;
  assert.equal(attachment.originalName, "客户聊天截图.png"); assert.equal(attachment.mime, "image/jpeg");
  assert.deepEqual(Object.keys(attachment), ["id", "originalName", "mime", "size", "createdAt"]);
  const file = newCustomerEvidencePath(s.uploadDir, attachment.id), encrypted = await readFile(file);
  assert.equal(encrypted.subarray(0, 3).toString("hex"), "6e6577"); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const preview = await s.get(attachment.id); assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store, private");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  const jpeg = Buffer.from(await preview.arrayBuffer()); assert.equal(jpeg.subarray(0, 3).toString("hex"), "ffd8ff"); assert.equal(jpeg.length, attachment.size);
  for (const token of [s.admin, s.other, ""]) assert.equal((await s.get(attachment.id, token)).status, token ? 403 : 401);
  const details = await s.detail(); ok(details); assert.deepEqual(details.body.draftEvidenceAttachments, [attachment]);
  assert.deepEqual((await s.detail(s.admin)).body.draftEvidenceAttachments, []);
  assert.equal((await s.detail(s.other)).body.canViewEvidence, false);
  const after = await s.readPersistedState(); delete after.newCustomerEvidenceAttachments; delete before.newCustomerEvidenceAttachments; assert.deepEqual(after, before);
});

test("bound proof is immutable, survives review/rejection and supports exact idempotency and resubmission", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  const uploaded = await s.upload(); ok(uploaded); const attachment = uploaded.body.attachment;
  const requested = await s.submit([attachment.id], { evidenceAttachments: [{ id: attachment.id, originalName: "forged" }] }); ok(requested);
  assert.deepEqual(requested.body.order.newCustomerApproval.evidenceAttachments, [attachment]);
  const retry = await s.submit([attachment.id]); ok(retry); assert.equal(retry.body.unchanged, true);
  assert.equal((await s.submit([])).response.status, 409);
  assert.equal((await s.get(attachment.id, s.owner, "DELETE")).status, 409);
  assert.equal((await s.get(attachment.id, s.admin)).status, 200);
  assert.equal((await s.get(attachment.id, s.other)).status, 403);
  assert.equal((await s.upload()).response.status, 409);
  const notices = await s.request("/api/notifications", { token: s.admin });
  const notice = notices.body.notifications.find((item) => item.type === "new_customer_approval");
  const notification = await s.request(`/api/notifications/detail?id=${notice.id}`, { token: s.admin }); ok(notification);
  assert.deepEqual(notification.body.notification.newCustomerReview.approval.evidenceAttachments, [attachment]);
  ok(await s.review("reject")); assert.equal((await s.get(attachment.id, s.owner, "DELETE")).status, 409);
  ok(await s.submit([attachment.id], { expectedApprovalVersion: 2, reason: "已补充核对新客户身份并提供凭证" }));
  ok(await s.review());
  const after = await s.readPersistedState(); assert.equal(after.newCustomerEvidenceAttachments[0].boundRequestIds.length, 2);
  assert.deepEqual(after.orders[0].newCustomerApproval.evidenceAttachments, [attachment]);
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.orders[0].items, before.orders[0].items); assert.deepEqual(after.orders[0].payments, before.orders[0].payments);
});

test("private registry and media cannot be read/forged through generic state, uploads or signed derivatives", async (t) => {
  const s = await setup(t), result = await s.upload(); ok(result); const { id } = result.body.attachment;
  const full = await s.request("/api/state", { token: s.admin }); ok(full); assert.equal(full.body.data.newCustomerEvidenceAttachments, undefined);
  assert.equal((await s.request("/api/state/slice?keys=newCustomerEvidenceAttachments", { token: s.admin })).response.status, 400);
  const patch = await s.request("/api/state/patch", { token: s.admin, body: { patch: { newCustomerEvidenceAttachments: [] } } });
  assert.equal(patch.response.status, 400); assert.match(patch.body.error, /不支持的状态字段/);
  const snapshot = await s.readPersistedState();
  for (const path of [`/uploads/.new-customer-evidence/${id}.bin`, `/uploads/%2enew-customer-evidence/${id}.bin`, `/uploads/a/%2e%2e/.new-customer-evidence/${id}.bin`]) {
    for (const token of [s.owner, ""]) {
      const response = await fetch(`${s.baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); assert.equal(response.status, 404);
    }
    const signedPath = publicVideoDerivativeProxyPath(path, "poster", { secret: "replace_with_stock_pricing_integration_secret" });
    const derivative = await fetch(`${s.baseUrl}${signedPath}`); assert.equal(derivative.status, 400);
    assert.match((await derivative.json()).error, /Invalid video preview source/);
  }
  const forged = structuredClone(snapshot.orders[0]); forged.newCustomerApproval = { status: "pending", evidenceAttachments: [result.body.attachment] };
  const write = await s.request("/api/state/patch", { token: s.admin, body: { patch: { orders: [forged] }, basePatch: { orders: snapshot.orders } } });
  assert.equal(write.response.status, 409); assert.match(write.body.error, /新客|版本|刷新/);
  assert.deepEqual(await s.readPersistedState(), snapshot);
});

test("upload rejects wrong actors, hidden sites, duplicate orders and invalid images without retaining files", async (t) => {
  const s = await setup(t), before = await s.readPersistedState();
  for (const token of [s.admin, s.other, ""]) assert.equal((await s.upload({ token })).response.status, token ? 403 : 401);
  for (const options of [{ body: Buffer.from("<svg/>"), mime: "image/svg+xml" }, { body: Buffer.from("forged"), mime: "image/png" }, { body: image.subarray(0, 24), mime: "image/png" }]) {
    const result = await s.upload(options); assert.ok([400, 415].includes(result.response.status), JSON.stringify(result.body)); assert.doesNotMatch(result.body.error, /ffmpeg|\/tmp|Command failed/i);
  }
  assert.deepEqual(await s.readPersistedState(), before);
  assert.deepEqual(await readdir(join(s.uploadDir, NEW_CUSTOMER_EVIDENCE_DIRECTORY)).catch(() => []), []);
  const hidden = newCustomerEvidenceFixture(); hidden.state.orders[0].siteId = "jiangyin";
  const otherSite = await setup(t, hidden); assert.equal((await otherSite.upload()).response.status, 403);
  const duplicate = newCustomerEvidenceFixture(); duplicate.state.orders.push(structuredClone(duplicate.state.orders[0]));
  const duplicateServer = await setup(t, duplicate); assert.equal((await duplicateServer.upload()).response.status, 409);
});

test("draft deletion is uploader-only, quota recovers and submit/delete races never commit a missing file", async (t) => {
  const s = await setup(t); const attachments = [];
  for (let index = 0; index < 6; index++) { const result = await s.upload(); ok(result); attachments.push(result.body.attachment); }
  assert.equal((await s.upload()).body.code, "NEW_CUSTOMER_EVIDENCE_QUOTA");
  assert.equal((await s.detail()).body.draftEvidenceAttachments.length, 6);
  assert.equal((await s.get(attachments[0].id, s.admin, "DELETE")).status, 403);
  assert.equal((await s.get(attachments[0].id, s.owner, "DELETE")).status, 200);
  assert.equal((await s.get(attachments[0].id)).status, 404);
  ok(await s.upload());
  const id = attachments[1].id;
  const [submitted, removed] = await Promise.all([s.submit([id]), s.get(id, s.owner, "DELETE")]);
  if (submitted.response.status === 200) {
    assert.equal(removed.status, 409); assert.equal((await s.get(id)).status, 200);
  } else { assert.equal(removed.status, 200); assert.equal(submitted.response.status, 404); }
});

test("old no-image requests remain valid; submitted images obey fresh account and current site access", async (t) => {
  const old = await setup(t); ok(await old.submit()); ok(await old.review());
  const s = await setup(t); const uploaded = await s.upload(); ok(uploaded); const id = uploaded.body.attachment.id; ok(await s.submit([id]));
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["jiangyin"] });
  assert.equal((await s.get(id)).status, 403);
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["nanjing"], accountEnabled: false });
  assert.equal((await s.get(id)).status, 401);
  await s.patchTestPersonnel("pricing-admin", { sessionVersion: 1 });
  assert.equal((await s.get(id, s.admin)).status, 401);
});

test("invalid evidence IDs, duplicates, expired drafts and wrong-order binding cannot change an application", async (t) => {
  const data = newCustomerEvidenceFixture(), expiredId = newCustomerEvidenceId(), otherOrderId = newCustomerEvidenceId(), otherOwnerId = newCustomerEvidenceId();
  const metadata = { uploaderPersonnelId: "pricing-editor", uploaderUsername: "pricing-editor", orderId: "ORDER-PENDING", size: 100, mime: "image/jpeg", originalName: "synthetic.jpg", boundRequestIds: [] };
  data.state.newCustomerEvidenceAttachments = [
    { ...metadata, id: expiredId, createdAt: "2026-01-01T00:00:00Z" },
    { ...metadata, id: otherOrderId, orderId: "OTHER-ORDER", createdAt: new Date().toISOString() },
    { ...metadata, id: otherOwnerId, uploaderPersonnelId: "pricing-admin", uploaderUsername: "pricing-admin", createdAt: new Date().toISOString() },
  ];
  const s = await setup(t, data), before = await s.readPersistedState();
  for (const [ids, status] of [[[expiredId], 409], [[otherOrderId], 403], [[otherOwnerId], 403], [[newCustomerEvidenceId()], 404], [["../bad"], 400], [[expiredId, expiredId], 400], [Array.from({ length: 7 }, newCustomerEvidenceId), 400]]) {
    assert.equal((await s.submit(ids)).response.status, status);
  }
  assert.deepEqual(await s.readPersistedState(), before);
  assert.deepEqual((await s.detail()).body.draftEvidenceAttachments, []);
  assert.equal((await s.get(expiredId)).status, 410);
});

test("failed registry write rolls back and cleans generated private file without changing business state", async (t) => {
  const data = newCustomerEvidenceFixture(); data.failNewCustomerEvidenceWrite = true;
  const s = await setup(t, data), before = await s.readPersistedState();
  const failed = await s.upload(); assert.equal(failed.response.status, 500); assert.doesNotMatch(failed.body.error, /Injected|database|\/tmp|Command/);
  assert.deepEqual(await s.readPersistedState(), before);
  assert.deepEqual(await readdir(join(s.uploadDir, NEW_CUSTOMER_EVIDENCE_DIRECTORY)), []);
  ok(await s.upload());
});

test("real decoder produces JPEG from PNG/JPEG/WebP, preserves white transparency and rejects forged headers", async (t) => {
  const options = { ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg", ffprobePath: process.env.FFPROBE_PATH || "ffprobe" };
  const temp = await mkdtemp(join(tmpdir(), "fishroom-evidence-codec-test-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const jpeg = await normalizeNewCustomerEvidenceImage(image, "image/png", options);
  assert.equal(jpeg.subarray(0, 3).toString("hex"), "ffd8ff");
  assert.ok((await normalizeNewCustomerEvidenceImage(jpeg, "image/jpeg", options)).length > 0);
  await writeFile(join(temp, "normalized.jpg"), jpeg);
  const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==", "base64");
  assert.ok((await normalizeNewCustomerEvidenceImage(webp, "image/webp", options)).length > 0);
  const { stdout } = await exec(options.ffmpegPath, ["-loglevel", "error", "-i", join(temp, "normalized.jpg"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
  // The first source pixel is fully transparent; JPEG conversion must flatten it white.
  assert.ok(stdout[0] > 220 && stdout[1] > 180 && stdout[2] > 180, String([...stdout.subarray(0, 3)]));
  await assert.rejects(normalizeNewCustomerEvidenceImage(Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.from("not a real jpg")]), "image/jpeg", options), { code: "NEW_CUSTOMER_EVIDENCE_DECODE_FAILED" });
});
