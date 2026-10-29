import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, StockStatusHistoryList, statusHistoryTime;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ StockStatusHistoryList, statusHistoryTime } = await server.ssrLoadModule("/src/app/components/StockStatusHistoryPanel.tsx"));
});
after(async () => { await server?.close(); });

test("history shows both states, trusted actor and time without treating color as meaning", () => {
  const html = renderToStaticMarkup(createElement(StockStatusHistoryList, { records: [{ id: "h1", stockItemId: "s1", previousStatus: "healthy", status: "feeding", changedAt: "2026-10-29T01:02:03.000Z", operator: "staff-a", operatorName: "员工甲", source: "batch_status" }] }));
  for (const text of ["正常", "开口", "员工甲", "staff-a", "09:02:03", "批量修改"]) assert.ok(html.includes(text));
  assert.match(html, /<ol.*<li/);
});
test("empty historic audit is explained without inventing an actor", () => {
  const html = renderToStaticMarkup(createElement(StockStatusHistoryList, { records: [] }));
  assert.match(html, /之前的操作人和时间不作推测/);
  assert.doesNotMatch(html, /管理员/);
});
test("approval records distinguish the reviewer from the requester", () => {
  const html = renderToStaticMarkup(createElement(StockStatusHistoryList, { records: [{ id: "approval", stockItemId: "s1", previousStatus: "healthy", status: "sick", changedAt: "2026-10-29T01:02:03.000Z", operator: "admin", operatorName: "管理员甲", source: "stock_approval", requestedBy: "staff", requestedByName: "员工乙" }] }));
  for (const text of ["操作人：管理员甲", "申请人：员工乙", "审批生效"]) assert.ok(html.includes(text));
});
test("initial state and unknown values do not fabricate state changes", () => {
  const html = renderToStaticMarkup(createElement(StockStatusHistoryList, { records: [{ id: "h2", stockItemId: "s1", previousStatus: null, status: "sick", changedAt: "bad", operator: "" }] }));
  assert.match(html, /初始状态/); assert.match(html, /疾病/); assert.match(html, /时间未记录/); assert.match(html, /操作人：未记录/);
  assert.equal(statusHistoryTime(""), "时间未记录");
});
