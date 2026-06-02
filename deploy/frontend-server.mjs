import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize, resolve } from "node:path";
import { pipeline } from "node:stream";
import { createGzip } from "node:zlib";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 80);
const backendUrl = new URL(process.env.BACKEND_URL || "http://backend:8787");
const distDir = resolve("dist");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
}

function isCompressible(ext) {
  return [".html", ".js", ".css", ".svg", ".json", ".txt"].includes(ext);
}

function isCompressibleContentType(contentType = "") {
  return /(?:application\/json|text\/|javascript|xml)/i.test(String(contentType));
}

function proxyApi(req, res) {
  const target = new URL(req.url || "/", backendUrl);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const proxyReq = transport(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...req.headers,
        host: target.host,
        "accept-encoding": "identity",
      },
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      const shouldGzip =
        acceptsGzip(req) &&
        !headers["content-encoding"] &&
        isCompressibleContentType(headers["content-type"]);

      if (shouldGzip) {
        delete headers["content-length"];
        headers["content-encoding"] = "gzip";
        headers.vary = headers.vary
          ? `${headers.vary}, Accept-Encoding`
          : "Accept-Encoding";
      }

      res.writeHead(proxyRes.statusCode || 502, headers);
      if (shouldGzip) {
        pipeline(proxyRes, createGzip(), res, (error) => {
          if (error && !res.destroyed) res.destroy(error);
        });
        return;
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    send(res, 502, `Backend proxy error: ${error.message}`);
  });

  req.pipe(proxyReq);
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const candidate = normalize(join(distDir, requested));
  const filePath = candidate === distDir || candidate.startsWith(`${distDir}/`)
    ? candidate
    : join(distDir, "index.html");
  const finalPath = existsSync(filePath) ? filePath : join(distDir, "index.html");

  try {
    const fileStat = await stat(finalPath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const ext = extname(finalPath);
    const headers = {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
    };
    if (url.pathname.startsWith("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    if (acceptsGzip(req) && isCompressible(ext)) {
      res.writeHead(200, {
        ...headers,
        "Content-Encoding": "gzip",
        "Vary": "Accept-Encoding",
      });
      pipeline(createReadStream(finalPath), createGzip(), res, (error) => {
        if (error && !res.destroyed) res.destroy(error);
      });
      return;
    }
    res.writeHead(200, headers);
    createReadStream(finalPath).pipe(res);
  } catch {
    send(res, 404, "Static file not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) {
    proxyApi(req, res);
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(port, host, () => {
  console.log(`Fishroom frontend: http://${host}:${port}`);
  console.log(`Proxying /api to ${backendUrl.href}`);
});
