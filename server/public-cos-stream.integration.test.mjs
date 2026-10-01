import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import COS from "cos-nodejs-sdk-v5";
import { createPublicCosStreamHandler } from "./public-cos-stream.mjs";
import { isSafePublicMediaMime } from "./public-media-token.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP fixture timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handleUpstream, options = {}) {
  const upstream = createServer(handleUpstream);
  const upstreamUrl = await listen(upstream);
  const signatures = [];
  const handler = createPublicCosStreamHandler({
    getSignedUrl(key, { method }) {
      signatures.push({ key, method });
      return `${upstreamUrl}/${key}?signature=server-only-test-signature`;
    },
    resolveContentType: (mime) => isSafePublicMediaMime(mime) ? mime : "",
    inferContentType: (key) => key.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
    ...options,
  });
  const proxy = createServer((req, res) => {
    void handler(req, res, new URL(req.url, "http://local").pathname.slice(1), "public, max-age=120");
  });
  const url = await listen(proxy);
  t.after(async () => {
    await Promise.all([proxy, upstream].map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  });
  return { url, signatures };
}

test("public media delivers its first bytes before COS completes without buffering the whole object", { timeout: 4000 }, async (t) => {
  const pending = deferred();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "10", ETag: '"fish"' });
    res.write("first");
    pending.resolve(res);
  });
  const response = await within(fetch(`${f.url}/fish.mp4`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("etag"), '"fish"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "public, max-age=120");
  const reader = response.body.getReader();
  const first = await within(reader.read());
  assert.equal(Buffer.from(first.value).toString(), "first");
  const origin = await pending.promise;
  assert.equal(origin.writableEnded, false, "origin still has half its bytes withheld");
  origin.end("last!");
  assert.equal(Buffer.from((await reader.read()).value).toString(), "last!");
  assert.equal((await reader.read()).done, true);
});

test("two videos stream concurrently while the first viewer is still connected", { timeout: 4000 }, async (t) => {
  const origins = [];
  const f = await fixture(t, (_req, res) => {
    origins.push(res);
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.write("first");
  });
  const one = await within(fetch(`${f.url}/one.mp4`));
  const firstReader = one.body.getReader();
  await firstReader.read();
  const two = await within(fetch(`${f.url}/two.mp4`));
  const secondReader = two.body.getReader();
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "first");
  assert.equal(origins.length, 2);
  assert.equal(origins[0].writableEnded, false);
  origins.forEach((res) => res.end());
  await Promise.all([firstReader.read(), secondReader.read()]);
});

test("disconnecting the viewer cancels the actual COS response and frees capacity", { timeout: 4000 }, async (t) => {
  const closed = deferred();
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    if (req.url.startsWith("/next")) { res.end("next"); return; }
    res.on("close", () => closed.resolve({ ended: res.writableEnded }));
    res.write("first");
  }, { videoConcurrency: 1, videoMaxPending: 0 });
  const controller = new AbortController();
  const response = await fetch(`${f.url}/held.mp4`, { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  assert.deepEqual(await within(closed.promise), { ended: false });
  const next = await within(fetch(`${f.url}/next.mp4`));
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "next");
});

