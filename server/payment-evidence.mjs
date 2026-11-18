import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { sanitizeAttachmentFilename } from "./personnel-private-attachments.mjs";
import { normalizeNewCustomerEvidenceImage } from "./new-customer-evidence.mjs";

export const PAYMENT_EVIDENCE_DIRECTORY = ".payment-evidence";
export const PAYMENT_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const PAYMENT_EVIDENCE_DRAFT_TTL = 24 * 60 * 60 * 1000;
const SAFE_ID = /^ppe_[a-f0-9]{32}$/;
const list = (value) => Array.isArray(value) ? value : [];
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };

export function paymentEvidenceId() { return `ppe_${randomBytes(16).toString("hex")}`; }
export function isPaymentEvidenceId(id) { return typeof id === "string" && SAFE_ID.test(id); }
export function normalizePaymentEvidenceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6 || value.some((id) => !isPaymentEvidenceId(id)) || new Set(value).size !== value.length) {
    fail(400, "PAYMENT_EVIDENCE_IDS_INVALID", "凭证最多 6 张，附件编号必须有效且不能重复");
  }
  return [...value];
}

export function paymentEvidenceMetadata(record) {
  return Object.fromEntries(["id", "originalName", "mime", "size", "createdAt"].map((key) => [key, record[key]]));
}

export function paymentEvidenceFilename(value) {
  try { return sanitizeAttachmentFilename(decodeURIComponent(String(value || "凭证图片"))); }
  catch { fail(400, "PAYMENT_EVIDENCE_FILENAME_INVALID", "图片文件名不正确"); }
}

export function paymentEvidencePath(uploadDir, id) {
  if (!isPaymentEvidenceId(id)) fail(400, "PAYMENT_EVIDENCE_ID_INVALID", "凭证编号不正确");
  return resolve(uploadDir, PAYMENT_EVIDENCE_DIRECTORY, `${id}.bin`);
}
export function isPaymentEvidencePath(uploadDir, path) {
  const root = resolve(uploadDir, PAYMENT_EVIDENCE_DIRECTORY);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function evidenceIsBound(record) { return list(record?.boundClaimIds).length > 0; }
export function evidenceIsExpired(record, now = Date.now()) {
  return !evidenceIsBound(record) && (!Number.isFinite(Date.parse(record?.createdAt)) || Date.parse(record.createdAt) + PAYMENT_EVIDENCE_DRAFT_TTL <= now);
}
export function resolvePaymentEvidence(registry, id) {
  if (!isPaymentEvidenceId(id)) fail(404, "PAYMENT_EVIDENCE_NOT_FOUND", "凭证不存在");
  const matches = list(registry).filter((record) => record?.id === id);
  if (matches.length !== 1) fail(matches.length ? 409 : 404, "PAYMENT_EVIDENCE_NOT_FOUND", "凭证不存在或记录冲突");
  return matches[0];
}
export function checkPaymentEvidenceQuota(registry, accountId, orderId, size, now = Date.now()) {
  const drafts = list(registry).filter((record) => !evidenceIsBound(record) && !evidenceIsExpired(record, now));
  const own = drafts.filter((record) => record.uploaderPersonnelId === accountId);
  if (own.filter((record) => record.orderId === orderId).length >= 6 || own.length >= 20 ||
      own.reduce((sum, record) => sum + Number(record.size || 0), size) > 60 * 1024 * 1024 ||
      drafts.reduce((sum, record) => sum + Number(record.size || 0), size) > 300 * 1024 * 1024) {
    fail(409, "PAYMENT_EVIDENCE_QUOTA", "未提交凭证过多，请先删除不需要的草稿图片后重试（每单最多 6 张）");
  }
}

export function resolveEvidenceForSubmission(registry, ids, order, account, now = Date.now()) {
  return normalizePaymentEvidenceIds(ids).map((id) => {
    const record = resolvePaymentEvidence(registry, id);
    if (record.orderId !== order.id || record.uploaderPersonnelId !== account.id || record.uploaderUsername !== account.username) {
      fail(403, "PAYMENT_EVIDENCE_FORBIDDEN", "只能提交本人为该订单上传的凭证");
    }
    if (evidenceIsExpired(record, now)) fail(409, "PAYMENT_EVIDENCE_EXPIRED", "凭证草稿已过期，请重新上传");
    return record;
  });
}

function evidenceAad(record) {
  if (!isPaymentEvidenceId(record?.id) || !record.orderId || !record.uploaderPersonnelId) fail(409, "PAYMENT_EVIDENCE_INVALID", "凭证关联信息不正确");
  return Buffer.from(JSON.stringify(["fishroom-payment-evidence", 1, record.id, record.orderId, record.uploaderPersonnelId]), "utf8");
}
function evidenceKey(keyring, kid = keyring?.activeKid) {
  const key = keyring?.keys?.get(kid);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid || "") || !Buffer.isBuffer(key) || key.length !== 32) {
    fail(503, "PAYMENT_EVIDENCE_KEY_UNAVAILABLE", "凭证安全存储暂不可用，请联系管理员");
  }
  return key;
}
export function encryptPaymentEvidence(buffer, record, keyring) {
  const key = evidenceKey(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(evidenceAad(record));
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.from(["payment-evidence", "1", keyring.activeKid, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join("$"));
}
export function decryptPaymentEvidence(buffer, record, keyring) {
  const parts = buffer.toString("utf8").split("$");
  try {
    if (parts.length !== 6 || parts[0] !== "payment-evidence" || parts[1] !== "1") throw new Error();
    const [, , kid, iv, tag, ciphertext] = parts;
    const decipher = createDecipheriv("aes-256-gcm", evidenceKey(keyring, kid), Buffer.from(iv, "base64url"));
    decipher.setAAD(evidenceAad(record)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch (error) {
    if (error.code === "PAYMENT_EVIDENCE_KEY_UNAVAILABLE") throw error;
    fail(409, "PAYMENT_EVIDENCE_DAMAGED", "凭证读取失败，请联系管理员核对文件");
  }
}


export const normalizePaymentEvidenceImage = normalizeNewCustomerEvidenceImage;
