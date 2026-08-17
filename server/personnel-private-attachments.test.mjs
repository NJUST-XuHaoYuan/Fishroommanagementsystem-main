import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve, sep } from "node:path";
import {
  PERSONNEL_ATTACHMENT_KINDS,
  PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY,
  PersonnelPrivateAttachmentError,
  assertPersonnelAttachmentReferenceAccess,
  decryptPersonnelAttachmentBuffer,
  encryptPersonnelAttachmentBuffer,
  isPersonnelPrivateAttachmentPath,
  normalizePersonnelAttachmentKind,
  personnelAttachmentCiphertextKid,
  privatePersonnelAttachmentPath,
  rewrapPersonnelAttachmentBuffer,
  sanitizeAttachmentFilename,
} from "./personnel-private-attachments.mjs";
import { parsePersonnelDataKeyring } from "./personnel-sensitive-data.mjs";

const oldKey = Buffer.alloc(32, 17).toString("base64");
const newKey = Buffer.alloc(32, 23).toString("base64");
const oldKeyring = parsePersonnelDataKeyring(JSON.stringify({
  activeKid: "old-key",
  keys: { "old-key": oldKey },
}));
const rotatedKeyring = parsePersonnelDataKeyring(JSON.stringify({
  activeKid: "new-key",
  keys: { "old-key": oldKey, "new-key": newKey },
}));

const context = {
  attachmentId: "attachment-123",
  personnelId: "person-1",
  kind: "id_card_front",
};

function encrypt(value = "private document", keyring = oldKeyring) {
  return encryptPersonnelAttachmentBuffer(Buffer.from(value), { ...context, keyring });
}

function assertAttachmentError(fn, { statusCode, code, message } = {}) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PersonnelPrivateAttachmentError, true);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    if (code !== undefined) assert.equal(error.code, code);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

test("supports only the three personnel document kinds", () => {
  assert.deepEqual(PERSONNEL_ATTACHMENT_KINDS, [
    "id_card_front",
    "id_card_back",
    "education_proof",
  ]);
  assert.equal(normalizePersonnelAttachmentKind(" ID_CARD_FRONT "), "id_card_front");
  assertAttachmentError(() => normalizePersonnelAttachmentKind("avatar"), { message: /不支持/ });
});

test("encrypts binary content with attachment, personnel and kind bound into AAD", () => {
  const plaintext = Buffer.from([0, 1, 2, 3, 254, 255]);
  const encrypted = encryptPersonnelAttachmentBuffer(plaintext, { ...context, keyring: oldKeyring });
  assert.notDeepEqual(encrypted, plaintext);
  assert.deepEqual(
    decryptPersonnelAttachmentBuffer(encrypted, { ...context, keyring: oldKeyring }),
    plaintext
  );

  assertAttachmentError(() => decryptPersonnelAttachmentBuffer(encrypted, {
    ...context,
    personnelId: "person-2",
    keyring: oldKeyring,
  }), { code: "PERSONNEL_ATTACHMENT_DECRYPTION_FAILED" });
  assertAttachmentError(() => decryptPersonnelAttachmentBuffer(encrypted, {
    ...context,
    kind: "id_card_back",
    keyring: oldKeyring,
  }), { code: "PERSONNEL_ATTACHMENT_DECRYPTION_FAILED" });
  assertAttachmentError(() => decryptPersonnelAttachmentBuffer(encrypted, {
    ...context,
    attachmentId: "attachment-456",
    keyring: oldKeyring,
  }), { code: "PERSONNEL_ATTACHMENT_DECRYPTION_FAILED" });
});

test("tampering fails authenticated decryption", () => {
  const encrypted = encrypt();
  const parts = encrypted.toString("utf8").split("$");
  const first = parts[5][0];
  parts[5] = `${first === "A" ? "B" : "A"}${parts[5].slice(1)}`;
  assertAttachmentError(() => decryptPersonnelAttachmentBuffer(
    Buffer.from(parts.join("$")),
    { ...context, keyring: oldKeyring }
  ), { code: "PERSONNEL_ATTACHMENT_DECRYPTION_FAILED" });
});

test("old ciphertext remains decryptable after key rotation while a missing old key fails closed", () => {
  const encrypted = encrypt("legacy attachment", oldKeyring);
  assert.equal(
    decryptPersonnelAttachmentBuffer(encrypted, { ...context, keyring: rotatedKeyring }).toString(),
    "legacy attachment"
  );
  assertAttachmentError(() => decryptPersonnelAttachmentBuffer(encrypted, {
    ...context,
    keyring: parsePersonnelDataKeyring(JSON.stringify({
      activeKid: "new-key",
      keys: { "new-key": newKey },
    })),
  }), { code: "PERSONNEL_ATTACHMENT_KEY_UNAVAILABLE" });
});

