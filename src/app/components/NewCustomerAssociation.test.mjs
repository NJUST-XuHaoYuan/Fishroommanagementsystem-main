import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, helper, sessionHelper, Panel, Association;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  helper = await server.ssrLoadModule("/src/app/utils/newCustomerLink.ts");
  sessionHelper = await server.ssrLoadModule("/src/app/utils/newCustomerEvidence.ts");
  ({ NewCustomerApprovalPanel: Panel } = await server.ssrLoadModule("/src/app/components/NewCustomerApprovalPanel.tsx"));
  ({ NewCustomerAssociation: Association } = await server.ssrLoadModule("/src/app/components/NewCustomerAssociation.tsx"));
});
after(async () => { await server?.close(); });

const customer = { id: "c1", name: "核对客户", phone: "", wechat: "wx-customer", douyin: "", addedDate: "2026-11-03", customerType: "", source: "微信", notes: "客户资料", address: "" };
const evidence = { id: "e1", originalName: "添加微信.png", mime: "image/jpeg", size: 100, createdAt: "2026-11-03T00:00:00Z" };
const detail = overrides => ({ orderId: "o1", currentOrder: { id: "o1", customerId: "", contactPerson: "销售甲" }, customerEvidence: { identityKnown: false, otherOrderCount: 0, priorOrders: [] }, linkedCustomer: null, canRequest: false, canApprove: false, canManageCustomer: true, canCreateCustomer: true, policyEffectiveDate: "2026-10-01", ...overrides });
const renderPanel = initialDetail => renderToStaticMarkup(createElement(Panel, { orderId: "o1", initialDetail }));

async function withSession(run) {
  const previous = globalThis.window;
  const data = new Map();
  const auth = { username: "sales", role: "staff", token: "token-a", expiresAt: Date.now() + 60_000, visibleSiteIds: ["nanjing"] };
  const write = value => data.set("fishroom-auth-session", JSON.stringify(value));
  globalThis.window = { localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } };
  write(auth);
  try { await run({ auth, write, session: sessionHelper.captureNewCustomerSession() }); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}

test("missing customer offers inline lookup and create without requiring optional contacts", () => {
  const markup = renderPanel(detail());
  assert.match(markup, /先关联客户档案|选择已有客户/);
  assert.match(markup, /新建客户并关联/);
  assert.doesNotMatch(markup, /人工核对客户身份.*确认可按新客首单批准/);
  assert.equal(helper.newCustomerLinkReady({ canManage: true, canCreate: true, mode: "create", name: "真实客户" }), true);
  assert.equal(helper.newCustomerLinkReady({ canManage: true, canCreate: true, mode: "create", name: "  " }), false);
  assert.equal(helper.newCustomerLinkReady({ canManage: true, canCreate: false, mode: "create", name: "真实客户" }), false);
  assert.equal(helper.newCustomerLinkReady({ canManage: true, mode: "existing", customerId: "c1" }), true);
  assert.equal(helper.newCustomerLinkReady({ canManage: true, mode: "existing", customerId: "c1", processing: true }), false);
});

test("customer permissions gate mutation and creation separately", () => {
  const props = { disabled: false, onBusyChange() {}, onLinked: async () => {}, onConflict: async () => {} };
  const readonly = renderToStaticMarkup(createElement(Association, { ...props, detail: detail({ canManageCustomer: false, customerBlockedReason: "仅负责人可处理" }) }));
  assert.match(readonly, /仅负责人可处理/); assert.doesNotMatch(readonly, /<button|<input|<select/);
  const linkOnly = renderToStaticMarkup(createElement(Association, { ...props, detail: detail({ canCreateCustomer: false }) }));
  assert.match(linkOnly, /选择已有客户/); assert.doesNotMatch(linkOnly, /新建客户并关联/);
});

test("dangling customer ID is repairable instead of appearing linked", () => {
  const markup = renderPanel(detail({ currentOrder: { id: "o1", customerId: "deleted-customer" }, customerEvidence: { identityKnown: true, otherOrderCount: 0, priorOrders: [] } }));
  assert.match(markup, /未关联有效客户档案/);
  assert.match(markup, /先关联客户档案/);
  assert.doesNotMatch(markup, /已关联客户档案/);
});

test("private customer projection hidden from unrelated staff is not mislabeled as missing", () => {
  const markup = renderPanel(detail({ canViewEvidence: false, canManageCustomer: false, currentOrder: { id: "o1", customerId: "c1" } }));
  assert.match(markup, /已有关联，当前账号无权核对/);
  assert.doesNotMatch(markup, /先关联客户档案|未关联有效客户档案/);
});

