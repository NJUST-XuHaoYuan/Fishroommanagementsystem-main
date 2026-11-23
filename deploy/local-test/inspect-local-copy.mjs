import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { localTestDatabaseOptions, LOCAL_ADMIN_ID } from "./bootstrap-local-admin.mjs";
import { privatePersonnelAttachmentPath, decryptPersonnelAttachmentBuffer } from "../../server/personnel-private-attachments.mjs";
import { parsePersonnelDataKeyring } from "../../server/personnel-sensitive-data.mjs";
import { PERSONNEL_PROFILE_ATTACHMENT_FIELDS } from "../../server/personnel-profile-rules.mjs";
import { newCustomerEvidencePath, isNewCustomerEvidenceId, decryptNewCustomerEvidence } from "../../server/new-customer-evidence.mjs";
import { paymentEvidencePath, isPaymentEvidenceId, decryptPaymentEvidence } from "../../server/payment-evidence.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const canonicalJson = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
const fingerprint = value => ({ count: list(value).length, sha256: createHash("sha256").update(canonicalJson(list(value))).digest("hex") });

function retainedReferenceIds(state) {
  const personnel = new Set(), newCustomer = new Set(), payment = new Set();
  const personRefs = profile => { for (const field of PERSONNEL_PROFILE_ATTACHMENT_FIELDS) if (text(profile?.[field]?.id)) personnel.add(text(profile[field].id)); };
  for (const person of list(state.personnel)) personRefs(person);
  for (const request of list(state.personnelProfileRequests)) if (["pending", "rejected"].includes(request?.status)) personRefs(request.proposedProfile);
  // Include old approval/notification and resubmission snapshots, excluding the registry itself.
  const registryKeys = new Set(["personnelPrivateAttachments", "newCustomerEvidenceAttachments", "paymentEvidenceAttachments"]);
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 60) return;
    for (const [key, value] of Object.entries(node)) {
      if (registryKeys.has(key)) continue;
      if (key === "evidenceAttachments") for (const attachment of list(value)) {
        if (isNewCustomerEvidenceId(attachment?.id)) newCustomer.add(attachment.id);
        if (isPaymentEvidenceId(attachment?.id)) payment.add(attachment.id);
      }
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(state);
  for (const record of list(state.newCustomerEvidenceAttachments)) if (list(record?.boundRequestIds).length) newCustomer.add(text(record.id));
  for (const record of list(state.paymentEvidenceAttachments)) if (list(record?.boundClaimIds).length) payment.add(text(record.id));
  return { personnel, newCustomer, payment };
}

async function inspectRegistry({ records, references, pathFor, decrypt }, uploadDir, keyring) {
  const result = { registryCount: records.length, retainedReferenceCount: references.size, missingRegistryCount: 0,
    duplicateRegistryCount: 0, invalidRegistryCount: 0, presentFiles: 0, missingFiles: 0, unsafeFiles: 0,
    decryptSamplesAttempted: 0, decryptSamplesPassed: 0, decryptSamplesFailed: 0, decryptSamplesNotApplicable: false };
  const seen = new Set(), duplicates = new Set(), available = [];
  const registryIds = new Set(records.map(record => text(record?.id)));
  result.missingRegistryCount = [...references].filter(id => !registryIds.has(id)).length;
  const uploadRoot = await realpath(uploadDir);
  for (const record of records) {
    const id = text(record?.id);
    if (seen.has(id)) { result.duplicateRegistryCount += 1; duplicates.add(id); continue; }
    seen.add(id);
    let path;
    try { path = pathFor(uploadDir, id); } catch { result.invalidRegistryCount += 1; continue; }
    try {
      const info = await lstat(path);
      const parent = await realpath(dirname(path));
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024 * 1024 ||
          !parent.startsWith(`${uploadRoot}${sep}`) || parent !== resolve(uploadRoot, dirname(path).slice(resolve(uploadDir).length + 1))) {
        result.unsafeFiles += 1; continue;
      }
      result.presentFiles += 1; available.push({ record, path });
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) result.missingFiles += 1; else result.unsafeFiles += 1; }
  }
  const sample = available.find(item => !duplicates.has(text(item.record?.id)));
  if (!records.length && !references.size) result.decryptSamplesNotApplicable = true;
  else if (sample) {
    result.decryptSamplesAttempted = 1;
    let handle;
    try {
      handle = await open(sample.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const ciphertext = await handle.readFile();
      const plaintext = decrypt(ciphertext, sample.record, keyring);
      if (!Buffer.isBuffer(plaintext) || !plaintext.length) throw new Error("INVALID_SAMPLE");
      if (Number.isFinite(Number(sample.record.size)) && Number(sample.record.size) > 0 && plaintext.length !== Number(sample.record.size)) throw new Error("INVALID_SAMPLE_SIZE");
      if (sample.record.sha256 && createHash("sha256").update(plaintext).digest("hex") !== sample.record.sha256) throw new Error("INVALID_SAMPLE_HASH");
      result.decryptSamplesPassed = 1;
      plaintext.fill(0);
    } catch { result.decryptSamplesFailed = 1; }
    finally { await handle?.close(); }
  } else result.decryptSamplesFailed = 1;
  return result;
}

