import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { basename, resolve, sep } from "node:path";

export const PERSONNEL_ATTACHMENT_KINDS = Object.freeze([
  "id_card_front",
  "id_card_back",
  "education_proof",
]);

export const PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY = ".personnel-private";

const ENVELOPE_DOMAIN = "personnel-attachment";
const ENVELOPE_VERSION = "1";
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const OWNER_PREVIEW_STATUSES = new Set(["draft", "pending", "approved", "rejected"]);
const TERMINAL_ATTACHMENT_STATUSES = new Set(["expired", "retired", "superseded", "orphaned"]);

export class PersonnelPrivateAttachmentError extends Error {
  constructor(message, { statusCode = 400, code = "INVALID_PERSONNEL_ATTACHMENT" } = {}) {
    super(message);
    this.name = "PersonnelPrivateAttachmentError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function fail(message, options) {
  throw new PersonnelPrivateAttachmentError(message, options);
}

function normalizeContextId(value, label) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    fail(`${label}不正确`);
  }
  return id;
}

function normalizeAttachmentId(value) {
  const id = String(value ?? "").trim();
  if (!SAFE_ATTACHMENT_ID.test(id)) fail("附件 ID 不正确");
  return id;
}

function requireKeyring(keyring) {
  if (!keyring || typeof keyring !== "object" || !(keyring.keys instanceof Map)) {
    fail("人员私密附件加密密钥未配置", {
      statusCode: 500,
      code: "PERSONNEL_ATTACHMENT_KEYRING_UNAVAILABLE",
    });
  }
  return keyring;
}

function keyForKid(keyring, kid) {
  const key = requireKeyring(keyring).keys.get(kid);
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    fail(`人员私密附件密钥 ${kid} 不可用`, {
      statusCode: 500,
      code: "PERSONNEL_ATTACHMENT_KEY_UNAVAILABLE",
    });
  }
  return key;
}

function attachmentAad({ attachmentId, personnelId, kind }) {
  return Buffer.from([
    "fishroom-personnel-private-attachment",
    `v${ENVELOPE_VERSION}`,
    normalizeAttachmentId(attachmentId),
    normalizeContextId(personnelId, "人员 ID"),
    normalizePersonnelAttachmentKind(kind),
  ].join("\0"), "utf8");
}

function decodeBase64Url(value, label, expectedLength = null) {
  const encoded = String(value ?? "");
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail(`${label}格式不正确`);
  const decoded = Buffer.from(encoded, "base64url");
  if (expectedLength !== null && decoded.length !== expectedLength) fail(`${label}格式不正确`);
  return decoded;
}

export function normalizePersonnelAttachmentKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  if (!PERSONNEL_ATTACHMENT_KINDS.includes(kind)) {
    fail("不支持的人员附件类型");
  }
  return kind;
}

export function encryptPersonnelAttachmentBuffer(
  buffer,
  { attachmentId, personnelId, kind, keyring } = {}
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail("人员私密附件内容不能为空");
  const activeKeyring = requireKeyring(keyring);
  const kid = String(activeKeyring.activeKid ?? "").trim();
  if (!SAFE_KEY_ID.test(kid)) {
    fail("人员私密附件活动密钥编号不正确", {
      statusCode: 500,
      code: "PERSONNEL_ATTACHMENT_KEYRING_UNAVAILABLE",
    });
  }
  const key = keyForKid(activeKeyring, kid);
  const iv = randomBytes(12);
  const aad = attachmentAad({ attachmentId, personnelId, kind });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad, { plaintextLength: buffer.length });
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from([
    ENVELOPE_DOMAIN,
    ENVELOPE_VERSION,
    kid,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join("$"), "utf8");
}

export function decryptPersonnelAttachmentBuffer(
  encryptedBuffer,
  { attachmentId, personnelId, kind, keyring } = {}
) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
    fail("人员私密附件密文不能为空");
  }
  const parts = encryptedBuffer.toString("utf8").split("$");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_DOMAIN || parts[1] !== ENVELOPE_VERSION) {
    fail("人员私密附件密文格式不正确");
  }
  const [, , kid, ivValue, tagValue, ciphertextValue] = parts;
  if (!SAFE_KEY_ID.test(kid)) fail("人员私密附件密文密钥编号不正确");
  const key = keyForKid(keyring, kid);
  const iv = decodeBase64Url(ivValue, "人员私密附件 IV", 12);
  const tag = decodeBase64Url(tagValue, "人员私密附件认证标签", 16);
  const ciphertext = decodeBase64Url(ciphertextValue, "人员私密附件密文");
  const aad = attachmentAad({ attachmentId, personnelId, kind });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail("人员私密附件解密失败，数据可能损坏或上下文不匹配", {
      statusCode: 409,
      code: "PERSONNEL_ATTACHMENT_DECRYPTION_FAILED",
    });
  }
}

