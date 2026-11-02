import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, ui, media;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ui = await server.ssrLoadModule("/src/app/components/MediaPreviewDialog.tsx");
  media = await server.ssrLoadModule("/src/app/utils/media.ts");
});
after(async () => { await server?.close(); });

const cosSrc = "https://test-bucket.cos.ap-nanjing.myqcloud.com/fish.mp4";
async function withBrowser(run) {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const store = new Map();
  globalThis.window = { location: { href: "https://fishroom.test/orders" }, localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }, navigator: { userAgent: "Desktop browser" } };
  const session = { username: "sales-a", role: "staff", token: "token-a", expiresAt: Date.now() + 60_000, visibleSiteIds: ["nanjing"] };
  const write = value => store.set("fishroom-auth-session", JSON.stringify(value));
  write(session); media.clearResolvedMediaCache();
  try { return await run({ write, session }); } finally { media.clearResolvedMediaCache(); globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
}

test("preview trigger is an accessible inert button, not a link, download or nested control", () => {
  let downloadCalls = 0;
  const markup = renderToStaticMarkup(createElement(ui.MediaPreviewTrigger, { src: "/uploads/fish.jpg", mediaType: "image", title: "维护照片", onDownload: async () => { downloadCalls++; }, ariaLabel: "预览维护照片", className: "size-20" }, createElement("img", { src: "/uploads/thumb.jpg", alt: "维护照片缩略图" })));
  assert.match(markup, /<button[^>]*type="button"[^>]*aria-label="预览维护照片"/);
  assert.match(markup, /aria-haspopup="dialog"/);
  assert.match(markup, /min-h-11 min-w-11/);
  assert.doesNotMatch(markup, /<a|download=|target=|<video/);
  assert.equal(downloadCalls, 0);
  const closed = renderToStaticMarkup(createElement(ui.MediaPreviewDialog, { open: false, onOpenChange() {}, items: [{ src: cosSrc, type: "video" }] }));
  assert.equal(closed, "");
});

test("preview protocol allowlist accepts only image/video data, blob and web paths", () => {
  for (const src of ["/uploads/a.jpg", "https://cdn.example.test/a.mp4", "blob:https://fishroom.test/private-1", "data:image/png;base64,aA==", "data:video/mp4;base64,aA=="]) assert.equal(media.isSafeMediaPreviewSrc(src), true, src);
  for (const src of ["", "javascript:alert(1)", "data:text/html,<script/>", "data:image/svg+xml,<svg/>", "file:///etc/passwd", "ftp://example.test/image.png", "https://user:pass@example.test/photo.jpg"]) assert.equal(media.isSafeMediaPreviewSrc(src), false, src);
});

test("preview indices clamp safely and downloaded filenames retain explicit original names", () => {
  assert.equal(ui.clampMediaPreviewIndex(-1, 5), 0);
  assert.equal(ui.clampMediaPreviewIndex(9, 2), 1);
  assert.equal(ui.clampMediaPreviewIndex(undefined, 0), 0);
  assert.equal(ui.mediaPreviewFilename({ src: "/uploads/proof.webp?a=1", type: "image" }, 2), "photo-3.webp");
  assert.equal(ui.mediaPreviewFilename({ src: "blob:https://fishroom.test/a", type: "video", filename: "操作视频.mov" }), "操作视频.mov");
  assert.equal(ui.mediaPreviewFilename({ src: "blob:https://fishroom.test/a", type: "video" }), "video-1.mp4");
});

test("signed media cache is reused only within the same authentication identity and scope", async () => withBrowser(async ({ write, session }) => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ url: `${cosSrc}?signed=${calls.length}`, expiresIn: 3600 }), { status: 200 }); };
  assert.equal(await media.resolveMediaUrl(cosSrc), `${cosSrc}?signed=1`);
  assert.equal(await media.resolveMediaUrl(cosSrc), `${cosSrc}?signed=1`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-a");
  assert.match(calls[0].url, /^\/api\/media\/cos-url\?/);
  write({ ...session, username: "sales-b", token: "token-b" });
  assert.equal(await media.resolveMediaUrl(cosSrc), `${cosSrc}?signed=2`);
  write({ ...session, visibleSiteIds: ["jiangyin"] });
  assert.equal(await media.resolveMediaUrl(cosSrc), `${cosSrc}?signed=3`);
  assert.equal(calls.length, 3);
  const before = calls.length;
  assert.equal(await media.resolveMediaUrl("https://unrelated.test/photo.jpg"), "https://unrelated.test/photo.jpg");
  assert.equal(calls.length, before, "never send auth headers to an arbitrary external preview source");
}));

test("late signing responses after token changes or cancellation are discarded and not cached", async () => withBrowser(async ({ write, session }) => {
  let resolve;
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  const oldRequest = media.resolveMediaUrl(cosSrc);
  write({ ...session, token: "renewed" });
  resolve(new Response(JSON.stringify({ url: `${cosSrc}?private-old`, expiresIn: 3600 }), { status: 200 }));
  await assert.rejects(oldRequest, { name: "AbortError" });
  const controller = new AbortController();
  const cancelled = media.resolveMediaUrl(cosSrc, { signal: controller.signal });
  controller.abort();
  resolve(new Response(JSON.stringify({ url: `${cosSrc}?cancelled`, expiresIn: 3600 }), { status: 200 }));
  await assert.rejects(cancelled, { name: "AbortError" });
  let nextCalls = 0;
  globalThis.fetch = async () => { nextCalls++; return new Response(JSON.stringify({ url: `${cosSrc}?fresh`, expiresIn: 3600 }), { status: 200 }); };
  assert.equal(await media.resolveMediaUrl(cosSrc), `${cosSrc}?fresh`); assert.equal(nextCalls, 1);
}));

test("explicit downloads never finish with a stale login session", async () => withBrowser(async ({ write, session }) => {
  let resolve;
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  const download = media.downloadMedia("/uploads/a.jpg", "a.jpg", { mediaType: "image" });
  write({ ...session, token: "another-session" });
  resolve(new Response(new Blob(["pixels"], { type: "image/jpeg" }), { status: 200 }));
  await assert.rejects(download, /登录状态已变化/);
}));

test("video preview remains streamed, inline and controlled; close removes its source and no preview opens a window", async () => {
  const source = await readFile(new URL("./MediaPreviewDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /<MediaVideo src=\{item.src\} controls playsInline preload="metadata" autoPlay=\{false\}/);
  assert.match(source, /video.pause\(\); video.removeAttribute\("src"\); video.load\(\)/);
  assert.match(source, /document.querySelectorAll\("video"\).forEach\(video => video.pause\(\)\)/);
  assert.match(source, /\{open && <MediaPreviewContent/);
  assert.match(source, /onClick=\{\(\) => void save\(\)\}/);
  assert.match(source, /item.onDownload \? await item.onDownload\(\) : await downloadMedia/);
  assert.match(source, /stockItemId: item.stockItemId, recordId: item.recordId/);
  assert.match(source, /onCloseAutoFocus/);
  assert.match(source, /event.stopPropagation\(\)/);
  assert.match(source, /原尺寸查看/);
  assert.match(source, /重新加载/);
  assert.doesNotMatch(source, /window.open|response.blob|URL.createObjectURL|dangerouslySetInnerHTML|<iframe/);
});
