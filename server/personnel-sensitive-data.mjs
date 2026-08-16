import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const PERSONNEL_SENSITIVE_FIELDS = [
  "idCardNo",
  "bankAccountName",
  "bankAccountNo",
  "bankName",
];

const CIPHERTEXT_PREFIX = "personnel$1$";

function normalizedPersonnelId(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("人员敏感信息缺少人员 ID");
  return normalized;
}

function assertSensitiveField(field) {
  if (!PERSONNEL_SENSITIVE_FIELDS.includes(field)) {
    throw new Error("不支持的人员敏感字段");
  }
}

function decodeKey(value) {
  const encoded = String(value ?? "").trim();
  if (!encoded) throw new Error("人员敏感信息密钥不能为空");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("人员敏感信息密钥必须是 32 字节 Base64");
  return key;
}

export function parsePersonnelDataKeyring(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("PERSONNEL_DATA_KEYRING_JSON 不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PERSONNEL_DATA_KEYRING_JSON 格式不正确");
  }
  const activeKid = String(parsed.activeKid ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(activeKid)) {
    throw new Error("PERSONNEL_DATA_KEYRING_JSON 缺少有效 activeKid");
  }
  const rawKeys = parsed.keys;
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) {
    throw new Error("PERSONNEL_DATA_KEYRING_JSON 缺少 keys");
  }
  const keys = new Map();
  for (const [kid, encodedKey] of Object.entries(rawKeys)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error("人员敏感信息密钥编号格式不正确");
    keys.set(kid, decodeKey(encodedKey));
  }
  if (!keys.has(activeKid)) throw new Error("activeKid 对应的人员敏感信息密钥不存在");
  return { activeKid, keys };
}

function aadFor(personnelId, field) {
  return Buffer.from(`fishroom-personnel:v1:${normalizedPersonnelId(personnelId)}:${field}`, "utf8");
}

export function isEncryptedPersonnelSensitiveValue(value) {
  return String(value ?? "").startsWith(CIPHERTEXT_PREFIX);
}

export function encryptedPersonnelSensitiveValueKid(value) {
  if (!isEncryptedPersonnelSensitiveValue(value)) return "";
  return String(value).split("$")[2] ?? "";
}

export function encryptPersonnelSensitiveValue(value, { personnelId, field, keyring } = {}) {
  const plaintext = String(value ?? "");
  if (!plaintext) return "";
  assertSensitiveField(field);
  if (!keyring) throw new Error("人员敏感信息加密密钥未配置");
  const key = keyring.keys.get(keyring.activeKid);
  if (!key) throw new Error("人员敏感信息活动密钥不可用");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(personnelId, field));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "personnel",
    "1",
    keyring.activeKid,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join("$");
}

export function decryptPersonnelSensitiveValue(value, { personnelId, field, keyring } = {}) {
  const stored = String(value ?? "");
  if (!stored || !isEncryptedPersonnelSensitiveValue(stored)) return stored;
  assertSensitiveField(field);
  if (!keyring) throw new Error("人员敏感信息解密密钥未配置");
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "personnel" || parts[1] !== "1") {
    throw new Error("人员敏感信息密文格式不正确");
  }
  const [, , kid, ivValue, tagValue, encryptedValue] = parts;
  const key = keyring.keys.get(kid);
  if (!key) throw new Error(`人员敏感信息密钥 ${kid} 不可用`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(aadFor(personnelId, field));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("人员敏感信息解密失败，数据可能损坏或密钥不匹配");
  }
}

export function encryptPersonnelSensitiveFields(fields = {}, personnelId, keyring) {
  return Object.fromEntries(PERSONNEL_SENSITIVE_FIELDS.map((field) => [
    field,
    encryptPersonnelSensitiveValue(fields?.[field], { personnelId, field, keyring }),
  ]));
}

export function decryptPersonnelSensitiveFields(person = {}, keyring) {
  const personnelId = normalizedPersonnelId(person?.id);
  return Object.fromEntries(PERSONNEL_SENSITIVE_FIELDS.map((field) => [
    field,
    decryptPersonnelSensitiveValue(person?.[field], { personnelId, field, keyring }),
  ]));
}

export function rewrapPersonnelSensitiveFields(person = {}, keyring) {
  const personnelId = normalizedPersonnelId(person?.id);
  const next = { ...person };
  for (const field of PERSONNEL_SENSITIVE_FIELDS) {
    const stored = String(person?.[field] ?? "");
    if (!stored) {
      next[field] = "";
      continue;
    }
    if (isEncryptedPersonnelSensitiveValue(stored) &&
        encryptedPersonnelSensitiveValueKid(stored) === keyring?.activeKid) {
      next[field] = stored;
      continue;
    }
    const plaintext = decryptPersonnelSensitiveValue(stored, { personnelId, field, keyring });
    next[field] = encryptPersonnelSensitiveValue(plaintext, { personnelId, field, keyring });
  }
  return next;
}
