import test from "node:test";
import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localTestDatabaseOptions, planLocalAdministrator, LOCAL_ADMIN_ID } from "./bootstrap-local-admin.mjs";
import { inspectCopiedState } from "./inspect-local-copy.mjs";
import { parsePersonnelDataKeyring } from "../../server/personnel-sensitive-data.mjs";
import { encryptPersonnelAttachmentBuffer, privatePersonnelAttachmentPath } from "../../server/personnel-private-attachments.mjs";
import { encryptNewCustomerEvidence, newCustomerEvidencePath } from "../../server/new-customer-evidence.mjs";
import { encryptPaymentEvidence, paymentEvidencePath } from "../../server/payment-evidence.mjs";

const credentials = { username: "synthetic-local-login", password: "SYNTHETIC-LOCAL-PASSWORD-ONLY" };
const env = { PGHOST: "database", PGDATABASE: "fishroom_test", PGUSER: "fishroom_test", PGPASSWORD: "synthetic-database-only" };
const baseState = () => ({ sites: [{ id: "nanjing" }, { id: "jiangyin" }],
  personnel: [{ id: "original-person", name: "SYNTHETIC-PRIVATE-NAME", username: "original-login", password: "SYNTHETIC-ORIGINAL-HASH" }],
  orders: [{ id: "order-1", customerName: "SYNTHETIC-CUSTOMER-NAME", payments: [{ id: "receipt", amount: 100 }] }],
  stock: [{ id: "fish-1", sold: true }], batches: [{ id: "batch-1" }], commissionLedgerV1: { preserve: "SYNTHETIC-LEDGER" },
});

test("database guard refuses a production-shaped target and alternate connection overrides before connecting", () => {
  assert.equal(localTestDatabaseOptions(env).database, "fishroom_test");
  for (const patch of [{ PGHOST: "129.211.211.201" }, { PGDATABASE: "fishroom" }, { PGUSER: "fishroom" }, { PGHOSTADDR: "127.0.0.1" },
    { DATABASE_URL: "postgres://synthetic.invalid/fishroom" }, { PGPORT: "5433" }]) {
    assert.throws(() => localTestDatabaseOptions({ ...env, ...patch }), error => error.safeCode.startsWith("LOCAL_TEST_DATABASE_"));
  }
});

test("local admin is login-compatible, complete, idempotent and preserves every original person and business record", () => {
  const state = baseState(), original = structuredClone(state);
  const planned = planLocalAdministrator(state, credentials, { now: new Date("2026-11-23T01:00:00Z"), salt: "synthetic-salt" });
  assert.equal(planned.created, true); assert.equal(planned.personnel.length, 2);
  assert.deepEqual(planned.personnel[0], original.personnel[0]); assert.deepEqual(state, original);
  const admin = planned.personnel[1];
  assert.equal(admin.id, LOCAL_ADMIN_ID); assert.equal(admin.accessRole, "admin"); assert.equal(admin.accountEnabled, true);
  assert.equal(admin.department, "本地测试"); assert.equal(admin.role, "管理员"); assert.equal(admin.hireDate, "2026-11-23");
  assert.deepEqual(admin.siteIds, ["nanjing", "jiangyin"]); assert.deepEqual(admin.visibleSiteIds, []);
  const [prefix, version, salt, hash] = admin.password.split("$");
  assert.equal(prefix, "scrypt"); assert.equal(version, "1"); assert.equal(hash, scryptSync(credentials.password, salt, 32).toString("base64url"));
  const repeated = planLocalAdministrator({ ...state, personnel: planned.personnel }, credentials, { now: new Date("2026-11-24T01:00:00Z"), salt: "new-synthetic-salt" });
  assert.equal(repeated.created, false); assert.equal(repeated.personnel.length, 2); assert.equal(repeated.personnel[1].sessionVersion, 1);
  assert.equal(repeated.personnel[1].hireDate, admin.hireDate); assert.deepEqual(repeated.personnel[0], original.personnel[0]);
});

test("admin bootstrap rejects existing owner/id/name conflicts instead of repurposing copied identities", () => {
  for (const person of [{ id: "other", username: credentials.username.toUpperCase() }, { id: LOCAL_ADMIN_ID, username: "original" },
    { id: "other", name: "本地测试管理员" }]) assert.throws(() => planLocalAdministrator({ ...baseState(), personnel: [person] }, credentials));
  assert.throws(() => planLocalAdministrator({ ...baseState(), retiredPersonnelUsernames: [credentials.username] }, credentials), error => error.safeCode === "LOCAL_TEST_USERNAME_RETIRED");
});

