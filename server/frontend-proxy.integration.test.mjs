import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPublicCosStreamHandler } from "./public-cos-stream.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Proxy fixture timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, upstreamHandler, apiHandler = null) {
  const upstream = createServer(upstreamHandler);
  const upstreamUrl = await listen(upstream);
  const streamMedia = createPublicCosStreamHandler({
    getSignedUrl: (key) => `${upstreamUrl}/${key}`,
    resolveContentType: (mime) => mime === "video/mp4" ? mime : "",
    inferContentType: () => "video/mp4",
    videoConcurrency: 1,
    videoMaxPending: 0,
  });
  const backend = createServer((req, res) => {
    if (req.url.startsWith("/api/media/")) {
      void streamMedia(req, res, req.url.slice("/api/media/".length), "public, max-age=60");
    } else if (apiHandler) apiHandler(req, res);
    else { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); }
  });
  const backendUrl = await listen(backend);
  // Run the real deployed entrypoint in a separate process so an unhandled
  // response-stream error is observable as a process crash, not hidden by a mock.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../deploy/frontend-server.mjs", import.meta.url))], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", BACKEND_URL: backendUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const address = output.match(/Fishroom frontend: (http:\/\/127\.0\.0\.1:\d+)/);
      if (address) resolve(address[1]);
    });
    child.once("exit", (code) => reject(new Error(`Frontend exited ${code}: ${errors}`)));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await Promise.all([backend, upstream].map((server) => new Promise((resolve) => {
      server.closeAllConnections(); server.close(resolve);
    })));
  });
  return { url: await within(ready), child, errors: () => errors };
}

test("viewer cancellation crosses the live frontend and backend and stops COS", { timeout: 5000 }, async (t) => {
  const closed = deferred();
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    if (req.url === "/next.mp4") { res.end("next"); return; }
    res.on("close", () => closed.resolve(res.writableEnded));
    res.write("first");
  });
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/media/held.mp4`, { signal: controller.signal });
  assert.equal(Buffer.from((await response.body.getReader().read()).value).toString(), "first");
  controller.abort();
  assert.equal(await within(closed.promise), false, "COS was cancelled before it finished its body");
  const next = await within(fetch(`${f.url}/api/media/next.mp4`));
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "next");
  assert.equal(f.child.exitCode, null);
});

test("a truncated backend stream aborts only that response and leaves frontend alive", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "10" });
    res.write("first");
    setTimeout(() => res.destroy(), 40);
  });
  const response = await fetch(`${f.url}/api/media/broken.mp4`);
  await assert.rejects(response.text(), /terminated|aborted/i);
  const health = await within(fetch(`${f.url}/api/health`));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(f.child.exitCode, null);
  assert.doesNotMatch(f.errors(), /Unhandled|ERR_HTTP_HEADERS_SENT|uncaught/i);
});

test("normal API bodies, gzip, error statuses and pre-header backend failure remain usable", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, () => {}, async (req, res) => {
    if (req.url === "/api/drop") { req.socket.destroy(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const value = req.url === "/api/error" ? { error: "validation failed" } : { body, method: req.method };
    const output = JSON.stringify(value);
    res.writeHead(req.url === "/api/error" ? 422 : 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(output) });
    res.end(output);
  });
  const body = JSON.stringify({ text: "中文请求正文", items: [1, 2, 3] });
  const normal = await fetch(`${f.url}/api/echo`, { method: "POST", body, headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" } });
  assert.equal(normal.headers.get("content-encoding"), "gzip");
  assert.deepEqual(await normal.json(), { body, method: "POST" });
  const error = await fetch(`${f.url}/api/error`);
  assert.equal(error.status, 422);
  assert.deepEqual(await error.json(), { error: "validation failed" });
  const dropped = await fetch(`${f.url}/api/drop`);
  assert.equal(dropped.status, 502);
  assert.match(await dropped.text(), /Backend proxy error/);
  const again = await fetch(`${f.url}/api/echo`);
  assert.equal(again.status, 200);
  await again.text();
});

test("an open media response continues delivering later chunks and preserves Range headers", { timeout: 5000 }, async (t) => {
  const origin = deferred();
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers.range, "bytes=0-9");
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-9/100", "Content-Length": "10" });
    res.write("first");
    origin.resolve(res);
  });
  const response = await fetch(`${f.url}/api/media/range.mp4`, { headers: { Range: "bytes=0-9" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-9/100");
  assert.equal(response.headers.get("content-length"), "10");
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "first");
  await new Promise((resolve) => setTimeout(resolve, 100));
  (await origin.promise).end("last!");
  assert.equal(Buffer.from((await reader.read()).value).toString(), "last!");
  assert.equal((await reader.read()).done, true);
});

test("aborting an incomplete upload cancels the forwarded backend request", { timeout: 5000 }, async (t) => {
  const started = deferred();
  const aborted = deferred();
  const f = await fixture(t, () => {}, (req) => {
    req.on("aborted", aborted.resolve);
    req.on("error", () => {});
    req.on("data", started.resolve);
  });
  const upload = request(`${f.url}/api/upload`, { method: "POST", headers: { "Content-Length": "1000000" } });
  upload.on("error", () => {});
  upload.write("partial-body");
  await within(started.promise);
  upload.destroy();
  await within(aborted.promise);
  assert.equal(f.child.exitCode, null);
});
