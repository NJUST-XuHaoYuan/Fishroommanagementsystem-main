import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, component, OrdersView, StoreContext, initialState;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  component = await server.ssrLoadModule("/src/app/components/SalesWorkbenchToolbar.tsx");
  ({ OrdersView } = await server.ssrLoadModule("/src/app/components/OrdersView.tsx"));
  ({ StoreContext, initialState } = await server.ssrLoadModule("/src/app/store.ts"));
});
after(async () => { await server?.close(); });
const noop = () => {};
test("workbench has three distinct queues and no creation or legacy filter controls", () => {
  const html = renderToStaticMarkup(createElement(component.SalesWorkbenchToolbar, { tab: "collection", counts: { collection: 3, shipment: 4, followup: null }, search: "", onTabChange: noop, onSearchChange: noop, onRefresh: noop }));
  for (const label of ["待收款", "待发货", "待回访", "搜索我的待办订单"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /新建订单|全部订单|下单日期筛选|批发标记/);
  assert.match(html, /aria-pressed="true"/);
});
test("each queue offers its direct action while keeping details", () => {
  const row = { id: "a", orderNo: "SO-1", customer: "客户甲", productSummary: "黄金吊 · 1 条", date: "2026-11-26", plannedDate: "", remaining: 40, shippingLabel: "已出库，待发货" };
  for (const [tab, action] of [["collection", "去收银台"], ["shipment", "处理发货"], ["followup", "登记回访"]]) {
    const html = renderToStaticMarkup(createElement(component.SalesWorkbenchOrderList, { tab, rows: [row], onRetry: noop, onOpen: noop, onDetails: noop }));
    assert.ok(html.includes(action)); assert.match(html, /详情/); assert.match(html, /SO-1/);
    assert.doesNotMatch(html, /删除|导出/);
  }
});
test("followup load failure has retry and never claims an empty queue", () => {
  const html = renderToStaticMarkup(createElement(component.SalesWorkbenchOrderList, { tab: "followup", rows: [], error: "回访加载失败", onRetry: noop, onOpen: noop, onDetails: noop }));
  assert.match(html, /role="alert"/); assert.match(html, /重试/); assert.doesNotMatch(html, /没有符合条件/);
});
test("workbench defaults to collection while ordinary order management keeps its toolbar", () => {
  const workspace = renderToStaticMarkup(createElement(OrdersView, { personalWorkspace: true }));
  assert.match(workspace, /我的销售待办/); assert.match(workspace, /我的待收款订单/);
  assert.doesNotMatch(workspace, /新建订单|订单状态|已选订单批量操作/);
  const ordinary = renderToStaticMarkup(createElement(OrdersView));
  assert.match(ordinary, /订单范围/); assert.match(ordinary, /全部订单/); assert.doesNotMatch(ordinary, /我的销售待办/);
});

test("an administrator's workbench lists only their unpaid orders while normal order management remains complete", () => {
  const makeOrder = (id, owner, extra = {}) => ({ id, orderNo: id, siteId: "nanjing", date: "2026-11-26", source: "私域线上", status: "confirmed", customerId: "customer", contactPersonnelId: owner,
    items: [{ stockItemId: `fish-${id}`, productId: "product", price: 100 }], payments: [], shippingFee: 0, packagingFee: 0, discount: 0, notes: "", ...extra });
  const state = { ...initialState, user: { username: "admin-a", role: "admin" },
    personnel: [{ id: "owner-a", username: "admin-a", name: "管理员甲", accountEnabled: true }, { id: "owner-b", username: "staff-b", name: "员工乙", accountEnabled: true }],
    orders: [makeOrder("OWN-UNPAID", "owner-a"), makeOrder("OTHER-UNPAID", "owner-b"), makeOrder("OWN-PAID", "owner-a", { paymentClaims: [{ id: "proof", amount: 100, status: "pending" }] })],
    shipments: [], stock: [], products: [{ id: "product", name: "示例鱼" }], customers: [{ id: "customer", name: "示例客户" }] };
  const renderOrders = personalWorkspace => renderToStaticMarkup(createElement(StoreContext.Provider, { value: { state, activeSiteId: "nanjing" } }, createElement(OrdersView, { personalWorkspace })));
  const workspace = renderOrders(true);
  assert.match(workspace, /OWN-UNPAID/); assert.doesNotMatch(workspace, /OTHER-UNPAID|OWN-PAID/);
  const ordinary = renderOrders(false);
  for (const id of ["OWN-UNPAID", "OTHER-UNPAID", "OWN-PAID"]) assert.ok(ordinary.includes(id));
});
