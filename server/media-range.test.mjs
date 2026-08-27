import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cosObjectDelivery,
  normalizeSingleByteRange,
  upstreamHeader,
} from "./media-range.mjs";

const localServerSource = readFileSync(new URL("./local-server.mjs", import.meta.url), "utf8");

test("single byte ranges are normalized for COS", () => {
  assert.deepEqual(normalizeSingleByteRange("bytes=0-1023"), {
    present: true,
    valid: true,
    value: "bytes=0-1023",
  });
  assert.equal(normalizeSingleByteRange("BYTES=1024-").value, "bytes=1024-");
  assert.equal(normalizeSingleByteRange("bytes=-512").value, "bytes=-512");
  assert.equal(normalizeSingleByteRange(undefined).present, false);
});

test("invalid and multipart ranges fail closed", () => {
  for (const value of ["items=0-1", "bytes=-", "bytes=10-9", "bytes=0-1,4-5", "bytes=abc-def"]) {
    assert.deepEqual(normalizeSingleByteRange(value), {
      present: true,
      valid: false,
      value: "",
    });
  }
});

test("COS response header lookup is case insensitive", () => {
  assert.equal(upstreamHeader({ "Content-Range": "bytes 0-9/100" }, "content-range"), "bytes 0-9/100");
  assert.equal(upstreamHeader({ etag: '"abc"' }, "ETag"), '"abc"');
});

test("partial COS delivery exposes seekable video headers", () => {
  const result = cosObjectDelivery({
    bodyLength: 1024,
    cacheControl: "public, max-age=3600",
    contentType: "video/mp4",
    range: "bytes=0-1023",
    upstreamHeaders: {
      "content-range": "bytes 0-1023/15000000",
      etag: '"video"',
    },
    upstreamStatusCode: 206,
  });
  assert.equal(result.statusCode, 206);
  assert.equal(result.headers["Accept-Ranges"], "bytes");
  assert.equal(result.headers["Content-Length"], "1024");
  assert.equal(result.headers["Content-Range"], "bytes 0-1023/15000000");
});

test("full COS delivery advertises range support and its body length", () => {
  const result = cosObjectDelivery({
    bodyLength: 15000000,
    cacheControl: "public, max-age=3600",
    contentType: "video/mp4",
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Accept-Ranges"], "bytes");
  assert.equal(result.headers["Content-Length"], "15000000");
  assert.equal(result.headers["Content-Range"], undefined);
});

test("public COS media route forwards Range and allows HEAD metadata checks", () => {
  assert.match(localServerSource, /Range:\s*requestedRange\.value/);
  assert.match(localServerSource, /\["GET",\s*"HEAD"\]\.includes\(req\.method\)/);
});
