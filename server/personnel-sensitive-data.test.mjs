import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptPersonnelSensitiveFields,
  decryptPersonnelSensitiveValue,
  encryptPersonnelSensitiveFields,
  encryptPersonnelSensitiveValue,
  encryptedPersonnelSensitiveValueKid,
  parsePersonnelDataKeyring,
  rewrapPersonnelSensitiveFields,
} from "./personnel-sensitive-data.mjs";

const keyA = Buffer.alloc(32, 17).toString("base64");
const keyB = Buffer.alloc(32, 23).toString("base64");
const keyringA = parsePersonnelDataKeyring(JSON.stringify({ activeKid: "key-a", keys: { "key-a": keyA } }));
const keyringB = parsePersonnelDataKeyring(JSON.stringify({ activeKid: "key-b", keys: { "key-a": keyA, "key-b": keyB } }));

test("personnel sensitive fields are encrypted with authenticated encryption", () => {
  const encrypted = encryptPersonnelSensitiveFields({
    idCardNo: "11010519491231002X",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "某银行南京支行",
  }, "person-1", keyringA);
  assert.notEqual(encrypted.idCardNo, "11010519491231002X");
  assert.equal(encryptedPersonnelSensitiveValueKid(encrypted.idCardNo), "key-a");
  assert.deepEqual(decryptPersonnelSensitiveFields({ id: "person-1", ...encrypted }, keyringA), {
    idCardNo: "11010519491231002X",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "某银行南京支行",
  });
});

test("personnel id and field name are authenticated as associated data", () => {
  const encrypted = encryptPersonnelSensitiveValue("6222021001116245", {
    personnelId: "person-1",
    field: "bankAccountNo",
    keyring: keyringA,
  });
  assert.throws(() => decryptPersonnelSensitiveValue(encrypted, {
    personnelId: "person-2",
    field: "bankAccountNo",
    keyring: keyringA,
  }), /解密失败/);
  assert.throws(() => decryptPersonnelSensitiveValue(encrypted, {
    personnelId: "person-1",
    field: "idCardNo",
    keyring: keyringA,
  }), /解密失败/);
});

test("tampering and missing keys fail closed", () => {
  const encrypted = encryptPersonnelSensitiveValue("secret", {
    personnelId: "person-1",
    field: "bankName",
    keyring: keyringA,
  });
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptPersonnelSensitiveValue(tampered, {
    personnelId: "person-1",
    field: "bankName",
    keyring: keyringA,
  }), /解密失败/);
  assert.throws(() => decryptPersonnelSensitiveValue(encrypted, {
    personnelId: "person-1",
    field: "bankName",
    keyring: null,
  }), /密钥未配置/);
});

test("key rotation rewraps old ciphertext while preserving plaintext", () => {
  const original = {
    id: "person-1",
    ...encryptPersonnelSensitiveFields({ bankAccountNo: "6222021001116245" }, "person-1", keyringA),
  };
  const rewrapped = rewrapPersonnelSensitiveFields(original, keyringB);
  assert.equal(encryptedPersonnelSensitiveValueKid(rewrapped.bankAccountNo), "key-b");
  assert.equal(decryptPersonnelSensitiveFields(rewrapped, keyringB).bankAccountNo, "6222021001116245");
});

test("keyring validation rejects malformed or incorrectly sized keys", () => {
  assert.throws(() => parsePersonnelDataKeyring("not-json"), /不是有效 JSON/);
  assert.throws(() => parsePersonnelDataKeyring(JSON.stringify({ activeKid: "a", keys: { a: "short" } })), /32 字节/);
  assert.throws(() => parsePersonnelDataKeyring(JSON.stringify({ activeKid: "missing", keys: { a: keyA } })), /不存在/);
});
