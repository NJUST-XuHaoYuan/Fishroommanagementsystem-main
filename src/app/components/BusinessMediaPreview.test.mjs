import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const names = ["DailyView", "OrdersView", "BatchDetailsView", "LossRecordsView", "ShipmentProofDialog"];
const source = {};
let vite, shipment;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  for (const name of names) source[name] = await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8");
});
after(async () => { await vite?.close(); });

test("all five business modules load with the shared media preview component", async () => {
  for (const name of names) {
    const module = await vite.ssrLoadModule(`/src/app/components/${name}.tsx`);
    assert.ok(module, name);
    assert.match(source[name], /import \{ MediaPreviewTrigger \} from "\.\/MediaPreviewDialog"/);
    if (name === "ShipmentProofDialog") shipment = module;
  }
});

test("click-to-preview entries no longer open external pages, inject image HTML or call photo download", () => {
  for (const name of names) {
    assert.doesNotMatch(source[name], /window\.open|document\.write|target="_blank"/, name);
    assert.doesNotMatch(source[name], /downloadMedia\(src, `photo-/, name);
    assert.match(source[name], /<MediaPreviewTrigger\b/, name);
  }
});

test("maintenance video preview preserves stream playback, explicit download and original authorization context", () => {
  for (const [name, stock, record] of [["DailyView", "bioItem?.id ?? \"\"", "ev.id"], ["OrdersView", "item.id", "event.id"]]) {
    assert.match(source[name], /<MediaVideo src=\{src\} className="w-full" controls/);
    assert.ok(source[name].includes(`stockItemId={${stock}} recordId={${record}}`), name);
    assert.match(source[name], /放大预览视频/);
    assert.match(source[name], /downloadMedia\(src, `video-/);
    assert.match(source[name], /aria-label=\{`保存第 /);
    assert.match(source[name], /recordId: (?:ev|event)\.id/);
  }
});

test("draft photo/video preview does not wrap removal or upload controls in the preview button", () => {
  for (const name of ["DailyView", "OrdersView"]) {
    assert.match(source[name], /title=\{`待保存照片 \$\{(?:i|index) \+ 1\}`\}/);
    assert.match(source[name], /title=\{`待保存视频 \$\{(?:i|index) \+ 1\}`\}[^>]*allowDownload=\{false\}/);
    assert.match(source[name], /<\/MediaPreviewTrigger>\s*<button[^]*?setNewRecord\(/);
    assert.match(source[name], /<\/MediaPreviewTrigger>\s*<button[^]*?setLossProof\(/);
    assert.match(source[name], /uploadOriginalMedia/);
  }
  assert.match(source.OrdersView, /<\/MediaPreviewTrigger>\s*<button[^]*?onChange\(images\.filter\(/);
  assert.match(source.DailyView, /<\/MediaPreviewTrigger>\s*<button[^]*?setBatchRecord\(/);
});

test("batch history resolves media and passes the underlying bio record identity to video downloads", () => {
  assert.match(source.BatchDetailsView, /<ImageWithFallback src=\{src\}/);
  assert.match(source.BatchDetailsView, /<MediaVideo src=\{src\} controls preload="none" playsInline/);
  assert.match(source.BatchDetailsView, /stockItemId=\{stockItemId\} recordId=\{event\.id\.startsWith\("bio:"\) \? event\.id\.slice\(4\) : undefined\}/);
  assert.doesNotMatch(source.BatchDetailsView, /<a[^>]*href=\{src\}|<video\s/);
});

test("shipment proof retains gallery navigation and separately labelled downloading without reopening the browser", () => {
  assert.deepEqual(shipment.shipmentPackingProofs({ packingProof: ["", "/uploads/a.jpg", null, 7] }), ["/uploads/a.jpg"]);
  assert.match(source.ShipmentProofDialog, /上一张凭证/);
  assert.match(source.ShipmentProofDialog, /下一张凭证/);
  assert.match(source.ShipmentProofDialog, /onClick=\{downloadActiveProof\}/);
  assert.match(source.ShipmentProofDialog, /下载当前照片/);
  assert.match(source.ShipmentProofDialog, /<MediaPreviewTrigger src=\{activeProof\}/);
  assert.match(source.ShipmentProofDialog, /放大预览/);
});
