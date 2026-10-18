import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, transfer, store;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  transfer = await server.ssrLoadModule("/src/app/components/StockTransferDialog.tsx");
  store = await server.ssrLoadModule("/src/app/store.ts");
});
after(async () => { await server?.close(); });

const fish = (overrides = {}) => ({ stockItemId: "fish-1", transferId: "transfer-1", productId: "product-1", productName: "黄金吊", size: "3-4", origin: "美国", imageUrl: "", code: "189", status: "sick", sold: true,
  fromSiteId: "nanjing", fromSiteName: "南京", fromSubTankId: "tank-1", fromTankName: "鱼 D / D2-2", issuedAt: "2026-10-18T01:02:03Z", issuedBy: "签发人", notes: "调整密度", ...overrides });

test("global transfer search combines source-site filtering with fish and source metadata", () => {
  const nj = fish(), jy = fish({ stockItemId: "fish-2", transferId: "transfer-2", fromSiteId: "jiangyin", fromSiteName: "江阴", code: "200" });
  const rows = [nj, jy];
  assert.deepEqual(transfer.filterStockTransfers(rows, "", ""), rows);
  assert.deepEqual(transfer.filterStockTransfers(rows, " 黄金吊 ", "jiangyin"), [jy]);
  assert.deepEqual(transfer.filterStockTransfers(rows, "189", ""), [nj]);
  assert.deepEqual(transfer.filterStockTransfers(rows, "江阴", "nanjing"), []);
  assert.deepEqual(transfer.filterStockTransfers(rows, "D2-2", ""), rows);
  assert.equal(rows.length, 2);
});

test("partial receipt is versioned by transfer id and cannot silently receive a re-issued fish", () => {
  const oldFish = fish(), nextFish = fish({ transferId: "transfer-new" }), other = fish({ stockItemId: "fish-2", transferId: "transfer-2" });
  const selected = new Set([transfer.transferSelectionKey(oldFish), transfer.transferSelectionKey(other)]);
  const retained = transfer.retainTransferSelection(selected, [nextFish, other]);
  assert.deepEqual([...retained], [transfer.transferSelectionKey(other)]);
  assert.equal(selected.size, 2, "selection inputs are not mutated on refresh");
  const receipt = transfer.stockTransferReceipt("original-tank-is-allowed", selected, [nextFish, other]);
  assert.deepEqual(receipt, { mode: "transferReceive", targetSubTankId: "original-tank-is-allowed", items: [{ stockItemId: "fish-2", transferId: "transfer-2" }] });
});

test("select all is scoped to the current page and preserves other pages without mutating the input", () => {
  const page = [fish(), fish({ stockItemId: "fish-2", transferId: "transfer-2" })];
  const hiddenKey = transfer.transferSelectionKey(fish({ stockItemId: "other-page", transferId: "transfer-3" }));
  const before = new Set([hiddenKey]);
  const selected = transfer.toggleTransferPageSelection(before, page);
  assert.equal(selected.size, 3);
  assert.deepEqual([...before], [hiddenKey]);
  assert.deepEqual([...transfer.toggleTransferPageSelection(selected, page)], [hiddenKey]);
  assert.deepEqual([...transfer.toggleTransferPageSelection(before, [])], [hiddenKey]);
});

test("read-only pool rows expose only minimal fish/source data, never cross-site order or detail links", () => {
  const row = fish({ customerName: "保密客户", orderNo: "保密订单", basePrice: 987654, batchId: "保密批次", notes: "非常长的备注".repeat(100) });
  const html = renderToStaticMarkup(createElement(transfer.StockTransferRows, { items: [row] }));
  for (const value of ["黄金吊", "南京", "D2-2", "签发人", "疾病", "已售", "编号 189"]) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /保密客户|保密订单|987654|保密批次|href=|type="checkbox"/);
  assert.match(html, /min-w-0/);
  assert.match(html, /break-words/);
});

