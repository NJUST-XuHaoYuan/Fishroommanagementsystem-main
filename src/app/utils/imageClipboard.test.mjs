import assert from "node:assert/strict";
import { before, test } from "node:test";

let imageFilesFromTransfer, readClipboardImages;
before(async () => {
  ({ imageFilesFromTransfer, readClipboardImages } = await import("./imageClipboard.ts"));
});
const png = (name = "screenshot.png") => new File(["synthetic screenshot"], name, { type: "image/png" });
const fileItem = file => ({ kind: "file", type: file.type, getAsFile: () => file });
const chineseError = /[\u3400-\u9fff]/;

test("paste extracts a screenshot File without reading text or creating duplicate file/item entries", () => {
  const image = png();
  const images = imageFilesFromTransfer({ files: [image], items: [fileItem(image)] });
  assert.deepEqual(images, [image]);
  assert.strictEqual(images[0], image);
});

test("paste falls back to file items and ignores plain text, video and empty items", () => {
  const image = png();
  const video = new File(["synthetic video"], "clip.mp4", { type: "video/mp4" });
  const images = imageFilesFromTransfer({ files: [], items: [
    { kind: "string", type: "text/plain", getAsFile() { throw new Error("must not read string item"); } },
    fileItem(video), { kind: "file", type: "image/png", getAsFile: () => null }, fileItem(image),
  ] });
  assert.deepEqual(images, [image]);
});

test("plain text paste contains no image and leaves text untouched", () => {
  assert.deepEqual(imageFilesFromTransfer({ files: [], items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] }), []);
  assert.deepEqual(imageFilesFromTransfer({ files: [], items: [] }), []);
});

test("clipboard button reads PNG binary and provides a usable image File", async () => {
  const calls = [];
  const blob = new Blob(["synthetic screenshot"], { type: "image/png" });
  const files = await readClipboardImages({ read: async () => [{ types: ["image/png"], getType: async type => { calls.push(type); return blob; } }] });
  assert.deepEqual(calls, ["image/png"]);
  assert.equal(files.length, 1); assert.ok(files[0] instanceof File);
  assert.equal(files[0].type, "image/png"); assert.equal(await files[0].text(), await blob.text());
  assert.match(files[0].name, /\.png$/i);
});

test("one clipboard item with several image representations produces exactly one preferred PNG", async () => {
  const calls = [];
  const files = await readClipboardImages({ read: async () => [{ types: ["text/html", "image/jpeg", "image/webp", "image/png"], getType: async type => {
    calls.push(type); return new Blob(["same screenshot"], { type });
  } }] });
  assert.equal(files.length, 1); assert.equal(files[0].type, "image/png");
  assert.deepEqual(calls, ["image/png"]);
});

test("distinct clipboard image items remain distinct and JPEG precedes WebP", async () => {
  const calls = [];
  const files = await readClipboardImages({ read: async () => [
    { types: ["image/webp", "image/jpeg"], getType: async type => { calls.push(type); return new Blob(["first"], { type }); } },
    { types: ["image/webp"], getType: async type => { calls.push(type); return new Blob(["second"], { type }); } },
  ] });
  assert.equal(files.length, 2); assert.deepEqual(calls, ["image/jpeg", "image/webp"]);
  assert.deepEqual(files.map(file => file.type), ["image/jpeg", "image/webp"]);
});

test("empty or text-only clipboard reports a Chinese error without reading HTML, text or URLs", async () => {
  await assert.rejects(() => readClipboardImages({ read: async () => [] }), chineseError);
  const calls = [];
  await assert.rejects(() => readClipboardImages({ read: async () => [{ types: ["text/html", "text/plain", "text/uri-list"], getType: async type => { calls.push(type); throw new Error("must not read text"); } }] }), chineseError);
  assert.deepEqual(calls, []);
});

test("unsupported clipboard and denied permission produce actionable Chinese errors", async () => {
  await assert.rejects(() => readClipboardImages({}), chineseError);
  await assert.rejects(() => readClipboardImages({ read: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } }), chineseError);
});