export function personnelAttachmentCiphertextKid(encryptedBuffer) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
    fail("人员私密附件密文不能为空");
  }
  const parts = encryptedBuffer.toString("utf8").split("$");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_DOMAIN || parts[1] !== ENVELOPE_VERSION || !SAFE_KEY_ID.test(parts[2])) {
    fail("人员私密附件密文格式不正确");
  }
  return parts[2];
}

export function rewrapPersonnelAttachmentBuffer(
  encryptedBuffer,
  { attachmentId, personnelId, kind, keyring } = {}
) {
  const currentKid = personnelAttachmentCiphertextKid(encryptedBuffer);
  const activeKid = String(requireKeyring(keyring).activeKid ?? "").trim();
  if (!SAFE_KEY_ID.test(activeKid)) {
    fail("人员私密附件活动密钥编号不正确", {
      statusCode: 500,
      code: "PERSONNEL_ATTACHMENT_KEYRING_UNAVAILABLE",
    });
  }
  if (currentKid === activeKid) return Buffer.from(encryptedBuffer);
  const plaintext = decryptPersonnelAttachmentBuffer(encryptedBuffer, {
    attachmentId,
    personnelId,
    kind,
    keyring,
  });
  return encryptPersonnelAttachmentBuffer(plaintext, {
    attachmentId,
    personnelId,
    kind,
    keyring,
  });
}

export function privatePersonnelAttachmentPath(uploadDir, attachmentId) {
  const rootInput = String(uploadDir ?? "").trim();
  if (!rootInput) fail("私密附件存储目录未配置", { statusCode: 500 });
  const id = normalizeAttachmentId(attachmentId);
  const privateRoot = resolve(rootInput, PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY);
  const candidate = resolve(privateRoot, `${id}.bin`);
  if (!candidate.startsWith(`${privateRoot}${sep}`)) fail("附件存储路径不安全");
  return candidate;
}

export function isPersonnelPrivateAttachmentPath(uploadDir, candidatePath) {
  const rootInput = String(uploadDir ?? "").trim();
  const candidateInput = String(candidatePath ?? "").trim();
  if (!rootInput || !candidateInput) return false;
  const privateRoot = resolve(rootInput, PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY);
  const candidate = resolve(candidateInput);
  return candidate === privateRoot || candidate.startsWith(`${privateRoot}${sep}`);
}

export function sanitizeAttachmentFilename(value) {
  const input = String(value ?? "")
    .normalize("NFKC")
    .replace(/\\/g, "/");
  let name = basename(input)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["'`;:|<>]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (!name || name === "." || name === "..") name = "attachment";
  const characters = [...name];
  if (characters.length > 120) name = characters.slice(0, 120).join("");
  return name;
}

export function assertPersonnelAttachmentReferenceAccess(
  reference,
  { requesterPersonnelId, isAdmin = false, allowOwnerPreview = false } = {}
) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    fail("人员附件引用不存在", { statusCode: 404, code: "PERSONNEL_ATTACHMENT_NOT_FOUND" });
  }
  const requesterId = String(requesterPersonnelId ?? "").trim();
  const ownerId = String(reference.personnelId ?? reference.ownerPersonnelId ?? "").trim();
  const uploaderId = String(reference.uploadedByPersonnelId ?? ownerId).trim();
  const status = String(reference.status ?? "").trim();
  const expiresAt = Date.parse(String(reference.expiresAt ?? ""));
  if (TERMINAL_ATTACHMENT_STATUSES.has(status) ||
      (["draft", "rejected"].includes(status) && Number.isFinite(expiresAt) && expiresAt <= Date.now())) {
    fail("人员附件引用不存在", { statusCode: 404, code: "PERSONNEL_ATTACHMENT_NOT_FOUND" });
  }
  if (isAdmin === true) return true;

  if (
    allowOwnerPreview === true &&
    requesterId &&
    requesterId === ownerId &&
    requesterId === uploaderId &&
    OWNER_PREVIEW_STATUSES.has(status)
  ) return true;

  fail("无权读取该人员私密附件", {
    statusCode: 403,
    code: "PERSONNEL_ATTACHMENT_FORBIDDEN",
  });
}
