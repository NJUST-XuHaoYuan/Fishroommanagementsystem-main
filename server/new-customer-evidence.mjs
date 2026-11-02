import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sanitizeAttachmentFilename } from "./personnel-private-attachments.mjs";
import { validateImageUploadBuffer } from "./media-upload-rules.mjs";

export const NEW_CUSTOMER_EVIDENCE_DIRECTORY = ".new-customer-evidence";
export const NEW_CUSTOMER_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const NEW_CUSTOMER_EVIDENCE_DRAFT_TTL = 24 * 60 * 60 * 1000;
const SAFE_ID = /^nce_[a-f0-9]{32}$/;
const list = (value) => Array.isArray(value) ? value : [];
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
const execFileAsync = promisify(execFile);

export function newCustomerEvidenceId() { return `nce_${randomBytes(16).toString("hex")}`; }
export function isNewCustomerEvidenceId(id) { return typeof id === "string" && SAFE_ID.test(id); }
export function normalizeNewCustomerEvidenceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6 || value.some((id) => !isNewCustomerEvidenceId(id)) || new Set(value).size !== value.length) {
    fail(400, "NEW_CUSTOMER_EVIDENCE_IDS_INVALID", "凭证最多 6 张，附件编号必须有效且不能重复");
  }
  return [...value];
}

export function newCustomerEvidenceMetadata(record) {
  return Object.fromEntries(["id", "originalName", "mime", "size", "createdAt"].map((key) => [key, record[key]]));
}

export function newCustomerEvidenceFilename(value) {
  try { return sanitizeAttachmentFilename(decodeURIComponent(String(value || "凭证图片"))); }
  catch { fail(400, "NEW_CUSTOMER_EVIDENCE_FILENAME_INVALID", "图片文件名不正确"); }
}