async function evidenceFixture(t) {
  const uploadDir = await mkdtemp(join(tmpdir(), "fishroom-local-copy-test-")); t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const keyringValue = JSON.stringify({ activeKid: "SYNTHETIC-KEY-ID", keys: { "SYNTHETIC-KEY-ID": Buffer.alloc(32, 7).toString("base64") } });
  const keyring = parsePersonnelDataKeyring(keyringValue), state = baseState();
  const bytes = Buffer.from("SYNTHETIC-PRIVATE-ATTACHMENT-PLAINTEXT");
  const personnel = { id: "attachment-synthetic", personnelId: "original-person", kind: "id_card_front", status: "approved", size: bytes.length };
  const newCustomer = { id: `nce_${"a".repeat(32)}`, orderId: "order-1", uploaderPersonnelId: "original-person", boundRequestIds: ["request-1"], size: bytes.length };
  const payment = { id: `ppe_${"b".repeat(32)}`, orderId: "order-1", uploaderPersonnelId: "original-person", boundClaimIds: ["claim-1"], size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  state.personnel[0].idCardFrontAttachment = { id: personnel.id };
  state.personnelPrivateAttachments = [personnel]; state.newCustomerEvidenceAttachments = [newCustomer]; state.paymentEvidenceAttachments = [payment];
  state.orders[0].newCustomerApproval = { evidenceAttachments: [{ id: newCustomer.id }] };
  state.orders[0].paymentClaims = [{ id: "claim-1", previousReviews: [{ evidenceAttachments: [{ id: payment.id }] }] }];
  const paths = { personnel: privatePersonnelAttachmentPath(uploadDir, personnel.id), newCustomer: newCustomerEvidencePath(uploadDir, newCustomer.id), payment: paymentEvidencePath(uploadDir, payment.id) };
  for (const directory of [".personnel-private", ".new-customer-evidence", ".payment-evidence"]) await mkdir(join(uploadDir, directory));
  await writeFile(paths.personnel, encryptPersonnelAttachmentBuffer(bytes, { attachmentId: personnel.id, personnelId: personnel.personnelId, kind: personnel.kind, keyring }));
  await writeFile(paths.newCustomer, encryptNewCustomerEvidence(bytes, newCustomer, keyring));
  await writeFile(paths.payment, encryptPaymentEvidence(bytes, payment, keyring));
  return { state, paths, uploadDir, keyringValue };
}

test("copy inspection validates real encrypted attachment samples while output contains only hashes and aggregate evidence results", async t => {
  const fixture = await evidenceFixture(t), original = structuredClone(fixture.state);
  const report = await inspectCopiedState(fixture.state, fixture);
  assert.equal(report.ok, true); assert.deepEqual(fixture.state, original);
  for (const domain of Object.values(report.privateAttachments)) {
    assert.equal(domain.registryCount, 1); assert.equal(domain.retainedReferenceCount, 1); assert.equal(domain.presentFiles, 1); assert.equal(domain.decryptSamplesPassed, 1);
  }
  const printed = JSON.stringify(report);
  for (const sensitive of [credentials.password, "SYNTHETIC-PRIVATE-NAME", "SYNTHETIC-CUSTOMER-NAME", "SYNTHETIC-PRIVATE-ATTACHMENT-PLAINTEXT", "SYNTHETIC-KEY-ID", fixture.paths.personnel, "attachment-synthetic"])
    assert.equal(printed.includes(sensitive), false);
  const planned = planLocalAdministrator(fixture.state, credentials, { salt: "synthetic-salt" });
  const after = await inspectCopiedState({ ...fixture.state, personnel: planned.personnel }, fixture);
  assert.deepEqual(after.collections.orders, report.collections.orders); assert.deepEqual(after.collections.stock, report.collections.stock); assert.deepEqual(after.collections.batches, report.collections.batches);
  assert.deepEqual(after.originalPersonnel, report.originalPersonnel); assert.equal(after.collections.personnel.count, report.collections.personnel.count + 1);
});

test("missing registry references, absent copied files and ciphertext damage fail inspection without printing private values", async t => {
  const fixture = await evidenceFixture(t);
  fixture.state.personnelPrivateAttachments = [];
  await rm(fixture.paths.newCustomer);
  await writeFile(fixture.paths.payment, "SYNTHETIC-CORRUPTED-ENVELOPE");
  const report = await inspectCopiedState(fixture.state, fixture);
  assert.equal(report.ok, false);
  assert.equal(report.privateAttachments.personnel.missingRegistryCount, 1);
  assert.equal(report.privateAttachments.newCustomer.missingFiles, 1);
  assert.equal(report.privateAttachments.payment.decryptSamplesFailed, 1);
});

test("symlinks and duplicate registry identifiers cannot masquerade as complete evidence", async t => {
  const fixture = await evidenceFixture(t);
  await rm(fixture.paths.payment); await symlink(fixture.paths.personnel, fixture.paths.payment);
  fixture.state.newCustomerEvidenceAttachments.push({ ...fixture.state.newCustomerEvidenceAttachments[0] });
  const report = await inspectCopiedState(fixture.state, fixture);
  assert.equal(report.ok, false); assert.equal(report.privateAttachments.payment.unsafeFiles, 1); assert.equal(report.privateAttachments.newCustomer.duplicateRegistryCount, 1);
});

test("a missing keyring never passes a copied-state inspection", async t => {
  const fixture = await evidenceFixture(t);
  const report = await inspectCopiedState(fixture.state, { ...fixture, keyringValue: "" });
  assert.equal(report.ok, false); assert.equal(report.keyringConfigurationValid, false);
  assert.equal(report.privateAttachments.personnel.decryptSamplesFailed, 1);
});