test("rewraps an attachment from the old key to the active key without changing plaintext", () => {
  const encrypted = encrypt("rotate me", oldKeyring);
  assert.equal(personnelAttachmentCiphertextKid(encrypted), "old-key");
  const rewrapped = rewrapPersonnelAttachmentBuffer(encrypted, { ...context, keyring: rotatedKeyring });
  assert.equal(personnelAttachmentCiphertextKid(rewrapped), "new-key");
  assert.equal(decryptPersonnelAttachmentBuffer(rewrapped, { ...context, keyring: rotatedKeyring }).toString(), "rotate me");
  assert.deepEqual(
    rewrapPersonnelAttachmentBuffer(rewrapped, { ...context, keyring: rotatedKeyring }),
    rewrapped
  );
});

test("private attachment paths stay below uploads/.personnel-private", () => {
  const uploadDir = "/tmp/fishroom-uploads";
  const path = privatePersonnelAttachmentPath(uploadDir, "attachment-123");
  const expectedRoot = resolve(uploadDir, PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY);
  assert.equal(dirname(path), expectedRoot);
  assert.equal(path, `${expectedRoot}${sep}attachment-123.bin`);

  for (const invalidId of ["", ".", "..", "../secret", "folder/file", "folder\\file", "%2e%2e", "id.bin"]) {
    assertAttachmentError(() => privatePersonnelAttachmentPath(uploadDir, invalidId), {});
  }
  assert.equal(isPersonnelPrivateAttachmentPath(uploadDir, resolve(uploadDir, ".personnel-private/file.bin")), true);
  assert.equal(isPersonnelPrivateAttachmentPath(uploadDir, resolve(uploadDir, "public/../.personnel-private/file.bin")), true);
  assert.equal(isPersonnelPrivateAttachmentPath(uploadDir, resolve(uploadDir, "public/file.jpg")), false);
});

test("sanitizes untrusted attachment filenames for metadata and Content-Disposition", () => {
  assert.equal(sanitizeAttachmentFilename("../../身份证正面.jpg"), "身份证正面.jpg");
  assert.equal(sanitizeAttachmentFilename("..\\..\\学历\r\n证明.pdf"), "学历证明.pdf");
  assert.equal(sanitizeAttachmentFilename("\"bad;name<.png"), "_bad_name_.png");
  assert.equal(sanitizeAttachmentFilename(".."), "attachment");
  assert.ok([...sanitizeAttachmentFilename("证".repeat(200))].length <= 120);
});

test("only administrators or the owner may preview their private attachment reference", () => {
  const reference = {
    personnelId: "person-1",
    uploadedByPersonnelId: "person-1",
    status: "pending",
  };
  assert.equal(assertPersonnelAttachmentReferenceAccess(reference, { isAdmin: true }), true);
  assert.equal(assertPersonnelAttachmentReferenceAccess(reference, {
    requesterPersonnelId: "person-1",
    allowOwnerPreview: true,
  }), true);
  for (const status of ["draft", "pending", "approved", "rejected"]) {
    assert.equal(assertPersonnelAttachmentReferenceAccess({ ...reference, status }, {
      requesterPersonnelId: "person-1",
      allowOwnerPreview: true,
    }), true);
  }

  assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess(reference, {
    requesterPersonnelId: "person-2",
    allowOwnerPreview: true,
  }), { statusCode: 403, code: "PERSONNEL_ATTACHMENT_FORBIDDEN" });
  assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess(reference, {
    requesterPersonnelId: "person-1",
  }), { statusCode: 403 });
  assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess({
    ...reference,
    status: "unknown",
  }, {
    requesterPersonnelId: "person-1",
    allowOwnerPreview: true,
  }), { statusCode: 403 });
  assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess({
    ...reference,
    uploadedByPersonnelId: "person-2",
  }, {
    requesterPersonnelId: "person-1",
    allowOwnerPreview: true,
  }), { statusCode: 403 });
  for (const status of ["expired", "retired", "superseded", "orphaned"]) {
    assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess({ ...reference, status }, {
      isAdmin: true,
    }), { statusCode: 404, code: "PERSONNEL_ATTACHMENT_NOT_FOUND" });
  }
  assertAttachmentError(() => assertPersonnelAttachmentReferenceAccess({
    ...reference,
    status: "rejected",
    expiresAt: "2000-01-01T00:00:00.000Z",
  }, {
    isAdmin: true,
  }), { statusCode: 404, code: "PERSONNEL_ATTACHMENT_NOT_FOUND" });
});
