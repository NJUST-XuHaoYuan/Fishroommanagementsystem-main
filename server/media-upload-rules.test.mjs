import assert from "node:assert/strict";
import test from "node:test";
import {
  imageBufferMatchesMime,
  isSupportedImageMime,
  validateImageUploadBuffer,
} from "./media-upload-rules.mjs";

test("accepts supported image signatures", () => {
  assert.equal(imageBufferMatchesMime(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg"), true);
  assert.equal(imageBufferMatchesMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), "image/png"), true);
  assert.equal(imageBufferMatchesMime(Buffer.from("GIF89a000000"), "image/gif"), true);
  assert.equal(imageBufferMatchesMime(Buffer.from("RIFF0000WEBP"), "image/webp"), true);
  assert.equal(
    imageBufferMatchesMime(
      Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic0000")]),
      "image/heic",
    ),
    true,
  );
});

test("rejects text uploaded with an image content type", () => {
  const corruptPayload = Buffer.from("edc5190d143b4dd7a8be8ea766c34c77");
  assert.equal(imageBufferMatchesMime(corruptPayload, "image/jpeg"), false);
  assert.throws(
    () => validateImageUploadBuffer(corruptPayload, "image/jpeg"),
    /图片文件内容无效或已损坏/,
  );
});

test("rejects image formats that the storage pipeline does not support", () => {
  assert.equal(isSupportedImageMime("image/svg+xml"), false);
  assert.throws(
    () => validateImageUploadBuffer(Buffer.from("<svg></svg>"), "image/svg+xml"),
    /仅支持 JPG、PNG、WebP、GIF、HEIC 或 HEIF 图片/,
  );
});
