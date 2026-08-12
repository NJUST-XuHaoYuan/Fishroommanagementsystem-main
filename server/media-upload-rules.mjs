const IMAGE_MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
]);

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

function normalizedMime(value) {
  const mime = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return IMAGE_MIME_ALIASES.get(mime) ?? mime;
}

function hasBytes(buffer, offset, expected) {
  if (!buffer || buffer.length < offset + expected.length) return false;
  return expected.every((value, index) => buffer[offset + index] === value);
}

function asciiAt(buffer, offset, length) {
  if (!buffer || buffer.length < offset + length) return "";
  return Buffer.from(buffer.subarray(offset, offset + length)).toString("ascii");
}

function isHeifContainer(buffer) {
  if (!buffer || buffer.length < 16 || asciiAt(buffer, 4, 4) !== "ftyp") return false;
  const brands = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
  if (brands.has(asciiAt(buffer, 8, 4))) return true;
  for (let offset = 16; offset + 4 <= Math.min(buffer.length, 64); offset += 4) {
    if (brands.has(asciiAt(buffer, offset, 4))) return true;
  }
  return false;
}

export function isSupportedImageMime(mime) {
  return SUPPORTED_IMAGE_MIMES.has(normalizedMime(mime));
}

export function imageBufferMatchesMime(buffer, mime) {
  const normalized = normalizedMime(mime);
  if (!buffer || buffer.length < 12) return false;
  if (normalized === "image/jpeg") return hasBytes(buffer, 0, [0xff, 0xd8, 0xff]);
  if (normalized === "image/png") return hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (normalized === "image/gif") return ["GIF87a", "GIF89a"].includes(asciiAt(buffer, 0, 6));
  if (normalized === "image/webp") return asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP";
  if (normalized === "image/heic" || normalized === "image/heif") return isHeifContainer(buffer);
  return false;
}

export function validateImageUploadBuffer(buffer, mime) {
  if (!isSupportedImageMime(mime)) {
    const error = new Error("仅支持 JPG、PNG、WebP、GIF、HEIC 或 HEIF 图片");
    error.statusCode = 400;
    throw error;
  }
  if (!imageBufferMatchesMime(buffer, mime)) {
    const error = new Error("图片文件内容无效或已损坏，请重新选择原始照片");
    error.statusCode = 400;
    throw error;
  }
}
