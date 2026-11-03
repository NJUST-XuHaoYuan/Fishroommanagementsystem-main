import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_CUSTOMER_EVIDENCE_MAX_BYTES, newCustomerEvidenceId, newCustomerEvidencePath, isNewCustomerEvidencePath,
  newCustomerEvidenceFilename, newCustomerEvidenceMetadata, normalizeNewCustomerEvidenceIds,
  encryptNewCustomerEvidence, decryptNewCustomerEvidence, evidenceIsExpired, checkNewCustomerEvidenceQuota,
  resolveEvidenceForSubmission, normalizeNewCustomerEvidenceImage,
} from "./new-customer-evidence.mjs";
import { planNewCustomerRequest } from "./new-customer-approval.mjs";
const keyring = { activeKid: "test", keys: new Map([["test", Buffer.alloc(32, 7)]]) };
const record = () => ({ id: newCustomerEvidenceId(), orderId: "o", uploaderPersonnelId: "p", uploaderUsername: "u", originalName: "凭证.png", mime: "image/jpeg", size: 100, createdAt: new Date().toISOString(), boundRequestIds: [] });

test("evidence IDs are strict, bounded and unique; names decode safely; public metadata is allowlisted", () => {
  const r = record(); assert.deepEqual(normalizeNewCustomerEvidenceIds(undefined), []);
  assert.deepEqual(normalizeNewCustomerEvidenceIds([r.id]), [r.id]);
  for (const value of [null, "x", [r.id, r.id], ["../secret"], Array.from({ length: 7 }, newCustomerEvidenceId)]) {
    assert.throws(() => normalizeNewCustomerEvidenceIds(value), { statusCode: 400 });
  }
  assert.equal(newCustomerEvidenceFilename(encodeURIComponent("../截图.png")), "截图.png");
  assert.throws(() => newCustomerEvidenceFilename("%ZZ"), { statusCode: 400 });
  assert.deepEqual(Object.keys(newCustomerEvidenceMetadata(r)), ["id", "originalName", "mime", "size", "createdAt"]);
  assert.throws(() => newCustomerEvidencePath("/safe", "../x"));
  assert.ok(isNewCustomerEvidencePath("/safe", newCustomerEvidencePath("/safe", r.id)));
});

test("AES-GCM binds immutable evidence to attachment, order and uploader, with independent domain", () => {
  const r = record(), plain = Buffer.from("private screenshot"), encrypted = encryptNewCustomerEvidence(plain, r, keyring);
  assert.equal(encrypted.includes(plain), false); assert.deepEqual(decryptNewCustomerEvidence(encrypted, r, keyring), plain);
  for (const patch of [{ id: newCustomerEvidenceId() }, { orderId: "other" }, { uploaderPersonnelId: "other" }]) {
    assert.throws(() => decryptNewCustomerEvidence(encrypted, { ...r, ...patch }, keyring), { statusCode: 409 });
  }
  assert.throws(() => decryptNewCustomerEvidence(Buffer.from(encrypted.toString().replace("new-customer-evidence", "personnel-attachment")), r, keyring));
  assert.throws(() => encryptNewCustomerEvidence(plain, r, null), { statusCode: 503 });
});

test("only drafts expire; quotas bound per-order, per-user and global accumulated bytes", () => {
  const r = { ...record(), createdAt: "2026-01-01T00:00:00Z" };
  assert.equal(evidenceIsExpired(r), true); assert.equal(evidenceIsExpired({ ...r, boundRequestIds: ["request"] }), false);
  const six = Array.from({ length: 6 }, record);
  assert.throws(() => checkNewCustomerEvidenceQuota(six, "p", "o", 100), { code: "NEW_CUSTOMER_EVIDENCE_QUOTA" });
  assert.doesNotThrow(() => checkNewCustomerEvidenceQuota([r], "p", "o", 100));
  assert.throws(() => checkNewCustomerEvidenceQuota([{ ...record(), size: 61 * 1024 * 1024 }], "p", "other", 100));
  assert.throws(() => checkNewCustomerEvidenceQuota([{ ...record(), uploaderPersonnelId: "other", size: 301 * 1024 * 1024 }], "p", "o", 100));
});

test("submission permits only own same-order unexpired drafts or immutable previous proofs", () => {
  const r = record(), account = { id: "p", username: "u" }, order = { id: "o" };
  assert.deepEqual(resolveEvidenceForSubmission([r], [r.id], order, account), [r]);
  assert.throws(() => resolveEvidenceForSubmission([r], [r.id], { id: "other" }, account), { statusCode: 403 });
  assert.throws(() => resolveEvidenceForSubmission([r], [r.id], order, { ...account, id: "other" }), { statusCode: 403 });
  assert.throws(() => resolveEvidenceForSubmission([{ ...r, createdAt: "2026-01-01T00:00:00Z" }], [r.id], order, account), { statusCode: 409 });
  const bound = { ...r, createdAt: "2026-01-01T00:00:00Z", boundRequestIds: ["old"] };
  assert.deepEqual(resolveEvidenceForSubmission([bound], [r.id], order, account), [bound]);
  assert.throws(() => resolveEvidenceForSubmission([r, r], [r.id], order, account), { statusCode: 409 });
});

test("image processing rejects unsupported, empty, huge and forged MIME before decoding", async () => {
  for (const [image, mime, status] of [[Buffer.alloc(0), "image/jpeg", 400], [Buffer.from("<svg/>"), "image/svg+xml", 415],
    [Buffer.from("not a png"), "image/png", 415], [Buffer.alloc(NEW_CUSTOMER_EVIDENCE_MAX_BYTES + 1), "image/jpeg", 413]]) {
    await assert.rejects(normalizeNewCustomerEvidenceImage(image, mime), { statusCode: status });
  }
});

test("pending approval idempotency includes attachment identity and order, never client metadata", () => {
  const account = { id: "p", username: "u", name: "Owner", accountEnabled: true, employmentStatus: "active", accessRole: "staff" };
  const order = { id: "o", createdAt: "2026-10-02T01:00:00Z", status: "pending", contactPersonnelId: "p", customerId: "customer" };
  const state = { personnel: [account], orders: [order], customers: [{ id: "customer", name: "真实客户" }] }, r = record();
  const body = { reason: "核对微信聊天记录确认为新客户", expectedApprovalVersion: 0, evidenceIds: [r.id] };
  assert.throws(() => planNewCustomerRequest(state, order, account, body, { requestId: "r" }), { code: "NEW_CUSTOMER_EVIDENCE_UNVERIFIED" });
  const planned = planNewCustomerRequest(state, order, account, body, { requestId: "r", evidenceAttachments: [r] });
  assert.deepEqual(planned.order.newCustomerApproval.evidenceAttachments, [newCustomerEvidenceMetadata(r)]);
  assert.equal(planNewCustomerRequest(state, planned.order, account, body, { requestId: "r2", evidenceAttachments: [r] }).unchanged, true);
  assert.throws(() => planNewCustomerRequest(state, planned.order, account, { ...body, evidenceIds: [] }, { requestId: "r2" }), { code: "NEW_CUSTOMER_EVIDENCE_REQUIRED" });
});