test("receipt rows have accessible labels and pending submission disables selection", () => {
  const row = fish();
  const html = renderToStaticMarkup(createElement(transfer.StockTransferRows, { items: [row], selectable: true, selected: new Set([transfer.transferSelectionKey(row)]), disabled: true }));
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked=""/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-label="选择 黄金吊，编号 189，南京 鱼 D \/ D2-2"/);
});

test("transfer audit records are distinctly labeled and are read-only in both bio timelines", async () => {
  assert.equal(transfer.stockTransferRecordLabel("stockMove"), "移缸记录");
  assert.equal(transfer.stockTransferRecordLabel("stockTransferIssued"), "移缸签发");
  assert.equal(transfer.stockTransferRecordLabel("stockTransferReceived"), "移缸签收");
  assert.equal(transfer.stockTransferRecordLabel("manual"), "");
  assert.equal(transfer.stockTransferRecordLabel(undefined), "");
  const daily = await readFile(new URL("./DailyView.tsx", import.meta.url), "utf8");
  const orders = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  assert.match(daily, /!stockTransferRecordLabel\(ev\.sourceType\) && \(permission\.canUpdate \|\| permission\.canDelete\)/);
  assert.match(orders, /!stockTransferRecordLabel\(event\.sourceType\) && permission\.canUpdate/);
  assert.match(orders, /!stockTransferRecordLabel\(event\.sourceType\) && permission\.canDelete/);
});

function renderPool(user) {
  return renderToStaticMarkup(createElement(store.StoreContext.Provider, { value: { state: { ...store.initialState, user } } }, createElement(transfer.StockTransferPoolButton)));
}
test("pool entry fails closed for stock-in-only staff and appears for authorized daily operators", () => {
  const permissions = store.emptyPermissions(); permissions.stockIn.update = true;
  const user = { username: "staff", role: "staff", account: { username: "staff", accessRole: "staff", accountEnabled: true, permissions } };
  assert.equal(renderPool(null), "");
  assert.equal(renderPool(user), "");
  permissions.daily.update = true;
  assert.match(renderPool(user), /移缸在途/);
  assert.match(renderPool({ username: "admin", role: "admin" }), /移缸在途/);
});

test("both old move forms issue without target tank and stale order picks are revalidated", async () => {
  const daily = await readFile(new URL("./DailyView.tsx", import.meta.url), "utf8");
  const orders = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  for (const source of [daily, orders]) {
    assert.match(source, /mode: "transferIssue"/);
    assert.doesNotMatch(source, /mode: "move"/);
    assert.doesNotMatch(source, /confirmWrite\("签发移缸"/);
    assert.match(source, /<DialogTitle>签发移缸<\/DialogTitle>/);
    assert.match(source, /确认签发/);
    assert.doesNotMatch(source, /<Label>目标(?:子缸|缸组)/);
    assert.match(source, /notifyStockTransfersChanged\(\)/);
  }
  assert.match(daily, /setReceiveTarget\(\{ subTankId: t\.id/);
  assert.match(orders, /stock\.id === stockItemId && isAvail\(stock\)/);
  assert.match(orders, /return !stock \|\| stock\.sold \|\| !isPhysicallyInTank\(stock, shippedOutStockIds\)/);
  assert.match(orders, /transferUnshippedItems\.length/);
});

test("receipt failures retain selection, conflict requires refresh, and requests carry idempotency keys", async () => {
  const source = await readFile(new URL("./StockTransferDialog.tsx", import.meta.url), "utf8");
  const failureBranch = source.slice(source.indexOf("if (!result.ok)"), source.indexOf("setSelected(new Set()); ticketRef.current"));
  assert.doesNotMatch(failureBranch, /setSelected/);
  assert.match(failureBranch, /result\.conflict === true/);
  assert.match(source, /requestLock\.current \|\| !target/);
  assert.match(source, /clientMutationId: ticket\.clientMutationId/);
  assert.match(source, /pool\.error \|\| conflict/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /pageItems = filtered\.slice/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /暂无移缸在途的鱼/);
});
