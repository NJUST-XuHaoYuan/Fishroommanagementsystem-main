import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { assertNoMacMetadataTarEntries } from "./create-release.mjs";

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const payload = Buffer.from(entry.payload || "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write(entry.typeFlag || "0", 156, 1, "ascii");
    blocks.push(header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("accepts an archive without macOS metadata", () => {
  const archive = tarArchive([{ name: "release/package.json", payload: "{}" }]);
  assert.doesNotThrow(() => assertNoMacMetadataTarEntries(archive));
});

test("rejects AppleDouble entries", () => {
  const archive = tarArchive([{ name: "release/._package.json", payload: "metadata" }]);
  assert.throws(() => assertNoMacMetadataTarEntries(archive), /AppleDouble/);
});

test("rejects macOS extended attributes stored in PAX headers", () => {
  const archive = tarArchive([
    {
      name: "PaxHeader/package.json",
      typeFlag: "x",
      payload: "52 LIBARCHIVE.xattr.com.apple.provenance=opaque\n",
    },
  ]);
  assert.throws(() => assertNoMacMetadataTarEntries(archive), /PAX/);
});

for (const [typeFlag, label] of [
  ["1", "hard link"],
  ["2", "symbolic link"],
  ["3", "character device"],
  ["4", "block device"],
  ["6", "fifo"],
]) {
  test(`rejects ${label} archive entries`, () => {
    const archive = tarArchive([{ name: `release/${label}`, typeFlag }]);
    assert.throws(() => assertNoMacMetadataTarEntries(archive), /非普通文件或目录/);
  });
}