export function newCustomerEvidencePath(uploadDir, id) {
  if (!isNewCustomerEvidenceId(id)) fail(400, "NEW_CUSTOMER_EVIDENCE_ID_INVALID", "凭证编号不正确");
  return resolve(uploadDir, NEW_CUSTOMER_EVIDENCE_DIRECTORY, `${id}.bin`);
}
export function isNewCustomerEvidencePath(uploadDir, path) {
  const root = resolve(uploadDir, NEW_CUSTOMER_EVIDENCE_DIRECTORY);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function evidenceIsBound(record) { return list(record?.boundRequestIds).length > 0; }
export function evidenceIsExpired(record, now = Date.now()) {
  return !evidenceIsBound(record) && (!Number.isFinite(Date.parse(record?.createdAt)) || Date.parse(record.createdAt) + NEW_CUSTOMER_EVIDENCE_DRAFT_TTL <= now);
}
export function resolveNewCustomerEvidence(registry, id) {
  if (!isNewCustomerEvidenceId(id)) fail(404, "NEW_CUSTOMER_EVIDENCE_NOT_FOUND", "凭证不存在");
  const matches = list(registry).filter((record) => record?.id === id);
  if (matches.length !== 1) fail(matches.length ? 409 : 404, "NEW_CUSTOMER_EVIDENCE_NOT_FOUND", "凭证不存在或记录冲突");
  return matches[0];
}
export function checkNewCustomerEvidenceQuota(registry, accountId, orderId, size, now = Date.now()) {
  const drafts = list(registry).filter((record) => !evidenceIsBound(record) && !evidenceIsExpired(record, now));
  const own = drafts.filter((record) => record.uploaderPersonnelId === accountId);
  if (own.filter((record) => record.orderId === orderId).length >= 6 || own.length >= 20 ||
      own.reduce((sum, record) => sum + Number(record.size || 0), size) > 60 * 1024 * 1024 ||
      drafts.reduce((sum, record) => sum + Number(record.size || 0), size) > 300 * 1024 * 1024) {
    fail(409, "NEW_CUSTOMER_EVIDENCE_QUOTA", "未提交凭证过多，请先删除不需要的草稿图片后重试（每单最多 6 张）");
  }
}

export function resolveEvidenceForSubmission(registry, ids, order, account, now = Date.now()) {
  return normalizeNewCustomerEvidenceIds(ids).map((id) => {
    const record = resolveNewCustomerEvidence(registry, id);
    if (record.orderId !== order.id || record.uploaderPersonnelId !== account.id || record.uploaderUsername !== account.username) {
      fail(403, "NEW_CUSTOMER_EVIDENCE_FORBIDDEN", "只能提交本人为该订单上传的凭证");
    }
    if (evidenceIsExpired(record, now)) fail(409, "NEW_CUSTOMER_EVIDENCE_EXPIRED", "凭证草稿已过期，请重新上传");
    return record;
  });
}

function evidenceAad(record) {
  if (!isNewCustomerEvidenceId(record?.id) || !record.orderId || !record.uploaderPersonnelId) fail(409, "NEW_CUSTOMER_EVIDENCE_INVALID", "凭证关联信息不正确");
  return Buffer.from(JSON.stringify(["fishroom-new-customer-evidence", 1, record.id, record.orderId, record.uploaderPersonnelId]), "utf8");
}
function evidenceKey(keyring, kid = keyring?.activeKid) {
  const key = keyring?.keys?.get(kid);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid || "") || !Buffer.isBuffer(key) || key.length !== 32) {
    fail(503, "NEW_CUSTOMER_EVIDENCE_KEY_UNAVAILABLE", "凭证安全存储暂不可用，请联系管理员");
  }
  return key;
}
export function encryptNewCustomerEvidence(buffer, record, keyring) {
  const key = evidenceKey(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(evidenceAad(record));
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.from(["new-customer-evidence", "1", keyring.activeKid, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join("$"));
}
export function decryptNewCustomerEvidence(buffer, record, keyring) {
  const parts = buffer.toString("utf8").split("$");
  try {
    if (parts.length !== 6 || parts[0] !== "new-customer-evidence" || parts[1] !== "1") throw new Error();
    const [, , kid, iv, tag, ciphertext] = parts;
    const decipher = createDecipheriv("aes-256-gcm", evidenceKey(keyring, kid), Buffer.from(iv, "base64url"));
    decipher.setAAD(evidenceAad(record)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch (error) {
    if (error.code === "NEW_CUSTOMER_EVIDENCE_KEY_UNAVAILABLE") throw error;
    fail(409, "NEW_CUSTOMER_EVIDENCE_DAMAGED", "凭证读取失败，请联系管理员核对文件");
  }
}

/** Decode outside the database lock. Re-encode removes metadata and active content. */
export async function normalizeNewCustomerEvidenceImage(buffer, mime, { ffmpegPath = "ffmpeg", ffprobePath = "ffprobe" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail(400, "NEW_CUSTOMER_EVIDENCE_EMPTY", "请选择凭证图片");
  if (buffer.length > NEW_CUSTOMER_EVIDENCE_MAX_BYTES) fail(413, "NEW_CUSTOMER_EVIDENCE_TOO_LARGE", "每张凭证图片不能超过 10 MB");
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) fail(415, "NEW_CUSTOMER_EVIDENCE_TYPE", "仅支持 JPG、PNG、WebP 图片");
  try { validateImageUploadBuffer(buffer, mime); } catch { fail(415, "NEW_CUSTOMER_EVIDENCE_TYPE", "文件内容与图片类型不符"); }
  const temp = await mkdtemp(join(tmpdir(), "fishroom-evidence-"));
  try {
    const input = join(temp, "input"), output = join(temp, "evidence.jpg");
    await writeFile(input, buffer, { mode: 0o600 });
    const options = { timeout: 30_000, maxBuffer: 512 * 1024 };
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_streams", input], options);
    const streams = JSON.parse(stdout).streams;
    const stream = streams?.find((item) => item.codec_type === "video");
    if (!stream || !["mjpeg", "png", "webp"].includes(stream.codec_name) || streams.length !== 1) throw new Error("not a still image");
    const width = Number(stream.width), height = Number(stream.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000 || Math.max(width, height) > 16000) {
      fail(400, "NEW_CUSTOMER_EVIDENCE_DIMENSIONS", "图片尺寸过大，请裁剪或缩小后上传（最多 4000 万像素）");
    }
    // Use decoded dimensions after EXIF autorotation, not the raw JPEG dimensions.
    // Derive an opaque white frame from the scaled image so transparency stays legible.
    const filter = "[0:v]scale='max(2,min(2560,iw))':'max(2,min(2560,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=rgba,split[fg][bg];[bg]lutrgb=r=255:g=255:b=255:a=255[white];[white][fg]overlay=shortest=1,format=yuvj420p[out]";
    await execFileAsync(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", "file,pipe", "-i", input,
      "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-threads", "1", "-q:v", "2", "-map_metadata", "-1", output], options);
    const normalized = await readFile(output);
    if (!normalized.length || normalized.length > NEW_CUSTOMER_EVIDENCE_MAX_BYTES) throw new Error("invalid output");
    return normalized;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === "ENOENT") fail(503, "NEW_CUSTOMER_EVIDENCE_PROCESSOR_UNAVAILABLE", "图片处理服务暂不可用，请联系管理员");
    fail(400, "NEW_CUSTOMER_EVIDENCE_DECODE_FAILED", "图片无法完整读取，请重新导出为 JPG、PNG 或 WebP 后上传");
  } finally { await rm(temp, { recursive: true, force: true }); }
}
