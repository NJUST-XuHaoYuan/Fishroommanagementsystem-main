import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createConcurrencyLimiter } from "./concurrency-limiter.mjs";
import { normalizeSingleByteRange } from "./media-range.mjs";

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function sendError(req, res, status, message, headers = {}) {
  if (res.destroyed || res.headersSent) return;
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// Only call this after validating the public URL token and resolving its COS key.
// getSignedUrl is server-owned; its URL and any upstream errors never reach users.
export function createPublicCosStreamHandler({
  getSignedUrl,
  resolveContentType,
  inferContentType,
  fetchImpl = globalThis.fetch,
  headerTimeoutMs = 30_000,
  totalTimeoutMs = 30 * 60_000,
  idleTimeoutMs = 60_000,
  imageConcurrency = 8,
  videoConcurrency = 4,
  imageMaxPending = 32,
  videoMaxPending = 16,
}) {
  // Streaming retains bounded chunks instead of a full original video per slot.
  const imageLimiter = createConcurrencyLimiter({ concurrency: imageConcurrency, maxPending: imageMaxPending });
  const videoLimiter = createConcurrencyLimiter({ concurrency: videoConcurrency, maxPending: videoMaxPending });

  return async function streamPublicCosObject(req, res, key, cacheControl) {
    const range = normalizeSingleByteRange(req.headers.range);
    if (!range.valid) {
      sendError(req, res, 416, "Invalid media range", { "Accept-Ranges": "bytes" });
      return;
    }
    const controller = new AbortController();
    let reason = "";
    let release;
    let upstream;
    let source;
    let idleTimer;
    const abort = (nextReason) => {
      if (controller.signal.aborted) return;
      reason = nextReason;
      controller.abort(new Error(nextReason));
    };
    const resetIdleTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort("timeout"), idleTimeoutMs);
      idleTimer.unref?.();
    };
    const onDisconnect = () => {
      if (!res.writableFinished) abort("disconnected");
    };
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    // The header deadline also bounds queue/signing time; a busy queue must not
    // silently wait through every preceding video's full stream budget.
    const headerTimer = setTimeout(() => abort("timeout"), headerTimeoutMs);
    const totalTimer = setTimeout(() => abort("timeout"), totalTimeoutMs);
    headerTimer.unref?.();
    totalTimer.unref?.();
    try {
      if (req.aborted || res.destroyed) { abort("disconnected"); return; }
      const limiter = String(inferContentType(key)).startsWith("video/") ? videoLimiter : imageLimiter;
      release = await limiter.acquire({ signal: controller.signal });
      const method = req.method === "HEAD" ? "HEAD" : "GET";
      const signedUrl = await abortable(Promise.resolve().then(() => getSignedUrl(key, { method })), controller.signal);
      if (!signedUrl) {
        sendError(req, res, 503, "COS is not configured");
        return;
      }
      upstream = await fetchImpl(signedUrl, {
        method,
        headers: {
          "Accept-Encoding": "identity",
          ...(method === "GET" && range.present ? { Range: range.value } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      clearTimeout(headerTimer);
      resetIdleTimeout();
      if (upstream.status === 416) {
        sendError(req, res, 416, "Media range is not satisfiable", {
          "Accept-Ranges": "bytes",
          ...(upstream.headers.get("content-range") ? { "Content-Range": upstream.headers.get("content-range") } : {}),
        });
        return;
      }
      if (upstream.status !== 200 && upstream.status !== 206) {
        sendError(req, res, upstream.status === 404 ? 404 : 502, "Failed to load COS object");
        return;
      }
      const contentType = resolveContentType(upstream.headers.get("content-type"), key);
      if (!contentType) {
        sendError(req, res, 415, "Unsupported public media type");
        return;
      }
      // fetch decodes compressed bodies. Reject a server that disregards identity
      // rather than forwarding Content-Length/Range for different encoded bytes.
      const encoding = upstream.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase() !== "identity") {
        sendError(req, res, 502, "Unsupported media encoding");
        return;
      }
      const headers = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
      };
      for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res._logicalResponseBytes = 0;
      res.writeHead(upstream.status, headers);
      if (method === "HEAD" || !upstream.body) {
        res.end();
        return;
      }
      source = Readable.fromWeb(upstream.body);
      const countBytes = new Transform({
        transform(chunk, _encoding, callback) {
          resetIdleTimeout();
          res._logicalResponseBytes += chunk.length;
          callback(null, chunk);
        },
      });
      // pipeline propagates backpressure and abort to both ends. No arrayBuffer(),
      // concatenation, or SDK buffer is retained while the client watches.
      await pipeline(source, countBytes, res, { signal: controller.signal });
    } catch (error) {
      if (reason === "disconnected" || req.aborted || res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      sendError(req, res, reason === "timeout" ? 504 : error?.statusCode === 503 ? 503 : 502,
        reason === "timeout" ? "COS media request timed out" : "Failed to load COS object");
    } finally {
      clearTimeout(headerTimer);
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      req.removeListener("aborted", onDisconnect);
      res.removeListener("close", onDisconnect);
      // Cancels a rejected upstream response as well as any unfinished fetch.
      if (!controller.signal.aborted) controller.abort();
      if (source && !source.destroyed) source.destroy();
      // Fetch has already been aborted; a body implementation whose cancel()
      // stalls must not retain a limiter slot after this request has ended.
      if (upstream?.body && !upstream.body.locked) void upstream.body.cancel().catch(() => undefined);
      release?.();
    }
  };
}