test("proof and customer are both required to approve; legacy approved record stays approved", () => {
  const approval = { status: "pending", requestId: "r1", version: 1, reason: "首次添加微信成交", requestedBy: "sales", evidenceAttachments: [] };
  const missing = renderPanel(detail({ canApprove: true, approval }));
  assert.match(missing, /暂不能批准/); assert.match(missing, /驳回申请/); assert.match(missing, /未上传添加微信证明/);
  const complete = renderPanel(detail({ canApprove: true, currentOrder: { id: "o1", customerId: "c1" }, customerEvidence: { identityKnown: true, otherOrderCount: 0, priorOrders: [] }, linkedCustomer: customer, approval: { ...approval, evidenceAttachments: [evidence] } }));
  const approveButton = complete.match(/<button[^>]*>[^]*?<\/button>/g).find(button => button.includes("批准并采用"));
  assert.doesNotMatch(approveButton, /disabled=""/); assert.match(complete, /已关联客户档案：核对客户/);
  const historical = renderPanel(detail({ approval: { ...approval, status: "approved" } }));
  assert.match(historical, /已批准为新客首单/); assert.match(historical, /不按新增材料要求追溯修改/); assert.doesNotMatch(historical, /先关联客户档案|暂不能批准/);
});

test("link merge preserves business state, existing customers and deleted orders", async () => withSession(({ auth, session }) => {
  const current = { user: auth, orders: [{ id: "o1", customerId: "", total: 999, status: "shipped", newCustomerApproval: { version: 2 } }], customers: [] };
  const change = { order: { id: "o1", customerId: "c1", total: 1, status: "draft" }, customer, expectedCustomerId: "", expectedApprovalVersion: 2 };
  const updated = helper.mergeNewCustomerLink(current, change, session);
  assert.deepEqual(updated.orders[0], { ...current.orders[0], customerId: "c1" });
  assert.deepEqual(updated.customers, [customer]);
  const newerCustomer = { ...customer, notes: "刚刚编辑的新备注" };
  assert.strictEqual(helper.mergeNewCustomerLink({ ...current, customers: [newerCustomer] }, change, session).customers[0], newerCustomer);
  const deleted = { ...current, orders: [] }; assert.strictEqual(helper.mergeNewCustomerLink(deleted, change, session), deleted);
  const changed = { ...current, orders: [{ ...current.orders[0], customerId: "c2" }] }; assert.strictEqual(helper.mergeNewCustomerLink(changed, change, session), changed);
  const approved = { ...current, orders: [{ ...current.orders[0], newCustomerApproval: { version: 3, status: "approved" } }] }; assert.strictEqual(helper.mergeNewCustomerLink(approved, change, session), approved);
  const projection = { id: "c1", name: "核对客户", phone: "", wechat: "", douyin: "" };
  assert.deepEqual(helper.mergeNewCustomerLink(current, { ...change, customer: projection }, session).customers, []);
  assert.equal(helper.mergeNewCustomerLink(current, { ...change, customer: undefined }, session).orders[0].customerId, "c1");
}));

test("late customer response cannot mutate another account, auth token or permission scope", async () => withSession(({ auth, write, session }) => {
  const current = { user: auth, orders: [{ id: "o1", customerId: "" }], customers: [] };
  const change = { order: { id: "o1", customerId: "c1" }, customer, expectedCustomerId: "", expectedApprovalVersion: 0 };
  for (const update of [{ username: "other" }, { token: "renewed-token" }, { expiresAt: Date.now() - 1 }, { visibleSiteIds: [] }]) {
    write({ ...auth, ...update }); assert.strictEqual(helper.mergeNewCustomerLink(current, change, session), current);
  }
  write(auth); const differentStore = { ...current, user: { ...auth, username: "other" } };
  assert.strictEqual(helper.mergeNewCustomerLink(differentStore, change, session), differentStore);
}));

test("success and conflict both clear parent busy even when refresh unmounts customer editor", async () => {
  const source = await readFile(new URL("./NewCustomerApprovalPanel.tsx", import.meta.url), "utf8");
  const callbacks = source.slice(source.indexOf("onConflict={async"), source.indexOf("{approval && ("));
  assert.equal((callbacks.match(/finally \{ if \(mountedRef\.current\) onCustomerBusyChange\(false\); \}/g) || []).length, 2);
  assert.doesNotMatch(callbacks, /setRequestReason|onEvidenceChange/);
  const editor = await readFile(new URL("./NewCustomerAssociation.tsx", import.meta.url), "utf8");
  assert.match(editor, /pending\.current \|\| !ready/);
  assert.match(editor, /expectedCustomerId, expectedApprovalVersion/);
  assert.match(editor, /controller\.signal\.aborted \|\| !current\(session\)/);
  assert.match(editor, /mutation\.current\?\.abort\(\)/);
});

test("order and notification integrations use safe linkage merge, and platform editing preserves links", async () => {
  const orders = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  const notices = await readFile(new URL("./NotificationCenter.tsx", import.meta.url), "utf8");
  for (const source of [orders, notices]) assert.match(source, /onCustomerLinked=\{\(change, session\) => setState\(current => mergeNewCustomerLink\(current, change, session\)\)\}/);
  assert.match(orders, /customerId: isPlatformOrderSource\(editForm.source\) \? \(order.customerId \|\| editForm.customerId\) : editForm.customerId/);
  assert.doesNotMatch(orders, /customerId: isPlatformOrderSource\(nextSource\) \? ""/);
});