/** Read-only evidence validation. No source values, attachment IDs, filenames or plaintext leave this function. */
export async function inspectCopiedState(state, { uploadDir, keyringValue } = {}) {
  if (!state || typeof state !== "object" || !["orders", "stock", "batches", "personnel"].every(key => Array.isArray(state[key]))) fail("LOCAL_TEST_COPY_SCHEMA_INVALID");
  let keyring = null, keyringInvalid = false;
  try { keyring = parsePersonnelDataKeyring(keyringValue); } catch { keyringInvalid = true; }
  const references = retainedReferenceIds(state);
  const descriptors = {
    personnel: { records: list(state.personnelPrivateAttachments), references: references.personnel, pathFor: privatePersonnelAttachmentPath,
      decrypt: (buffer, record, keys) => decryptPersonnelAttachmentBuffer(buffer, { attachmentId: record.id, personnelId: record.personnelId, kind: record.kind, keyring: keys }) },
    newCustomer: { records: list(state.newCustomerEvidenceAttachments), references: references.newCustomer, pathFor: newCustomerEvidencePath, decrypt: decryptNewCustomerEvidence },
    payment: { records: list(state.paymentEvidenceAttachments), references: references.payment, pathFor: paymentEvidencePath, decrypt: decryptPaymentEvidence },
  };
  const privateAttachments = {};
  for (const [kind, descriptor] of Object.entries(descriptors)) privateAttachments[kind] = await inspectRegistry(descriptor, uploadDir, keyring);
  const hasProblem = Object.values(privateAttachments).some(result => result.missingRegistryCount || result.duplicateRegistryCount || result.invalidRegistryCount ||
    result.missingFiles || result.unsafeFiles || result.decryptSamplesFailed);
  return { ok: !hasProblem && !keyringInvalid && Boolean(keyring), hashAlgorithm: "canonical-json-sha256",
    collections: Object.fromEntries(["orders", "stock", "batches", "personnel"].map(key => [key, fingerprint(state[key])])),
    originalPersonnel: fingerprint(state.personnel.filter(person => text(person?.id) !== LOCAL_ADMIN_ID)),
    privateAttachments, keyringConfigurationValid: !keyringInvalid && Boolean(keyring) };
}

export async function inspectLocalCopy(env = process.env) {
  const options = localTestDatabaseOptions(env);
  const { Client } = await import("pg");
  const client = new Client({ ...options, application_name: "fishroom-local-test-readonly-inspection" });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (await client.query("SELECT current_database() AS database, current_user AS username")).rows[0];
    if (identity?.database !== "fishroom_test" || identity?.username !== "fishroom_test") fail("LOCAL_TEST_DATABASE_IDENTITY_REFUSED");
    const rows = (await client.query("SELECT data FROM public.app_state WHERE id = $1", ["main"])).rows;
    if (rows.length !== 1) fail("LOCAL_TEST_MAIN_STATE_REQUIRED");
    const report = await inspectCopiedState(rows[0].data, { uploadDir: env.UPLOAD_DIR || "/app/uploads", keyringValue: env.PERSONNEL_DATA_KEYRING_JSON });
    await client.query("COMMIT");
    return report;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await inspectLocalCopy(); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.safeCode || "LOCAL_TEST_COPY_INSPECTION_FAILED" })); process.exitCode = 1; }
}
