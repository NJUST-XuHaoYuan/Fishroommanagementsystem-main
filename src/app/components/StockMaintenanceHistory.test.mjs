import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, module;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  module = await server.ssrLoadModule("/src/app/components/StockMaintenanceHistory.tsx");
});
after(async () => { await server?.close(); });
const record = (id, extra = {}) => ({ id, stockItemId: "fish-1", date: "2026-11-20T09:20:30", text: "观察记录内容", photos: [], videos: [], ...extra });
const render = (records, extra = {}) => renderToStaticMarkup(createElement(module.StockMaintenanceHistoryRecords, { records, ...extra }));

test("read-only history shows recorded time, actor, source, text and location", () => {
  const html = render([record("record-1", { operator: "养护员甲", sourceType: "dailyLog", tankGroupName: "鱼D", subTankName: "D2" })]);
  for (const text of ["2026-11-20 09:20:30", "养护员甲", "缸组养护", "观察记录内容", "鱼D / D2"]) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /编辑|删除记录|新增维护|保存信息|<input|<textarea/);
});

test("history source labels reuse transfer meanings and distinguish legacy unknown sources", () => {
  assert.equal(module.maintenanceHistorySourceLabel("stockTransferReceived"), "移缸签收");
  assert.equal(module.maintenanceHistorySourceLabel("stockTransferDispatched"), "在途直接出库");
  assert.equal(module.maintenanceHistorySourceLabel("shipmentCancellation"), "取消出库回缸核对");
  assert.match(module.maintenanceHistorySourceLabel("legacy-source"), /legacy-source/);
});

test("photos and videos have in-page preview controls without automatic downloads or video loading", () => {
  const html = render([record("record-1", { photos: ["/uploads/photo.jpg"], videos: ["/uploads/video.mp4"] })]);
  assert.match(html, /预览维护照片 1/); assert.match(html, /放大预览维护视频 1/);
  assert.match(html, /<video[^>]*controls=""[^>]*preload="none"/);
  assert.doesNotMatch(html, /<a[^>]*download|autoplay/);
});

test("twenty-row initial rendering can reveal all forty-seven records", () => {
  const records = Array.from({ length: 47 }, (_, i) => record(`record-${i}`, { text: `记录编号 ${i}` }));
  const first = render(records);
  assert.equal((first.match(/<li /g) || []).length, 20); assert.match(first, /已显示 20 \/ 47 条/); assert.match(first, /查看更多记录/);
  const next = render(records, { visibleCount: 40 });
  assert.equal((next.match(/<li /g) || []).length, 40); assert.match(next, /查看更多记录/);
  const all = render(records, { visibleCount: 60 });
  assert.equal((all.match(/<li /g) || []).length, 47); assert.match(all, /记录编号 46/); assert.doesNotMatch(all, /查看更多记录/);
});

test("known empty history and missing legacy metadata are described without invented facts", () => {
  assert.match(render([]), /暂无留存的维护记录/);
  const html = render([record("legacy", { date: "", operator: "" })]);
  assert.match(html, /时间未记录/); assert.match(html, /操作人：未记录/);
});

test("mounted history starts with an explicit loading state instead of an empty-record claim", () => {
  const html = renderToStaticMarkup(createElement(module.StockMaintenanceHistory, { stockItemId: "fish-1" }));
  assert.match(html, /正在加载维护记录/); assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /暂无留存的维护记录/);
});