test("Range and HEAD preserve metadata, method-specific signing, and safe upstream errors", { timeout: 4000 }, async (t) => {
  const requests = [];
  const f = await fixture(t, (req, res) => {
    requests.push({ url: req.url, method: req.method, range: req.headers.range });
    if (req.url.startsWith("/missing")) { res.writeHead(404); res.end("private upstream detail"); return; }
    if (req.url.startsWith("/failure")) { res.writeHead(500); res.end("private upstream detail"); return; }
    if (req.url.startsWith("/past")) { res.writeHead(416, { "Content-Range": "bytes */10" }); res.end(); return; }
    if (req.url.startsWith("/head")) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "10" }); res.end(); return;
    }
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": "3", "Content-Range": "bytes 2-4/10" });
    res.end("234");
  });
  const partial = await fetch(`${f.url}/range.mp4`, { headers: { Range: "bytes=2-4" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(partial.headers.get("accept-ranges"), "bytes");
  assert.equal(await partial.text(), "234");
  assert.equal(requests[0].range, "bytes=2-4");
  const head = await fetch(`${f.url}/head.jpg`, { method: "HEAD", headers: { Range: "bytes=2-4" } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  assert.deepEqual(f.signatures.at(-1), { key: "head.jpg", method: "HEAD" });
  assert.equal(requests.at(-1).method, "HEAD");
  assert.equal(requests.at(-1).range, undefined);
  const past = await fetch(`${f.url}/past.mp4`, { headers: { Range: "bytes=20-" } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */10");
  await past.text();
  for (const [path, status] of [["missing", 404], ["failure", 502]]) {
    const error = await fetch(`${f.url}/${path}.mp4`);
    assert.equal(error.status, status);
    assert.doesNotMatch(await error.text(), /private upstream|signature|http:/);
  }
  const before = requests.length;
  const invalid = await fetch(`${f.url}/range.mp4`, { headers: { Range: "bytes=0-1,3-4" } });
  assert.equal(invalid.status, 416);
  await invalid.text();
  assert.equal(requests.length, before, "invalid ranges never reach the upstream");
});

test("unsafe MIME and redirects are rejected without exposing or following the upstream URL", { timeout: 4000 }, async (t) => {
  let followed = false;
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith("/redirect")) { res.writeHead(302, { Location: "/target" }); res.end(); return; }
    if (req.url.startsWith("/target")) followed = true;
    res.writeHead(200, { "Content-Type": "text/html" }); res.end("<script>private</script>");
  });
  const unsafe = await fetch(`${f.url}/unsafe.html`);
  assert.equal(unsafe.status, 415);
  assert.doesNotMatch(await unsafe.text(), /script/);
  const redirect = await fetch(`${f.url}/redirect.mp4`);
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get("location"), null);
  assert.equal(followed, false);
  assert.doesNotMatch(await redirect.text(), /signature|http:/);
});

test("header timeout aborts a stalled upstream and returns 504", { timeout: 4000 }, async (t) => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.on("close", closed.resolve);
  }, { headerTimeoutMs: 80, totalTimeoutMs: 1000 });
  const response = await fetch(`${f.url}/stall.mp4`);
  assert.equal(response.status, 504);
  await response.text();
  await within(closed.promise);
});

test("a healthy stream outlives the header deadline, but its total lifetime remains bounded", { timeout: 4000 }, async (t) => {
  const origin = deferred();
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.on("close", () => closed.resolve());
    res.writeHead(200, { "Content-Type": "video/mp4" }); res.write("first");
    origin.resolve(res);
  }, { headerTimeoutMs: 60, totalTimeoutMs: 300 });
  const response = await fetch(`${f.url}/long.mp4`);
  const reader = response.body.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 100));
  (await origin.promise).write("later");
  assert.equal(Buffer.from((await reader.read()).value).toString(), "later");
  await assert.rejects(reader.read(), /terminated|aborted/i);
  await within(closed.promise);
});

test("continuing chunks reset the idle deadline throughout a slow active stream", { timeout: 4000 }, async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.write("first");
    let count = 0;
    const timer = setInterval(() => {
      res.write("more");
      if (++count === 8) { clearInterval(timer); res.end("last"); }
    }, 30);
    res.on("close", () => clearInterval(timer));
  }, { headerTimeoutMs: 60, idleTimeoutMs: 90, totalTimeoutMs: 1500 });
  const response = await fetch(`${f.url}/active.mp4`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `first${"more".repeat(8)}last`);
});

test("a stream with no further chunks is cancelled at the idle deadline and releases capacity", { timeout: 4000 }, async (t) => {
  const closed = deferred();
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    if (req.url.startsWith("/next")) { res.end("next"); return; }
    res.on("close", () => closed.resolve(res.writableEnded));
    res.write("first");
  }, { videoConcurrency: 1, videoMaxPending: 0, idleTimeoutMs: 80, totalTimeoutMs: 1500 });
  const response = await fetch(`${f.url}/idle.mp4`);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "first");
  await assert.rejects(within(reader.read()), /terminated|aborted/i);
  assert.equal(await within(closed.promise), false);
  const next = await within(fetch(`${f.url}/next.mp4`));
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "next");
});

