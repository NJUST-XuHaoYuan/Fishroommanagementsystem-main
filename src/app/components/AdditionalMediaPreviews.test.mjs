import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, BatchInfoSection, ImageUpload;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ BatchInfoSection } = await server.ssrLoadModule("/src/app/components/BatchInfoSection.tsx"));
  ({ ImageUpload } = await server.ssrLoadModule("/src/app/components/ImageUpload.tsx"));
});
after(async () => { await server?.close(); });

const batch = { id: "batch-1", batchNo: "PO-TEST", bioFee: 100, shippingFee: 20, stockedCount: 4, lossCount: 1, notes: "原有批次备注", lossProof: ["/uploads/batch-proof.png"] };

test("batch detail proof uses a named keyboard button and never an external/download link", () => {
  const markup = renderToStaticMarkup(createElement(BatchInfoSection, { batch, revenue: null, loading: false, error: "", onRetry() {} }));
  assert.match(markup, /<button[^>]*type="button"[^>]*aria-label="预览批次报损凭证 1"/);
  assert.match(markup, /alt="报损凭证 1"/);
  assert.match(markup, /原有批次备注/);
  assert.doesNotMatch(markup, /download=|target="_blank"|href="\/uploads/);
});

test("empty batch proof preserves the honest empty state without a phantom preview", () => {
  const markup = renderToStaticMarkup(createElement(BatchInfoSection, { batch: { ...batch, lossProof: [] }, revenue: null, loading: false, error: "", onRetry() {} }));
  assert.match(markup, /暂无报损凭证/);
  assert.doesNotMatch(markup, /aria-label="预览批次报损凭证/);
});

test("uploaded image has an independent preview button while replacement/removal remain separate", () => {
  let edits = 0;
  const markup = renderToStaticMarkup(createElement(ImageUpload, { value: "/uploads/product.png", onChange() { edits++; } }));
  assert.match(markup, /<button[^>]*type="button"[^>]*aria-label="预览已上传图片"/);
  assert.match(markup, /更换图片/);
  assert.match(markup, /移除/);
  assert.doesNotMatch(markup, /download=|target="_blank"/);
  assert.equal(edits, 0);
  const empty = renderToStaticMarkup(createElement(ImageUpload, { value: "", onChange() {} }));
  assert.match(empty, /无图片/);
  assert.doesNotMatch(empty, /aria-label="预览已上传图片"/);
});

test("both financial proof lists use the shared preview contract and keep mutation controls outside it", async () => {
  const source = await readFile(new URL("./FinanceView.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<MediaPreviewTrigger\b/g) || []).length, 2);
  assert.match(source, /ariaLabel=\{`预览资金凭证 \$\{index \+ 1\}`\}/);
  assert.doesNotMatch(source, /window\.open|openProofImage|resolveMediaUrl|document\.write/);
  assert.match(source, /<\/MediaPreviewTrigger>\s*<button[^]*?aria-label="删除凭证"/);
  assert.match(source, /onChange\(images\.filter\(/);
});

test("batch editing and summary share preview rather than retaining a second modal or bubbling a write", async () => {
  const editor = await readFile(new URL("./BatchesView.tsx", import.meta.url), "utf8");
  const summary = await readFile(new URL("./BatchInfoSection.tsx", import.meta.url), "utf8");
  assert.match(editor, /<MediaPreviewTrigger[\s\S]*?mediaType="image"/);
  assert.match(summary, /<MediaPreviewTrigger[\s\S]*?mediaType="image"/);
  assert.doesNotMatch(editor + summary, /proofPreview|setProofPreview|onPreview|window\.open|downloadMedia/);
  assert.match(editor, /<\/MediaPreviewTrigger>\s*<button[^]*?lossProof: editing\.lossProof\.filter/);
});