test("the queue stays bounded and queued clients can cancel before an upstream request starts", { timeout: 4000 }, async (t) => {
  const origin = deferred();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" }); res.write("first");
    origin.resolve(res);
  }, { videoConcurrency: 1, videoMaxPending: 1, headerTimeoutMs: 1000 });
  const first = await fetch(`${f.url}/one.mp4`);
  const reader = first.body.getReader();
  await reader.read();
  const controller = new AbortController();
  const queued = fetch(`${f.url}/two.mp4`, { signal: controller.signal }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const full = await fetch(`${f.url}/three.mp4`);
  assert.equal(full.status, 503);
  await full.text();
  controller.abort();
  assert.equal((await queued).name, "AbortError");
  assert.equal(f.signatures.length, 1);
  (await origin.promise).end();
  await reader.read();
});

test("a rejected response whose body cancellation stalls cannot retain a stream slot", { timeout: 4000 }, async (t) => {
  const f = await fixture(t, () => {}, {
    imageConcurrency: 1,
    imageMaxPending: 0,
    fetchImpl: async (url) => url.includes("unsafe") ? {
      status: 200,
      headers: new Headers({ "Content-Type": "text/html" }),
      body: { locked: false, cancel: () => new Promise(() => {}) },
    } : new Response("next", { headers: { "Content-Type": "image/jpeg" } }),
  });
  const rejected = await fetch(`${f.url}/unsafe.jpg`);
  assert.equal(rejected.status, 415);
  await rejected.text();
  const next = await within(fetch(`${f.url}/next.jpg`));
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "next");
});

test("a truncated upstream terminates the partial response and frees the slot", { timeout: 4000 }, async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "10" });
    if (req.url.startsWith("/next")) { res.end("1234567890"); return; }
    res.write("first");
    setTimeout(() => res.destroy(), 30);
  }, { videoConcurrency: 1, videoMaxPending: 0 });
  const partial = await fetch(`${f.url}/broken.mp4`);
  await assert.rejects(partial.text(), /terminated|aborted/i);
  const next = await fetch(`${f.url}/next.mp4`);
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "1234567890");
});

test("the installed COS SDK signs HEAD and GET separately over HTTPS through the actual URL helper", async () => {
  const server = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const helper = server.slice(server.indexOf("async function signedCosObjectUrl("), server.indexOf("\nfunction mediaAttachmentDisposition("));
  const credentials = { SecretId: "test-only-cos-id", SecretKey: "test-only-cos-key" };
  const cos = new COS(credentials);
  const config = { bucket: "test-1250000000", region: "ap-shanghai" };
  const sign = new Function("getCosClient", "cosConfig", `${helper}; return signedCosObjectUrl;`)(() => cos, config);
  for (const method of ["HEAD", "GET"]) {
    const url = new URL(await sign("folder/fish.mp4", { method, expires: 600 }));
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "test-1250000000.cos.ap-shanghai.myqcloud.com");
    const expected = new URLSearchParams(COS.getAuthorization({
      ...credentials, Bucket: config.bucket, Region: config.region, Key: "folder/fish.mp4",
      Method: method, KeyTime: url.searchParams.get("q-key-time"),
    }));
    assert.equal(url.searchParams.get("q-signature"), expected.get("q-signature"));
    const wrongMethod = new URLSearchParams(COS.getAuthorization({
      ...credentials, Bucket: config.bucket, Region: config.region, Key: "folder/fish.mp4",
      Method: method === "HEAD" ? "GET" : "HEAD", KeyTime: url.searchParams.get("q-key-time"),
    }));
    assert.notEqual(url.searchParams.get("q-signature"), wrongMethod.get("q-signature"));
  }
});

test("the live public route verifies its token before streaming a server-signed key", async () => {
  const server = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const start = server.lastIndexOf('if (url.pathname === "/api/public/media/cos"');
  const end = server.indexOf('if (url.pathname === "/api/public/media/video-derivative"', start);
  const route = server.slice(start, end);
  assert.ok(route.indexOf("cosKeyFromUrl(mediaUrl)") < route.indexOf("verifyPublicMediaUrlToken"));
  assert.ok(route.indexOf("if (!validToken)") < route.indexOf("await streamPublicCosObject(req, res, key"));
  assert.doesNotMatch(route, /fetch\(mediaUrl|signedUrl.*sendJson/);
  assert.match(server, /Method: normalizedOptions\.method/);
});
